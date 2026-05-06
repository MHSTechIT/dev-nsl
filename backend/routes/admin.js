const express  = require('express');
const { body, validationResult } = require('express-validator');
const crypto   = require('crypto');
const router   = express.Router();
const pool     = require('../db');
const { adminAuth }                = require('../middleware/adminAuth');
const { getPassword, writeConfig } = require('../utils/adminConfig');
const cache = require('../utils/webinarConfigCache');
const { broadcast } = require('../utils/sseClients');
const { syncLeadsToSheet } = require('../utils/leadsSheetSync');
const { rotateLink }       = require('../utils/linkRotation');

router.use(adminAuth);

/* ── GET /api/admin/leads ── */
router.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM leads ORDER BY created_at DESC'
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('Fetch leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

/* ── PUT /api/admin/webinar-config ── */
const configValidators = [
  body('next_webinar_at').optional().isISO8601(),
  body('backup_webinar_at').optional().isISO8601(),
  body('tuesday_whatsapp_link').optional().isString(),
  body('friday_whatsapp_link').optional().isString(),
  body('kill_switch').optional().isBoolean(),
  body('pending_whatsapp_link').optional().isString(),
  body('whatsapp_link_swap_at').optional({ nullable: true }).isISO8601(),
  body('pending_whatsapp_link_2').optional().isString(),
  body('whatsapp_link_swap_at_2').optional({ nullable: true }).isISO8601(),
];

router.put('/webinar-config', configValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: 'validation_failed', fields: errors.array() });
  }

  const allowed = ['next_webinar_at', 'backup_webinar_at', 'tuesday_whatsapp_link', 'friday_whatsapp_link', 'kill_switch', 'pending_whatsapp_link', 'whatsapp_link_swap_at', 'pending_whatsapp_link_2', 'whatsapp_link_swap_at_2'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.updated_at = new Date().toISOString();

  // Build dynamic SET clause: SET col1=$1, col2=$2 ...
  const keys = Object.keys(updates);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => updates[k]);

  try {
    await pool.query(
      `UPDATE webinar_config SET ${setClause} WHERE id = 1`,
      values
    );
    cache.invalidate();

    // Fetch fresh config and push to all connected clients immediately
    const { rows } = await pool.query(
      'SELECT next_webinar_at, backup_webinar_at, tuesday_whatsapp_link, friday_whatsapp_link, kill_switch, pending_whatsapp_link, whatsapp_link_swap_at, pending_whatsapp_link_2, whatsapp_link_swap_at_2 FROM webinar_config WHERE id = 1'
    );
    if (rows.length > 0) {
      const fresh = { ...rows[0] };
      cache.set(fresh);
      broadcast(fresh);
    }

    // Sync webinar sessions — UPDATE existing row, only INSERT if none exists
    if (updates.next_webinar_at) {
      try {
        // Try to update the currently active webinar's date
        const { rowCount } = await pool.query(
          'UPDATE webinars SET date_time = $1 WHERE is_active = TRUE',
          [updates.next_webinar_at]
        );
        // If no active webinar existed, create one
        if (rowCount === 0) {
          await pool.query(
            'INSERT INTO webinars (date_time, is_active) VALUES ($1, TRUE)',
            [updates.next_webinar_at]
          );
        }
      } catch (webinarErr) {
        console.error('Webinar session update error:', webinarErr.message);
      }
    }

    if (updates.backup_webinar_at) {
      try {
        // Find an existing "upcoming" webinar (inactive, 0 leads) to update
        // If none exists, create a new one — never touch old sessions with leads
        const { rowCount } = await pool.query(
          `UPDATE webinars SET date_time = $1
           WHERE id = (
             SELECT w.id FROM webinars w
             LEFT JOIN leads l ON l.webinar_id = w.id
             WHERE w.is_active = FALSE
             GROUP BY w.id
             HAVING COUNT(l.id) = 0
             ORDER BY w.created_at DESC LIMIT 1
           )`,
          [updates.backup_webinar_at]
        );

        if (rowCount === 0) {
          await pool.query(
            'INSERT INTO webinars (date_time, is_active) VALUES ($1, FALSE)',
            [updates.backup_webinar_at]
          );
        }
      } catch (webinarErr) {
        console.error('Upcoming webinar update error:', webinarErr.message);
      }
    }

    res.json({ success: true, updated_at: updates.updated_at });
  } catch (err) {
    console.error('Update config error:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

/* ── GET /api/admin/webinars ── */
router.get('/webinars', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        w.id,
        w.date_time AS webinar_at,
        w.is_active,
        w.created_at,
        COUNT(l.id)::int AS lead_count
      FROM webinars w
      LEFT JOIN leads l ON l.webinar_id = w.id
      GROUP BY w.id
      ORDER BY w.created_at DESC
    `);
    res.json({ webinars: rows });
  } catch (err) {
    // webinar_id column or webinars table may not exist yet (async migration race)
    if (err.message && (err.message.includes('does not exist') || err.message.includes('column'))) {
      try {
        const { rows } = await pool.query(
          `SELECT id, date_time AS webinar_at, is_active, created_at, 0::int AS lead_count
           FROM webinars ORDER BY created_at DESC`
        );
        return res.json({ webinars: rows });
      } catch (_) {
        return res.json({ webinars: [] });
      }
    }
    console.error('Get webinars error:', err.message);
    res.status(500).json({ error: 'Failed to fetch webinars' });
  }
});

/* ── POST /api/admin/leads/delete ── */
router.post('/leads/delete', async (req, res) => {
  // Accept ids from body (JSON) or query string as fallback
  const raw = [].concat(req.body?.ids || req.query.ids || []);
  const ids = raw.map(String).filter(s => s.length > 0);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'No valid lead IDs provided.' });
  }
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `DELETE FROM leads WHERE id IN (${placeholders})`,
      ids
    );
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('Delete leads error:', err.message);
    res.status(500).json({ error: 'Failed to delete leads.' });
  }
});

/* ── POST /api/admin/sync-sheet ── */
router.post('/sync-sheet', async (_req, res) => {
  const result = await syncLeadsToSheet();
  if (result.skipped) {
    return res.status(503).json({ error: 'Google Sheets not configured. Add GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID env vars.' });
  }
  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }
  res.json({ success: true, count: result.count });
});

/* ── PATCH /api/admin/change-password ── */
router.patch('/change-password',
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 6 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ error: 'New password must be at least 6 characters.' });
    }

    const { current_password, new_password } = req.body;
    const expected = getPassword();

    const a = Buffer.alloc(Math.max(current_password.length, expected.length));
    const b = Buffer.alloc(Math.max(current_password.length, expected.length));
    Buffer.from(current_password).copy(a);
    Buffer.from(expected).copy(b);

    if (current_password.length !== expected.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    try {
      writeConfig({ password: new_password });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to save new password.' });
    }
  }
);

/* ── GET /api/admin/wa-links?webinar_id=X ── */
router.get('/wa-links', async (req, res) => {
  const { webinar_id } = req.query;
  if (!webinar_id) return res.status(400).json({ error: 'webinar_id required' });

  try {
    const { rows } = await pool.query(
      'SELECT id, webinar_id, link_url, order_index FROM whatsapp_links WHERE webinar_id = $1 ORDER BY order_index',
      [webinar_id]
    );
    res.json({ links: rows });
  } catch (err) {
    // Table may not exist yet
    if (err.message && err.message.includes('does not exist')) {
      return res.json({ links: [] });
    }
    console.error('Get WA links error:', err.message);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

/* ── PUT /api/admin/wa-links — save all links for a webinar (upsert) ── */
router.put('/wa-links', async (req, res) => {
  const { webinar_id, links } = req.body;
  if (!webinar_id || !Array.isArray(links)) {
    return res.status(400).json({ error: 'webinar_id and links[] required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete existing links for this webinar
    await client.query('DELETE FROM whatsapp_links WHERE webinar_id = $1', [webinar_id]);

    // Insert new links
    for (const link of links) {
      if (!link.link_url) continue;
      await client.query(
        'INSERT INTO whatsapp_links (webinar_id, link_url, order_index) VALUES ($1, $2, $3)',
        [webinar_id, link.link_url.trim(), link.order_index || 1]
      );
    }

    await client.query('COMMIT');

    // If this is the active webinar, rotate the link immediately
    const { rows: wRows } = await pool.query(
      'SELECT is_active FROM webinars WHERE id = $1',
      [webinar_id]
    );
    if (wRows.length > 0 && wRows[0].is_active) {
      await rotateLink(webinar_id);
    }

    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save WA links error:', err.message);
    res.status(500).json({ error: 'Failed to save links' });
  } finally {
    client.release();
  }
});

/* ── GET /api/admin/dashboard ── */
router.get('/dashboard', async (req, res) => {
  const { from, to, webinar_at } = req.query;
  const params = [];
  const conditions = [];

  if (from) {
    params.push(new Date(from + 'T00:00:00+05:30'));
    conditions.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(new Date(to + 'T23:59:59+05:30'));
    conditions.push(`created_at <= $${params.length}`);
  }
  if (webinar_at) {
    params.push(new Date(webinar_at));
    conditions.push(`webinar_at = $${params.length}`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await pool.query(
      `SELECT event_name, COUNT(*)::int AS count
       FROM click_events
       ${where}
       GROUP BY event_name`,
      params
    );

    const { rows: sessions } = await pool.query(
      `SELECT DISTINCT webinar_at
       FROM click_events
       WHERE webinar_at IS NOT NULL
       ORDER BY webinar_at DESC
       LIMIT 50`
    );

    const counts = {};
    for (const row of rows) counts[row.event_name] = row.count;

    res.json({ counts, sessions: sessions.map(r => r.webinar_at) });
  } catch (err) {
    console.error('Dashboard query error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;
