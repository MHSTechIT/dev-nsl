const express  = require('express');
const { body, validationResult } = require('express-validator');
const crypto   = require('crypto');
const router   = express.Router();
const pool     = require('../db');
const { adminAuth }                = require('../middleware/adminAuth');
const { getPassword, writeConfig } = require('../utils/adminConfig');
const cache = require('../utils/webinarConfigCache');
const { broadcast } = require('../utils/sseClients');
const callerSse = require('../utils/callerSse');
const activityLogger = require('../utils/activityLogger');
const { syncLeadsToSheet } = require('../utils/leadsSheetSync');
const { rotateLink }       = require('../utils/linkRotation');
const { nextWebinarName, nextUpcomingWebinarName } = require('../utils/webinarName');
const {
  fetchLandingViewsByDay,
  fetchLandingViewsByDayFiltered,
  attributeViewsToWebinars,
  metaConfigured,
  fetchAllCampaigns,
  clearMetaCache,
} = require('../utils/metaInsights');

router.use(adminAuth);

const ALLOWED_SOURCES = new Set(['meta', 'yt']);
function getSource(req) {
  const v = req.query.source ?? req.body?.source;
  return ALLOWED_SOURCES.has(v) ? v : 'meta';
}

/* Top-2 recent webinars per source — the same window the caller-side
   Assigned / Untouched pages use to bucket leads. Inlined as a SQL
   sub-query so the sales-performance CTEs can reference it without a
   cross-file import. Mirrors routes/caller.js RECENT_WEBINARS. */
const RECENT_WEBINARS_SQL = `(
  SELECT ranked.id FROM (
    SELECT w.id,
           ROW_NUMBER() OVER (
             PARTITION BY w.source
             ORDER BY w.date_time DESC NULLS LAST, w.id DESC
           ) AS rn
      FROM webinars w
      JOIN (
        SELECT source,
               COALESCE(MAX(date_time) FILTER (WHERE is_active), MAX(date_time)) AS cap
          FROM webinars
         GROUP BY source
      ) caps ON caps.source = w.source
     WHERE w.date_time <= caps.cap
  ) ranked
  WHERE ranked.rn <= 2
)`;

