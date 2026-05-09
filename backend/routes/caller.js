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
         latest_call.id            AS last_call_id,
         latest_call.status        AS last_call_status,
         latest_call.duration_sec  AS last_call_duration,
         latest_call.recording_url AS last_call_recording_url,
         latest_call.started_at    AS last_call_started_at,
         latest_note.id                  AS last_note_id,
         latest_note.sugar_confirmation  AS last_note_sugar_confirmation,
         latest_note.confirmed_range     AS last_note_confirmed_range,
         latest_note.range_for           AS last_note_range_for,
         latest_note.patient_age         AS last_note_patient_age,
         latest_note.diet_status         AS last_note_diet_status,
         latest_note.takes_medicine     AS last_note_takes_medicine,
         latest_note.note               AS last_note_text
    FROM leads l
    LEFT JOIN webinars w ON w.id = l.webinar_id
    LEFT JOIN LATERAL (
      SELECT id, status, duration_sec, recording_url, started_at
        FROM calls c
       WHERE c.lead_id = l.id
       ORDER BY c.started_at DESC
       LIMIT 1
    ) latest_call ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, sugar_confirmation, confirmed_range, range_for,
             patient_age, diet_status, takes_medicine, note
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
          outcome, follow_up_at, interested)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, created_at`,
      [
        lead_id, req.caller.id, call_id || null,
        sugar_confirmation || null, confirmed_range || null,
        range_for || null, patient_age || null,
        diet_status || null, takes_medicine || null,
        (note || '').trim() || null,
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

module.exports = router;
