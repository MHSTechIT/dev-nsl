/**
 * Public auth routes — forgot-password & reset-password.
 * Fully autonomous: token and password stored in server/data/admin.json.
 * No database dependency.
 */
const express    = require('express');
const { body, validationResult } = require('express-validator');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const router     = express.Router();
const { readConfig, writeConfig } = require('../utils/adminConfig');

const pool = require('../db');
const jwtUtil = require('../utils/jwt');

/* Verify a scrypt-hashed password (format: scrypt$<salt-hex>$<hash-hex>) */
function verifyScryptHash(plain, stored) {
  return new Promise(resolve => {
    if (!stored || typeof stored !== 'string') return resolve(false);
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
    let salt, expected;
    try {
      salt     = Buffer.from(parts[1], 'hex');
      expected = Buffer.from(parts[2], 'hex');
    } catch { return resolve(false); }
    crypto.scrypt(plain, salt, expected.length, (err, derived) => {
      if (err) return resolve(false);
      try {
        resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
      } catch { resolve(false); }
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   POST /api/auth/crm-login
   Authenticates a CRM user (junior caller, manager, etc.)
   against the crm_users table. Returns the user record on success.
───────────────────────────────────────────────────────────── */
router.post('/crm-login',
  body('username').trim().isLength({ min: 1, max: 200 }),
  body('password').isLength({ min: 1, max: 256 }),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(401).json({ error: 'Invalid credentials.' });

    const { username, password } = req.body;
    const uname = String(username).trim().toLowerCase();
    try {
      // Shared caller login. A caller account lives in exactly ONE pool:
      // crm_users (Meta/YT/Meta2 workspace) or nsm_users (NSM workspace).
      // Check Meta first, then fall back to NSM. The pool the account is found
      // in decides the `workspace` stamped into the JWT — which scopes every
      // /api/caller/* query to the right tables. One login, one caller page.
      let workspace = 'meta';
      let { rows } = await pool.query(
        `SELECT id, full_name, email, phone, role, password_hash, is_active, department
         FROM crm_users WHERE LOWER(email) = $1`,
        [uname]
      );
      if (rows.length === 0) {
        const nsm = await pool.query(
          `SELECT id, full_name, email, phone, role, password_hash, is_active, NULL::text AS department
           FROM nsm_users WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
          [uname]
        );
        if (nsm.rows.length > 0) { rows = nsm.rows; workspace = 'nsm'; }
      }
      if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
      const u = rows[0];
      if (!u.is_active)      return res.status(401).json({ error: 'Account is inactive.' });
      if (!u.password_hash)  return res.status(401).json({ error: 'No password set for this account. Contact your admin.' });

      const ok = await verifyScryptHash(password, u.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

      const token = jwtUtil.sign({
        user_id:    u.id,
        role:       u.role,
        full_name:  u.full_name,
        department: u.department || null,
        workspace,
      });
      res.json({
        user: {
          id:         u.id,
          full_name:  u.full_name,
          email:      u.email,
          phone:      u.phone,
          role:       u.role,
          department: u.department || null,
          workspace,
        },
        token,
      });
    } catch (err) {
      console.error('crm-login error:', err.message);
      res.status(500).json({ error: 'Login failed. Try again.' });
    }
  }
);

/* ── Gmail transporter ── */
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_FROM,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

/* ─────────────────────────────────────────────────────────────
   POST /api/auth/forgot-password
   Generates a one-time token → saves to local file → emails reset link.
   No auth required, no database.
───────────────────────────────────────────────────────────── */
router.post('/forgot-password', async (req, res) => {
  try {
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    /* Write token + expiry to local file */
    writeConfig({ reset_token: token, reset_expires: expires });

    const origin   = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const resetUrl = `${origin}/admin/reset-password?token=${token}`;
    const fromAddr = process.env.GMAIL_FROM;
    const toAddr   = process.env.RESET_EMAIL_TO;

    if (!fromAddr || !toAddr || !process.env.GMAIL_APP_PASSWORD) {
      console.error('forgot-password: email env vars not configured');
      return res.status(500).json({ error: 'Email service not configured.' });
    }

    const transporter = createTransporter();

    await transporter.sendMail({
      from:    `"MHS Admin" <${fromAddr}>`,
      to:      toAddr,
      subject: 'MHS Admin — Password Reset Request',
      html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F3F0FD;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(91,33,182,0.12);" cellpadding="0" cellspacing="0">

        <tr>
          <td style="background:linear-gradient(135deg,#5B21B6,#8B5CF6);padding:32px 28px;text-align:center;">
            <div style="width:52px;height:52px;background:rgba(255,255,255,0.18);border-radius:14px;display:inline-block;line-height:52px;margin-bottom:14px;">
              <span style="color:#fff;font-size:26px;font-weight:800;">M</span>
            </div>
            <h1 style="color:#fff;margin:0;font-size:1.35rem;font-weight:700;">Password Reset</h1>
            <p style="color:rgba(255,255,255,0.70);margin:6px 0 0;font-size:0.84rem;">My Health School · Admin Panel</p>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 28px;">
            <p style="color:#3B0764;font-size:0.95rem;margin:0 0 10px;font-weight:600;">Hi Admin,</p>
            <p style="color:#555;font-size:0.88rem;line-height:1.6;margin:0 0 24px;">
              A password reset was requested. Click the button below to set a new password.
              This link is valid for <strong style="color:#5B21B6;">1 hour</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding-bottom:24px;">
                  <a href="${resetUrl}"
                    style="display:inline-block;background:#5B21B6;color:#fff;text-decoration:none;padding:15px 40px;border-radius:50px;font-weight:700;font-size:0.95rem;box-shadow:0 4px 18px rgba(91,33,182,0.35);">
                    Reset My Password &rarr;
                  </a>
                </td>
              </tr>
            </table>
            <p style="color:#888;font-size:0.75rem;margin:0 0 6px;">If the button doesn't work, paste this link in your browser:</p>
            <p style="word-break:break-all;color:#5B21B6;font-size:0.74rem;background:#F3F0FD;padding:10px 14px;border-radius:8px;margin:0 0 24px;">${resetUrl}</p>
            <p style="color:#aaa;font-size:0.73rem;margin:0;">If you didn't request this, you can safely ignore this email.</p>
          </td>
        </tr>

        <tr>
          <td style="border-top:1px solid #EDE9FE;padding:16px 28px;text-align:center;">
            <p style="color:#c4b5fd;font-size:0.69rem;margin:0;">My Health School &middot; ${new Date().getFullYear()}</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('forgot-password error:', err.message);
    res.status(500).json({ error: 'Failed to send reset email. Please try again later.' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/auth/reset-password
   Verifies token from local file → sets new password in local file.
   No auth required, no database.
───────────────────────────────────────────────────────────── */
router.post('/reset-password',
  body('token').notEmpty(),
  body('new_password').isLength({ min: 8 }),
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) {
      return res.status(422).json({ error: 'Password must be at least 8 characters.' });
    }

    const { token, new_password } = req.body;
    const cfg = readConfig();

    // Timing-safe token comparison
    if (!cfg.reset_token || token.length !== cfg.reset_token.length) {
      return res.status(400).json({ error: 'Invalid or already-used reset link.' });
    }
    const a = Buffer.from(token);
    const b = Buffer.from(cfg.reset_token);
    if (!crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({ error: 'Invalid or already-used reset link.' });
    }

    if (!cfg.reset_expires || new Date(cfg.reset_expires) < new Date()) {
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    }

    try {
      writeConfig({
        password:      new_password,
        reset_token:   null,
        reset_expires: null,
      });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to save new password.' });
    }
  }
);

module.exports = router;
