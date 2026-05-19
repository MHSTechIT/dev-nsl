/**
 * Caller-scoped API. Mounted at /api/caller, all routes go through callerAuth.
 *
 *   GET  /api/caller/me               — return the JWT-decoded caller info
 *   GET  /api/caller/leads            — leads assigned to req.caller.id
 *   GET  /api/caller/leads/events     — SSE; pushes new lead assignments
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const callerSse = require('../utils/callerSse');
const { callerAuth } = require('../middleware/callerAuth');
const tataInboundSync = require('../utils/tataInboundSync');
const activityLogger = require('../utils/activityLogger');

router.use(callerAuth);

/* ── POST /api/caller/heartbeat ──
   Caller's browser fires this every ~30s and on every activity-state change
   (auto-call start/stop, call start/end, break start/end). Server records the
   most recent state so the admin's Sales Performance "Status" column can
   render live green/orange/red badges.

   Body: { status: 'working'|'on_break'|'idle', break?: {...} }
     - status='working': in a call or auto-call mode
     - status='on_break': break modal is up
     - status='idle':    nothing active

   rest_started_at transitions:
     - any → 'working'      → rest_started_at = NULL
     - 'working' → other    → rest_started_at = NOW() (only if was previously NULL)
     - other → other        → rest_started_at unchanged */
