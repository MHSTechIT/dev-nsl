/**
 * NSM-Caller caller-facing API — the independent equivalent of /api/caller,
 * but authenticated against nsm_users and serving nsm_leads. Tokens carry
 * scope='nsm-caller' so a Meta crm_users JWT can never reach NSM data and an
 * NSM JWT can never reach Meta data. Nothing here touches Meta tables/routes.
 *
 * Phase 1 (this file): login + me + assigned leads. The call workflow
 * (click-to-call, call notes, heartbeats, robot-nudge) lands in later phases.
 */
const express = require('express');
const crypto  = require('crypto');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const pool    = require('../db');
const jwtUtil = require('../utils/jwt');

/* Verify a scrypt-hashed password (format: scrypt$<salt-hex>$<hash-hex>) —
   same scheme nsm_users (and crm_users) are hashed with. */
function verifyScryptHash(plain, stored) {
  return new Promise(resolve => {
    if (!stored || typeof stored !== 'string') return resolve(false);
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
    let salt, expected;
    try { salt = Buffer.from(parts[1], 'hex'); expected = Buffer.from(parts[2], 'hex'); }
    catch { return resolve(false); }
    crypto.scrypt(plain, salt, expected.length, (err, derived) => {
      if (err) return resolve(false);
      try { resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected)); }
      catch { resolve(false); }
    });
  });
}

/* Scoped JWT auth — requires scope='nsm-caller' and a live nsm_users row. */
async function nsmCallerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token  = bearer || (typeof req.query?.token === 'string' ? req.query.token : '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  let payload;
  try { payload = jwtUtil.verify(token); } catch { return res.status(401).json({ error: 'unauthorized' }); }
  if (!payload || payload.scope !== 'nsm-caller' || !payload.user_id) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, is_active
         FROM nsm_users WHERE id = $1 AND deleted_at IS NULL`,
      [payload.user_id]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'unauthorized' });
    req.caller = rows[0];
    next();
  } catch (e) {
    return res.status(500).json({ error: 'auth error' });
  }
}

/* ── POST /api/nsm-caller/login (public) ── */
router.post('/login',
  body('username').trim().isLength({ min: 1, max: 200 }),
  body('password').isLength({ min: 1, max: 256 }),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(401).json({ error: 'Invalid credentials.' });

    const { username, password } = req.body;
    try {
      const { rows } = await pool.query(
        `SELECT id, full_name, email, phone, role, password_hash, is_active
           FROM nsm_users WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
        [String(username).trim().toLowerCase()]
      );
      if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
      const u = rows[0];
      if (!u.is_active)     return res.status(401).json({ error: 'Account is inactive.' });
      if (!u.password_hash) return res.status(401).json({ error: 'No password set. Contact your admin.' });

      const ok = await verifyScryptHash(password, u.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

      const token = jwtUtil.sign({ user_id: u.id, role: u.role, full_name: u.full_name, scope: 'nsm-caller' });
      res.json({
        user: { id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, role: u.role },
        token,
      });
    } catch (err) {
      console.error('[nsm-caller] login error:', err.message);
      res.status(500).json({ error: 'Login failed. Try again.' });
    }
  }
);

/* Everything below requires a valid NSM caller token. */
router.use(nsmCallerAuth);

/* ── GET /api/nsm-caller/me ── */
router.get('/me', (req, res) => {
  res.json({ user: req.caller, is_active: req.caller.is_active });
});

/* ── GET /api/nsm-caller/leads — leads assigned to this caller ── */
router.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.batch_id, b.batch_name, l.form_name, l.created_time,
              l.full_name, l.phone, l.email, l.city, l.field_data, l.assigned_at
         FROM nsm_leads l
         LEFT JOIN nsm_batches b ON b.id = l.batch_id
        WHERE l.assigned_user_id = $1 AND l.deleted_at IS NULL
        ORDER BY l.assigned_at DESC NULLS LAST, l.created_time DESC NULLS LAST
        LIMIT 2000`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('[nsm-caller] GET /leads error:', err.message);
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

module.exports = router;
