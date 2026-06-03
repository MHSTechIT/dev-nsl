const express = require('express');
const router = express.Router();
const pool = require('../db');
const jwtUtil = require('../utils/jwt');
const { verifyScryptHash } = require('../utils/scrypt');

/* POST /api/auth/login — CRM staff sign in with their CRM email + password.
   Validated against the SHARED crm_users table (read-only). Any active, non-
   deleted staff account may sign in. (To restrict to specific roles later,
   add a role check here.) */
router.post('/login', async (req, res) => {
  const email = String(req.body?.email || req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, role, password_hash, is_active
         FROM crm_users
        WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
      [email]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const u = rows[0];
    if (!u.is_active)     return res.status(401).json({ error: 'Account is inactive.' });
    if (!u.password_hash) return res.status(401).json({ error: 'No password set for this account. Contact your admin.' });

    const ok = await verifyScryptHash(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = jwtUtil.sign({ user_id: u.id, role: u.role, full_name: u.full_name });
    res.json({ token, user: { id: u.id, full_name: u.full_name, email: u.email, role: u.role } });
  } catch (e) {
    console.error('[wd] login error:', e.message);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

/* GET /api/auth/me — verify the current token (used by the SPA on load). */
router.get('/me', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    const p = jwtUtil.verify(token);
    res.json({ user: { id: p.user_id, full_name: p.full_name, role: p.role } });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
});

module.exports = router;