/* ── GET /api/admin/leads ── */
router.get('/leads', async (req, res) => {
  const source = getSource(req);
  // TL scope: only leads currently assigned to a caller on this TL's team.
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  const params = [source];
  let scopeSQL = '';
  if (tl) {
    params.push(req.adminUser.id);
    scopeSQL = `AND l.assigned_user_id IN (SELECT id FROM crm_users WHERE team_leader_id = $${params.length})`;
  }
  try {
    const { rows } = await pool.query(`
      SELECT l.*,
             u.full_name AS assigned_to_name,
             u.role      AS assigned_to_role
        FROM leads l
        LEFT JOIN crm_users u ON u.id = l.assigned_user_id
       WHERE l.source = $1
         ${scopeSQL}
       ORDER BY l.created_at DESC
    `, params);
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    // assigned_user_id column may be missing on a stale schema — fallback
    if (err.message && err.message.includes('column')) {
      try {
        // Stale-schema fallback can't TL-scope (no assigned_user_id column);
        // simplest correct behaviour is to return empty for TLs in that
        // case rather than leaking unscoped rows.
        if (tl) return res.json({ leads: [], total: 0 });
        const { rows } = await pool.query('SELECT * FROM leads WHERE source = $1 ORDER BY created_at DESC', [source]);
        return res.json({ leads: rows, total: rows.length });
      } catch (_) { /* fallthrough */ }
    }
    console.error('Fetch leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

/* ── GET /api/admin/completed-calls ──
   Powers the Sales → Completed Calls tab. Returns every lead whose
   latest call note has outcome = 'completed' or 'not_interested', joined
   with:
     • the most recent lead_call_notes row (so the caller's answers to
       every form question are returned as last_note_* columns)
     • the most recent calls row that holds a recording_url (so the
       admin can play it back via /api/caller/recordings/:id?token=ADMIN)
     • crm_users (so we can label which caller handled the lead).

   Limit defaults to 500 to keep the payload reasonable; the caller can
   pass ?limit=N to override (capped at 2000). */
router.get('/completed-calls', async (req, res) => {
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
  // TL scope: only leads handled by a caller on this TL's team. We push
  // the filter into the WHERE clause rather than mutating the SELECT
  // shape so the frontend response contract stays identical for every
  // role. Manager scope is currently NOT applied here (the existing
  // super-admin behaviour) — left untouched to avoid changing manager
  // semantics in this pass.
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  const params = [limit];
  let scopeSQL = '';
  if (tl) {
    params.push(req.adminUser.id);
    scopeSQL = `AND l.assigned_user_id IN (SELECT id FROM crm_users WHERE id = $${params.length} OR team_leader_id = $${params.length})`;
  }
  try {
    const { rows } = await pool.query(`
      SELECT l.id, l.full_name, l.whatsapp_number, l.email, l.source,
             l.sugar_level, l.diabetes_duration, l.language_pref,
             l.lead_score, l.lead_tag,
             l.last_note_outcome, l.last_note_at, l.completed_at,
             l.last_note_interested, l.last_note_outcome_subtag,
             l.created_at,
             w.name AS webinar_name,
             u.id   AS caller_id,
             u.full_name AS caller_name,
             u.role      AS caller_role,
             latest_note.confirmed_range          AS last_note_confirmed_range,
             latest_note.range_for                AS last_note_range_for,
             latest_note.patient_age              AS last_note_patient_age,
             latest_note.takes_medicine           AS last_note_takes_medicine,
             latest_note.hba1c                    AS last_note_hba1c,
             latest_note.working_professional     AS last_note_working_professional,
             latest_note.location                 AS last_note_location,
             latest_note.webinar_attended         AS last_note_webinar_attended,
             latest_note.available_for_webinar    AS last_note_available_for_webinar,
             latest_note.next_batch_joining       AS last_note_next_batch_joining,
             latest_note.note                     AS last_note_text,
             latest_note.follow_up_at             AS last_note_follow_up_at,
             latest_call.id                       AS last_call_id,
             latest_call.duration_sec             AS last_call_duration,
             latest_call.recording_url            AS last_call_recording_url,
             latest_call.started_at               AS last_call_started_at
        FROM leads l
        LEFT JOIN webinars w  ON w.id = l.webinar_id
        LEFT JOIN crm_users u ON u.id = l.assigned_user_id
        LEFT JOIN LATERAL (
          SELECT id, confirmed_range, range_for, patient_age, takes_medicine,
                 hba1c, working_professional, location, webinar_attended,
                 available_for_webinar, next_batch_joining, note, follow_up_at
            FROM lead_call_notes n
           WHERE n.lead_id = l.id
           ORDER BY n.created_at DESC
           LIMIT 1
        ) latest_note ON TRUE
        LEFT JOIN LATERAL (
          SELECT id, duration_sec, recording_url, started_at
            FROM calls c
           WHERE c.lead_id = l.id
             AND c.recording_url IS NOT NULL
           ORDER BY c.started_at DESC
           LIMIT 1
        ) latest_call ON TRUE
       WHERE l.last_note_outcome IN ('completed', 'not_interested', 'incomplete')
         ${scopeSQL}
       ORDER BY l.last_note_at DESC NULLS LAST
       LIMIT $1
    `, params);
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('admin/completed-calls error:', err.message);
    res.status(500).json({ error: 'Failed to fetch completed calls.' });
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
    // Snapshot the previous next_webinar_at BEFORE we apply the update so we
    // can tell whether the caller actually started a NEW batch (cutover moved
    // forward in time) — that's the trigger that promotes parked Next-Batch
    // leads back to their callers' Assigned queue as follow-ups.
    let prevNextWebinarAt = null;
    if (updates.next_webinar_at !== undefined) {
      const { rows: prev } = await pool.query(
        'SELECT next_webinar_at FROM webinar_config WHERE source = $1',
        [source]
      );
      prevNextWebinarAt = prev[0]?.next_webinar_at || null;
    }

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
      // Cross-service: post-split, funnel-meta and funnel-yt run in different
      // processes than this CRM admin route, so the in-process broadcast above
      // only reaches admin SPA clients connected to THIS service. The funnels
      // receive the same payload via pg_notify -> their LISTEN handler.
      pool.query(`SELECT pg_notify('webinar.config.updated', $1)`, [source])
        .catch(e => console.error('[admin] webinar.config.updated notify error:', e.message));
    }

    // Promote parked "Next Batch" leads when the caller schedules a fresh
    // batch — i.e. next_webinar_at changed AND the new value is strictly
    // later than the previous value (a true "new batch" cutover, not just a
    // minor edit / earlier reschedule). Each promoted lead becomes a
    // follow-up due NOW so it sits at the top of its original caller's
    // Assigned page. SSE pushes the row so the caller's tab refreshes live.
    if (updates.next_webinar_at !== undefined) {
      const newAt = new Date(updates.next_webinar_at);
      const prevAt = prevNextWebinarAt ? new Date(prevNextWebinarAt) : null;
      const isNewBatch = !prevAt || newAt.getTime() > prevAt.getTime();
      if (isNewBatch) {
        try {
          const { rows: promoted } = await pool.query(
            `UPDATE leads
                SET next_batch_parked     = FALSE,
                    next_batch_parked_at  = NULL,
                    last_note_outcome     = 'follow_up',
                    follow_up_at          = NOW(),
                    last_note_at          = NOW()
              WHERE next_batch_parked = TRUE
              RETURNING id, assigned_user_id`
          );
          for (const r of promoted) {
            if (r.assigned_user_id) {
              callerSse.pushTo(r.assigned_user_id, {
                type: 'lead.assigned',
                lead: { id: r.id, promoted_from: 'next_batch' },
              });
            }
          }
          if (promoted.length > 0) {
            console.log(`[admin] Next-Batch promoted ${promoted.length} leads on new-batch cutover (source=${source})`);
          }
        } catch (promoteErr) {
          console.error('[admin] Next-Batch promote error:', promoteErr.message);
        }
      }
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

/* ── GET /api/admin/timer-settings ──
   Returns the merged timer settings (stored values clamped over defaults). */
router.get('/timer-settings', async (req, res) => {
  try {
    const { mergeTimerSettings } = require('../utils/timerDefaults');
    const { rows } = await pool.query('SELECT settings FROM timer_settings WHERE id = 1');
    res.json({ settings: mergeTimerSettings(rows[0]?.settings || {}) });
  } catch (err) {
    console.error('Get timer-settings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch timer settings' });
  }
});

/* ── PUT /api/admin/timer-settings ──
   Clamps every value to BOUNDS, persists, restarts backend schedulers live,
   and broadcasts the change to every connected caller browser via SSE. */
router.put('/timer-settings', async (req, res) => {
  // Timer settings are global / department-level configuration. TLs see
  // them read-only in the UI; defense-in-depth: reject the PUT too.
  if (req.adminUser && req.adminUser.kind === 'tl') {
    return res.status(403).json({ error: 'Team leaders cannot modify timer settings.' });
  }
  try {
    const { mergeTimerSettings } = require('../utils/timerDefaults');
    const merged = mergeTimerSettings(req.body && req.body.settings);
    await pool.query(
      'UPDATE timer_settings SET settings = $1::jsonb, updated_at = NOW() WHERE id = 1',
      [JSON.stringify(merged)]
    );
    require('../utils/schedulerManager').applyTimerSettings(merged);
    callerSse.broadcastAll({ type: 'timer.settings.updated', settings: merged });
    res.json({ settings: merged });
  } catch (err) {
    console.error('Update timer-settings error:', err.message);
    res.status(500).json({ error: 'Failed to update timer settings' });
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
      'SELECT alert_phone_number, alert_phone_numbers, meta_campaign_ids FROM webinar_config WHERE source = $1',
      [source]
    );
    // Multi-recipient migration: if the new array column is empty but the
    // legacy single column has a value, surface that single value as a
    // one-element array so the UI shows the migrated number. Once the admin
    // saves through the new UI, the array column will be populated.
    const arr = Array.isArray(rows[0]?.alert_phone_numbers) ? rows[0].alert_phone_numbers : [];
    const legacy = rows[0]?.alert_phone_number || '';
    const phones = (arr.length === 0 && legacy) ? [legacy] : arr;
    res.json({
      source,
      // Legacy field kept for callers still reading it; equals phones[0] || ''.
      alert_phone_number:  phones[0] || '',
      alert_phone_numbers: phones,
      meta_campaign_ids:   rows[0]?.meta_campaign_ids || [],
    });
  } catch (err) {
    console.error('Get settings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

/* ── PUT /api/admin/settings ──
   Body: { source, alert_phone_number?, meta_campaign_ids? }
   Saves admin preferences for the given source. Only the keys present in
   the body get updated — omit a field to leave it untouched. */
router.put('/settings', async (req, res) => {
  const source = getSource(req);
  const updates = [];
  const params  = [];

  // alert_phone_number (optional, legacy single-value field)
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'alert_phone_number')) {
    let phone = req.body.alert_phone_number;
    if (typeof phone !== 'string') {
      return res.status(422).json({ error: 'alert_phone_number must be a string' });
    }
    phone = phone.replace(/\D/g, '');
    if (phone && !/^\d{10,15}$/.test(phone)) {
      return res.status(422).json({ error: 'alert_phone_number must be 10–15 digits' });
    }
    params.push(phone || null);
    updates.push(`alert_phone_number = $${params.length}`);
  }

  // alert_phone_numbers (optional, multi-recipient array). Each entry is
  // validated to be 10–15 digits. When this field is supplied we also
  // mirror the first entry into the legacy single column so any back-end
  // code that hasn't been migrated yet (e.g. one-off scripts) still works.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'alert_phone_numbers')) {
    const list = req.body.alert_phone_numbers;
    if (!Array.isArray(list)) {
      return res.status(422).json({ error: 'alert_phone_numbers must be an array' });
    }
    const cleaned = [];
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const digits = entry.replace(/\D/g, '');
      if (!digits) continue;
      if (!/^\d{10,15}$/.test(digits)) {
        return res.status(422).json({ error: `phone "${entry}" must be 10–15 digits` });
      }
      if (!cleaned.includes(digits)) cleaned.push(digits);   // de-duplicate
    }
    params.push(JSON.stringify(cleaned));
    updates.push(`alert_phone_numbers = $${params.length}::jsonb`);
    // Mirror first entry into legacy column for back-compat readers.
    params.push(cleaned[0] || null);
    updates.push(`alert_phone_number = $${params.length}`);
  }

  // meta_campaign_ids (optional). Stored as JSONB array of campaign-id strings.
  let campaignFilterTouched = false;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'meta_campaign_ids')) {
    const ids = req.body.meta_campaign_ids;
    if (!Array.isArray(ids)) {
      return res.status(422).json({ error: 'meta_campaign_ids must be an array' });
    }
    const cleaned = ids.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    params.push(JSON.stringify(cleaned));
    updates.push(`meta_campaign_ids = $${params.length}::jsonb`);
    campaignFilterTouched = true;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields supplied' });
  }

  params.push(source);
  try {
    await pool.query(
      `UPDATE webinar_config SET ${updates.join(', ')}, updated_at = NOW() WHERE source = $${params.length}`,
      params
    );
    // If the admin changed the campaign filter, wipe the Meta cache so the
    // very next /meta-insights call hits Facebook fresh — the dashboard
    // reflects the new selection immediately instead of waiting 30 min.
    if (campaignFilterTouched) clearMetaCache();
    const { rows } = await pool.query(
      'SELECT alert_phone_number, alert_phone_numbers, meta_campaign_ids FROM webinar_config WHERE source = $1',
      [source]
    );
    const arr = Array.isArray(rows[0]?.alert_phone_numbers) ? rows[0].alert_phone_numbers : [];
    const legacy = rows[0]?.alert_phone_number || '';
    const phones = (arr.length === 0 && legacy) ? [legacy] : arr;
    res.json({
      success: true,
      alert_phone_number:  phones[0] || '',
      alert_phone_numbers: phones,
      meta_campaign_ids:   rows[0]?.meta_campaign_ids || [],
    });
  } catch (err) {
    console.error('Update settings error:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

/* ── POST /api/admin/settings/test-alert ──
   Triggers an immediate dry-run of the alert scheduler so admin can verify
   the WATI key + phone are wired up. Body: { source }
   Returns BOTH the leads-alert and wa-link-alert decisions for that source. */
router.post('/settings/test-alert', async (req, res) => {
  const source = getSource(req);
  try {
    const { runOnce } = require('../utils/leadsAlertScheduler');
    const result = await runOnce();
    const forSource = result.filter(r => r.source === source);
    res.json({
      ok: true,
      results: forSource,
      // Back-compat: first result keyed under `result` for older callers.
      result: forSource[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/admin/settings/send-test-template ──
   Bypasses all scheduler conditions and fires ONE WATI template to the
   saved phone right now. Used to verify the WATI integration end-to-end.
   Body: { source, template_name?, parameters? }
   - template_name defaults to 'leads_alert'
   - parameters is an optional array of strings passed as the template
     body variables (e.g. ['500'] for the {{1}} variable on wa_link_alert).
   Returns the full WATI response so the admin can see whether WATI
   accepted or rejected the call. */
router.post('/settings/send-test-template', async (req, res) => {
  const source = getSource(req);
  const templateName = (req.body?.template_name || 'leads_alert').trim();
  const parameters = Array.isArray(req.body?.parameters)
    ? req.body.parameters.map(v => String(v))
    : [];

  // Optional override — if the admin types a number in the UI and clicks
  // Test without saving first, the frontend passes that number here so the
  // test goes to what they just typed, not the previously-saved value.
  let overridePhone = null;
  if (typeof req.body?.override_phone === 'string') {
    const digits = req.body.override_phone.replace(/\D/g, '');
    if (digits) {
      if (!/^\d{10,15}$/.test(digits)) {
        return res.status(422).json({ error: 'override_phone must be 10–15 digits' });
      }
      overridePhone = digits;
    }
  }

  try {
    let phone = overridePhone;
    if (!phone) {
      const { rows } = await pool.query(
        'SELECT alert_phone_number FROM webinar_config WHERE source = $1',
        [source]
      );
      phone = rows[0]?.alert_phone_number || null;
    }
    if (!phone) {
      return res.status(422).json({ error: 'No phone supplied. Type a number or save one first.' });
    }
    const wati = require('../utils/watiClient');
    if (!wati.isConfigured()) {
      return res.status(503).json({ error: 'WATI_API_KEY is not set in backend env vars.' });
    }
    const result = await wati.sendTemplate({ phone, templateName, parameters });
    res.json({
      ok:        result.ok,
      phone,
      override:  !!overridePhone,
      template:  templateName,
      parameters,
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
    // Option-C unique-visitor count merges visitor_ids that map to the
    // same registered phone number. The `merged_id` CTE coalesces every
    // visitor_id to its lead's phone if there's a matching lead row;
    // otherwise it keeps the visitor_id as-is. Then we COUNT DISTINCT.
    const { rows: sessions } = await pool.query(
      `WITH visit_identity AS (
         SELECT ce.webinar_id,
                ce.is_meta,
                ce.event_name,
                COALESCE(l.whatsapp_number, ce.visitor_id) AS merged_id
           FROM click_events ce
           LEFT JOIN leads l ON l.visitor_id = ce.visitor_id
          WHERE ce.webinar_id IS NOT NULL
       )
       SELECT w.id           AS webinar_id,
              w.date_time    AS webinar_at,
              w.name,
              w.is_active,
              COALESCE(ce_agg.visitors, 0)::int           AS visitors,
              COALESCE(ce_agg.unique_visitors, 0)::int    AS unique_visitors,
              COALESCE(ce_agg.meta_visits, 0)::int        AS meta_verified_visits,
              COALESCE(lead_agg.regs, 0)::int             AS registrations,
              COALESCE(lead_agg.meta_regs, 0)::int        AS meta_verified_regs,
              COALESCE(lead_agg.wa_uniq, 0)::int          AS wa_clicks,
              COALESCE(lead_agg.meta_wa, 0)::int          AS meta_verified_wa
         FROM webinars w
         LEFT JOIN (
           SELECT webinar_id,
                  SUM(CASE WHEN event_name = 'page_visited' THEN 1 ELSE 0 END) AS visitors,
                  COUNT(DISTINCT merged_id) FILTER (WHERE event_name = 'page_visited' AND merged_id IS NOT NULL) AS unique_visitors,
                  SUM(CASE WHEN event_name = 'page_visited' AND is_meta = TRUE THEN 1 ELSE 0 END) AS meta_visits
             FROM visit_identity
            GROUP BY webinar_id
         ) ce_agg ON ce_agg.webinar_id = w.id
         LEFT JOIN (
           SELECT webinar_id,
                  COUNT(*)                                                AS regs,
                  COUNT(*) FILTER (WHERE fbclid IS NOT NULL OR utm_source = 'meta') AS meta_regs,
                  SUM(CASE WHEN wa_clicked THEN 1 ELSE 0 END)             AS wa_uniq,
                  SUM(CASE WHEN wa_clicked AND (fbclid IS NOT NULL OR utm_source = 'meta') THEN 1 ELSE 0 END) AS meta_wa
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
        `SELECT COUNT(*) FILTER (WHERE l.wa_clicked = TRUE)::int                                                 AS wa_unique_leads,
                COUNT(*)::int                                                                                    AS lead_registrations,
                COUNT(*) FILTER (WHERE l.fbclid IS NOT NULL OR l.utm_source = 'meta')::int                       AS meta_verified_regs,
                COUNT(*) FILTER (WHERE l.wa_clicked = TRUE AND (l.fbclid IS NOT NULL OR l.utm_source = 'meta'))::int AS meta_verified_wa
           FROM leads l
          WHERE ${leadFilterClauses.join(' AND ')}`,
        leadFilterParams
      );
      counts.wa_unique_leads    = leadCounts[0]?.wa_unique_leads    ?? 0;
      counts.lead_registrations = leadCounts[0]?.lead_registrations ?? 0;
      counts.meta_verified_regs = leadCounts[0]?.meta_verified_regs ?? 0;
      counts.meta_verified_wa   = leadCounts[0]?.meta_verified_wa   ?? 0;
    } catch (_) {
      counts.wa_unique_leads    = 0;
      counts.lead_registrations = 0;
      counts.meta_verified_regs = 0;
      counts.meta_verified_wa   = 0;
    }

    // Verified Meta visits + unique visitor counts (lead-phone merged)
    // from click_events. Same filter window as event counts.
    try {
      const { rows: r } = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE ce.event_name = 'page_visited' AND ce.is_meta = TRUE)::int AS meta_verified_visits,
            COUNT(DISTINCT COALESCE(l.whatsapp_number, ce.visitor_id))
              FILTER (WHERE ce.event_name = 'page_visited' AND (ce.visitor_id IS NOT NULL OR l.whatsapp_number IS NOT NULL))::int AS unique_visitors
           FROM click_events ce
           LEFT JOIN leads l ON l.visitor_id = ce.visitor_id
           ${where}`,
        params
      );
      counts.meta_verified_visits = r[0]?.meta_verified_visits ?? 0;
      counts.unique_visitors      = r[0]?.unique_visitors      ?? 0;
    } catch (_) {
      counts.meta_verified_visits = 0;
      counts.unique_visitors      = 0;
    }

    res.json({
      counts,
      sessions: sessions.map(r => ({
        webinar_id:           r.webinar_id,
        webinar_at:           r.webinar_at,
        name:                 r.name,
        is_active:            r.is_active,
        visitors:             r.visitors,
        unique_visitors:      r.unique_visitors,
        meta_verified_visits: r.meta_verified_visits,
        registrations:        r.registrations,
        meta_verified_regs:   r.meta_verified_regs,
        wa_clicks:            r.wa_clicks,
        meta_verified_wa:     r.meta_verified_wa,
      })),
    });
  } catch (err) {
    console.error('Dashboard query error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

/* ── GET /api/admin/crm-users ──
   Returns user rows with the Smartflo API key MASKED — admins can see
   that a key is present (and what it looks like) but the raw secret is
   never sent over the wire after creation. The Users page form should
   show the masked value as a placeholder; if the admin submits the
   masked value unchanged, the PATCH endpoint treats it as a no-op and
   keeps the real key in the DB. */
router.get('/crm-users', async (req, res) => {
  try {
    // Three scopes:
    //   super  → every user
    //   mgr    → users in the manager's department
    //   tl     → the TL themselves + their direct reports (team_leader_id = self.id)
    const mgr = req.adminUser && req.adminUser.kind === 'manager';
    const tl  = req.adminUser && req.adminUser.kind === 'tl';
    let whereSQL = '';
    let params   = [];
    // Soft-deleted rows are never returned to the Users list. The
    // deleted_at IS NULL gate goes into the WHERE in every branch.
    if (mgr) {
      whereSQL = 'WHERE deleted_at IS NULL AND department = $1';
      params   = [req.adminUser.department];
    } else if (tl) {
      whereSQL = 'WHERE deleted_at IS NULL AND (id = $1 OR team_leader_id = $1)';
      params   = [req.adminUser.id];
    } else {
      whereSQL = 'WHERE deleted_at IS NULL';
    }
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, is_active,
              department, team_leader_id, manager_id, password_plain,
              tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
              tata_smartflo_api_key, tata_outbound_route,
              created_at
         FROM crm_users
        ${whereSQL}
        ORDER BY created_at DESC`,
      params
    );
    const tata = require('../utils/tataClient');
    const users = rows.map(u => ({
      ...u,
      tata_smartflo_api_key: u.tata_smartflo_api_key ? tata.maskKey(u.tata_smartflo_api_key) : null,
      // Flag for the frontend so it knows a key is configured even when the
      // displayed value is masked. Avoids confusing "is this empty or just
      // hidden?" UX.
      tata_smartflo_api_key_set: !!u.tata_smartflo_api_key,
    }));
    res.json({ users, total: users.length });
  } catch (err) {
    console.error('Get crm_users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/* Returns true if `v` looks like a maskKey() output (e.g. "abcd…wxyz")
   rather than a real key. Used on PATCH to skip overwriting the real
   key when the admin saves the form without retyping it. */
function isMaskedKey(v) {
  return typeof v === 'string' && /…/.test(v);
}

/* ── POST /api/admin/crm-users ── */
const ALLOWED_ROLES = ['junior_caller','senior_caller','manager','trainer','admin','team_leader'];

const crmUserValidators = [
  body('full_name').trim().notEmpty().withMessage('Full name is required.').isLength({ max: 120 }),
  body('email').trim().isEmail().withMessage('Valid email required.').isLength({ max: 200 }),
  body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 30 }),
  body('role').isIn(ALLOWED_ROLES).withMessage('Role must be one of the 6 allowed values.'),
  body('password').isLength({ min: 6, max: 128 }).withMessage('Password must be 6–128 characters.'),
  body('department').optional({ nullable: true, checkFalsy: true }).isIn(['sales','marketing']).withMessage('Department must be "sales" or "marketing".'),
  body('team_leader_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Team leader must be a valid user.'),
  body('manager_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Manager must be a valid user.'),
  body('tata_extension').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_account_type').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_agent_number').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_caller_id').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_smartflo_api_key')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage('Smartflo API key must be at least 10 characters.')
    .matches(/^\S+$/)
    .withMessage('Smartflo API key must not contain spaces.'),
  body('tata_outbound_route')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['did','agent','extension'])
    .withMessage('Outbound route must be "did", "agent" or "extension".'),
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
    department, team_leader_id, manager_id,
    tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
    tata_smartflo_api_key, tata_outbound_route,
  } = req.body;
  // TL guard: TLs may only create caller-level users — no managers, no
  // peer TLs, no admins. Reject early with a clear message so a leaked
  // /admin/crm-users POST from a TL JWT can't escalate privileges.
  const isTL = req.adminUser && req.adminUser.kind === 'tl';
  if (isTL && role !== 'junior_caller' && role !== 'senior_caller') {
    return res.status(403).json({ error: 'Team leaders can only create caller users.' });
  }
  // A manager can only create users in their OWN department — override
  // whatever the body sent. TLs same: their own department. Super-admin
  // uses the submitted department.
  const effectiveDept = (req.adminUser && (req.adminUser.kind === 'manager' || req.adminUser.kind === 'tl'))
    ? req.adminUser.department
    : (department ? String(department).trim() : null);
  // A manager-created user always reports to that manager; only super-admin
  // may assign a different manager. TLs don't set manager_id at all.
  const effectiveManagerId = (req.adminUser && req.adminUser.kind === 'manager')
    ? req.adminUser.id
    : (isTL ? null : (manager_id || null));
  // A TL-created caller is automatically assigned to that TL's team.
  // Super-admin / manager submissions honour the request body.
  const effectiveTeamLeaderId = isTL
    ? req.adminUser.id
    : (team_leader_id || null);
  try {
    const password_hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO crm_users
         (full_name, email, phone, role, password_hash,
          department, team_leader_id,
          tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
          tata_smartflo_api_key, tata_outbound_route, manager_id, password_plain)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, full_name, email, phone, role, is_active,
                 department, team_leader_id, manager_id, password_plain,
                 tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
                 tata_smartflo_api_key, tata_outbound_route,
                 created_at`,
      [
        full_name.trim(),
        email.trim().toLowerCase(),
        phone?.trim() || null,
        role,
        password_hash,
        effectiveDept,
        effectiveTeamLeaderId,
        tata_extension?.trim() || null,
        tata_account_type?.trim() || null,
        tata_agent_number?.trim() || null,
        tata_caller_id?.trim() || null,
        tata_smartflo_api_key?.trim() || null,
        tata_outbound_route === 'agent' || tata_outbound_route === 'did'
          ? tata_outbound_route
          : 'extension',
        effectiveManagerId,
        password,
      ]
    );
    // Mask the API key in the response so the freshly-created secret
    // isn't echoed back into the admin UI / browser memory / network logs.
    const tata = require('../utils/tataClient');
    const created = {
      ...rows[0],
      tata_smartflo_api_key: rows[0].tata_smartflo_api_key
        ? tata.maskKey(rows[0].tata_smartflo_api_key) : null,
      tata_smartflo_api_key_set: !!rows[0].tata_smartflo_api_key,
    };
    res.status(201).json({ user: created });
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
  body('department').optional({ nullable: true, checkFalsy: true }).isIn(['sales','marketing']).withMessage('Department must be "sales" or "marketing".'),
  body('team_leader_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Team leader must be a valid user.'),
  body('manager_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Manager must be a valid user.'),
  body('tata_extension').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_account_type').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_agent_number').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_caller_id').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_smartflo_api_key')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage('Smartflo API key must be at least 10 characters.')
    .matches(/^\S+$/)
    .withMessage('Smartflo API key must not contain spaces.'),
  body('tata_outbound_route')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['did','agent','extension'])
    .withMessage('Outbound route must be "did", "agent" or "extension".'),
  body('is_active').optional().isBoolean().withMessage('is_active must be a boolean.'),
];

router.patch('/crm-users/:id', crmUserPatchValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg, fields: errors.array() });
  }

  const { id } = req.params;
  const allowed = [
    'full_name', 'email', 'phone', 'role',
    'department', 'team_leader_id', 'manager_id',
    'tata_extension', 'tata_account_type', 'tata_agent_number', 'tata_caller_id',
    'tata_smartflo_api_key', 'tata_outbound_route',
    // is_active doubles as the "paused" flag — leadAssigner.js already skips
    // callers where is_active = FALSE; the Sales Performance kebab toggles it.
    'is_active',
  ];
  const tataKeys = new Set([
    'tata_extension', 'tata_account_type', 'tata_agent_number', 'tata_caller_id',
    'tata_smartflo_api_key', 'tata_outbound_route',
  ]);
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const raw = req.body[key];
      if (key === 'email') {
        updates[key] = String(raw).trim().toLowerCase();
      } else if (tataKeys.has(key)) {
        // If the frontend submitted the masked placeholder unchanged (e.g.
        // "abcd…wxyz"), treat it as "leave the stored value alone" — drop
        // the key from the updates set entirely instead of clobbering the
        // real secret with the mask.
        if (key === 'tata_smartflo_api_key' && isMaskedKey(raw)) continue;
        // tata_outbound_route is NOT NULL with default 'extension'; coerce
        // empty / null / unknown values to 'extension' so the CHECK
        // constraint never trips. 'agent' and 'did' are honoured verbatim.
        if (key === 'tata_outbound_route') {
          const v = typeof raw === 'string' ? raw.trim() : raw;
          updates[key] = (v === 'agent' || v === 'did') ? v : 'extension';
        } else {
          updates[key] = raw === null || raw === '' ? null : String(raw).trim() || null;
        }
      } else if (key === 'is_active') {
        updates[key] = !!raw;
      } else if (key === 'department' || key === 'team_leader_id' || key === 'manager_id') {
        // All nullable — an empty string must become NULL (team_leader_id /
        // manager_id are UUID columns; '' would trip a type error).
        const v = typeof raw === 'string' ? raw.trim() : raw;
        updates[key] = v ? v : null;
      } else if (typeof raw === 'string') {
        updates[key] = raw.trim();
      } else {
        updates[key] = raw;
      }
    }
  }

  // Optional password update — hash for login verification, and keep the
  // plain text so the admin can view the user's current password.
  if (req.body.password) {
    try {
      updates.password_hash  = await hashPassword(req.body.password);
      updates.password_plain = String(req.body.password);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to hash password.' });
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update.' });
  }

  // Manager scope: can only edit users in their own department, and can never
  // move a user to a different department.
  if (req.adminUser && req.adminUser.kind === 'manager') {
    try {
      const { rows: tgt } = await pool.query('SELECT department FROM crm_users WHERE id = $1', [id]);
      if (tgt.length === 0) return res.status(404).json({ error: 'User not found.' });
      if (tgt[0].department !== req.adminUser.department) {
        return res.status(403).json({ error: 'You can only manage users in your own department.' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Failed to verify user.' });
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'department')) {
      updates.department = req.adminUser.department;
    }
    // A manager cannot reassign who a user reports to — only super-admin can.
    delete updates.manager_id;
  }
  // TL scope: can only edit users on THEIR team (target.team_leader_id =
  // self.id, OR the TL editing their own profile). TLs cannot move
  // people between teams, change roles upward, change department, or
  // edit manager_id.
  if (req.adminUser && req.adminUser.kind === 'tl') {
    try {
      const { rows: tgt } = await pool.query(
        'SELECT id, role, team_leader_id, department FROM crm_users WHERE id = $1',
        [id]
      );
      if (tgt.length === 0) return res.status(404).json({ error: 'User not found.' });
      const t = tgt[0];
      const isSelf = t.id === req.adminUser.id;
      const isMyReport = t.team_leader_id === req.adminUser.id;
      if (!isSelf && !isMyReport) {
        return res.status(403).json({ error: 'You can only manage users on your team.' });
      }
      // Role escalations blocked: a TL can leave existing role intact
      // OR set a caller to the other caller level, but never to manager/
      // admin/team_leader/trainer.
      if (Object.prototype.hasOwnProperty.call(updates, 'role')) {
        const r = updates.role;
        if (r !== 'junior_caller' && r !== 'senior_caller') {
          delete updates.role;
        }
      }
      // Lock department / team membership / manager.
      if (Object.prototype.hasOwnProperty.call(updates, 'department')) {
        updates.department = t.department;
      }
      delete updates.team_leader_id;
      delete updates.manager_id;
    } catch (e) {
      return res.status(500).json({ error: 'Failed to verify user.' });
    }
  }

  // When the admin flips is_active back to TRUE, also clear the SmartFlow
  // auto-pause bookkeeping so the next system-driven pause starts from a
  // clean slate. The two columns are no-ops for any user that was paused
  // manually (they were never set).
  const setFragments = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
  if (Object.prototype.hasOwnProperty.call(updates, 'is_active') && updates.is_active === true) {
    setFragments.push('auto_paused_at = NULL', 'auto_pause_reason = NULL');
  }
  const setClause = setFragments.join(', ');
  const values = Object.keys(updates).map(k => updates[k]);
  values.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE crm_users SET ${setClause}
       WHERE id = $${values.length}
       RETURNING id, full_name, email, phone, role, is_active,
                 auto_paused_at, auto_pause_reason,
                 department, team_leader_id, manager_id, password_plain,
                 tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
                 tata_smartflo_api_key, tata_outbound_route,
                 created_at`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    // If is_active was in this PATCH, push an SSE so the caller's open tab
    // shows / hides the "paused by admin" overlay without a manual refresh.
    if (Object.prototype.hasOwnProperty.call(updates, 'is_active')) {
      try {
        callerSse.pushTo(id, {
          type: updates.is_active ? 'caller.resumed' : 'caller.paused',
          is_active: !!updates.is_active,
        });
      } catch (sseErr) {
        console.error('[admin] caller-paused SSE push error:', sseErr.message);
      }
      // Activity audit: record the admin-initiated pause/resume so the
      // activity drawer can show "Paused by admin" entries with timing.
      activityLogger.logPointEvent(
        id,
        updates.is_active ? 'UNPAUSED_BY_ADMIN' : 'PAUSED_BY_ADMIN'
      );
      // If admin/manager just PAUSED this caller, mark whatever lead
      // they had open as Incomplete so it surfaces in Completed Calls
      // for review. Same code path activitySpanReaper uses on stale
      // heartbeat, just triggered immediately instead of after the
      // 90-second timeout.
      if (updates.is_active === false) {
        try {
          const { markInFlightLeadIncomplete } = require('../utils/markInFlightLeadIncomplete');
          markInFlightLeadIncomplete({
            callerId: id,
            reason:   req.adminUser?.kind === 'manager' ? 'manager_pause' : 'admin_pause',
          }).catch(() => {});
        } catch (e) {
          console.error('[admin] markInFlightLeadIncomplete load error:', e.message);
        }
      }
    }
    // Mask the API key in the response (see GET /crm-users for the
    // reasoning — never echo the real secret back to the browser).
    const tataLib = require('../utils/tataClient');
    const updated = {
      ...rows[0],
      tata_smartflo_api_key: rows[0].tata_smartflo_api_key
        ? tataLib.maskKey(rows[0].tata_smartflo_api_key) : null,
      tata_smartflo_api_key_set: !!rows[0].tata_smartflo_api_key,
    };
    res.json({ user: updated });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }
    console.error('Update crm_user error:', err.message);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

/* ── GET /api/admin/auto-paused-callers ──
   Notifications feed for the Sales dashboard. Returns every caller the
   SYSTEM auto-paused — robot-nudge self-pause or the SmartFlow retry-cap.
   Admin pauses are excluded: they leave auto_paused_at NULL. The card's
   Resume button calls PATCH /crm-users/:id { is_active: true }, which
   clears auto_paused_at + auto_pause_reason so the row drops off this feed. */
router.get('/auto-paused-callers', async (req, res) => {
  try {
    // TL scope: only the auto-paused callers on this TL's team.
    // Manager + super-admin: department-wide / global as before.
    const tl  = req.adminUser && req.adminUser.kind === 'tl';
    const mgr = req.adminUser && req.adminUser.kind === 'manager';
    let whereExtra = '';
    let params     = [];
    if (tl) {
      whereExtra = 'AND team_leader_id = $1';
      params     = [req.adminUser.id];
    } else if (mgr) {
      whereExtra = 'AND department = $1';
      params     = [req.adminUser.department];
    }
    const { rows } = await pool.query(
      `SELECT id, full_name, role, auto_paused_at, auto_pause_reason
         FROM crm_users
        WHERE is_active = FALSE
          AND auto_paused_at IS NOT NULL
          AND deleted_at IS NULL
          ${whereExtra}
        ORDER BY auto_paused_at DESC`,
      params
    );
    res.json({ callers: rows });
  } catch (err) {
    console.error('auto-paused-callers error:', err.message);
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

/* ── GET /api/admin/lead-share-config?webinar_id=<uuid> ── */
router.get('/lead-share-config', async (req, res) => {
  const { webinar_id } = req.query;
  if (!webinar_id) return res.status(400).json({ error: 'webinar_id required' });

  try {
    // All callers eligible to be in the rotation (junior + senior caller
    // roles). Soft-deleted callers (deleted_at IS NOT NULL) are excluded
    // so they don't appear in the Leads Logic rotation list — the entire
    // point of soft-delete is that they're gone from active workflows.
    const callersQuery = pool.query(
      `SELECT id, full_name, email, role, is_active
         FROM crm_users
        WHERE role IN ('junior_caller','senior_caller')
          AND deleted_at IS NULL
        ORDER BY created_at ASC`
    );
    // Existing config rows for this webinar
    const configQuery = pool.query(
      `SELECT caller_id, enabled, allowed_lead_types, position
         FROM lead_share_config
        WHERE webinar_id = $1`,
      [webinar_id]
    );
    // How many leads in THIS webinar have already been handed out to each
    // caller. Powers the "Assigned" column in the admin view so the operator
    // can eyeball whether round-robin is distributing fairly.
    const countsQuery = pool.query(
      `SELECT assigned_user_id::text AS caller_id, COUNT(*)::int AS count
         FROM leads
        WHERE webinar_id = $1
          AND assigned_user_id IS NOT NULL
        GROUP BY assigned_user_id`,
      [webinar_id]
    );
    const [callersRes, configRes, countsRes] = await Promise.all([callersQuery, configQuery, countsQuery]);

    const configByCaller = {};
    for (const row of configRes.rows) configByCaller[row.caller_id] = row;
    const countByCaller = {};
    for (const row of countsRes.rows) countByCaller[row.caller_id] = row.count;

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
        assigned_count:     countByCaller[c.id] || 0,
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

/* ── DELETE /api/admin/crm-users/:id ──
   Soft-delete. A physical DELETE would fail Postgres FK checks because
   lead_assignments / lead_call_notes / leads.assigned_user_id all have
   ON DELETE NO ACTION (intentional — those rows are historical and
   shouldn't lose their caller attribution). Instead we stamp
   deleted_at = NOW() and flip is_active = FALSE. The user disappears
   from the Users list, the assignment pool, and the performance grid;
   call history retains the name pointer for audit.

   To restore a soft-deleted user later: UPDATE crm_users SET
   deleted_at = NULL WHERE id = '<uuid>'. No UI for undelete yet —
   admin can do it via psql / a follow-up endpoint if needed. */
router.delete('/crm-users/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    // Manager scope: can only delete users in their own department.
    if (req.adminUser && req.adminUser.kind === 'manager') {
      const { rows: tgt } = await pool.query('SELECT department FROM crm_users WHERE id = $1', [id]);
      if (tgt.length === 0) return res.status(404).json({ error: 'User not found.' });
      if (tgt[0].department !== req.adminUser.department) {
        return res.status(403).json({ error: 'You can only manage users in your own department.' });
      }
    }
    // TL has no delete permission at all — would let them remove their
    // own reports unilaterally, which is a manager+ decision.
    if (req.adminUser && req.adminUser.kind === 'tl') {
      return res.status(403).json({ error: 'Team leaders cannot delete users.' });
    }
    const result = await pool.query(
      `UPDATE crm_users
          SET deleted_at = NOW(),
              is_active  = FALSE
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING id`,
      [id]
    );
    if (result.rowCount === 0) {
      // Either the user doesn't exist or was already deleted. Either
      // way the UI's effect is the same (row should disappear).
      return res.status(404).json({ error: 'User not found.' });
    }
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
         AND u.deleted_at IS NULL
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

/* ── GET /api/admin/meta-debug ──
   Diagnostic: asks Meta which ad accounts the configured token actually has
   access to, and tests an insights call on each configured account. Helps
   pin down which accounts are missing permissions vs which ones work. */
router.get('/meta-debug', async (req, res) => {
  const token = (process.env.META_ACCESS_TOKEN || '').trim();
  const accounts = (process.env.META_AD_ACCOUNTS || '').trim().split(',').map(s => s.trim()).filter(Boolean);
  if (!token) return res.json({ configured: false, error: 'META_ACCESS_TOKEN missing in .env' });

  const out = { configured: true, configured_accounts: accounts, token_sees: [], probe: {} };

  // 1) Which accounts does this token *actually* see?
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=id,account_id,name,account_status&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    if (j.error) {
      out.token_sees_error = j.error.message;
    } else {
      out.token_sees = (j.data || []).map(a => ({ id: a.account_id, name: a.name, status: a.account_status }));
    }
  } catch (e) { out.token_sees_error = e.message; }

  // 2) Probe each configured account directly. Two-step:
  //    a) Try a metadata read — proves the token at least sees the account
  //    b) Try an insights call — proves it has ads_read scope on the account
  for (const accId of accounts) {
    const tok = (process.env[`META_ACCESS_TOKEN_${accId}`] || token).trim();
    const probe = { metadata: null, insights: null };

    try {
      const rm = await fetch(`https://graph.facebook.com/v23.0/act_${accId}?fields=id,name,account_status,business&access_token=${encodeURIComponent(tok)}`);
      const jm = await rm.json();
      probe.metadata = jm.error
        ? { ok: false, message: jm.error.message, code: jm.error.code }
        : { ok: true, name: jm.name, status: jm.account_status, business: jm.business?.name || null, business_id: jm.business?.id || null };
    } catch (e) {
      probe.metadata = { ok: false, message: e.message };
    }

    try {
      const ri = await fetch(`https://graph.facebook.com/v23.0/act_${accId}/insights?fields=impressions&date_preset=last_7d&access_token=${encodeURIComponent(tok)}`);
      const ji = await ri.json();
      probe.insights = ji.error
        ? { ok: false, message: ji.error.message, code: ji.error.code }
        : { ok: true, rows: (ji.data || []).length };
    } catch (e) {
      probe.insights = { ok: false, message: e.message };
    }

    out.probe[accId] = probe;
  }

  // 3) Who owns this token?
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    out.token_owner = j.error ? { error: j.error.message } : { id: j.id, name: j.name };
  } catch (e) {
    out.token_owner = { error: e.message };
  }

  res.json(out);
});

/* ── GET /api/admin/meta-raw?from=YYYY-MM-DD&to=YYYY-MM-DD ──
   Diagnostic: dumps every action_type + count Meta returns for the saved
   campaign filter over the given date range, plus each account's
   configured timezone. Lets us spot which metric the user is actually
   comparing against in Ads Manager. */
router.get('/meta-raw', async (req, res) => {
  if (!metaConfigured()) return res.json({ configured: false });
  const source = getSource(req);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to   || '') ? req.query.to   : null;
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });

  const { rows } = await pool.query(
    'SELECT meta_campaign_ids FROM webinar_config WHERE source = $1',
    [source]
  );
  const campaignIds = Array.isArray(rows[0]?.meta_campaign_ids) ? rows[0].meta_campaign_ids : [];

  const accounts = (process.env.META_AD_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = { from, to, campaign_filter_count: campaignIds.length, accounts: {} };

  for (const accId of accounts) {
    const tok = (process.env[`META_ACCESS_TOKEN_${accId}`] || process.env.META_ACCESS_TOKEN || '').trim();
    if (!tok) { out.accounts[accId] = { error: 'no token' }; continue; }

    // 1) Account timezone
    let timezone_name = null, timezone_offset_hours_utc = null;
    try {
      const r = await fetch(`https://graph.facebook.com/v23.0/act_${accId}?fields=timezone_name,timezone_offset_hours_utc&access_token=${encodeURIComponent(tok)}`);
      const j = await r.json();
      timezone_name = j.timezone_name; timezone_offset_hours_utc = j.timezone_offset_hours_utc;
    } catch (_) { /* ignore */ }

    // 2) Daily insights over the range — every action type
    const u = new URL(`https://graph.facebook.com/v23.0/act_${accId}/insights`);
    u.searchParams.set('level', 'account');
    u.searchParams.set('fields', 'actions,inline_link_clicks,impressions,clicks');
    u.searchParams.set('time_increment', '1');
    u.searchParams.set('time_range', JSON.stringify({ since: from, until: to }));
    u.searchParams.set('action_attribution_windows', JSON.stringify(['1d_view', '7d_click', '28d_click']));
    if (campaignIds.length > 0) {
      u.searchParams.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]));
    }
    u.searchParams.set('access_token', tok);

    try {
      const r = await fetch(u.toString());
      const j = await r.json();
      if (j.error) {
        out.accounts[accId] = { timezone_name, timezone_offset_hours_utc, error: j.error.message };
        continue;
      }
      const action_totals = {};
      let inline_link_clicks_total = 0, impressions_total = 0, clicks_total = 0;
      for (const row of (j.data || [])) {
        if (row.inline_link_clicks) inline_link_clicks_total += parseInt(row.inline_link_clicks, 10) || 0;
        if (row.impressions)        impressions_total        += parseInt(row.impressions, 10) || 0;
        if (row.clicks)             clicks_total             += parseInt(row.clicks, 10) || 0;
        for (const a of (row.actions || [])) {
          action_totals[a.action_type] = (action_totals[a.action_type] || 0) + (parseInt(a.value, 10) || 0);
        }
      }
      out.accounts[accId] = {
        timezone_name, timezone_offset_hours_utc,
        days_returned: (j.data || []).length,
        inline_link_clicks_total, impressions_total, clicks_total,
        action_totals,
      };
    } catch (e) {
      out.accounts[accId] = { timezone_name, timezone_offset_hours_utc, error: e.message };
    }
  }
  res.json(out);
});

/* ── GET /api/admin/meta-campaigns ──
   Returns every Meta Ads campaign across all configured accounts so the
   admin can choose a subset to scope the landing-view dashboards. */
router.get('/meta-campaigns', async (_req, res) => {
  if (!metaConfigured()) return res.json({ configured: false, campaigns: [] });
  try {
    const campaigns = await fetchAllCampaigns();
    res.json({ configured: true, campaigns });
  } catch (err) {
    console.error('meta-campaigns error:', err.message);
    res.status(500).json({ error: 'Failed to load campaigns.' });
  }
});

/* ── GET /api/admin/meta-insights?source=meta&from=YYYY-MM-DD&to=YYYY-MM-DD&webinar_at=<iso>&webinar_id=<uuid> ──
   Returns Meta-attributed landing_page_view counts summed across every ad
   account in META_AD_ACCOUNTS. A "landing view" = an ad click that
   successfully loaded our funnel page.

   Response shape:
     {
       configured: bool,
       window: { from, to },
       total_landing_views: int,                  // filtered sum (drives the stat box)
       webinars: [{ webinar_id, name, landing_views }, …]   // per-webinar (always full 180-day attribution)
     }

   Filters:
     • from / to     — narrow the fetched window (defaults to last 180 days)
     • webinar_id    — restrict total to just that webinar
     • webinar_at    — alternate way to pick a webinar (by its date_time)
   The per-webinar `webinars` array is always built from the full 180-day
   window so the per-card metrics stay stable when filters change. */
router.get('/meta-insights', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({ configured: false, webinars: [], total_landing_views: 0 });
  }
  const source = getSource(req);
  const { from, to, webinar_at, webinar_id } = req.query;
  const fmt = d => d.toISOString().slice(0, 10);

  try {
    const today = new Date();
    const defaultFrom = new Date(today); defaultFrom.setDate(defaultFrom.getDate() - 180);
    const fullFromYmd = fmt(defaultFrom);
    const fullToYmd   = fmt(today);

    const filterFromYmd = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : fullFromYmd;
    const filterToYmd   = /^\d{4}-\d{2}-\d{2}$/.test(to   || '') ? to   : fullToYmd;

    const { rows: webinars } = await pool.query(
      `SELECT id AS webinar_id, name, date_time
         FROM webinars
        WHERE source = $1 AND date_time IS NOT NULL
        ORDER BY date_time ASC`,
      [source]
    );

    // Read the admin-selected campaign filter (per source). Empty/null
    // means "include every campaign" — same as today's behaviour.
    let selectedCampaignIds = [];
    try {
      const { rows } = await pool.query(
        'SELECT meta_campaign_ids FROM webinar_config WHERE source = $1',
        [source]
      );
      const stored = rows[0]?.meta_campaign_ids;
      if (Array.isArray(stored)) selectedCampaignIds = stored;
    } catch (_) { /* column may be missing on stale schemas */ }

    // Both LPV and Link Clicks respect the dashboard's date-range filter
    // and the saved campaign selection.
    const dailyFiltered = await fetchLandingViewsByDayFiltered(filterFromYmd, filterToYmd, selectedCampaignIds);
    const byWebinarLpv    = attributeViewsToWebinars(dailyFiltered.lpv,    webinars);
    const byWebinarClicks = attributeViewsToWebinars(dailyFiltered.clicks, webinars);

    function resolveWebinarTotal(map) {
      if (webinar_id) return map[webinar_id] || 0;
      if (webinar_at) {
        const target = webinars.find(w => new Date(w.date_time).getTime() === new Date(webinar_at).getTime());
        return target ? (map[target.webinar_id] || 0) : 0;
      }
      return null; // signal "sum the date range" to caller
    }

    function sumDaily(daily) {
      return Object.values(daily).reduce((s, n) => s + n, 0);
    }

    const total_landing_views = resolveWebinarTotal(byWebinarLpv)    ?? sumDaily(dailyFiltered.lpv);
    const total_link_clicks   = resolveWebinarTotal(byWebinarClicks) ?? sumDaily(dailyFiltered.clicks);

    res.json({
      configured: true,
      window: { from: filterFromYmd, to: filterToYmd },
      total_landing_views,
      total_link_clicks,
      webinars: webinars.map(w => ({
        webinar_id:    w.webinar_id,
        name:          w.name,
        landing_views: byWebinarLpv[w.webinar_id]    || 0,
        link_clicks:   byWebinarClicks[w.webinar_id] || 0,
      })),
    });
  } catch (err) {
    console.error('meta-insights error:', err.message);
    res.status(500).json({ error: 'Failed to load Meta insights.' });
  }
});

/* ── GET /api/admin/sales-performance?from=YYYY-MM-DD&to=YYYY-MM-DD&salesperson_id=<uuid> ──
   Per-salesperson dashboard aggregating lead counts (assigned/hot/warm/
   touched/untouched/enrolled) and call activity (total/incoming/outgoing/
   connected/duration). Trend data (`*_prev`) comes from a same-span window
   shifted back so the frontend can show ▲/▼ arrows.

   Defaults: from = to = today (IST). */
/* ── GET /api/admin/caller-activity/:id?date=YYYY-MM-DD ──
   Returns the chronological activity audit log for one caller for one
   IST day. Used by the Performance grid's Status pill → activity drawer.
   Each row carries: tag, started_at, ended_at, duration_sec, context.
   Open events (ended_at IS NULL) are returned as ongoing — the frontend
   shows them with a live ticking duration. */
router.get('/caller-activity/:id', async (req, res) => {
  const id = String(req.params.id || '');
  // crm_users.id is a UUID — accept the standard 36-char format.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  // Date is the IST calendar day. Default = today (IST).
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const dateYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayYmd;

  // IST day window → UTC bounds. IST is UTC+5:30, so the IST day Y-M-D
  // runs from (Y-M-D 00:00 IST) = (Y-M-D 18:30 prev-UTC) to next-day 18:30 UTC.
  const dayStartUtc = new Date(`${dateYmd}T00:00:00+05:30`);
  const dayEndUtc   = new Date(dayStartUtc.getTime() + 24 * 3600 * 1000);

  try {
    const { rows: caller } = await pool.query(
      'SELECT id, full_name, role, is_active FROM crm_users WHERE id = $1',
      [id]
    );
    if (caller.length === 0) return res.status(404).json({ error: 'caller not found' });

    // Single-tag cutover — pre-redesign rows used three overlapping channels,
    // so a day summed past 24h. Only rows at/after the cutover are returned.
    const { rows: flag } = await pool.query(
      'SELECT applied_at FROM activity_log_redesign_flag ORDER BY applied_at ASC LIMIT 1'
    );
    const cutover = flag[0]?.applied_at
      ? new Date(flag[0].applied_at).toISOString()
      : '1970-01-01T00:00:00.000Z';

    // `day_duration_sec` clamps each event to the selected IST day — the
    // overlap of [started_at, ended_at ?? now] with [dayStart, dayEnd]. This
    // is what the drawer sums, so a span crossing midnight (or an event left
    // open for days) can never inflate the day's totals past 24h.
    const { rows } = await pool.query(
      `SELECT id, tag, started_at, ended_at, duration_sec, context,
              GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(COALESCE(ended_at, NOW()), $3::timestamptz)
                - GREATEST(started_at, $2::timestamptz)
              ))::int) AS day_duration_sec
         FROM caller_activity_events
        WHERE caller_id = $1
          AND started_at < $3
          AND started_at >= $4
          AND (ended_at IS NULL OR ended_at >= $2)
        ORDER BY started_at ASC`,
      [id, dayStartUtc.toISOString(), dayEndUtc.toISOString(), cutover]
    );

    res.json({
      caller: caller[0],
      date: dateYmd,
      day_start: dayStartUtc.toISOString(),
      day_end: dayEndUtc.toISOString(),
      events: rows,
    });
  } catch (err) {
    console.error('[admin] caller-activity error:', err.message);
    res.status(500).json({ error: 'failed to load activity' });
  }
});

/* ── GET /api/admin/sales-performance/leads-export ──
   Returns the deduplicated set of leads that match ANY of the requested
   categories within the date window, optionally scoped to a single
   webinar. Used by the Performance "Export CSV" modal so admins can
   download lead-level rows (not per-caller aggregates) for any
   combination of buckets like hot, warm, touched, connected, etc.

   Each lead appears exactly once. A `matched_categories` array on each
   row shows which buckets that lead falls into. Categories map:
     • assigned     → l.assigned_at in window
     • hot          → l.lead_score >= 4   AND assigned in window
     • warm         → l.lead_score IN (2,3) AND assigned in window
     • touched      → l.last_note_at in window AND assigned in window
     • untouched    → l.last_note_at IS NULL AND l.assigned_at < NOW() - 24h
     • follow_up    → l.last_note_outcome = 'follow_up'
     • total_calls  → has ANY call in window
     • incoming     → has inbound  call in window
     • outgoing     → has outbound call in window
     • connected    → has connected (duration_sec > 0) call in window  */
router.get('/sales-performance/leads-export', async (req, res) => {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const fromYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayYmd;
  const toYmd   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : fromYmd;
  const dayStart = new Date(`${fromYmd}T00:00:00+05:30`).toISOString();
  const dayEnd   = new Date(`${toYmd}T23:59:59.999+05:30`).toISOString();
  const webinarId = req.query.webinar_id ? String(req.query.webinar_id) : null;

  const validCats = new Set([
    'assigned', 'hot', 'warm', 'touched', 'untouched', 'follow_up',
    'total_calls', 'incoming', 'outgoing', 'connected',
  ]);
  const requested = String(req.query.categories || '')
    .split(',').map(s => s.trim()).filter(c => validCats.has(c));
  if (requested.length === 0) {
    return res.status(400).json({ error: 'no valid categories' });
  }

  // Build the per-category boolean expression. Each one tags the lead row
  // with `1` if it matches the bucket, `0` if not. The outer SELECT then
  // returns leads where ANY bucket = 1, and aggregates the matched buckets
  // into a text[] so the CSV can show which categories each lead fell into.
  try {
    const { rows } = await pool.query(
      `
      WITH w AS (
        SELECT $1::timestamptz AS d_start, $2::timestamptz AS d_end
      ),
      base AS (
        SELECT l.*,
               u.full_name AS assigned_to_name,
               u.role      AS assigned_to_role
          FROM leads l
          LEFT JOIN crm_users u ON u.id = l.assigned_user_id
         WHERE l.assigned_user_id IS NOT NULL
           AND ($3::text IS NULL OR l.webinar_id::text = $3::text)
      ),
      tagged AS (
        SELECT b.*,
               (b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_assigned,
               (b.lead_score >= 4 AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_hot,
               (b.lead_score IN (2,3) AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_warm,
               (b.last_note_at IS NOT NULL AND b.last_note_at >= w.d_start AND b.last_note_at <= w.d_end AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_touched,
               (b.last_note_at IS NULL AND b.assigned_at < NOW() - INTERVAL '24 hours')::int AS c_untouched,
               (b.last_note_outcome = 'follow_up')::int AS c_follow_up,
               (EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = b.id AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_total_calls,
               (EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = b.id AND c.direction = 'inbound'  AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_incoming,
               (EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = b.id AND c.direction = 'outbound' AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_outgoing,
               (EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = b.id AND c.duration_sec > 0 AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_connected
          FROM base b CROSS JOIN w
      )
      SELECT id, full_name, whatsapp_number, email, language_pref, sugar_level,
             diabetes_duration, lead_score, lead_tag, last_note_outcome,
             assigned_to_name, assigned_to_role,
             assigned_at, last_note_at, completed_at,
             c_assigned, c_hot, c_warm, c_touched, c_untouched, c_follow_up,
             c_total_calls, c_incoming, c_outgoing, c_connected
        FROM tagged
       WHERE ${requested.map(c => `c_${c} = 1`).join(' OR ')}
       ORDER BY assigned_at DESC NULLS LAST
       LIMIT 50000
      `,
      [dayStart, dayEnd, webinarId]
    );

    res.json({ leads: rows });
  } catch (err) {
    console.error('[admin] sales-performance/leads-export error:', err.message);
    res.status(500).json({ error: 'failed to load leads' });
  }
});

/* ── GET /api/admin/caller-leads/:callerId ──
   Returns every lead assigned to one caller, grouped client-side by
   bucket. Used by the "Caller page" drawer in the admin so an admin can
   see what the caller sees and reopen completed leads back to assigned.

   Buckets are derived from `last_note_outcome`:
     • assigned   — no outcome yet (or follow_up scheduled in the future)
     • completed  — last_note_outcome IN ('completed','not_interested')
     • not_picked — last_note_outcome IN ('not_picked','auto_paused')
   The frontend re-buckets the same payload so we don't need three queries. */
router.get('/caller-leads/:callerId', async (req, res) => {
  const { callerId } = req.params;
  if (!callerId) return res.status(400).json({ error: 'callerId required' });
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.full_name, l.whatsapp_number, l.email, l.sugar_level,
              l.diabetes_duration, l.on_medication, l.age_group, l.occupation,
              l.lead_score, l.lead_tag, l.last_note_outcome, l.last_note_at,
              l.last_note_interested, l.last_note_outcome_subtag,
              l.follow_up_at, l.completed_at, l.assigned_at, l.created_at,
              l.wa_clicked, l.utm_content,
              l.webinar_id,
              w.name AS webinar_name
         FROM leads l
         LEFT JOIN webinars w ON w.id = l.webinar_id
        WHERE l.assigned_user_id = $1
        ORDER BY COALESCE(l.last_note_at, l.assigned_at, l.created_at) DESC
        LIMIT 1000`,
      [callerId]
    );
    res.json({ leads: rows });
  } catch (err) {
    console.error('[admin] caller-leads error:', err.message);
    res.status(500).json({ error: 'failed to load caller leads' });
  }
});

/* ── POST /api/admin/leads/reopen ──
   Bulk-reopen leads — moves them back to the caller's Assigned bucket
   by clearing every closing-state column (outcome, follow_up, completed_at).
   Mirrors the existing caller-side reopen path used by /caller/leads/reopen
   but accepts an explicit list of IDs so the admin can pick exactly which
   completed leads to bring back to active.

   Body: { lead_ids: ["uuid", "uuid", ...] }
   Returns: { reopened: <count> }
*/
router.post('/leads/reopen', async (req, res) => {
  const ids = Array.isArray(req.body?.lead_ids)
    ? req.body.lead_ids.filter(x => typeof x === 'string' && x.length > 0)
    : [];
  if (ids.length === 0) return res.status(400).json({ error: 'lead_ids required' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE leads
          SET last_note_outcome        = NULL,
              last_note_interested     = NULL,
              last_note_outcome_subtag = NULL,
              last_note_at             = NULL,
              follow_up_at             = NULL,
              completed_at             = NULL,
              assigned_at              = NOW(),
              pinned_at                = NOW(),
              -- Fresh assignment ⇒ no tag. Tag is reapplied by the
              -- LeadCallNoteModal classifier only AFTER the next call's
              -- form is submitted. Without this reset, the badge from the
              -- previous completion (HOT/WARM/COLD/JUNK) would linger
              -- through the new Assigned cycle and mislead the caller.
              lead_tag                 = NULL
        WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    res.json({ reopened: rowCount });
  } catch (err) {
    console.error('[admin] leads/reopen error:', err.message);
    res.status(500).json({ error: 'failed to reopen leads' });
  }
});

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
  // Optional webinar filter — scopes lead + call aggregates to a single
  // webinar so each caller row reflects their numbers for that batch only.
  // We compare as text so the column's underlying type (BIGINT vs UUID)
  // doesn't matter to the SQL.
  const webinarId = req.query.webinar_id ? String(req.query.webinar_id) : null;
  params.push(webinarId);
  const webinarParamIdx = params.length;  // e.g. $5 if no salesperson filter

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
        -- Include paused (is_active = FALSE) callers in the result so the
        -- admin's Sales Performance kebab can show a Paused pill and a
        -- Resume action. The frontend reads is_active per row.
        -- Soft-deleted callers (deleted_at IS NOT NULL) are excluded —
        -- they shouldn't appear in the grid even though their historical
        -- calls / leads still reference them.
        -- Also surfaces the heartbeat columns so the Status column can render
        -- live green/orange/red badges per caller.
        SELECT u.id AS caller_id, u.full_name AS name, u.role, u.is_active,
               u.last_heartbeat_at, u.activity_status, u.activity_break,
               u.rest_started_at
          FROM crm_users u
         WHERE u.role IN ('junior_caller','senior_caller','team_leader','manager')
           AND u.deleted_at IS NULL
      ),
      lead_agg AS (
        -- Per-caller lead counts mirror each caller-side page exactly
        -- (Assigned / Completed / Untouched / etc.). These are
        -- CURRENT-STATE metrics, NOT date-windowed, so admins see the
        -- same number on the dashboard as the caller sees on their
        -- own page. The only exception is the enrolled field (still
        -- date-windowed for the conversion-rate / predicted-enrollments
        -- math the dashboard renders alongside the per-caller cards).
        SELECT l.assigned_user_id AS caller_id,
               -- ASSIGNED: leads on caller's Assigned page right now.
               COUNT(*) FILTER (
                 WHERE l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IS NULL
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()))
                   AND (l.webinar_id IS NULL OR l.webinar_id IN ${RECENT_WEBINARS_SQL})
               )::int AS assigned,
               -- HOT / WARM: leads on Completed page whose lead_tag
               -- (set by classifyLeadTag) matches.
               COUNT(*) FILTER (
                 WHERE l.lead_tag = 'HOT'
                   AND l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IN ('completed','not_interested','incomplete')
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW()))
               )::int AS hot,
               COUNT(*) FILTER (
                 WHERE l.lead_tag = 'WARM'
                   AND l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IN ('completed','not_interested','incomplete')
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW()))
               )::int AS warm,
               -- TOUCHED: total count of rows on caller's Completed
               -- Calls page. Mirrors GET /api/caller/leads/completed.
               COUNT(*) FILTER (
                 WHERE l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IN ('completed','not_interested','incomplete')
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW()))
               )::int AS touched,
               -- UNTOUCHED: count of caller's Untouched Leads page
               -- (uncompleted leads on OLDER webinars). Mirrors
               -- GET /api/caller/leads/untouched.
               COUNT(*) FILTER (
                 WHERE l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IS NULL
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()))
                   AND l.webinar_id IS NOT NULL
                   AND l.webinar_id NOT IN ${RECENT_WEBINARS_SQL}
               )::int AS untouched,
               -- FOLLOW-UPS: leads currently scheduled to come back as
               -- a follow-up. Shows up on caller's Completed page until
               -- follow_up_at hits, then moves to Assigned.
               COUNT(*) FILTER (
                 WHERE l.last_note_outcome = 'follow_up'
                   AND l.follow_up_at > NOW()
                   AND l.next_batch_parked = FALSE
               )::int AS followups,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed' AND l.completed_at >= w.d_start AND l.completed_at <= w.d_end)::int AS enrolled,
               -- INCOMPLETE: leads on Completed page with the
               -- "incomplete" outcome (caller was paused / disconnected
               -- mid-form). Current-state count, no date filter.
               COUNT(*) FILTER (
                 WHERE l.last_note_outcome = 'incomplete'
                   AND l.next_batch_parked = FALSE
               )::int AS incomplete
          FROM leads l CROSS JOIN w
         WHERE l.assigned_user_id IS NOT NULL
           AND ($${webinarParamIdx}::text IS NULL OR l.webinar_id::text = $${webinarParamIdx}::text)
         GROUP BY l.assigned_user_id
      ),
      lead_prev AS (
        SELECT l.assigned_user_id AS caller_id,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed' AND l.completed_at >= w.p_start AND l.completed_at <= w.p_end)::int AS enrolled_prev,
               COUNT(*) FILTER (WHERE l.assigned_at >= w.p_start AND l.assigned_at <= w.p_end)::int AS assigned_prev
          FROM leads l CROSS JOIN w
         WHERE l.assigned_user_id IS NOT NULL
           AND ($${webinarParamIdx}::text IS NULL OR l.webinar_id::text = $${webinarParamIdx}::text)
         GROUP BY l.assigned_user_id
      ),
      call_agg AS (
        SELECT c.caller_id,
               -- TOTAL CALLS: every outbound dial including ones that
               -- never connected (missed by agent OR customer). Date-
               -- windowed since calls accrue over time.
               COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS total_calls,
               -- CONNECTED: outbound calls where Tata stamped
               -- customer_answered_at (true customer pickup, not
               -- agent-only-leg).
               COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL)::int AS connected,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound'), 0)::int AS total_duration_sec,
               MAX(c.started_at) FILTER (WHERE c.direction = 'outbound') AS last_call_at
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.webinar_id::text = $${webinarParamIdx}::text
               ))
         GROUP BY c.caller_id
      ),
      -- INCOMING: count of rows in the caller's Missed Calls page.
      -- Mirrors GET /api/caller/calls/missed-inbound. Current-state
      -- count (no date filter) so the dashboard reflects whatever
      -- the caller would see on that page right now.
      missed_in_agg AS (
        SELECT c.caller_id, COUNT(*)::int AS incoming
          FROM calls c
         WHERE c.caller_id IS NOT NULL
           AND c.direction = 'inbound'
           AND (
             c.status IN ('missed','failed')
             OR (c.status = 'ringing' AND c.started_at < NOW() - INTERVAL '2 minutes')
             OR (c.status = 'ended' AND c.agent_answered_at IS NULL)
           )
         GROUP BY c.caller_id
      ),
      -- 1ST / 2ND CALL TRIGGERED: ROW_NUMBER() over (lead_id) ranks
      -- outbound calls in time order. attempt_num=1 = the original
      -- trigger, attempt_num=2 = the auto-redial (agent_ringing_2
      -- flow). We count how many calls answered the customer at each
      -- attempt level, per caller, within the date window.
      attempt_ranked AS (
        SELECT c.id, c.caller_id, c.lead_id, c.customer_answered_at,
               c.started_at, c.direction,
               ROW_NUMBER() OVER (PARTITION BY c.lead_id ORDER BY c.started_at) AS attempt_num
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.direction = 'outbound'
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.webinar_id::text = $${webinarParamIdx}::text
               ))
      ),
      attempt_agg AS (
        SELECT caller_id,
               COUNT(*) FILTER (WHERE attempt_num = 1 AND customer_answered_at IS NOT NULL)::int AS first_call_answered,
               COUNT(*) FILTER (WHERE attempt_num = 2 AND customer_answered_at IS NOT NULL)::int AS second_call_answered
          FROM attempt_ranked
         GROUP BY caller_id
      ),
      call_prev AS (
        SELECT c.caller_id,
               COUNT(*)::int AS total_calls_prev
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.p_start AND c.started_at <= w.p_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.webinar_id::text = $${webinarParamIdx}::text
               ))
         GROUP BY c.caller_id
      )
      SELECT cb.caller_id, cb.name, cb.role, cb.is_active,
             cb.last_heartbeat_at, cb.activity_status, cb.activity_break, cb.rest_started_at,
             COALESCE(la.assigned, 0)            AS assigned,
             COALESCE(la.hot, 0)                 AS hot,
             COALESCE(la.warm, 0)                AS warm,
             COALESCE(la.touched, 0)             AS touched,
             COALESCE(la.untouched, 0)           AS untouched,
             COALESCE(la.followups, 0)           AS followups,
             COALESCE(la.incomplete, 0)          AS incomplete,
             COALESCE(ca.total_calls, 0)         AS total_calls,
             COALESCE(mi.incoming, 0)            AS incoming,
             COALESCE(ca.connected, 0)           AS connected,
             COALESCE(ca.total_duration_sec, 0)  AS total_duration_sec,
             ca.last_call_at                     AS last_call_at,
             COALESCE(la.enrolled, 0)            AS enrolled,
             COALESCE(lp.enrolled_prev, 0)       AS enrolled_prev,
             COALESCE(cp.total_calls_prev, 0)    AS total_calls_prev,
             -- Per-attempt customer-pickup counts.
             COALESCE(att.first_call_answered, 0)  AS first_call_answered,
             COALESCE(att.second_call_answered, 0) AS second_call_answered
        FROM caller_base cb
        LEFT JOIN lead_agg  la ON la.caller_id = cb.caller_id
        LEFT JOIN lead_prev lp ON lp.caller_id = cb.caller_id
        LEFT JOIN call_agg     ca  ON ca.caller_id  = cb.caller_id
        LEFT JOIN call_prev    cp  ON cp.caller_id  = cb.caller_id
        LEFT JOIN missed_in_agg mi ON mi.caller_id = cb.caller_id
        LEFT JOIN attempt_agg  att ON att.caller_id = cb.caller_id
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
      followups:           sum('followups'),
      incomplete:          sum('incomplete'),
      total_calls:         teamCalls,
      incoming:            sum('incoming'),
      connected:           teamConnected,
      total_duration_sec:  teamDuration,
      enrolled:            teamEnrolled,
      first_call_answered:  sum('first_call_answered'),
      second_call_answered: sum('second_call_answered'),
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

/* ── GET /api/admin/leads/assignment-pool?from=ISO&to=ISO&webinar_id=UUID ──
   Used by the "Manual Assign Leads" modal in Sales → Leads.
   `webinar_id` is optional — when supplied the pool is restricted to leads
   tied to that webinar.
   Returns:
     - available:   count of unassigned leads whose created_at falls in the
                    given datetime range.
     - callers:     active junior/senior callers (id, full_name, role)
                    with their current open-lead count for context. */
router.get('/leads/assignment-pool', async (req, res) => {
  const { from, to, webinar_id } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to ISO datetime params are required' });
  }
  try {
    const { rows: poolRows } = await pool.query(
      `SELECT COUNT(*)::int AS available
         FROM leads
        WHERE assigned_user_id IS NULL
          AND created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
          AND ($3::text IS NULL OR webinar_id::text = $3::text)`,
      [from, to, webinar_id || null]
    );
    const { rows: callers } = await pool.query(
      `SELECT u.id, u.full_name, u.role, u.is_active,
              COUNT(l.id) FILTER (
                WHERE l.last_note_outcome IS NULL
                   OR l.last_note_outcome = 'follow_up'
              )::int AS open_count
         FROM crm_users u
         LEFT JOIN leads l ON l.assigned_user_id = u.id
        WHERE u.is_active = TRUE
          AND u.role IN ('junior_caller','senior_caller')
          AND u.deleted_at IS NULL
        GROUP BY u.id
        ORDER BY u.role DESC, u.full_name ASC`
    );
    res.json({ available: poolRows[0]?.available || 0, callers });
  } catch (err) {
    console.error('assignment-pool error:', err.message);
    res.status(500).json({ error: 'Failed to load assignment pool.' });
  }
});

/* ── POST /api/admin/leads/manual-assign ──
   Hands a custom-count distribution of unassigned leads (within a datetime
   window) to a chosen set of callers. Each entry in `distribution` says
   "give caller X exactly N leads".

   Body:
     {
       from:         ISO datetime (created_at >=),
       to:           ISO datetime (created_at <=),
       webinar_id:   UUID (optional — restrict the pool to one webinar),
       distribution: [{ user_id: UUID, count: integer ≥ 1 }, …]
     }

   Leads are pulled in created_at ASC order so the OLDEST unassigned leads
   are handed out first. The caller distribution is processed in the order
   supplied. If the requested total exceeds availability, the LAST callers
   in the list get short rations or zero — we never error half-way.

   Wrapped in a transaction with row-level locks so a concurrent manual /
   auto assign cannot grab the same leads. */
router.post('/leads/manual-assign', async (req, res) => {
  const { from, to, webinar_id } = req.body || {};
  const distribution = Array.isArray(req.body?.distribution) ? req.body.distribution : null;

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to ISO datetime params are required' });
  }
  if (!distribution || distribution.length === 0) {
    return res.status(400).json({ error: 'distribution must be a non-empty array' });
  }

  // Validate distribution shape — UUID + integer count ≥ 1 per row, no dupes.
  const seen = new Set();
  for (const row of distribution) {
    if (!row || typeof row !== 'object') {
      return res.status(400).json({ error: 'distribution rows must be objects' });
    }
    if (!row.user_id || typeof row.user_id !== 'string') {
      return res.status(400).json({ error: 'each distribution row needs user_id' });
    }
    if (seen.has(row.user_id)) {
      return res.status(400).json({ error: 'distribution user_ids must be distinct' });
    }
    seen.add(row.user_id);
    if (!Number.isInteger(row.count) || row.count < 1) {
      return res.status(400).json({ error: 'each count must be an integer ≥ 1' });
    }
  }

  const totalRequested = distribution.reduce((s, r) => s + r.count, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify every destination is an active junior/senior caller.
    const userIds = distribution.map(r => r.user_id);
    const { rows: tgt } = await client.query(
      `SELECT id FROM crm_users
        WHERE id = ANY($1::uuid[])
          AND is_active = TRUE
          AND role IN ('junior_caller','senior_caller')`,
      [userIds]
    );
    if (tgt.length !== userIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or more destination callers not found or not active.' });
    }

    // Lock the available unassigned leads in the window, oldest first.
    const { rows: pool_ } = await client.query(
      `SELECT id FROM leads
        WHERE assigned_user_id IS NULL
          AND created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
          AND ($4::text IS NULL OR webinar_id::text = $4::text)
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3`,
      [from, to, totalRequested, webinar_id || null]
    );
    const available = pool_.length;

    // Walk distribution in order, slicing leads off the front of the pool.
    let cursor = 0;
    const actual = [];
    for (const row of distribution) {
      const ask = Math.min(row.count, available - cursor);
      if (ask <= 0) {
        actual.push({ user_id: row.user_id, requested: row.count, assigned: 0 });
        continue;
      }
      const chunkIds = pool_.slice(cursor, cursor + ask).map(r => r.id);
      cursor += ask;
      await client.query(
        `UPDATE leads
            SET assigned_user_id = $1::uuid,
                assigned_at      = NOW()
          WHERE id = ANY($2::uuid[])`,
        [row.user_id, chunkIds]
      );
      actual.push({ user_id: row.user_id, requested: row.count, assigned: ask });
    }

    await client.query('COMMIT');

    res.json({
      total_requested: totalRequested,
      total_assigned:  cursor,
      available,
      distribution:    actual,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('manual-assign error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to assign leads.' });
  } finally {
    client.release();
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
