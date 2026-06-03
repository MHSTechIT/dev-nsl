/*
 * nsmDashboard.js — NSM-Caller "Web Reminder" admin dashboard endpoints.
 *
 * A faithful clone of Meta's Sales-Dashboard / Web-Reminder admin endpoints
 * (routes/admin.js), re-scoped to the independent nsm_* tables. Mounted by
 * app.js at  /api/admin/nsm  (alongside the existing nsm batch/leads/users
 * admin endpoints that live in admin.js — the sub-paths here never collide
 * with those: batches|leads|users|settings|sync|lead-forms|whatsapp|ivr-config).
 *
 * Table swaps vs Meta:
 *   crm_users               → nsm_users
 *   leads                   → nsm_leads
 *   calls                   → nsm_calls
 *   lead_call_notes         → nsm_lead_call_notes
 *   caller_activity_events  → nsm_caller_activity_events
 *   lead_share_config       → nsm_lead_share_config
 *   round_robin_state       → nsm_round_robin_state
 *   timer_settings          → nsm_timer_settings
 *
 * Webinar dimension: Meta keys leads by leads.webinar_id → webinars. NSM has
 * no webinars table, so the "webinar" dimension is nsm_batches and the lead's
 * webinar key is nsm_leads.batch_id. A `webinar_id` query param therefore means
 * a batch id (filter nsm_leads.batch_id = $webinar_id), and the webinar name is
 * nsm_batches.batch_name (aliased AS webinar_name to match Meta's response).
 * NSM leads do NOT age out, so Meta's "recent webinars" windowing is dropped —
 * every batch is always in scope (no untouched-by-age bucket).
 *
 * Field-name parity: every response key / SELECT alias is kept IDENTICAL to
 * Meta's so the cloned frontend renders unchanged. nsm_leads lacks some Meta
 * lead columns (source, sugar_level, diabetes_duration, language_pref,
 * lead_score, on_medication, age_group, occupation, utm_content, wa_clicked,
 * webinar_id) and uses `phone` instead of `whatsapp_number` — those are aliased
 * (phone AS whatsapp_number) or emitted as NULL/0 so the contract is preserved.
 *
 * Auth: same adminAuth bearer the Meta admin routes apply at the router level.
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const pool    = require('../db');
const { adminAuth }    = require('../middleware/adminAuth');
const { sendTelegram } = require('../utils/telegramNotifier');
const { mergeIvrConfig, loadIvrConfig } = require('../utils/nsmIvrCallConfig');
const { loadTeleConfig, saveTeleConfig, sendTeleMessage } = require('../utils/teleConfig');

router.use(adminAuth);

/* ──────────────────────────────────────────────────────────────────────────
   POST /media-upload — upload a WhatsApp template image/video (≤ 15 MB).
   Body is the raw file bytes (Content-Type = the file's mime). Stored in
   nsm_media (Postgres, since Render disk is ephemeral) and returned as a
   public URL whapi can fetch. Response: { id, url, type:'image'|'video', mime, size }.
   ────────────────────────────────────────────────────────────────────────── */
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
router.post('/media-upload',
  express.raw({ type: () => true, limit: MAX_MEDIA_BYTES + 256 * 1024 }),
  async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'No file received.' });
    if (buf.length > MAX_MEDIA_BYTES) return res.status(413).json({ error: 'File too large — max 15 MB.' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim() || 'application/octet-stream';
    if (!/^image\/|^video\//.test(mime)) return res.status(415).json({ error: 'Only image or video files are allowed.' });
    try {
      const { rows } = await pool.query(
        'INSERT INTO nsm_media (mime, size, data) VALUES ($1, $2, $3) RETURNING id',
        [mime, buf.length, buf]
      );
      const id = rows[0].id;
      const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      res.json({
        id,
        url:  `${base}/api/nsm-media/${id}`,
        type: mime.startsWith('video/') ? 'video' : 'image',
        mime,
        size: buf.length,
      });
    } catch (e) {
      console.error('[nsm] media-upload error:', e.message);
      res.status(500).json({ error: 'Upload failed.' });
    }
  }
);

/* ──────────────────────────────────────────────────────────────────────────
   IVR campaign config for the NSM-Caller workspace (nsm_call_config). Same
   dynamic-campaigns shape as NSM-IVR; the NsmIvrPage editor posts here when
   rendered with apiBase /api/admin/nsm. The caller IVR scheduler reads it.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/ivr-config', async (_req, res) => {
  try { res.json({ config: await loadIvrConfig('nsm_call_config') }); }
  catch (err) { res.status(500).json({ error: 'Failed to load IVR config' }); }
});
router.put('/ivr-config', async (req, res) => {
  const incoming = req.body && req.body.config;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'config object required' });
  const merged = mergeIvrConfig(incoming);
  try {
    await pool.query(
      `INSERT INTO nsm_call_config (id, config, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
    res.json({ config: merged });
  } catch (err) { res.status(500).json({ error: 'Failed to save IVR config' }); }
});

/* ──────────────────────────────────────────────────────────────────────────
   Telegram alert config (NSM-Caller). { enabled, bot_token, chat_id }.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/tele-config', async (_req, res) => {
  try { res.json({ config: await loadTeleConfig('nsm_tele_config') }); }
  catch (e) { res.status(500).json({ error: 'Failed to load Telegram config' }); }
});
router.put('/tele-config', async (req, res) => {
  const inc = req.body && req.body.config;
  if (!inc || typeof inc !== 'object') return res.status(400).json({ error: 'config object required' });
  try { res.json({ config: await saveTeleConfig('nsm_tele_config', inc) }); }
  catch (e) { res.status(500).json({ error: 'Failed to save Telegram config' }); }
});
router.post('/tele-config/test', async (_req, res) => {
  try {
    const cfg = await loadTeleConfig('nsm_tele_config');
    await sendTeleMessage({ bot_token: cfg.bot_token, chat_id: cfg.chat_id });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ──────────────────────────────────────────────────────────────────────────
   GET /leads/assignment-pool?from=ISO&to=ISO[&webinar_id] — manual-assign pool.
   webinar_id = batch id (filter nsm_leads.batch_id). Mirrors Meta, nsm tables,
   created_time instead of created_at, no source scoping.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/leads/assignment-pool', async (req, res) => {
  const { from, to, webinar_id } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to ISO datetime params are required' });
  try {
    const { rows: poolRows } = await pool.query(
      `SELECT COUNT(*)::int AS available
         FROM nsm_leads
        WHERE assigned_user_id IS NULL AND deleted_at IS NULL
          AND created_time >= $1::timestamptz
          AND created_time <= $2::timestamptz
          AND ($3::text IS NULL OR batch_id::text = $3::text)`,
      [from, to, webinar_id || null]
    );
    const { rows: callers } = await pool.query(
      `SELECT u.id, u.full_name, u.role, u.is_active,
              COUNT(l.id) FILTER (
                WHERE l.last_note_outcome IS NULL OR l.last_note_outcome = 'follow_up'
              )::int AS open_count
         FROM nsm_users u
         LEFT JOIN nsm_leads l ON l.assigned_user_id = u.id AND l.deleted_at IS NULL
        WHERE u.is_active = TRUE
          AND u.role IN ('junior_caller','senior_caller')
          AND u.deleted_at IS NULL
        GROUP BY u.id
        ORDER BY u.role DESC, u.full_name ASC`
    );
    res.json({ available: poolRows[0]?.available || 0, callers });
  } catch (err) {
    console.error('[nsm] assignment-pool error:', err.message);
    res.status(500).json({ error: 'Failed to load assignment pool.' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   POST /leads/manual-assign — distribute oldest unassigned nsm_leads to callers.
   Body { from, to, webinar_id(=batch), distribution:[{user_id,count}] }.
   Transaction + FOR UPDATE SKIP LOCKED, oldest-first by created_time.
   ────────────────────────────────────────────────────────────────────────── */
router.post('/leads/manual-assign', async (req, res) => {
  const { from, to, webinar_id } = req.body || {};
  const distribution = Array.isArray(req.body?.distribution) ? req.body.distribution : null;
  if (!from || !to) return res.status(400).json({ error: 'from and to ISO datetime params are required' });
  if (!distribution || distribution.length === 0) return res.status(400).json({ error: 'distribution must be a non-empty array' });
  const seen = new Set();
  for (const row of distribution) {
    if (!row || typeof row !== 'object') return res.status(400).json({ error: 'distribution rows must be objects' });
    if (!row.user_id || typeof row.user_id !== 'string') return res.status(400).json({ error: 'each distribution row needs user_id' });
    if (seen.has(row.user_id)) return res.status(400).json({ error: 'distribution user_ids must be distinct' });
    seen.add(row.user_id);
    if (!Number.isInteger(row.count) || row.count < 1) return res.status(400).json({ error: 'each count must be an integer ≥ 1' });
  }
  const totalRequested = distribution.reduce((s, r) => s + r.count, 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userIds = distribution.map(r => r.user_id);
    const { rows: tgt } = await client.query(
      `SELECT id FROM nsm_users
        WHERE id = ANY($1::uuid[]) AND is_active = TRUE AND role IN ('junior_caller','senior_caller')`,
      [userIds]
    );
    if (tgt.length !== userIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or more destination callers not found or not active.' });
    }
    const { rows: pool_ } = await client.query(
      `SELECT id FROM nsm_leads
        WHERE assigned_user_id IS NULL AND deleted_at IS NULL
          AND created_time >= $1::timestamptz
          AND created_time <= $2::timestamptz
          AND ($4::text IS NULL OR batch_id::text = $4::text)
        ORDER BY created_time ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3`,
      [from, to, totalRequested, webinar_id || null]
    );
    const available = pool_.length;
    let cursor = 0;
    const actual = [];
    for (const row of distribution) {
      const ask = Math.min(row.count, available - cursor);
      if (ask <= 0) { actual.push({ user_id: row.user_id, requested: row.count, assigned: 0 }); continue; }
      const chunkIds = pool_.slice(cursor, cursor + ask).map(r => r.id);
      cursor += ask;
      await client.query(
        `UPDATE nsm_leads SET assigned_user_id = $1::uuid, assigned_at = NOW() WHERE id = ANY($2::uuid[])`,
        [row.user_id, chunkIds]
      );
      actual.push({ user_id: row.user_id, requested: row.count, assigned: ask });
    }
    await client.query('COMMIT');
    res.json({ total_requested: totalRequested, total_assigned: cursor, available, distribution: actual });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[nsm] manual-assign error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to assign leads.' });
  } finally {
    client.release();
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   1. GET /sales-performance?from,to[,webinar_id]
   Per-caller performance grid. Same row fields + team_totals + window as Meta.
   webinar_id = nsm_batches.id, filtered via nsm_leads.batch_id. Source scoping
   is dropped (single NSM workspace). Recent-webinar restriction dropped — every
   batch is in scope, so the "untouched" (aged) bucket is always 0.
   ────────────────────────────────────────────────────────────────────────── */
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
  // Optional batch (== webinar) filter — scopes lead + call aggregates to a
  // single batch. Compared as text so the column's underlying type is irrelevant.
  const webinarId = req.query.webinar_id ? String(req.query.webinar_id) : null;
  params.push(webinarId);
  const webinarParamIdx = params.length;

  try {
    // Predicted-enrollments coefficient: enrolled-hot / total-hot over last 30
    // days, globally. nsm_leads has no lead_score, so "hot" here is keyed on
    // lead_tag = 'HOT' (the classifier that NSM actually writes).
    const ratioRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN last_note_outcome = 'completed' AND lead_tag = 'HOT' THEN 1 ELSE 0 END), 0)::float
        / NULLIF(SUM(CASE WHEN lead_tag = 'HOT' THEN 1 ELSE 0 END), 0) AS ratio
      FROM nsm_leads
      WHERE assigned_at >= NOW() - INTERVAL '30 days'
    `);
    const hotToEnrollRatio = ratioRes.rows[0]?.ratio ?? 0;

    const { rows } = await pool.query(`
      WITH w AS (
        SELECT $1::timestamptz AS d_start, $2::timestamptz AS d_end,
               $3::timestamptz AS p_start, $4::timestamptz AS p_end
      ),
      caller_base AS (
        SELECT u.id AS caller_id, u.full_name AS name, u.role, u.is_active,
               u.last_heartbeat_at, u.activity_status, u.activity_break,
               u.rest_started_at
          FROM nsm_users u
         WHERE u.role IN ('junior_caller','senior_caller','team_leader','manager')
           AND u.deleted_at IS NULL
      ),
      lead_agg AS (
        SELECT l.assigned_user_id AS caller_id,
               -- ASSIGNED: every batch is in scope for NSM (no aging), so the
               -- recent-webinar restriction Meta applies is dropped.
               COUNT(*) FILTER (
                 WHERE l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IS NULL
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()))
               )::int AS assigned,
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
               COUNT(*) FILTER (
                 WHERE l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IN ('completed','not_interested','incomplete')
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW()))
               )::int AS touched,
               -- UNTOUCHED: Meta counts no-note leads on OLDER (aged-out)
               -- webinars. NSM leads never age out, so this is always 0.
               0::int AS untouched,
               COUNT(*) FILTER (
                 WHERE l.last_note_outcome = 'follow_up'
                   AND l.follow_up_at > NOW()
                   AND l.next_batch_parked = FALSE
               )::int AS followups,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed' AND l.completed_at >= w.d_start AND l.completed_at <= w.d_end)::int AS enrolled,
               COUNT(*) FILTER (
                 WHERE l.last_note_outcome = 'incomplete'
                   AND l.next_batch_parked = FALSE
               )::int AS incomplete
          FROM nsm_leads l CROSS JOIN w
         WHERE l.assigned_user_id IS NOT NULL
           AND ($${webinarParamIdx}::text IS NULL OR l.batch_id::text = $${webinarParamIdx}::text)
         GROUP BY l.assigned_user_id
      ),
      lead_prev AS (
        SELECT l.assigned_user_id AS caller_id,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed' AND l.completed_at >= w.p_start AND l.completed_at <= w.p_end)::int AS enrolled_prev,
               COUNT(*) FILTER (WHERE l.assigned_at >= w.p_start AND l.assigned_at <= w.p_end)::int AS assigned_prev
          FROM nsm_leads l CROSS JOIN w
         WHERE l.assigned_user_id IS NOT NULL
           AND ($${webinarParamIdx}::text IS NULL OR l.batch_id::text = $${webinarParamIdx}::text)
         GROUP BY l.assigned_user_id
      ),
      call_agg AS (
        SELECT c.caller_id,
               COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS total_calls,
               COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL)::int AS connected,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound'), 0)::int AS total_duration_sec,
               MAX(c.started_at) FILTER (WHERE c.direction = 'outbound') AS last_call_at
          FROM nsm_calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM nsm_leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.batch_id::text = $${webinarParamIdx}::text
               ))
         GROUP BY c.caller_id
      ),
      missed_in_agg AS (
        SELECT c.caller_id, COUNT(*)::int AS incoming
          FROM nsm_calls c
         WHERE c.caller_id IS NOT NULL
           AND c.direction = 'inbound'
           AND (
             c.status IN ('missed','failed')
             OR (c.status = 'ringing' AND c.started_at < NOW() - INTERVAL '2 minutes')
             OR (c.status = 'ended' AND c.agent_answered_at IS NULL)
           )
         GROUP BY c.caller_id
      ),
      attempt_ranked AS (
        SELECT c.id, c.caller_id, c.lead_id, c.customer_answered_at,
               c.started_at, c.direction,
               ROW_NUMBER() OVER (PARTITION BY c.lead_id ORDER BY c.started_at) AS attempt_num
          FROM nsm_calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.direction = 'outbound'
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM nsm_leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.batch_id::text = $${webinarParamIdx}::text
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
          FROM nsm_calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.p_start AND c.started_at <= w.p_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM nsm_leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.batch_id::text = $${webinarParamIdx}::text
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
    console.error('nsm/sales-performance error:', err.message);
    res.status(500).json({ error: 'Failed to load sales performance.' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   2. GET /caller-report?from,to[,webinar_id]
   "Caller 360" — telephony activity + lead-disposition atoms per caller.
   Same column keys as Meta. webinar_id = batch id (nsm_leads.batch_id).
   "batch" label = the caller's most common nsm_batches.batch_name.
   untouched (aged) is always 0 for NSM.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/caller-report', async (req, res) => {
  const istNow   = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const fromYmd  = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayYmd;
  const toYmd    = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to   || '') ? req.query.to   : fromYmd;
  const dayStart = new Date(`${fromYmd}T00:00:00+05:30`).toISOString();
  const dayEnd   = new Date(`${toYmd}T23:59:59.999+05:30`).toISOString();
  const webinarId = req.query.webinar_id ? String(req.query.webinar_id) : null;
  const params = [dayStart, dayEnd, webinarId]; // $1, $2, $3

  try {
    const { rows } = await pool.query(`
      WITH w AS (
        SELECT $1::timestamptz AS d_start, $2::timestamptz AS d_end
      ),
      caller_base AS (
        SELECT u.id AS caller_id, u.full_name AS name, u.role, u.is_active,
               u.tata_extension
          FROM nsm_users u
         WHERE u.role IN ('junior_caller','senior_caller')
           AND u.deleted_at IS NULL
      ),
      call_agg AS (
        SELECT c.caller_id,
               COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS touched,
               COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL)::int AS answered,
               COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NULL)::int AS missed,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL), 0)::int AS answered_dur_sec,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NULL), 0)::int AS missed_dur_sec,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound'), 0)::int AS total_dur_sec
          FROM nsm_calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
           AND ($3::text IS NULL OR EXISTS (
                 SELECT 1 FROM nsm_leads ll
                  WHERE ll.id = c.lead_id AND ll.batch_id::text = $3::text
               ))
         GROUP BY c.caller_id
      ),
      disp_agg AS (
        SELECT l.assigned_user_id AS caller_id,
               mode() WITHIN GROUP (ORDER BY web.batch_name) AS batch,
               COUNT(*)::int AS assigned,
               COUNT(*) FILTER (WHERE l.last_note_outcome IS NOT NULL)::int AS with_note,
               COUNT(*) FILTER (WHERE l.last_note_outcome IS NULL)::int AS new_leads,
               COUNT(*) FILTER (WHERE l.last_note_interested = 'yes')::int AS interested,
               COUNT(*) FILTER (WHERE l.next_batch_parked = TRUE)::int AS next_batch,
               COUNT(*) FILTER (WHERE l.lead_tag = 'HOT')::int  AS hot,
               COUNT(*) FILTER (WHERE l.lead_tag = 'WARM')::int AS warm,
               COUNT(*) FILTER (WHERE l.lead_tag = 'COLD')::int AS cold,
               COUNT(*) FILTER (WHERE l.lead_tag = 'JUNK')::int AS junk,
               -- UNTOUCHED: Meta counts no-note leads on aged-out webinars.
               -- NSM leads never age out, so this atom is always 0.
               0::int AS untouched,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed')::int AS o_completed,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW())::int AS o_follow_up,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'not_interested')::int AS o_not_interested,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'not_picked')::int AS o_not_picked,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'incomplete')::int AS o_incomplete,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'other_languages')::int          AS st_other_languages,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'already_paid')::int             AS st_already_paid,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'not_available_for_webinar')::int AS st_not_available_for_webinar,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'no_diabetes')::int              AS st_no_diabetes,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'no_sugar_interested')::int      AS st_no_sugar_interested,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'no_sugar_not_interested')::int  AS st_no_sugar_not_interested,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'not_register')::int             AS st_not_register,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'just_for_knowledge')::int       AS st_just_for_knowledge,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'call_disconnected')::int        AS st_call_disconnected,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'wrong_number')::int             AS st_wrong_number,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'already_attended')::int         AS st_already_attended,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'switch_off')::int               AS st_switch_off,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'out_of_service')::int           AS st_out_of_service,
               COUNT(*) FILTER (WHERE l.last_note_outcome_subtag = 'no_ring')::int                  AS st_no_ring
          FROM nsm_leads l
          LEFT JOIN nsm_batches web ON web.id = l.batch_id
         WHERE l.assigned_user_id IS NOT NULL
           AND ($3::text IS NULL OR l.batch_id::text = $3::text)
         GROUP BY l.assigned_user_id
      )
      SELECT cb.caller_id, cb.name, cb.role, cb.is_active, cb.tata_extension,
             da.batch,
             COALESCE(ca.touched, 0)          AS touched,
             COALESCE(ca.answered, 0)         AS answered,
             COALESCE(ca.missed, 0)           AS missed,
             COALESCE(ca.answered_dur_sec, 0) AS answered_dur_sec,
             COALESCE(ca.missed_dur_sec, 0)   AS missed_dur_sec,
             COALESCE(ca.total_dur_sec, 0)    AS total_dur_sec,
             COALESCE(da.assigned, 0)         AS assigned,
             COALESCE(da.with_note, 0)        AS with_note,
             COALESCE(da.new_leads, 0)        AS new_leads,
             COALESCE(da.interested, 0)       AS interested,
             COALESCE(da.next_batch, 0)       AS next_batch,
             COALESCE(da.hot, 0)              AS hot,
             COALESCE(da.warm, 0)             AS warm,
             COALESCE(da.cold, 0)             AS cold,
             COALESCE(da.junk, 0)             AS junk,
             COALESCE(da.untouched, 0)        AS untouched,
             COALESCE(da.o_completed, 0)      AS o_completed,
             COALESCE(da.o_follow_up, 0)      AS o_follow_up,
             COALESCE(da.o_not_interested, 0) AS o_not_interested,
             COALESCE(da.o_not_picked, 0)     AS o_not_picked,
             COALESCE(da.o_incomplete, 0)     AS o_incomplete,
             COALESCE(da.st_other_languages, 0)          AS st_other_languages,
             COALESCE(da.st_already_paid, 0)             AS st_already_paid,
             COALESCE(da.st_not_available_for_webinar, 0) AS st_not_available_for_webinar,
             COALESCE(da.st_no_diabetes, 0)              AS st_no_diabetes,
             COALESCE(da.st_no_sugar_interested, 0)      AS st_no_sugar_interested,
             COALESCE(da.st_no_sugar_not_interested, 0)  AS st_no_sugar_not_interested,
             COALESCE(da.st_not_register, 0)             AS st_not_register,
             COALESCE(da.st_just_for_knowledge, 0)       AS st_just_for_knowledge,
             COALESCE(da.st_call_disconnected, 0)        AS st_call_disconnected,
             COALESCE(da.st_wrong_number, 0)             AS st_wrong_number,
             COALESCE(da.st_already_attended, 0)         AS st_already_attended,
             COALESCE(da.st_switch_off, 0)               AS st_switch_off,
             COALESCE(da.st_out_of_service, 0)           AS st_out_of_service,
             COALESCE(da.st_no_ring, 0)                  AS st_no_ring
        FROM caller_base cb
        LEFT JOIN call_agg ca ON ca.caller_id = cb.caller_id
        LEFT JOIN disp_agg da ON da.caller_id = cb.caller_id
       ORDER BY cb.name ASC
    `, params);

    const NUM_KEYS = [
      'touched','answered','missed','answered_dur_sec','missed_dur_sec','total_dur_sec',
      'assigned','with_note','new_leads','interested','next_batch',
      'hot','warm','cold','junk','untouched',
      'o_completed','o_follow_up','o_not_interested','o_not_picked','o_incomplete',
      'st_other_languages','st_already_paid','st_not_available_for_webinar','st_no_diabetes',
      'st_no_sugar_interested','st_no_sugar_not_interested','st_not_register','st_just_for_knowledge',
      'st_call_disconnected','st_wrong_number','st_already_attended','st_switch_off',
      'st_out_of_service','st_no_ring',
    ];
    const totals = {};
    for (const k of NUM_KEYS) totals[k] = rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

    res.json({
      rows,
      totals,
      window: { from: fromYmd, to: toYmd },
      webinar_id: webinarId,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('nsm/caller-report error:', err.message);
    res.status(500).json({ error: 'Failed to load caller report.' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   3. GET /caller-activity/:id?date=YYYY-MM-DD
   Per-caller activity timeline from nsm_caller_activity_events. NSM has no
   activity_log_redesign_flag cutover table, so the cutover clamp is dropped
   (all rows for the IST day are returned); response shape is identical.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/caller-activity/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const dateYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayYmd;

  const dayStartUtc = new Date(`${dateYmd}T00:00:00+05:30`);
  const dayEndUtc   = new Date(dayStartUtc.getTime() + 24 * 3600 * 1000);

  try {
    const { rows: caller } = await pool.query(
      'SELECT id, full_name, role, is_active FROM nsm_users WHERE id = $1',
      [id]
    );
    if (caller.length === 0) return res.status(404).json({ error: 'caller not found' });

    const { rows } = await pool.query(
      `SELECT id, tag, started_at, ended_at, duration_sec, context,
              GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(COALESCE(ended_at, NOW()), $3::timestamptz)
                - GREATEST(started_at, $2::timestamptz)
              ))::int) AS day_duration_sec
         FROM nsm_caller_activity_events
        WHERE caller_id = $1
          AND started_at < $3
          AND started_at >= $2
          AND (ended_at IS NULL OR ended_at >= $2)
        ORDER BY started_at ASC`,
      [id, dayStartUtc.toISOString(), dayEndUtc.toISOString()]
    );

    res.json({
      caller: caller[0],
      date: dateYmd,
      day_start: dayStartUtc.toISOString(),
      day_end: dayEndUtc.toISOString(),
      events: rows,
    });
  } catch (err) {
    console.error('[nsm] caller-activity error:', err.message);
    res.status(500).json({ error: 'failed to load activity' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   4. GET /auto-paused-callers
   nsm_users WHERE is_active=FALSE AND auto_paused_at IS NOT NULL. TL/manager
   scoping mirrors Meta (against nsm_users.team_leader_id / department).
   ────────────────────────────────────────────────────────────────────────── */
router.get('/auto-paused-callers', async (req, res) => {
  try {
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
         FROM nsm_users
        WHERE is_active = FALSE
          AND auto_paused_at IS NOT NULL
          AND deleted_at IS NULL
          ${whereExtra}
        ORDER BY auto_paused_at DESC`,
      params
    );
    res.json({ callers: rows });
  } catch (err) {
    console.error('nsm/auto-paused-callers error:', err.message);
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   5. GET /completed-calls
   Completed nsm_leads + latest note + caller name + last call id/recording.
   nsm_leads lacks several Meta lead columns (source, sugar_level,
   diabetes_duration, language_pref, lead_score) — emitted as NULL to preserve
   the response contract. whatsapp_number ← phone. webinar_name ← batch_name.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/completed-calls', async (req, res) => {
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  const params = [limit];
  let scopeSQL = '';
  if (tl) {
    params.push(req.adminUser.id);
    scopeSQL = `AND l.assigned_user_id IN (SELECT id FROM nsm_users WHERE id = $${params.length} OR team_leader_id = $${params.length})`;
  }
  try {
    const { rows } = await pool.query(`
      SELECT l.id, l.full_name, l.phone AS whatsapp_number, l.email,
             NULL::text AS source,
             NULL::text AS sugar_level, NULL::text AS diabetes_duration, NULL::text AS language_pref,
             NULL::int  AS lead_score, l.lead_tag,
             l.last_note_outcome, l.last_note_at, l.completed_at,
             l.last_note_interested, l.last_note_outcome_subtag,
             l.created_time AS created_at,
             w.batch_name AS webinar_name,
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
        FROM nsm_leads l
        LEFT JOIN nsm_batches w ON w.id = l.batch_id
        LEFT JOIN nsm_users u   ON u.id = l.assigned_user_id
        LEFT JOIN LATERAL (
          SELECT id, confirmed_range, range_for, patient_age, takes_medicine,
                 hba1c, working_professional, location, webinar_attended,
                 available_for_webinar, next_batch_joining, note, follow_up_at
            FROM nsm_lead_call_notes n
           WHERE n.lead_id = l.id
           ORDER BY n.created_at DESC
           LIMIT 1
        ) latest_note ON TRUE
        LEFT JOIN LATERAL (
          SELECT id, duration_sec, recording_url, started_at
            FROM nsm_calls c
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
    console.error('nsm/completed-calls error:', err.message);
    res.status(500).json({ error: 'Failed to fetch completed calls.' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   6. GET /calls?caller_id=&limit=50
   Recent calls for one caller + linked lead name/phone.
   ────────────────────────────────────────────────────────────────────────── */
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
             l.full_name AS lead_name,
             l.phone     AS lead_phone
        FROM nsm_calls c
        LEFT JOIN nsm_leads l ON l.id = c.lead_id
       WHERE c.caller_id = $1
       ORDER BY c.started_at DESC
       LIMIT $2
    `, [callerId, limit]);
    res.json({ calls: rows });
  } catch (err) {
    console.error('nsm/calls error:', err.message);
    res.status(500).json({ error: 'Failed to load calls.' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   7. GET /caller-workload?date=YYYY-MM-DD
   Per nsm_user pending / followups_for_date / completed_for_date / total_open.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/caller-workload', async (req, res) => {
  const date = (req.query.date || '').toString().slice(0, 10);
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
       FROM nsm_users u
       LEFT JOIN nsm_leads l ON l.assigned_user_id = u.id
       WHERE u.role IN ('junior_caller','senior_caller')
         AND u.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY u.is_active DESC, u.full_name ASC`,
      [dayStart, dayEnd]
    );
    res.json({ date: ymd, callers: rows });
  } catch (err) {
    console.error('nsm/caller-workload error:', err.message);
    res.status(500).json({ error: 'Failed to load workload.' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   8. GET /caller-leads/:callerId
   One caller's full nsm_leads roster (frontend re-buckets into assigned /
   completed / not_picked). nsm_leads lacks several Meta lead columns —
   emitted as NULL to preserve shape. on_recent_webinar is always TRUE for NSM
   (no aging). whatsapp_number ← phone. webinar_name ← batch_name.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/caller-leads/:callerId', async (req, res) => {
  const { callerId } = req.params;
  if (!callerId) return res.status(400).json({ error: 'callerId required' });
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.full_name, l.phone AS whatsapp_number, l.email,
              NULL::text AS sugar_level, NULL::text AS diabetes_duration,
              NULL::text AS on_medication, NULL::text AS age_group, NULL::text AS occupation,
              NULL::int  AS lead_score, l.lead_tag, l.last_note_outcome, l.last_note_at,
              l.last_note_interested, l.last_note_outcome_subtag,
              l.follow_up_at, l.completed_at, l.assigned_at, l.created_time AS created_at,
              NULL::boolean AS wa_clicked, NULL::text AS utm_content, l.next_batch_parked,
              l.batch_id AS webinar_id,
              TRUE AS on_recent_webinar,
              w.batch_name AS webinar_name
         FROM nsm_leads l
         LEFT JOIN nsm_batches w ON w.id = l.batch_id
        WHERE l.assigned_user_id = $1
        ORDER BY COALESCE(l.last_note_at, l.assigned_at, l.created_time) DESC
        LIMIT 1000`,
      [callerId]
    );
    res.json({ leads: rows });
  } catch (err) {
    console.error('[nsm] caller-leads error:', err.message);
    res.status(500).json({ error: 'failed to load caller leads' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   9a. POST /leads/reopen — bulk reopen nsm_leads back to Assigned.
   ────────────────────────────────────────────────────────────────────────── */
router.post('/leads/reopen', async (req, res) => {
  const ids = Array.isArray(req.body?.lead_ids)
    ? req.body.lead_ids.filter(x => typeof x === 'string' && x.length > 0)
    : [];
  if (ids.length === 0) return res.status(400).json({ error: 'lead_ids required' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE nsm_leads
          SET last_note_outcome        = NULL,
              last_note_interested     = NULL,
              last_note_outcome_subtag = NULL,
              last_note_at             = NULL,
              follow_up_at             = NULL,
              completed_at             = NULL,
              assigned_at              = NOW(),
              pinned_at                = NOW(),
              lead_tag                 = NULL
        WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    res.json({ reopened: rowCount });
  } catch (err) {
    console.error('[nsm] leads/reopen error:', err.message);
    res.status(500).json({ error: 'failed to reopen leads' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   9b. POST /leads/move — move a list of nsm_leads to a target bucket and/or
   reassign to another caller. Mirrors Meta's column rewrites.
   ────────────────────────────────────────────────────────────────────────── */
router.post('/leads/move', async (req, res) => {
  const ids = Array.isArray(req.body?.lead_ids)
    ? req.body.lead_ids.filter(x => typeof x === 'string' && x.length > 0)
    : [];
  const targetBucket = req.body?.target_bucket || null;
  const targetCaller = (typeof req.body?.target_caller_id === 'string' && req.body.target_caller_id)
    ? req.body.target_caller_id : null;
  if (ids.length === 0) return res.status(400).json({ error: 'lead_ids required' });
  if (!targetBucket && !targetCaller) return res.status(400).json({ error: 'target_bucket or target_caller_id required' });

  const cols = {};
  if (targetBucket === 'assigned') {
    Object.assign(cols, {
      last_note_outcome: `CASE WHEN last_note_outcome IS NOT NULL THEN 'follow_up' ELSE NULL END`,
      follow_up_at:      `CASE WHEN last_note_outcome IS NOT NULL THEN NOW() ELSE NULL END`,
      completed_at:      'NULL',
      next_batch_parked: 'FALSE',
      assigned_at:       'NOW()',
      pinned_at:         'NOW()',
    });
  } else if (targetBucket === 'completed') {
    Object.assign(cols, {
      last_note_outcome: `'completed'`, completed_at: 'NOW()', last_note_at: 'NOW()',
      follow_up_at: 'NULL', next_batch_parked: 'FALSE',
    });
  } else if (targetBucket === 'not_picked') {
    Object.assign(cols, {
      last_note_outcome: `'not_picked'`, last_note_at: 'NOW()',
      completed_at: 'NULL', follow_up_at: 'NULL', next_batch_parked: 'FALSE',
    });
  } else if (targetBucket === 'next_batch') {
    Object.assign(cols, { next_batch_parked: 'TRUE', next_batch_parked_at: 'NOW()' });
  } else if (targetBucket) {
    return res.status(422).json({ error: 'invalid target_bucket' });
  }

  const params = [];
  if (targetCaller) {
    params.push(targetCaller);
    cols.assigned_user_id = `$${params.length}`;
    if (!cols.assigned_at) cols.assigned_at = 'NOW()';
  }
  const setClause = Object.entries(cols).map(([k, v]) => `${k} = ${v}`).join(', ');
  params.push(ids);
  try {
    const { rowCount } = await pool.query(
      `UPDATE nsm_leads SET ${setClause} WHERE id = ANY($${params.length}::uuid[])`,
      params
    );
    res.json({ moved: rowCount });
  } catch (err) {
    console.error('[nsm] leads/move error:', err.message);
    res.status(500).json({ error: 'failed to move leads' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   9c. POST /leads/reassign — bulk-move a source caller's open / due-follow-up
   nsm_leads to one or more destination callers (with optional per-dest counts).
   Mirrors Meta's transactional reassign.
   ────────────────────────────────────────────────────────────────────────── */
router.post('/leads/reassign', async (req, res) => {
  const { from_caller_id, scope, date } = req.body || {};
  let { distribution } = req.body || {};

  if (!from_caller_id) return res.status(400).json({ error: 'from_caller_id required' });

  if (!distribution && req.body?.to_caller_id) {
    distribution = [{ to_caller_id: req.body.to_caller_id, count: null }];
  }

  if (!Array.isArray(distribution) || distribution.length === 0) {
    return res.status(400).json({ error: 'distribution must be a non-empty array' });
  }

  const allowedScopes = ['all_open', 'followups_for_date'];
  const scp = allowedScopes.includes(scope) ? scope : 'all_open';

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
    const destIds = distribution.map(d => d.to_caller_id);
    const { rows: tgt } = await client.query(
      `SELECT id FROM nsm_users
         WHERE id = ANY($1::uuid[])
           AND is_active = TRUE
           AND role IN ('junior_caller','senior_caller')`,
      [destIds]
    );
    if (tgt.length !== destIds.length) {
      return res.status(404).json({ error: 'One or more destination callers not found or not active.' });
    }

    await client.query('BEGIN');

    let leadRows;
    if (scp === 'followups_for_date') {
      ({ rows: leadRows } = await client.query(
        `SELECT id FROM nsm_leads
            WHERE assigned_user_id = $1
              AND last_note_outcome = 'follow_up'
              AND follow_up_at >= $2 AND follow_up_at <= $3
            ORDER BY assigned_at ASC NULLS LAST, id ASC
            FOR UPDATE`,
        [from_caller_id, dayStart, dayEnd]
      ));
    } else {
      ({ rows: leadRows } = await client.query(
        `SELECT id FROM nsm_leads
            WHERE assigned_user_id = $1
              AND (last_note_outcome IS NULL OR last_note_outcome = 'follow_up')
            ORDER BY assigned_at ASC NULLS LAST, id ASC
            FOR UPDATE`,
        [from_caller_id]
      ));
    }
    const totalAvailable = leadRows.length;

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

    let cursor = 0;
    for (const slot of distribution) {
      if (slot.count === 0) continue;
      const ids = leadRows.slice(cursor, cursor + slot.count).map(r => r.id);
      cursor += slot.count;
      if (ids.length === 0) continue;
      await client.query(
        `UPDATE nsm_leads
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
    console.error('nsm/leads/reassign error:', err.message);
    res.status(500).json({ error: 'Failed to reassign leads.' });
  } finally {
    client.release();
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   10. GET /sales-performance/leads-export?from,to,categories[,webinar_id]
   Deduplicated lead rows matching ANY requested category, each tagged with the
   buckets it falls into. webinar_id = batch id (nsm_leads.batch_id).
   nsm_leads lacks lead_score / language_pref / sugar_level / diabetes_duration
   / whatsapp_number — aliased (phone AS whatsapp_number) or emitted as NULL.
   c_hot / c_warm key on lead_tag (NSM's classifier) instead of lead_score.
   ────────────────────────────────────────────────────────────────────────── */
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
          FROM nsm_leads l
          LEFT JOIN nsm_users u ON u.id = l.assigned_user_id
         WHERE l.assigned_user_id IS NOT NULL
           AND ($3::text IS NULL OR l.batch_id::text = $3::text)
      ),
      tagged AS (
        SELECT b.*,
               (b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_assigned,
               (b.lead_tag = 'HOT' AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_hot,
               (b.lead_tag = 'WARM' AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_warm,
               (b.last_note_at IS NOT NULL AND b.last_note_at >= w.d_start AND b.last_note_at <= w.d_end AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_touched,
               -- NSM leads never age out → no untouched-by-age bucket.
               0 AS c_untouched,
               (b.last_note_outcome = 'follow_up')::int AS c_follow_up,
               (EXISTS (SELECT 1 FROM nsm_calls c WHERE c.lead_id = b.id AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_total_calls,
               (EXISTS (SELECT 1 FROM nsm_calls c WHERE c.lead_id = b.id AND c.direction = 'inbound'  AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_incoming,
               (EXISTS (SELECT 1 FROM nsm_calls c WHERE c.lead_id = b.id AND c.direction = 'outbound' AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_outgoing,
               (EXISTS (SELECT 1 FROM nsm_calls c WHERE c.lead_id = b.id AND c.duration_sec > 0 AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_connected
          FROM base b CROSS JOIN w
      )
      SELECT id, full_name, phone AS whatsapp_number, email,
             NULL::text AS language_pref, NULL::text AS sugar_level,
             NULL::text AS diabetes_duration, NULL::int AS lead_score,
             lead_tag, last_note_outcome,
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
    console.error('[nsm] sales-performance/leads-export error:', err.message);
    res.status(500).json({ error: 'failed to load leads' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   11. GET /timer-settings + PUT /timer-settings
   Read/merge/save nsm_timer_settings using the SAME timerDefaults helper +
   BOUNDS as Meta. NSM has no separate scheduler, so the PUT skips the
   scheduler-restart / SSE broadcast side effects — it just persists + returns
   the merged settings. TLs are rejected on PUT (same 403 rule as Meta).
   ────────────────────────────────────────────────────────────────────────── */
router.get('/timer-settings', async (req, res) => {
  try {
    const { mergeTimerSettings } = require('../utils/timerDefaults');
    const { rows } = await pool.query('SELECT settings FROM nsm_timer_settings WHERE id = 1');
    res.json({ settings: mergeTimerSettings(rows[0]?.settings || {}) });
  } catch (err) {
    console.error('nsm/get timer-settings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch timer settings' });
  }
});

router.put('/timer-settings', async (req, res) => {
  if (req.adminUser && req.adminUser.kind === 'tl') {
    return res.status(403).json({ error: 'Team leaders cannot modify timer settings.' });
  }
  try {
    const { mergeTimerSettings } = require('../utils/timerDefaults');
    const merged = mergeTimerSettings(req.body && req.body.settings);
    await pool.query(
      'UPDATE nsm_timer_settings SET settings = $1::jsonb, updated_at = NOW() WHERE id = 1',
      [JSON.stringify(merged)]
    );
    res.json({ settings: merged });
  } catch (err) {
    console.error('nsm/update timer-settings error:', err.message);
    res.status(500).json({ error: 'Failed to update timer settings' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   12. Telegram alert recipients CRUD + test — on nsm_telegram_alerts.
       GET /telegram-alerts, POST /telegram-alerts, PATCH /telegram-alerts/:id,
       DELETE /telegram-alerts/:id, POST /telegram-alerts/:id/test.
       team_leader_name is joined from nsm_users. /test reuses the shared
       telegramNotifier.sendTelegram (needs TELEGRAM_BOT_TOKEN); if the token is
       unavailable the util returns {ok:false} → we surface a 502, mirroring the
       Meta test path.
   ────────────────────────────────────────────────────────────────────────── */
router.get('/telegram-alerts', async (req, res) => {
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  const params = [];
  let whereSQL = '';
  if (tl) {
    params.push(req.adminUser.id);
    whereSQL = `WHERE r.target_type = 'team_leader' AND r.team_leader_id = $1`;
  }
  try {
    const { rows } = await pool.query(`
      SELECT r.id,
             r.telegram_chat_id,
             r.target_type,
             r.team_leader_id,
             r.department,
             r.label,
             r.created_at,
             tl.full_name AS team_leader_name
        FROM nsm_telegram_alerts r
        LEFT JOIN nsm_users tl ON tl.id = r.team_leader_id
       ${whereSQL}
       ORDER BY r.created_at DESC
    `, params);
    res.json({ recipients: rows });
  } catch (err) {
    console.error('nsm/GET telegram-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to load Telegram recipients.' });
  }
});

router.post(
  '/telegram-alerts',
  body('telegram_chat_id').isString().trim().notEmpty().withMessage('Telegram User ID is required.'),
  body('target_type').isIn(['team_leader', 'manager']).withMessage('target_type must be team_leader or manager.'),
  body('team_leader_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Invalid team_leader_id.'),
  body('department').optional({ nullable: true, checkFalsy: true }).isIn(['sales', 'marketing']).withMessage('Department must be sales or marketing.'),
  body('label').optional({ nullable: true }).isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { telegram_chat_id, target_type, team_leader_id, department, label } = req.body;

    if (target_type === 'team_leader' && !team_leader_id) {
      return res.status(400).json({ error: 'team_leader_id is required when target_type=team_leader.' });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO nsm_telegram_alerts
           (telegram_chat_id, target_type, team_leader_id, department, label)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          String(telegram_chat_id).trim(),
          target_type,
          target_type === 'team_leader' ? team_leader_id : null,
          target_type === 'manager'     ? (department || null) : null,
          label || null,
        ]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      console.error('nsm/POST telegram-alerts error:', err.message);
      res.status(500).json({ error: 'Failed to create recipient.' });
    }
  }
);

router.patch('/telegram-alerts/:id', async (req, res) => {
  const allowed = ['telegram_chat_id', 'target_type', 'team_leader_id', 'department', 'label'];
  const set = [];
  const vals = [];
  for (const k of allowed) {
    if (k in req.body) {
      set.push(`${k} = $${set.length + 1}`);
      vals.push(req.body[k] === '' ? null : req.body[k]);
    }
  }
  if (set.length === 0) return res.status(400).json({ error: 'No fields to update.' });
  vals.push(req.params.id);
  try {
    const { rowCount } = await pool.query(
      `UPDATE nsm_telegram_alerts SET ${set.join(', ')} WHERE id = $${vals.length}`,
      vals
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Recipient not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('nsm/PATCH telegram-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to update recipient.' });
  }
});

router.delete('/telegram-alerts/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM nsm_telegram_alerts WHERE id = $1`,
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Recipient not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('nsm/DELETE telegram-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to delete recipient.' });
  }
});

router.post('/telegram-alerts/:id/test', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT telegram_chat_id, label FROM nsm_telegram_alerts WHERE id = $1`,
      [req.params.id]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Recipient not found.' });

    const result = await sendTelegram(
      r.telegram_chat_id,
      `✅ <b>NSM CRM test message</b>\n\nIf you can read this, alerts are wired up correctly for <b>${r.label || 'this recipient'}</b>.`
    );
    if (!result || !result.ok) return res.status(502).json({ error: (result && result.error) || 'Telegram send failed.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('nsm/POST telegram-alerts/:id/test error:', err.message);
    res.status(500).json({ error: 'Test send failed.' });
  }
});

module.exports = router;
