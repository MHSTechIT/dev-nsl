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

router.use(callerAuth);

/* ── GET /api/caller/me ── */
router.get('/me', (req, res) => {
  res.json({ caller: req.caller });
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
    LEFT JOIN LATERAL (
      SELECT id, status, duration_sec, recording_url, started_at,
             agent_answered_at, customer_answered_at, customer_missed_at,
             ended_at, hangup_by
        FROM calls c
       WHERE c.lead_id = l.id
       ORDER BY c.started_at DESC
       LIMIT 1
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
          AND (
            l.last_note_outcome IS NULL
            OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW())
          )
        ORDER BY
          (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()) DESC NULLS LAST,
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
   Leads this caller marked as DNP (Did Not Pick) via the call-note modal. */
router.get('/leads/not-picked', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${LEAD_SELECT}
        WHERE l.assigned_user_id = $1
          AND l.last_note_outcome = 'not_picked'
        ORDER BY l.last_note_at DESC NULLS LAST, l.created_at DESC`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads/not-picked error:', err.message);
    res.status(500).json({ error: 'Failed to fetch not-picked leads' });
  }
});

/* ── GET /api/caller/leads/completed ──
   Completed leads + scheduled-but-not-yet-due follow-ups for this caller. */
router.get('/leads/completed', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${LEAD_SELECT}
        WHERE l.assigned_user_id = $1
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

/* ── POST /api/caller/leads/:id/note ──
   Save the post-call form. Updates the lead's denormalized state and writes
   an immutable lead_call_notes row. Pushes SSE so both views update live. */
const ALLOWED_OUTCOMES = ['completed', 'follow_up', 'not_interested', 'not_picked'];
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
  // 'not_picked' bypasses every other field check — caller didn't reach the lead.
  if (outcome !== 'not_picked') {
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

    // Update denormalized columns on leads (and full_name if the caller edited it)
    const cleanName = typeof full_name === 'string' ? full_name.trim() : '';
    await client.query(
      `UPDATE leads
          SET last_note_outcome     = $2,
              last_note_at          = NOW(),
              follow_up_at          = $3,
              completed_at          = CASE WHEN $2 IN ('completed','not_interested') THEN NOW() ELSE NULL END,
              last_note_interested  = $4,
              full_name             = COALESCE(NULLIF($5, ''), full_name)
        WHERE id = $1`,
      [
        lead_id,
        outcome,
        outcome === 'follow_up' ? follow_up_at : null,
        interested === 'yes' || interested === 'no' ? interested : null,
        cleanName,
      ]
    );

    await client.query('COMMIT');

    // Push SSE so both Assigned and Completed pages can react
    callerSse.pushTo(req.caller.id, {
      type: 'lead.note_saved',
      lead_id,
      outcome,
      follow_up_at: outcome === 'follow_up' ? follow_up_at : null,
      note_id: noteRows[0].id,
    });

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
    const { rows } = await pool.query(
      `SELECT c.id, c.lead_id, c.caller_id, c.provider_call_id, c.status,
              c.direction, c.started_at, c.ended_at, c.duration_sec, c.recording_url,
              c.hangup_by, c.raw_payload,
              l.full_name AS lead_full_name,
              l.whatsapp_number AS lead_phone,
              l.email AS lead_email,
              l.sugar_level AS lead_sugar_level
         FROM calls c
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.direction = 'inbound'
          AND (c.caller_id = $1 OR c.caller_id IS NULL)
          AND (
            c.status IN ('missed','failed')
            OR (c.status = 'ringing' AND c.started_at < NOW() - INTERVAL '2 minutes')
            OR (c.status = 'ended' AND c.agent_answered_at IS NULL)
          )
        ORDER BY c.started_at DESC NULLS LAST
        LIMIT 200`,
      [req.caller.id]
    );

    // Best-effort "caller phone" from raw_payload for unknown rows
    const out = rows.map(r => {
      const raw = r.raw_payload || {};
      const phoneRaw = r.lead_phone
        || raw.caller_id_number || raw.callerIdNumber || raw.from || raw.From || null;
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
    res.json({ calls: out, total: out.length });
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