router.post('/heartbeat', async (req, res) => {
  const { status, break: breakInfo } = req.body || {};
  const allowed = new Set(['working', 'on_break', 'idle']);
  if (!allowed.has(status)) {
    return res.status(422).json({ error: 'status must be one of: working, on_break, idle' });
  }
  try {
    // Fetch previous state so we can update rest_started_at correctly,
    // and detect transitions for the activity audit log.
    const { rows: prev } = await pool.query(
      'SELECT activity_status, rest_started_at, last_heartbeat_at FROM crm_users WHERE id = $1',
      [req.caller.id]
    );
    const prevStatus = prev[0]?.activity_status || null;
    const prevRest   = prev[0]?.rest_started_at || null;
    const prevHb     = prev[0]?.last_heartbeat_at || null;

    let nextRest;
    if (status === 'working') {
      nextRest = null;
    } else if (prevStatus === 'working' || !prevRest) {
      // First time leaving working OR rest_started_at was never set — stamp it.
      nextRest = new Date();
    } else {
      nextRest = prevRest;  // continue ticking
    }

    await pool.query(
      `UPDATE crm_users
          SET activity_status   = $1,
              activity_break    = $2::jsonb,
              last_heartbeat_at = NOW(),
              rest_started_at   = $3
        WHERE id = $4`,
      [
        status,
        breakInfo ? JSON.stringify(breakInfo) : null,
        nextRest,
        req.caller.id,
      ]
    );

    // Activity audit log — emit transition events. Best-effort; never
    // throws. A "logged in" point event fires when this is the first
    // heartbeat in >90s (re-login or initial open).
    try {
      const callerId = req.caller.id;
      const gapMs = prevHb ? Date.now() - new Date(prevHb).getTime() : Infinity;
      const justLoggedIn = !prevHb || gapMs > 90_000;
      if (justLoggedIn) {
        await activityLogger.endEventsForCaller(callerId, ['OFFLINE']);
        await activityLogger.logPointEvent(callerId, 'LOGGED_IN');
      }

      if (status === 'working') {
        // Working = active between calls. End any BREAK / IDLE,
        // open ACTIVE if not already open. End BREAK records over_by_sec
        // when relevant (break minutes exceeded).
        if (prevStatus === 'on_break') {
          await activityLogger.endEvent(callerId, 'BREAK');
          await activityLogger.logPointEvent(callerId, 'RESUMED');
        }
        await activityLogger.endEvent(callerId, 'IDLE');
        await activityLogger.startEvent(callerId, 'ACTIVE');
      } else if (status === 'on_break') {
        await activityLogger.endEvent(callerId, 'ACTIVE');
        await activityLogger.endEvent(callerId, 'IDLE');
        await activityLogger.startEvent(callerId, 'BREAK', breakInfo || null);
      } else if (status === 'idle') {
        await activityLogger.endEvent(callerId, 'ACTIVE');
        await activityLogger.startEvent(callerId, 'IDLE');
      }
    } catch (logErr) {
      console.error('caller/heartbeat activity log error:', logErr.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('caller/heartbeat error:', err.message);
    res.status(500).json({ error: 'heartbeat_failed' });
  }
});

/* ── POST /api/caller/state ──
   Caller-driven UI-state transition for the granular activity log.

   The heartbeat above tracks coarse working / on_break / idle status. This
   endpoint records the fine-grained "what page / modal is the caller on
   right now" timeline (Assigned Leads page → Viewing Lead → On Call → Form
   → Reason picker → Assigned Leads page again …).

   Body shape:
     { action: 'start'|'end'|'replace', tag, context?, end_tag? }

   - action='start'   → activityLogger.startEvent(caller, tag, context)
   - action='end'     → activityLogger.endEvent(caller, tag, context)  (context = optional patch)
   - action='replace' → end_tag (or every other page/modal tag) is closed, then `tag` starts.
                        Use 'replace' for clean A → B transitions so the timeline
                        shows two consecutive rows instead of overlapping ones.

   All operations are best-effort; the response is always { ok:true } unless the
   tag is unknown. Logging failures never surface to the caller. */
const PAGE_TAGS = [
  'ON_PAGE_CALL', 'ON_PAGE_ASSIGNED', 'ON_PAGE_COMPLETED',
  'ON_PAGE_NOT_PICKED', 'ON_PAGE_MISSED_CALLS', 'ON_PAGE_UNTOUCHED',
  'ON_PAGE_NEXT_BATCH',
];
const MODAL_TAGS = [
  'VIEWING_LEAD', 'AFTER_CALL_FORM', 'ON_REASON_FORM',
  'BREAK_PICKER', 'BREAK_OTHER_PICKER',
];

router.post('/state', async (req, res) => {
  const { action, tag, context, end_tag } = req.body || {};
  if (!action || !tag) {
    return res.status(422).json({ error: 'action and tag are required' });
  }
  if (!activityLogger.VALID_TAGS.has(tag)) {
    return res.status(422).json({ error: `unknown tag: ${tag}` });
  }
  const callerId = req.caller.id;
  try {
    if (action === 'end') {
      await activityLogger.endEvent(callerId, tag, context || null);
    } else if (action === 'start') {
      await activityLogger.startEvent(callerId, tag, context || null);
    } else if (action === 'replace') {
      // Close any modal-level event first so the new state takes precedence.
      // If a specific end_tag was supplied, close only that one; otherwise
      // sweep all modal tags + the page tags that aren't `tag` itself.
      if (end_tag && activityLogger.VALID_TAGS.has(end_tag)) {
        await activityLogger.endEvent(callerId, end_tag);
      } else {
        const sweep = [...MODAL_TAGS, ...PAGE_TAGS].filter(t => t !== tag);
        await activityLogger.endEventsForCaller(callerId, sweep);
      }
      await activityLogger.startEvent(callerId, tag, context || null);
    } else {
      return res.status(422).json({ error: 'action must be one of: start, end, replace' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('caller/state error:', err.message);
    res.status(500).json({ error: 'state_failed' });
  }
});

/* ── GET /api/caller/me ──
   Returns the JWT payload PLUS the live is_active flag. The caller frontend
   uses is_active to show a blocking "paused by admin" overlay; the JWT alone
   can't be trusted for that because admin can flip it mid-session. */
router.get('/me', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT is_active FROM crm_users WHERE id = $1',
      [req.caller.id]
    );
    const isActive = rows[0]?.is_active !== false;  // default to active if row vanished
    res.json({ caller: { ...req.caller, is_active: isActive } });
  } catch (err) {
    console.error('caller/me error:', err.message);
    // Fall back to JWT-only payload so an outage doesn't lock callers out.
    res.json({ caller: { ...req.caller, is_active: true } });
  }
});

/* ── GET /api/caller/leads ──
   Active assigned = no note yet, or marked follow_up whose time has arrived.
   Follow-ups whose time hasn't arrived live in the Completed Leads page. */
const LEAD_SELECT = `
  SELECT l.id, l.full_name, l.whatsapp_number, l.email, l.sugar_level, l.diabetes_duration,
         l.language_pref, l.lead_score, l.wa_clicked, l.webinar_id,
         l.assigned_user_id, l.assigned_at, l.created_at,
         l.last_note_outcome, l.last_note_at, l.follow_up_at, l.completed_at,
         l.last_note_interested,
         l.next_batch_parked, l.next_batch_parked_at,
         w.name AS webinar_name,
         latest_call.id                   AS last_call_id,
         latest_call.status               AS last_call_status,
         latest_call.duration_sec         AS last_call_duration,
         latest_call.recording_url        AS last_call_recording_url,
         latest_call.started_at           AS last_call_started_at,
         latest_call.agent_answered_at    AS last_call_agent_answered_at,
         latest_call.customer_answered_at AS last_call_customer_answered_at,
         latest_call.customer_missed_at   AS last_call_customer_missed_at,
         latest_call.ended_at             AS last_call_ended_at,
         latest_call.hangup_by            AS last_call_hangup_by,
         latest_note.id                       AS last_note_id,
         latest_note.sugar_confirmation       AS last_note_sugar_confirmation,
         latest_note.confirmed_range          AS last_note_confirmed_range,
         latest_note.range_for                AS last_note_range_for,
         latest_note.patient_age              AS last_note_patient_age,
         latest_note.diet_status              AS last_note_diet_status,
         latest_note.takes_medicine           AS last_note_takes_medicine,
         latest_note.note                     AS last_note_text,
         latest_note.hba1c                    AS last_note_hba1c,
         latest_note.other_languages          AS last_note_other_languages,
         latest_note.working_professional     AS last_note_working_professional,
         latest_note.location                 AS last_note_location,
         latest_note.already_paid             AS last_note_already_paid,
         latest_note.webinar_attended         AS last_note_webinar_attended,
         latest_note.available_for_webinar    AS last_note_available_for_webinar,
         latest_note.next_batch_joining       AS last_note_next_batch_joining,
         latest_note.interested               AS last_note_interested_in_note,
         latest_note.follow_up_at             AS last_note_follow_up_at
    FROM leads l
    LEFT JOIN webinars w ON w.id = l.webinar_id
    -- Latest-call aggregation. Tata fragments a single click-to-call into
    -- multiple "calls" rows (one per leg, each with its own provider_call_id).
    -- The recording webhook lands on whichever fragment Tata happens to attach
    -- it to — often NOT the row with the latest started_at, which may carry
    -- status='failed' / null duration / null recording. Picking that fragment
    -- alone makes the completed-lead card show "failed / — / No recording"
    -- even when the call was answered and recorded.
    --
    -- Solution: gather the most-recent 6 rows for this lead, scope to a
    -- ~30-min "session" window around the latest one (so a previous day's
    -- call doesn't leak into today's row), and pick the best value for each
    -- field across those rows — same approach the in-call modal uses
    -- client-side (LeadCallNoteModal.jsx polling merge).
    LEFT JOIN LATERAL (
      WITH recent AS (
        SELECT id, status, duration_sec, recording_url, started_at,
               agent_answered_at, customer_answered_at, customer_missed_at,
               ended_at, hangup_by
          FROM calls c
         WHERE c.lead_id = l.id
         ORDER BY c.started_at DESC
         LIMIT 6
      ),
      session AS (
        SELECT * FROM recent
         WHERE started_at >= (SELECT MAX(started_at) FROM recent) - INTERVAL '30 minutes'
      )
      SELECT
        -- id: prefer the fragment that actually holds the recording (so the
        -- /api/caller/recordings/:id lookup hits a row with recording_url).
        COALESCE(
          (SELECT id FROM session WHERE recording_url IS NOT NULL
             ORDER BY started_at DESC LIMIT 1),
          (SELECT id FROM session ORDER BY started_at DESC LIMIT 1)
        ) AS id,
        -- status: if any fragment has an "answered" signal (customer picked,
        -- duration > 0, or a recording landed), the call effectively ended
        -- normally — surface 'ended' instead of whatever the latest fragment
        -- happens to carry. Otherwise fall back to the latest row's status.
        COALESCE(
          (SELECT 'ended' WHERE EXISTS (
             SELECT 1 FROM session
              WHERE recording_url IS NOT NULL
                 OR customer_answered_at IS NOT NULL
                 OR (duration_sec IS NOT NULL AND duration_sec > 0)
          )),
          (SELECT status FROM session ORDER BY started_at DESC LIMIT 1)
        ) AS status,
        (SELECT duration_sec FROM session
           WHERE duration_sec IS NOT NULL AND duration_sec > 0
           ORDER BY started_at DESC LIMIT 1) AS duration_sec,
        (SELECT recording_url FROM session
           WHERE recording_url IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS recording_url,
        -- started_at: earliest fragment in the session — that's when the
        -- call actually began, not when the last leg-row was created.
        (SELECT MIN(started_at) FROM session) AS started_at,
        (SELECT agent_answered_at FROM session
           WHERE agent_answered_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS agent_answered_at,
        (SELECT customer_answered_at FROM session
           WHERE customer_answered_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS customer_answered_at,
        (SELECT customer_missed_at FROM session
           WHERE customer_missed_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS customer_missed_at,
        (SELECT ended_at FROM session
           WHERE ended_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS ended_at,
        (SELECT hangup_by FROM session
           WHERE hangup_by IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS hangup_by
    ) latest_call ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, sugar_confirmation, confirmed_range, range_for,
             patient_age, diet_status, takes_medicine, note,
             hba1c, other_languages, working_professional, location,
             already_paid, webinar_attended, available_for_webinar,
             next_batch_joining, interested, follow_up_at
        FROM lead_call_notes n
       WHERE n.lead_id = l.id
       ORDER BY n.created_at DESC
       LIMIT 1
    ) latest_note ON TRUE
`;

router.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${LEAD_SELECT}
        WHERE l.assigned_user_id = $1
          AND l.next_batch_parked = FALSE
          AND (
            l.last_note_outcome IS NULL
            OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW())
          )
        ORDER BY
          (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()) DESC NULLS LAST,
          l.pinned_at  DESC NULLS LAST,
          l.assigned_at ASC NULLS LAST, l.created_at ASC`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

/* ── GET /api/caller/leads/not-picked ──
   Leads this caller couldn't reach — either marked DNP (Did Not Pick) via
   the call-note modal OR auto-paused after the 5-attempt SmartFlow cap.
   Both buckets share the same "couldn't reach the customer" UX state. */
router.get('/leads/not-picked', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${LEAD_SELECT}
        WHERE l.assigned_user_id = $1
          AND l.last_note_outcome IN ('not_picked', 'auto_paused')
        ORDER BY l.last_note_at DESC NULLS LAST, l.created_at DESC`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads/not-picked error:', err.message);
    res.status(500).json({ error: 'Failed to fetch not-picked leads' });
  }
});

