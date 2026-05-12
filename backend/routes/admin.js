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
const { nextWebinarName, nextUpcomingWebinarName } = require('../utils/webinarName');

router.use(adminAuth);

const ALLOWED_SOURCES = new Set(['meta', 'yt']);
function getSource(req) {
  const v = req.query.source ?? req.body?.source;
  return ALLOWED_SOURCES.has(v) ? v : 'meta';
}

/* ── GET /api/admin/leads ── */
router.get('/leads', async (req, res) => {
  const source = getSource(req);
  try {
    const { rows } = await pool.query(`
      SELECT l.*,
             u.full_name AS assigned_to_name,
             u.role      AS assigned_to_role
        FROM leads l
        LEFT JOIN crm_users u ON u.id = l.assigned_user_id
       WHERE l.source = $1
       ORDER BY l.created_at DESC
    `, [source]);
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    // assigned_user_id column may be missing on a stale schema — fallback
    if (err.message && err.message.includes('column')) {
      try {
        const { rows } = await pool.query('SELECT * FROM leads WHERE source = $1 ORDER BY created_at DESC', [source]);
        return res.json({ leads: rows, total: rows.length });
      } catch (_) { /* fallthrough */ }
    }
    console.error('Fetch leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

/* ── PUT /api/admin/webinar-config ── */
const configValidators = [
  body('next_webinar_at').optional().isISO8601(),
  body('backup_webinar_at').optional().isISO8601(),
  body('current_webinar_date').optional({ nullable: true }).isISO8601(),
  body('next_webinar_date').optional({ nullable: true }).isISO8601(),
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

  const source = getSource(req);

  const allowed = ['next_webinar_at', 'backup_webinar_at', 'current_webinar_date', 'next_webinar_date', 'tuesday_whatsapp_link', 'friday_whatsapp_link', 'kill_switch', 'pending_whatsapp_link', 'whatsapp_link_swap_at', 'pending_whatsapp_link_2', 'whatsapp_link_swap_at_2'];
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
    values.push(source);
    await pool.query(
      `UPDATE webinar_config SET ${setClause} WHERE source = $${values.length}`,
      values
    );
    cache.invalidate(source);

    // Fetch fresh config and push to all connected clients (this source) immediately
    const { rows } = await pool.query(
      'SELECT next_webinar_at, backup_webinar_at, tuesday_whatsapp_link, friday_whatsapp_link, kill_switch, pending_whatsapp_link, whatsapp_link_swap_at, pending_whatsapp_link_2, whatsapp_link_swap_at_2, current_webinar_date, next_webinar_date FROM webinar_config WHERE source = $1',
      [source]
    );
    if (rows.length > 0) {
      const fresh = { ...rows[0] };
      cache.set(fresh, source);
      broadcast(fresh, source);
    }

    // Sync webinar sessions for this source — UPDATE existing row, only INSERT if none exists
    let webinarWarning = null;
    if (updates.next_webinar_at) {
      try {
        const { rowCount } = await pool.query(
          'UPDATE webinars SET date_time = $1 WHERE is_active = TRUE AND source = $2',
          [updates.next_webinar_at, source]
        );
        if (rowCount === 0) {
          const name = await nextWebinarName(source);
          await pool.query(
            'INSERT INTO webinars (date_time, is_active, name, source) VALUES ($1, TRUE, $2, $3)',
            [updates.next_webinar_at, name, source]
          );
          console.log(`[admin] Created active ${source} webinar: ${name}`);
        }
      } catch (webinarErr) {
        webinarWarning = `active webinar: ${webinarErr.message}${webinarErr.code ? ` [${webinarErr.code}]` : ''}`;
        console.error(`[admin] ${source} active webinar update error:`, webinarErr.message, webinarErr.code, webinarErr.detail);
      }
    }

    if (updates.backup_webinar_at) {
      try {
        // Reuse an existing "upcoming" webinar for this source (inactive, 0 leads)
        // and just bump its date.
        const { rowCount } = await pool.query(
          `UPDATE webinars SET date_time = $1
           WHERE id = (
             SELECT w.id FROM webinars w
             LEFT JOIN leads l ON l.webinar_id = w.id
             WHERE w.is_active = FALSE AND w.source = $2
             GROUP BY w.id
             HAVING COUNT(l.id) = 0
             ORDER BY w.created_at DESC LIMIT 1
           )`,
          [updates.backup_webinar_at, source]
        );

        if (rowCount === 0) {
          const name = await nextUpcomingWebinarName(source);
          await pool.query(
            'INSERT INTO webinars (date_time, is_active, name, source) VALUES ($1, FALSE, $2, $3)',
            [updates.backup_webinar_at, name, source]
          );
          console.log(`[admin] Created upcoming ${source} webinar: ${name}`);
        }
      } catch (webinarErr) {
        webinarWarning = (webinarWarning ? webinarWarning + '; ' : '') +
          `upcoming webinar: ${webinarErr.message}${webinarErr.code ? ` [${webinarErr.code}]` : ''}`;
        console.error(`[admin] ${source} upcoming webinar update error:`, webinarErr.message, webinarErr.code, webinarErr.detail);
      }
    }

    res.json({ success: true, updated_at: updates.updated_at, webinarWarning });
  } catch (err) {
    console.error('Update config error:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

/* ── GET /api/admin/webinars ── */
router.get('/webinars', async (req, res) => {
  const source = getSource(req);
  try {
    const { rows } = await pool.query(`
      SELECT
        w.id,
        w.date_time AS webinar_at,
        w.is_active,
        w.created_at,
        w.name,
        COUNT(l.id)::int AS lead_count
      FROM webinars w
      LEFT JOIN leads l ON l.webinar_id = w.id
      WHERE w.source = $1
      GROUP BY w.id
      ORDER BY w.created_at DESC
    `, [source]);
    res.json({ webinars: rows });
  } catch (err) {
    // webinar_id column or webinars table may not exist yet (async migration race)
    if (err.message && (err.message.includes('does not exist') || err.message.includes('column'))) {
      try {
        const { rows } = await pool.query(
          `SELECT id, date_time AS webinar_at, is_active, created_at, name, 0::int AS lead_count
           FROM webinars WHERE source = $1 ORDER BY created_at DESC`,
          [source]
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
  const source = getSource(req);
  // Accept ids from body (JSON) or query string as fallback
  const raw = [].concat(req.body?.ids || req.query.ids || []);
  const ids = raw.map(String).filter(s => s.length > 0);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'No valid lead IDs provided.' });
  }
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `DELETE FROM leads WHERE id IN (${placeholders}) AND source = $${ids.length + 1}`,
      [...ids, source]
    );
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('Delete leads error:', err.message);
    res.status(500).json({ error: 'Failed to delete leads.' });
  }
});

/* ── GET /api/admin/settings?source=meta ──
   Returns the per-source admin settings stored on webinar_config (just the
   alert phone number for now). */
router.get('/settings', async (req, res) => {
  const source = getSource(req);
  try {
    const { rows } = await pool.query(
      'SELECT alert_phone_number FROM webinar_config WHERE source = $1',
      [source]
    );
    res.json({
      source,
      alert_phone_number: rows[0]?.alert_phone_number || '',
    });
  } catch (err) {
    console.error('Get settings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

/* ── PUT /api/admin/settings ──
   Body: { source, alert_phone_number }
   Saves the WATI alert recipient phone for the given source. */
router.put('/settings', async (req, res) => {
  const source = getSource(req);
  let { alert_phone_number } = req.body || {};
  if (typeof alert_phone_number !== 'string') {
    return res.status(422).json({ error: 'alert_phone_number must be a string' });
  }
  // Strip everything except digits; allow blank to clear.
  alert_phone_number = alert_phone_number.replace(/\D/g, '');
  if (alert_phone_number && !/^\d{10,15}$/.test(alert_phone_number)) {
    return res.status(422).json({ error: 'alert_phone_number must be 10–15 digits' });
  }
  try {
    await pool.query(
      'UPDATE webinar_config SET alert_phone_number = $1, updated_at = NOW() WHERE source = $2',
      [alert_phone_number || null, source]
    );
    res.json({ success: true, alert_phone_number });
  } catch (err) {
    console.error('Update settings error:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

/* ── POST /api/admin/settings/test-alert ──
   Triggers an immediate dry-run of the alert scheduler so admin can verify
   the WATI key + phone are wired up. Body: { source } */
router.post('/settings/test-alert', async (req, res) => {
  const source = getSource(req);
  try {
    const { runOnce } = require('../utils/leadsAlertScheduler');
    const result = await runOnce();
    res.json({ ok: true, result: result.find(r => r.source === source) || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/admin/settings/send-test-template ──
   Bypasses all scheduler conditions and fires ONE WATI template to the
   saved phone right now. Used to verify the WATI integration end-to-end.
   Body: { source, template_name? }. Default template = 'leads_alert'.
   Returns the full WATI response so the admin can see whether WATI
   accepted or rejected the call. */
router.post('/settings/send-test-template', async (req, res) => {
  const source = getSource(req);
  const templateName = (req.body?.template_name || 'leads_alert').trim();
  try {
    const { rows } = await pool.query(
      'SELECT alert_phone_number FROM webinar_config WHERE source = $1',
      [source]
    );
    const phone = rows[0]?.alert_phone_number;
    if (!phone) {
      return res.status(422).json({ error: 'No phone saved for this source. Save a number first.' });
    }
    const wati = require('../utils/watiClient');
    if (!wati.isConfigured()) {
      return res.status(503).json({ error: 'WATI_API_KEY is not set in backend env vars.' });
    }
    const result = await wati.sendTemplate({ phone, templateName });
    res.json({
      ok:        result.ok,
      phone,
      template:  templateName,
      status:    result.status,
      urlUsed:   result.urlUsed,
      body:      result.body,
      error:     result.error,
      attempts:  result.attempts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  const source = getSource(req);
  if (!webinar_id) return res.status(400).json({ error: 'webinar_id required' });

  try {
    // Inner join on webinars enforces the webinar belongs to this source.
    const { rows } = await pool.query(
      `SELECT wl.id, wl.webinar_id, wl.link_url, wl.order_index
         FROM whatsapp_links wl
         JOIN webinars w ON w.id = wl.webinar_id
        WHERE wl.webinar_id = $1 AND w.source = $2
        ORDER BY wl.order_index`,
      [webinar_id, source]
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
  const source = getSource(req);
  if (!webinar_id || !Array.isArray(links)) {
    return res.status(400).json({ error: 'webinar_id and links[] required' });
  }

  const client = await pool.connect();
  try {
    // Verify the webinar belongs to this source before touching anything.
    const { rows: wOwn } = await client.query(
      'SELECT is_active FROM webinars WHERE id = $1 AND source = $2',
      [webinar_id, source]
    );
    if (wOwn.length === 0) {
      return res.status(404).json({ error: 'Webinar not found for this source.' });
    }

    await client.query('BEGIN');

    // Delete existing links for this webinar
    await client.query('DELETE FROM whatsapp_links WHERE webinar_id = $1', [webinar_id]);

    // Insert new links
    for (const link of links) {
      if (!link.link_url) continue;
      await client.query(
        'INSERT INTO whatsapp_links (webinar_id, link_url, order_index, source) VALUES ($1, $2, $3, $4)',
        [webinar_id, link.link_url.trim(), link.order_index || 1, source]
      );
    }

    await client.query('COMMIT');

    // If this is the active webinar, rotate the link immediately
    if (wOwn[0].is_active) {
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

/* ── GET /api/admin/dashboard ──
   Filters and groups by webinar.id (UUID) instead of webinar_at, so admin
   edits to a webinar's deadline don't fragment its event history.
   Accepts `webinar_id` (preferred) or legacy `webinar_at` as the filter. */
router.get('/dashboard', async (req, res) => {
  const { from, to, webinar_id, webinar_at } = req.query;
  const source = getSource(req);
  const params = [source];
  const conditions = [`ce.source = $1`];

  if (from) {
    params.push(new Date(from + 'T00:00:00+05:30'));
    conditions.push(`ce.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(new Date(to + 'T23:59:59+05:30'));
    conditions.push(`ce.created_at <= $${params.length}`);
  }
  if (webinar_id) {
    params.push(webinar_id);
    conditions.push(`ce.webinar_id = $${params.length}`);
  } else if (webinar_at) {
    // Legacy fallback — match by deadline if no id provided
    params.push(new Date(webinar_at));
    conditions.push(`ce.webinar_at = $${params.length}`);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  try {
    const { rows } = await pool.query(
      `SELECT ce.event_name, COUNT(*)::int AS count
         FROM click_events ce
         ${where}
        GROUP BY ce.event_name`,
      params
    );

    // Sessions list = every webinar (this source) that has at least one
    // click_event tied to it.
    //
    // Per-webinar metrics:
    //   • visitors      = raw page_visited events (page-loads, not unique)
    //   • registrations = COUNT(leads where webinar_id = w.id) — reliable
    //                     because each lead row corresponds to one real
    //                     human form-submit. Avoids the click_events
    //                     "current-active webinar" attribution drift.
    //   • wa_clicks     = COUNT(leads where wa_clicked = TRUE) — also lead-
    //                     based, so it's always ≤ registrations.
    const { rows: sessions } = await pool.query(
      `SELECT w.id           AS webinar_id,
              w.date_time    AS webinar_at,
              w.name,
              w.is_active,
              COALESCE(ce_agg.visitors, 0)::int      AS visitors,
              COALESCE(lead_agg.regs, 0)::int        AS registrations,
              COALESCE(lead_agg.wa_uniq, 0)::int     AS wa_clicks
         FROM webinars w
         LEFT JOIN (
           SELECT webinar_id,
                  SUM(CASE WHEN event_name = 'page_visited' THEN 1 ELSE 0 END) AS visitors
             FROM click_events
            WHERE webinar_id IS NOT NULL
            GROUP BY webinar_id
         ) ce_agg ON ce_agg.webinar_id = w.id
         LEFT JOIN (
           SELECT webinar_id,
                  COUNT(*)                                     AS regs,
                  SUM(CASE WHEN wa_clicked THEN 1 ELSE 0 END)  AS wa_uniq
             FROM leads
            WHERE webinar_id IS NOT NULL
            GROUP BY webinar_id
         ) lead_agg ON lead_agg.webinar_id = w.id
        WHERE w.source = $1
          AND EXISTS (SELECT 1 FROM click_events ce2 WHERE ce2.webinar_id = w.id)
        ORDER BY w.date_time DESC
        LIMIT 50`,
      [source]
    );

    const counts = {};
    for (const row of rows) counts[row.event_name] = row.count;

    // Lead-based unique count of WhatsApp clickers — matches the per-webinar
    // wa_clicks field so the Reg → WA drop-off box uses consistent math
    // instead of inflated event counts. Scoped to the same filter window as
    // event counts above (by leads.created_at).
    const leadFilterClauses = ['l.source = $1'];
    const leadFilterParams  = [source];
    if (from) {
      leadFilterParams.push(new Date(from + 'T00:00:00+05:30'));
      leadFilterClauses.push(`l.created_at >= $${leadFilterParams.length}`);
    }
    if (to) {
      leadFilterParams.push(new Date(to + 'T23:59:59+05:30'));
      leadFilterClauses.push(`l.created_at <= $${leadFilterParams.length}`);
    }
    if (webinar_id) {
      leadFilterParams.push(webinar_id);
      leadFilterClauses.push(`l.webinar_id = $${leadFilterParams.length}`);
    }
    try {
      const { rows: leadCounts } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE l.wa_clicked = TRUE)::int AS wa_unique_leads,
                COUNT(*)::int                                    AS lead_registrations
           FROM leads l
          WHERE ${leadFilterClauses.join(' AND ')}`,
        leadFilterParams
      );
      counts.wa_unique_leads    = leadCounts[0]?.wa_unique_leads    ?? 0;
      counts.lead_registrations = leadCounts[0]?.lead_registrations ?? 0;
    } catch (_) {
      counts.wa_unique_leads    = 0;
      counts.lead_registrations = 0;
    }

    res.json({
      counts,
      sessions: sessions.map(r => ({
        webinar_id:    r.webinar_id,
        webinar_at:    r.webinar_at,
        name:          r.name,
        is_active:     r.is_active,
        visitors:      r.visitors,
        registrations: r.registrations,
        wa_clicks:     r.wa_clicks,
      })),
    });
  } catch (err) {
    console.error('Dashboard query error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

/* ── GET /api/admin/crm-users ── */
router.get('/crm-users', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, is_active,
              tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
              tata_smartflo_api_key,
              created_at
         FROM crm_users
        ORDER BY created_at DESC`
    );
    res.json({ users: rows, total: rows.length });
  } catch (err) {
    console.error('Get crm_users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/* ── POST /api/admin/crm-users ── */
const ALLOWED_ROLES = ['junior_caller','senior_caller','manager','trainer','admin','team_leader'];

const crmUserValidators = [
  body('full_name').trim().notEmpty().withMessage('Full name is required.').isLength({ max: 120 }),
  body('email').trim().isEmail().withMessage('Valid email required.').isLength({ max: 200 }),
  body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 30 }),
  body('role').isIn(ALLOWED_ROLES).withMessage('Role must be one of the 6 allowed values.'),
  body('password').isLength({ min: 6, max: 128 }).withMessage('Password must be 6–128 characters.'),
  body('tata_extension').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_account_type').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_agent_number').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_caller_id').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_smartflo_api_key').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 1000 }),
];

function hashPassword(plain) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(plain, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
    });
  });
}

router.post('/crm-users', crmUserValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg, fields: errors.array() });
  }

  const {
    full_name, email, phone, role, password,
    tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
    tata_smartflo_api_key,
  } = req.body;
  try {
    const password_hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO crm_users
         (full_name, email, phone, role, password_hash,
          tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
          tata_smartflo_api_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, full_name, email, phone, role, is_active,
                 tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
                 tata_smartflo_api_key,
                 created_at`,
      [
        full_name.trim(),
        email.trim().toLowerCase(),
        phone?.trim() || null,
        role,
        password_hash,
        tata_extension?.trim() || null,
        tata_account_type?.trim() || null,
        tata_agent_number?.trim() || null,
        tata_caller_id?.trim() || null,
        tata_smartflo_api_key?.trim() || null,
      ]
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }
    console.error('Create crm_user error:', err.message);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

/* ── PATCH /api/admin/crm-users/:id ── */
const crmUserPatchValidators = [
  body('full_name').optional().trim().notEmpty().withMessage('Full name cannot be empty.').isLength({ max: 120 }),
  body('email').optional().trim().isEmail().withMessage('Valid email required.').isLength({ max: 200 }),
  body('phone').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('role').optional().isIn(ALLOWED_ROLES).withMessage('Role must be one of the 6 allowed values.'),
  body('password').optional({ checkFalsy: true }).isLength({ min: 6, max: 128 }).withMessage('Password must be 6–128 characters.'),
  body('tata_extension').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_account_type').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_agent_number').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_caller_id').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_smartflo_api_key').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 1000 }),
];

router.patch('/crm-users/:id', crmUserPatchValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg, fields: errors.array() });
  }

  const { id } = req.params;
  const allowed = [
    'full_name', 'email', 'phone', 'role',
    'tata_extension', 'tata_account_type', 'tata_agent_number', 'tata_caller_id',
    'tata_smartflo_api_key',
  ];
  const tataKeys = new Set(['tata_extension', 'tata_account_type', 'tata_agent_number', 'tata_caller_id', 'tata_smartflo_api_key']);
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const raw = req.body[key];
      if (key === 'email') {
        updates[key] = String(raw).trim().toLowerCase();
      } else if (tataKeys.has(key)) {
        updates[key] = raw === null || raw === '' ? null : String(raw).trim() || null;
      } else if (typeof raw === 'string') {
        updates[key] = raw.trim();
      } else {
        updates[key] = raw;
      }
    }
  }

  // Optional password update — hash before storing
  if (req.body.password) {
    try {
      updates.password_hash = await hashPassword(req.body.password);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to hash password.' });
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update.' });
  }

  const keys = Object.keys(updates);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => updates[k]);
  values.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE crm_users SET ${setClause}
       WHERE id = $${values.length}
       RETURNING id, full_name, email, phone, role, is_active,
                 tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
                 tata_smartflo_api_key,
                 created_at`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }
    console.error('Update crm_user error:', err.message);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

/* ── GET /api/admin/lead-share-config?webinar_id=<uuid> ── */
router.get('/lead-share-config', async (req, res) => {
  const { webinar_id } = req.query;
  if (!webinar_id) return res.status(400).json({ error: 'webinar_id required' });

  try {
    // All callers eligible to be in the rotation (junior + senior caller roles)
    const callersQuery = pool.query(
      `SELECT id, full_name, email, role, is_active
         FROM crm_users
        WHERE role IN ('junior_caller','senior_caller')
        ORDER BY created_at ASC`
    );
    // Existing config rows for this webinar
    const configQuery = pool.query(
      `SELECT caller_id, enabled, allowed_lead_types, position
         FROM lead_share_config
        WHERE webinar_id = $1`,
      [webinar_id]
    );
    const [callersRes, configRes] = await Promise.all([callersQuery, configQuery]);

    const configByCaller = {};
    for (const row of configRes.rows) configByCaller[row.caller_id] = row;

    const config = callersRes.rows.map((c, idx) => {
      const saved = configByCaller[c.id];
      return {
        caller_id: c.id,
        full_name: c.full_name,
        email:     c.email,
        role:      c.role,
        is_active: c.is_active,
        // Defaults: enabled=true, allowed=['all'], stable position
        enabled:            saved ? saved.enabled            : true,
        allowed_lead_types: saved ? saved.allowed_lead_types : ['all'],
        position:           saved ? saved.position           : idx,
        has_saved_config:   !!saved,
      };
    });
    res.json({ callers: config });
  } catch (err) {
    if (err.message && err.message.includes('does not exist')) {
      // Tables not migrated yet — return empty
      return res.json({ callers: [] });
    }
    console.error('Get lead-share-config error:', err.message);
    res.status(500).json({ error: 'Failed to load configuration' });
  }
});

/* ── PUT /api/admin/lead-share-config ── */
const ALLOWED_LEAD_TYPES = ['250+', '150-250', 'all'];

router.put('/lead-share-config', async (req, res) => {
  const { webinar_id, callers } = req.body;
  if (!webinar_id || !Array.isArray(callers)) {
    return res.status(400).json({ error: 'webinar_id and callers[] required' });
  }
  // Validate every row
  for (const c of callers) {
    if (!c.caller_id) return res.status(422).json({ error: 'caller_id required on every row' });
    if (typeof c.enabled !== 'boolean') return res.status(422).json({ error: 'enabled must be boolean' });
    if (!Array.isArray(c.allowed_lead_types) || c.allowed_lead_types.length === 0) {
      return res.status(422).json({ error: 'allowed_lead_types must be a non-empty array' });
    }
    for (const t of c.allowed_lead_types) {
      if (!ALLOWED_LEAD_TYPES.includes(t)) {
        return res.status(422).json({ error: `Invalid lead type: ${t}` });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Wipe + reinsert is the simplest correctness model
    await client.query('DELETE FROM lead_share_config WHERE webinar_id = $1', [webinar_id]);

    for (let i = 0; i < callers.length; i++) {
      const c = callers[i];
      await client.query(
        `INSERT INTO lead_share_config
           (webinar_id, caller_id, enabled, allowed_lead_types, position, updated_at)
         VALUES ($1, $2, $3, $4::TEXT[], $5, NOW())`,
        [webinar_id, c.caller_id, c.enabled, c.allowed_lead_types, typeof c.position === 'number' ? c.position : i]
      );
    }

    // Reset round-robin cursor — eligible list may have changed
    await client.query(
      `INSERT INTO round_robin_state (webinar_id, last_position)
       VALUES ($1, -1)
       ON CONFLICT (webinar_id) DO UPDATE SET last_position = -1, updated_at = NOW()`,
      [webinar_id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save lead-share-config error:', err.message);
    res.status(500).json({ error: 'Failed to save configuration' });
  } finally {
    client.release();
  }
});

/* ── DELETE /api/admin/crm-users/:id ── */
router.delete('/crm-users/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const result = await pool.query('DELETE FROM crm_users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete crm_user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

/* ── GET /api/admin/caller-workload?date=YYYY-MM-DD ──
   Per-caller load snapshot. The date filters follow-ups + completions to that
   IST day; "open" leads (pending or due-now follow-ups) are date-independent.
   Used to spot overloaded callers and reassign when someone is absent. */
router.get('/caller-workload', async (req, res) => {
  const date = (req.query.date || '').toString().slice(0, 10);
  // Bound the IST day window: 00:00 IST = previous day 18:30 UTC.
  // If no date passed, default to "today" in IST.
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const ymd = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : istNow.toISOString().slice(0, 10);
  const dayStart = new Date(`${ymd}T00:00:00+05:30`).toISOString();
  const dayEnd   = new Date(`${ymd}T23:59:59.999+05:30`).toISOString();

  try {
    const { rows } = await pool.query(
      `SELECT
         u.id, u.full_name, u.role, u.is_active,
         COUNT(l.id) FILTER (
           WHERE l.last_note_outcome IS NULL
              OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW())
         )::int AS pending_count,
         COUNT(l.id) FILTER (
           WHERE l.last_note_outcome = 'follow_up'
             AND l.follow_up_at >= $1 AND l.follow_up_at <= $2
         )::int AS followups_for_date,
         COUNT(l.id) FILTER (
           WHERE l.last_note_outcome IN ('completed','not_interested')
             AND l.last_note_at >= $1 AND l.last_note_at <= $2
         )::int AS completed_for_date,
         COUNT(l.id) FILTER (
           WHERE l.last_note_outcome IS NULL
              OR l.last_note_outcome = 'follow_up'
         )::int AS total_open
       FROM crm_users u
       LEFT JOIN leads l ON l.assigned_user_id = u.id
       WHERE u.role IN ('junior_caller','senior_caller')
       GROUP BY u.id
       ORDER BY u.is_active DESC, u.full_name ASC`,
      [dayStart, dayEnd]
    );
    res.json({ date: ymd, callers: rows });
  } catch (err) {
    console.error('caller-workload error:', err.message);
    res.status(500).json({ error: 'Failed to load workload.' });
  }
});

/* ── GET /api/admin/sales-performance?from=YYYY-MM-DD&to=YYYY-MM-DD&salesperson_id=<uuid> ──
   Per-salesperson dashboard aggregating lead counts (assigned/hot/warm/
   touched/untouched/enrolled) and call activity (total/incoming/outgoing/
   connected/duration). Trend data (`*_prev`) comes from a same-span window
   shifted back so the frontend can show ▲/▼ arrows.

   Defaults: from = to = today (IST). */
router.get('/sales-performance', async (req, res) => {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const fromYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayYmd;
  const toYmd   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : fromYmd;
  const salespersonId = req.query.salesperson_id || null;

  // Current window
  const dayStart = new Date(`${fromYmd}T00:00:00+05:30`).toISOString();
  const dayEnd   = new Date(`${toYmd}T23:59:59.999+05:30`).toISOString();

  // Previous window of the same span (inclusive day count)
  const spanDays = Math.max(1, Math.round(
    (new Date(`${toYmd}T00:00:00+05:30`) - new Date(`${fromYmd}T00:00:00+05:30`)) / 86_400_000
  ) + 1);
  const prevToDate = new Date(`${fromYmd}T00:00:00+05:30`);
  prevToDate.setDate(prevToDate.getDate() - 1);
  const prevFromDate = new Date(prevToDate);
  prevFromDate.setDate(prevFromDate.getDate() - (spanDays - 1));
  const prevStart = new Date(prevFromDate.setHours(0, 0, 0, 0)).toISOString();
  const prevEnd   = new Date(prevToDate.setHours(23, 59, 59, 999)).toISOString();

  const params = [dayStart, dayEnd, prevStart, prevEnd];
  let salespersonFilter = '';
  if (salespersonId) {
    params.push(salespersonId);
    salespersonFilter = `WHERE cb.caller_id = $${params.length}`;
  }

  try {
    // Predicted-enrollments coefficient: enrolled-hot / total-hot over last 30 days, globally.
    const ratioRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN last_note_outcome = 'completed' AND lead_score >= 4 THEN 1 ELSE 0 END), 0)::float
        / NULLIF(SUM(CASE WHEN lead_score >= 4 THEN 1 ELSE 0 END), 0) AS ratio
      FROM leads
      WHERE assigned_at >= NOW() - INTERVAL '30 days'
    `);
    const hotToEnrollRatio = ratioRes.rows[0]?.ratio ?? 0;

    const { rows } = await pool.query(`
      WITH w AS (
        SELECT $1::timestamptz AS d_start, $2::timestamptz AS d_end,
               $3::timestamptz AS p_start, $4::timestamptz AS p_end
      ),
      caller_base AS (
        SELECT u.id AS caller_id, u.full_name AS name, u.role
          FROM crm_users u
         WHERE u.is_active = TRUE
           AND u.role IN ('junior_caller','senior_caller','team_leader','manager')
      ),
      lead_agg AS (
        SELECT l.assigned_user_id AS caller_id,
               COUNT(*) FILTER (WHERE l.assigned_at >= w.d_start AND l.assigned_at <= w.d_end)::int AS assigned,
               COUNT(*) FILTER (WHERE l.lead_score >= 4 AND l.assigned_at >= w.d_start AND l.assigned_at <= w.d_end)::int AS hot,
               COUNT(*) FILTER (WHERE l.lead_score IN (2,3) AND l.assigned_at >= w.d_start AND l.assigned_at <= w.d_end)::int AS warm,
               COUNT(*) FILTER (WHERE l.last_note_at IS NOT NULL AND l.last_note_at >= w.d_start AND l.last_note_at <= w.d_end AND l.assigned_at >= w.d_start AND l.assigned_at <= w.d_end)::int AS touched,
               COUNT(*) FILTER (WHERE l.last_note_at IS NULL AND l.assigned_at < NOW() - INTERVAL '24 hours')::int AS untouched_aged,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed' AND l.completed_at >= w.d_start AND l.completed_at <= w.d_end)::int AS enrolled
          FROM leads l CROSS JOIN w
         WHERE l.assigned_user_id IS NOT NULL
         GROUP BY l.assigned_user_id
      ),
      lead_prev AS (
        SELECT l.assigned_user_id AS caller_id,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed' AND l.completed_at >= w.p_start AND l.completed_at <= w.p_end)::int AS enrolled_prev,
               COUNT(*) FILTER (WHERE l.assigned_at >= w.p_start AND l.assigned_at <= w.p_end)::int AS assigned_prev
          FROM leads l CROSS JOIN w
         WHERE l.assigned_user_id IS NOT NULL
         GROUP BY l.assigned_user_id
      ),
      call_agg AS (
        SELECT c.caller_id,
               COUNT(*)::int AS total_calls,
               COUNT(*) FILTER (WHERE c.direction = 'inbound')::int  AS incoming,
               COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS outgoing,
               COUNT(*) FILTER (WHERE c.duration_sec > 0)::int       AS connected,
               COALESCE(SUM(c.duration_sec), 0)::int                 AS total_duration_sec,
               MAX(c.started_at)                                     AS last_call_at
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
         GROUP BY c.caller_id
      ),
      call_prev AS (
        SELECT c.caller_id,
               COUNT(*)::int AS total_calls_prev
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.p_start AND c.started_at <= w.p_end
         GROUP BY c.caller_id
      )
      SELECT cb.caller_id, cb.name, cb.role,
             COALESCE(la.assigned, 0)            AS assigned,
             COALESCE(la.hot, 0)                 AS hot,
             COALESCE(la.warm, 0)                AS warm,
             COALESCE(la.touched, 0)             AS touched,
             GREATEST(COALESCE(la.assigned, 0) - COALESCE(la.touched, 0), 0) AS untouched,
             COALESCE(la.untouched_aged, 0)      AS untouched_aged,
             COALESCE(ca.total_calls, 0)         AS total_calls,
             COALESCE(ca.incoming, 0)            AS incoming,
             COALESCE(ca.outgoing, 0)            AS outgoing,
             COALESCE(ca.connected, 0)           AS connected,
             COALESCE(ca.total_duration_sec, 0)  AS total_duration_sec,
             ca.last_call_at                     AS last_call_at,
             COALESCE(la.enrolled, 0)            AS enrolled,
             COALESCE(lp.enrolled_prev, 0)       AS enrolled_prev,
             COALESCE(cp.total_calls_prev, 0)    AS total_calls_prev
        FROM caller_base cb
        LEFT JOIN lead_agg  la ON la.caller_id = cb.caller_id
        LEFT JOIN lead_prev lp ON lp.caller_id = cb.caller_id
        LEFT JOIN call_agg  ca ON ca.caller_id = cb.caller_id
        LEFT JOIN call_prev cp ON cp.caller_id = cb.caller_id
        ${salespersonFilter}
       ORDER BY enrolled DESC, name ASC
    `, params);

    // Compute derived percentages + team totals in JS to keep the SQL simple.
    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

    const enrichedRows = rows.map(r => ({
      ...r,
      conversion_pct:      pct(r.enrolled, r.assigned),
      connection_rate_pct: pct(r.connected, r.total_calls),
      avg_duration_sec:    r.connected > 0 ? Math.round(r.total_duration_sec / r.connected) : 0,
      conversion_pct_prev: pct(r.enrolled_prev, r.assigned_prev || 0),
    }));

    const sum = (k) => enrichedRows.reduce((s, r) => s + (r[k] || 0), 0);
    const teamAssigned   = sum('assigned');
    const teamConnected  = sum('connected');
    const teamCalls      = sum('total_calls');
    const teamDuration   = sum('total_duration_sec');
    const teamEnrolled   = sum('enrolled');

    const team_totals = {
      assigned:            teamAssigned,
      hot:                 sum('hot'),
      warm:                sum('warm'),
      touched:             sum('touched'),
      untouched:           sum('untouched'),
      untouched_aged:      sum('untouched_aged'),
      total_calls:         teamCalls,
      incoming:            sum('incoming'),
      outgoing:            sum('outgoing'),
      connected:           teamConnected,
      total_duration_sec:  teamDuration,
      enrolled:            teamEnrolled,
      conversion_pct:      pct(teamEnrolled, teamAssigned),
      connection_rate_pct: pct(teamConnected, teamCalls),
      avg_duration_sec:    teamConnected > 0 ? Math.round(teamDuration / teamConnected) : 0,
    };

    res.json({
      rows: enrichedRows,
      team_totals,
      hot_to_enroll_ratio: hotToEnrollRatio,
      window: { from: fromYmd, to: toYmd, prev_from: prevStart.slice(0, 10), prev_to: prevEnd.slice(0, 10) },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('sales-performance error:', err.message);
    res.status(500).json({ error: 'Failed to load sales performance.' });
  }
});

/* ── GET /api/admin/calls?caller_id=<uuid>&limit=50 ──
   Drill-down feed: recent calls for one salesperson with the linked lead's
   name + phone for context. */
router.get('/calls', async (req, res) => {
  const callerId = req.query.caller_id;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  if (!callerId) return res.status(400).json({ error: 'caller_id required' });

  try {
    const { rows } = await pool.query(`
      SELECT c.id,
             c.started_at,
             c.direction,
             c.status,
             c.duration_sec,
             l.full_name      AS lead_name,
             l.whatsapp_number AS lead_phone
        FROM calls c
        LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.caller_id = $1
       ORDER BY c.started_at DESC
       LIMIT $2
    `, [callerId, limit]);
    res.json({ calls: rows });
  } catch (err) {
    console.error('admin/calls error:', err.message);
    res.status(500).json({ error: 'Failed to load calls.' });
  }
});

/* ── POST /api/admin/leads/reassign ──
   Spread one caller's open leads across N teammates with custom counts.
   Body: {
     from_caller_id,
     scope: 'all_open' | 'followups_for_date',
     date?: 'YYYY-MM-DD'         (required when scope = followups_for_date),
     distribution: [{ to_caller_id, count }, …]   custom counts per teammate
   }
   Backward-compat: legacy { to_caller_id } is treated as a single-row
   distribution that takes the full source count.
   Returns { moved, distribution: [{to_caller_id, count}, …] }. */
router.post('/leads/reassign', async (req, res) => {
  const { from_caller_id, scope, date } = req.body || {};
  let { distribution } = req.body || {};

  if (!from_caller_id) return res.status(400).json({ error: 'from_caller_id required' });

  // Backward-compat: legacy single-destination shape
  if (!distribution && req.body?.to_caller_id) {
    distribution = [{ to_caller_id: req.body.to_caller_id, count: null }]; // null → "take all"
  }

  if (!Array.isArray(distribution) || distribution.length === 0) {
    return res.status(400).json({ error: 'distribution must be a non-empty array' });
  }

  const allowedScopes = ['all_open', 'followups_for_date'];
  const scp = allowedScopes.includes(scope) ? scope : 'all_open';

  // Validate distribution shape
  const seen = new Set();
  for (const row of distribution) {
    if (!row || typeof row !== 'object') {
      return res.status(400).json({ error: 'distribution rows must be objects' });
    }
    if (!row.to_caller_id) {
      return res.status(400).json({ error: 'each distribution row needs to_caller_id' });
    }
    if (row.to_caller_id === from_caller_id) {
      return res.status(400).json({ error: 'destination cannot equal source' });
    }
    if (seen.has(row.to_caller_id)) {
      return res.status(400).json({ error: 'destination callers must be distinct' });
    }
    seen.add(row.to_caller_id);
    // count must be ≥ 1 unless null (legacy compat path)
    if (row.count !== null && (!Number.isInteger(row.count) || row.count < 1)) {
      return res.status(400).json({ error: 'each count must be an integer ≥ 1' });
    }
  }

  let dayStart = null, dayEnd = null;
  if (scp === 'followups_for_date') {
    const ymd = (date || '').toString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      return res.status(400).json({ error: 'date (YYYY-MM-DD) required for followups_for_date scope' });
    }
    dayStart = new Date(`${ymd}T00:00:00+05:30`).toISOString();
    dayEnd   = new Date(`${ymd}T23:59:59.999+05:30`).toISOString();
  }

  const client = await pool.connect();
  try {
    // Verify all destinations exist + are active junior/senior callers
    const destIds = distribution.map(d => d.to_caller_id);
    const { rows: tgt } = await client.query(
      `SELECT id FROM crm_users
         WHERE id = ANY($1::uuid[])
           AND is_active = TRUE
           AND role IN ('junior_caller','senior_caller')`,
      [destIds]
    );
    if (tgt.length !== destIds.length) {
      return res.status(404).json({ error: 'One or more destination callers not found or not active.' });
    }

    await client.query('BEGIN');

    // Lock the leads we're about to move so a concurrent reassignment / auto-assign
    // can't shift them out from under us.
    let leadRows;
    if (scp === 'followups_for_date') {
      ({ rows: leadRows } = await client.query(
        `SELECT id FROM leads
            WHERE assigned_user_id = $1
              AND last_note_outcome = 'follow_up'
              AND follow_up_at >= $2 AND follow_up_at <= $3
            ORDER BY assigned_at ASC NULLS LAST, id ASC
            FOR UPDATE`,
        [from_caller_id, dayStart, dayEnd]
      ));
    } else {
      ({ rows: leadRows } = await client.query(
        `SELECT id FROM leads
            WHERE assigned_user_id = $1
              AND (last_note_outcome IS NULL OR last_note_outcome = 'follow_up')
            ORDER BY assigned_at ASC NULLS LAST, id ASC
            FOR UPDATE`,
        [from_caller_id]
      ));
    }
    const totalAvailable = leadRows.length;

    // Resolve legacy "take all" entries: a single null-count row absorbs the full pile.
    const hasLegacy = distribution.some(d => d.count === null);
    if (hasLegacy) {
      if (distribution.length !== 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'legacy single-destination cannot mix with explicit counts' });
      }
      distribution[0].count = totalAvailable;
    }

    const requested = distribution.reduce((s, d) => s + d.count, 0);
    if (requested > totalAvailable) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Lead count changed: source has ${totalAvailable} lead${totalAvailable === 1 ? '' : 's'} but you allocated ${requested}. Please reload and retry.`,
        available: totalAvailable,
        allocated: requested,
      });
    }
    // requested < totalAvailable is allowed — leftover leads stay with the source caller.

    // Walk the queue and hand out chunks in the order admin specified.
    let cursor = 0;
    for (const slot of distribution) {
      if (slot.count === 0) continue;
      const ids = leadRows.slice(cursor, cursor + slot.count).map(r => r.id);
      cursor += slot.count;
      if (ids.length === 0) continue;
      await client.query(
        `UPDATE leads
            SET assigned_user_id = $1, assigned_at = NOW()
          WHERE id = ANY($2::uuid[])`,
        [slot.to_caller_id, ids]
      );
    }

    await client.query('COMMIT');
    res.json({
      moved: requested,
      remaining: totalAvailable - requested,
      distribution: distribution.map(d => ({ to_caller_id: d.to_caller_id, count: d.count })),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('leads/reassign error:', err.message);
    res.status(500).json({ error: 'Failed to reassign leads.' });
  } finally {
    client.release();
  }
});

module.exports = router;