/* ── POST /api/caller/leads/reopen ──
   "Refill the Assigned bucket" — called from the queue-end modal after an
   auto-call run finishes. Body: { source: 'dnp' | 'missed' }.

     'dnp'    → leads this caller marked as 'not_picked'.
     'missed' → leads linked to inbound-missed calls that hit either this
                caller (caller_id match) or this caller's configured Tata
                DIDs (tata_caller_id / tata_agent_number).

   For each matched lead we clear last_note_outcome and re-stamp
   assigned_at = NOW() so the Assigned Leads list (sorted assigned_at
   DESC) bubbles them straight to the top. Returns { moved: <count> }. */
router.post('/leads/reopen', async (req, res) => {
  const source = (req.body?.source || '').trim();
  if (source !== 'dnp' && source !== 'missed' && source !== 'untouched') {
    return res.status(422).json({ error: 'source must be "dnp", "missed", or "untouched"' });
  }

  // 'untouched' is a placeholder bucket — the data definition is TBD. For now
  // we accept the source so the front-end button works, but return zero moves.
  // Once we know what "untouched" means (no calls? no notes? unassigned?), the
  // matching UPDATE goes here.
  if (source === 'untouched') {
    return res.json({ moved: 0, source, pending_definition: true });
  }

  try {
    let result;
    if (source === 'dnp') {
      // Reopen both 'not_picked' and 'auto_paused' — both mean
      // "we couldn't reach the customer" and the UX bucket is the same.
      result = await pool.query(
        `UPDATE leads
            SET last_note_outcome = NULL,
                last_note_interested = NULL,
                last_note_at      = NULL,
                follow_up_at      = NULL,
                completed_at      = NULL,
                assigned_at       = NOW(),
                pinned_at         = NOW()
          WHERE assigned_user_id  = $1
            AND last_note_outcome IN ('not_picked', 'auto_paused')
          RETURNING id`,
        [req.caller.id]
      );
    } else {
      // Resolve this caller's own DIDs (last-10) for matching unassigned
      // inbound-missed rows — same approach the /missed-inbound endpoint uses.
      const { rows: meRows } = await pool.query(
        `SELECT
           RIGHT(REGEXP_REPLACE(COALESCE(tata_caller_id, ''),    '\\D', '', 'g'), 10) AS caller_did,
           RIGHT(REGEXP_REPLACE(COALESCE(tata_agent_number, ''), '\\D', '', 'g'), 10) AS agent_did
           FROM crm_users WHERE id = $1`,
        [req.caller.id]
      );
      const myDids = [meRows[0]?.caller_did, meRows[0]?.agent_did].filter(d => d && d.length === 10);

      result = await pool.query(
        `UPDATE leads
            SET last_note_outcome = NULL,
                last_note_interested = NULL,
                last_note_at      = NULL,
                follow_up_at      = NULL,
                completed_at      = NULL,
                assigned_at       = NOW(),
                pinned_at         = NOW(),
                assigned_user_id  = COALESCE(assigned_user_id, $1)
          WHERE id IN (
            SELECT DISTINCT lead_id FROM calls
             WHERE direction = 'inbound'
               AND lead_id IS NOT NULL
               AND status IN ('missed','failed')
               AND (caller_id = $1 OR did_number = ANY($2::text[]))
          )
          RETURNING id`,
        [req.caller.id, myDids]
      );
    }
    res.json({ moved: result.rowCount, source });
  } catch (err) {
    console.error('caller/leads/reopen error:', err.message);
    res.status(500).json({ error: 'Failed to reopen leads.' });
  }
});

/* ── GET /api/caller/leads/completed ──
   Completed leads + scheduled-but-not-yet-due follow-ups for this caller.
   Excludes leads parked in the Next-Batch bucket — those have their own page. */
router.get('/leads/completed', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${LEAD_SELECT}
        WHERE l.assigned_user_id = $1
          AND l.next_batch_parked = FALSE
          AND (
            l.last_note_outcome IN ('completed','not_interested')
            OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW())
          )
        ORDER BY l.last_note_at DESC NULLS LAST`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads/completed error:', err.message);
    res.status(500).json({ error: 'Failed to fetch completed leads' });
  }
});

/* ── GET /api/caller/leads/next-batch ──
   Leads the caller parked by answering Q14 "Next Batch Joining" with Yes.
   They sit here until the admin starts a new batch (updates next_webinar_at),
   at which point routes/admin.js promotes them back to /leads as follow-ups. */
router.get('/leads/next-batch', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${LEAD_SELECT}
        WHERE l.assigned_user_id = $1
          AND l.next_batch_parked = TRUE
        ORDER BY l.next_batch_parked_at DESC NULLS LAST, l.last_note_at DESC NULLS LAST`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads/next-batch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch next-batch leads' });
  }
});

/* ── POST /api/caller/leads/:id/note ──
   Save the post-call form. Updates the lead's denormalized state and writes
   an immutable lead_call_notes row. Pushes SSE so both views update live. */
// 'auto_paused' = the auto-call workflow hit the AGENT_RETRY_CAP SmartFlow
//                  cap on the agent leg (currently 15, defined in
//                  apps/crm/src/modules/LeadCallNoteModal.jsx). The lead is
//                  parked AND the caller's own crm_users.is_active is flipped
//                  to FALSE — only a super admin can resume them via PATCH
//                  /api/admin/crm-users/:id { is_active: true }.
const ALLOWED_OUTCOMES = ['completed', 'follow_up', 'not_interested', 'not_picked', 'auto_paused'];
const ALLOWED_RANGES   = ['250+', '200-250', '100-200', 'no_diabetes'];
const ALLOWED_AGES     = ['0-18', '19-24', '25-34', '35-44', '45-54', 'above-54'];

router.post('/leads/:id/note', async (req, res) => {
  const lead_id = req.params.id;
  const {
    full_name,
    sugar_confirmation, confirmed_range, range_for,
    patient_age, diet_status, takes_medicine, note,
    hba1c, other_languages, working_professional, location,
    already_paid, webinar_attended, available_for_webinar, next_batch_joining,
    outcome, follow_up_at, call_id,
    interested,
  } = req.body || {};

  if (!ALLOWED_OUTCOMES.includes(outcome)) {
    return res.status(422).json({ error: 'outcome must be one of: ' + ALLOWED_OUTCOMES.join(', ') });
  }
  // 'not_picked' and 'auto_paused' both mean the caller never reached the
  // customer, so the discovery-field validations don't apply.
  const NO_CONTACT_OUTCOMES = new Set(['not_picked', 'auto_paused']);
  if (!NO_CONTACT_OUTCOMES.has(outcome)) {
    if (outcome === 'follow_up' && !follow_up_at) {
      return res.status(422).json({ error: 'follow_up_at required when outcome is follow_up' });
    }
    if (confirmed_range && !ALLOWED_RANGES.includes(confirmed_range)) {
      return res.status(422).json({ error: 'invalid confirmed_range' });
    }
    if (patient_age && !ALLOWED_AGES.includes(patient_age)) {
      return res.status(422).json({ error: 'invalid patient_age' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Confirm the lead is assigned to this caller
    const { rows: leadRows } = await client.query(
      'SELECT id, assigned_user_id FROM leads WHERE id = $1',
      [lead_id]
    );
    if (leadRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'lead not found' });
    }
    if (leadRows[0].assigned_user_id !== req.caller.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'lead not assigned to you' });
    }

    // Insert the note row
    const { rows: noteRows } = await client.query(
      `INSERT INTO lead_call_notes
         (lead_id, caller_id, call_id, sugar_confirmation, confirmed_range,
          range_for, patient_age, diet_status, takes_medicine, note,
          hba1c, other_languages, working_professional, location,
          already_paid, webinar_attended, available_for_webinar, next_batch_joining,
          outcome, follow_up_at, interested)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING id, created_at`,
      [
        lead_id, req.caller.id, call_id || null,
        sugar_confirmation || null, confirmed_range || null,
        range_for || null, patient_age || null,
        diet_status || null, takes_medicine || null,
        (note || '').trim() || null,
        hba1c || null, other_languages || null,
        working_professional || null, location || null,
        already_paid || null, webinar_attended || null,
        available_for_webinar || null, next_batch_joining || null,
        outcome,
        outcome === 'follow_up' ? follow_up_at : null,
        interested === 'yes' || interested === 'no' ? interested : null,
      ]
    );

    // Update denormalized columns on leads (and full_name if the caller edited it).
    // Re-asserts assigned_user_id in WHERE to close the TOCTOU window between
    // the ownership SELECT above and this UPDATE — a concurrent reassignment
    // would otherwise let this caller mutate a lead they no longer own.
    // If the caller answered Q14 (next_batch_joining) with Yes, park the lead
    // in the Next-Batch bucket — it disappears from Assigned/Completed until
    // admin starts a new batch.
    const cleanName = typeof full_name === 'string' ? full_name.trim() : '';
    const parkForNextBatch = next_batch_joining === 'yes';
    await client.query(
      `UPDATE leads
          SET last_note_outcome     = $2,
              last_note_at          = NOW(),
              follow_up_at          = $3,
              completed_at          = CASE WHEN $2 IN ('completed','not_interested') THEN NOW() ELSE NULL END,
              last_note_interested  = $4,
              full_name             = COALESCE(NULLIF($5, ''), full_name),
              next_batch_parked     = CASE WHEN $7 THEN TRUE  ELSE next_batch_parked    END,
              next_batch_parked_at  = CASE WHEN $7 THEN NOW() ELSE next_batch_parked_at END
        WHERE id = $1
          AND assigned_user_id = $6`,
      [
        lead_id,
        outcome,
        outcome === 'follow_up' ? follow_up_at : null,
        interested === 'yes' || interested === 'no' ? interested : null,
        cleanName,
        req.caller.id,
        parkForNextBatch,
      ]
    );

    // SmartFlow auto-pause: when the caller submits a note with
    // outcome='auto_paused' the front-end has just tripped AGENT_RETRY_CAP
    // (currently 15) consecutive agent-side misses on this lead. We flip the
    // caller's own is_active to FALSE inside the same transaction so the
    // lead-state change and the account-pause are atomic. The caller cannot
    // un-pause themselves — only a super admin can, via PATCH
    // /api/admin/crm-users/:id (adminAuth = ADMIN_PASSWORD bearer).
    //
    // We only act when is_active is currently TRUE — repeat auto_paused
    // outcomes on subsequent leads should not overwrite an earlier
    // auto_paused_at timestamp, and they should not log duplicate audit
    // events. The RETURNING clause tells us whether we actually paused.
    let autoPausedThisRequest = false;
    if (outcome === 'auto_paused') {
      const { rows: pauseRows } = await client.query(
        `UPDATE crm_users
            SET is_active         = FALSE,
                auto_paused_at    = NOW(),
                auto_pause_reason = 'smartflow_cap_exceeded'
          WHERE id        = $1
            AND is_active = TRUE
        RETURNING id`,
        [req.caller.id]
      );
      autoPausedThisRequest = pauseRows.length > 0;
    }

    await client.query('COMMIT');

    // Structured log — one JSON line per note save. Grep on Render with
    // e.g. `lead_id=<uuid>` to trace a lead's lifecycle across callers.
    console.log(JSON.stringify({
      type:      'call_note_saved',
      caller_id: req.caller.id,
      lead_id,
      outcome,
      call_id:   call_id || null,
      follow_up_at: outcome === 'follow_up' ? follow_up_at : null,
      note_id:   noteRows[0].id,
      auto_paused_caller: autoPausedThisRequest,
      at:        new Date().toISOString(),
    }));

    // Push SSE so both Assigned and Completed pages can react
    callerSse.pushTo(req.caller.id, {
      type: 'lead.note_saved',
      lead_id,
      outcome,
      follow_up_at: outcome === 'follow_up' ? follow_up_at : null,
      note_id: noteRows[0].id,
    });

    // Side effects of the SmartFlow auto-pause. Pushed AFTER commit so the
    // CallerShell receives them only once the DB state actually reflects
    // is_active=FALSE.
    if (autoPausedThisRequest) {
      try {
        callerSse.pushTo(req.caller.id, {
          type: 'caller.paused',
          is_active: false,
          reason:    'smartflow_cap_exceeded',
        });
      } catch (sseErr) {
        console.error('[caller] smartflow-pause SSE push error:', sseErr.message);
      }
      activityLogger.logPointEvent(
        req.caller.id,
        'PAUSED_BY_SMARTFLOW',
        { lead_id }
      );
    }

    res.json({
      success: true,
      note_id: noteRows[0].id,
      outcome,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('caller/note error:', err.message);
    res.status(500).json({ error: 'Failed to save note' });
  } finally {
    client.release();
  }
});

/* ── GET /api/caller/leads/events ── (SSE)
   Note: EventSource cannot set headers, so callerAuth also accepts ?token=<jwt> */
router.get('/leads/events', (req, res) => {
  res.set({
    'Content-Type':    'text/event-stream',
    'Cache-Control':   'no-cache',
    'Connection':      'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  callerSse.add(req.caller.id, res);

  // Heartbeat every 30 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n'); } catch (_) { /* drop on next pushTo */ }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    callerSse.remove(req.caller.id, res);
  });
});

/* ── GET /api/caller/calls/missed-inbound ──
   Customers who called the caller's Tata DID but weren't connected (or rang
   without anyone picking up). Includes:
     – calls linked to a lead assigned to this caller (status=missed/failed
       OR a stale 'ringing' row older than 2 min)
     – calls with no matching lead (caller_id NULL) — surfaced to every CRM
       as an 'Unknown caller' that any agent can claim.

   Sorted newest-first so fresh missed calls always appear at the top. */
router.get('/calls/missed-inbound', async (req, res) => {
  try {
    // Look up this caller's own Tata numbers (last-10) — we filter the
    // unassigned-missed bucket to only those that hit one of these DIDs.
    // Without this, every caller saw every missed call across the org.
    const { rows: meRows } = await pool.query(
      `SELECT
         RIGHT(REGEXP_REPLACE(COALESCE(tata_caller_id, ''),    '\\D', '', 'g'), 10) AS caller_did,
         RIGHT(REGEXP_REPLACE(COALESCE(tata_agent_number, ''), '\\D', '', 'g'), 10) AS agent_did
         FROM crm_users WHERE id = $1`,
      [req.caller.id]
    );
    const myDids = [meRows[0]?.caller_did, meRows[0]?.agent_did].filter(d => d && d.length === 10);

    const { rows } = await pool.query(
      `SELECT c.id, c.lead_id, c.caller_id, c.provider_call_id, c.status,
              c.direction, c.started_at, c.ended_at, c.duration_sec, c.recording_url,
              c.hangup_by, c.raw_payload, c.caller_phone, c.did_number,
              l.full_name AS lead_full_name,
              l.whatsapp_number AS lead_phone,
              l.email AS lead_email,
              l.sugar_level AS lead_sugar_level
         FROM calls c
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.direction = 'inbound'
          AND (
            c.caller_id = $1
            OR (c.caller_id IS NULL AND c.did_number = ANY($2::text[]))
          )
          AND (
            c.status IN ('missed','failed')
            OR (c.status = 'ringing' AND c.started_at < NOW() - INTERVAL '2 minutes')
            OR (c.status = 'ended' AND c.agent_answered_at IS NULL)
          )
        ORDER BY c.started_at DESC NULLS LAST
        LIMIT 200`,
      [req.caller.id, myDids]
    );

    // Caller phone — prefer the dedicated calls.caller_phone column; if NULL
    // (very old rows that pre-date the column), fall back to the lead's phone,
    // then to a best-effort scrape of raw_payload aliases.
    const out = rows.map(r => {
      const raw = r.raw_payload || {};
      const phoneRaw = r.caller_phone
        || r.lead_phone
        || raw.caller_id_number || raw.client_number || raw.callerIdNumber
        || raw.from || raw.From || raw.from_number || raw.source || null;
      const phone10 = phoneRaw ? String(phoneRaw).replace(/\D/g, '').slice(-10) : null;
      return {
        id:              r.id,
        lead_id:         r.lead_id,
        is_known:        !!r.lead_id,
        full_name:       r.lead_full_name || 'Unknown caller',
        phone:           phone10,
        email:           r.lead_email,
        sugar_level:     r.lead_sugar_level,
        status:          r.status,
        started_at:      r.started_at,
        duration_sec:    r.duration_sec,
        recording_url:   r.recording_url,
        hangup_by:       r.hangup_by,
      };
    });
    res.json({
      calls: out,
      total: out.length,
      // Surface which DIDs are being filtered on so the UI can show the
      // caller what numbers their missed-calls list is scoped to.
      filtered_dids: myDids,
    });
  } catch (err) {
    console.error('caller/calls/missed-inbound error:', err.message);
    res.status(500).json({ error: 'Failed to fetch missed inbound calls' });
  }
});

/* ── POST /api/caller/calls/sync-inbound ──
   Manually triggers a Tata CDR poll. Useful from the Missed Calls page to
   force-refresh when the customer reports they just called. Returns the
   poll result so the frontend can show "synced 3 new" or the error. */
router.post('/calls/sync-inbound', async (_req, res) => {
  try {
    const result = await tataInboundSync.syncOnce({ lookbackMinutes: 60 });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
