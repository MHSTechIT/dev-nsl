/**
 * Caller-scoped call endpoints. Mounted at /api/caller (after callerAuth).
 *
 *   POST /api/caller/calls/start  body: { lead_id }     – trigger Tata click-to-call
 *   GET  /api/caller/calls?lead_id=...                  – call history for a lead
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const tata    = require('../utils/tataClient');
const { callerAuth } = require('../middleware/callerAuth');

router.use(callerAuth);

function toE164India(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('91') && d.length === 12) return `+${d}`;
  if (d.length === 10) return `+91${d}`;
  return `+${d}`;
}

/* ── POST /api/caller/calls/start ── */
router.post('/calls/start', async (req, res) => {
  const { lead_id } = req.body || {};
  if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

  try {
    // Confirm the lead is assigned to this caller
    const { rows: leadRows } = await pool.query(
      `SELECT id, full_name, whatsapp_number, assigned_user_id
         FROM leads
        WHERE id = $1`,
      [lead_id]
    );
    if (leadRows.length === 0) return res.status(404).json({ error: 'lead not found' });
    const lead = leadRows[0];
    if (lead.assigned_user_id !== req.caller.id) {
      return res.status(403).json({ error: 'lead not assigned to you' });
    }

    // Look up the caller's Smartflo profile (set per-user in Users page)
    const { rows: agentRows } = await pool.query(
      `SELECT tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
              tata_smartflo_api_key, phone
         FROM crm_users WHERE id = $1`,
      [req.caller.id]
    );
    const agent = agentRows[0] || {};

    const customerNumber = toE164India(lead.whatsapp_number);
    if (!customerNumber) {
      return res.status(422).json({ error: 'invalid lead phone number' });
    }

    // Insert the call row up front so we always have a record even if the API call fails
    const { rows: callRows } = await pool.query(
      `INSERT INTO calls (lead_id, caller_id, status)
       VALUES ($1, $2, 'initiated')
       RETURNING id`,
      [lead_id, req.caller.id]
    );
    const callId = callRows[0].id;

    let providerCallId = null;
    let raw = null;
    let stubbed = false;
    try {
      const result = await tata.startCall({
        agentNumber:       agent.tata_agent_number || undefined,
        extension:         agent.tata_extension    || agent.phone || undefined,
        destinationNumber: customerNumber,
        callerId:          agent.tata_caller_id    || undefined,
        accountType:       agent.tata_account_type || undefined,
        perUserKey:        agent.tata_smartflo_api_key || undefined,
        customIdentifier:  {
          lead_id:   String(lead.id),
          lead_name: lead.full_name,
          source:    'CRM',
        },
      });
      providerCallId = result.provider_call_id;
      raw = result.raw;
      stubbed = !!result.stubbed;
    } catch (err) {
      await pool.query(
        `UPDATE calls
            SET status = 'failed',
                error_message = $2,
                raw_payload   = $3,
                updated_at    = NOW()
          WHERE id = $1`,
        [callId, err.message || 'tata_error', err.body || null]
      );
      console.error('[calls] tata.startCall error:', err.message);
      const status = err.status === 409 || err.status === 422 ? err.status : 502;
      return res.status(status).json({ error: 'provider_error', message: err.message });
    }

    await pool.query(
      `UPDATE calls
          SET provider_call_id = $2,
              raw_payload      = $3,
              updated_at       = NOW()
        WHERE id = $1`,
      [callId, providerCallId, raw]
    );

    res.json({
      success: true,
      call_id: callId,
      provider_call_id: providerCallId,
      stubbed,
    });
  } catch (err) {
    console.error('[calls] start error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ── POST /api/caller/leads/:lead_id/hangup ──
   Best-effort termination of the active call for this lead, regardless of
   which call_id the client was holding (handles the Recall case where the
   modal still has the old call_id). Looks up the latest non-terminal call
   for this caller + lead and hangs it up. */
router.post('/leads/:lead_id/hangup', async (req, res) => {
  const leadId = req.params.lead_id;
  if (!leadId) return res.status(400).json({ error: 'lead_id required' });

  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.provider_call_id, c.status,
              u.tata_account_type, u.tata_smartflo_api_key
         FROM calls c
         LEFT JOIN crm_users u ON u.id = c.caller_id
        WHERE c.lead_id = $1
          AND c.caller_id = $2
          AND c.status NOT IN ('ended','missed','failed')
        ORDER BY c.started_at DESC
        LIMIT 1`,
      [leadId, req.caller.id]
    );
    if (rows.length === 0) {
      return res.json({ success: true, no_active_call: true });
    }
    const call = rows[0];
    if (!call.provider_call_id) {
      return res.json({ success: true, no_provider_id: true });
    }
    const result = await tata.hangup({
      providerCallId: call.provider_call_id,
      accountType:    call.tata_account_type || undefined,
      perUserKey:     call.tata_smartflo_api_key || undefined,
    });
    if (result.ok) {
      await pool.query(
        `UPDATE calls
            SET status = 'ended', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
          WHERE id = $1`,
        [call.id]
      );
    }
    res.json({
      success: !!result.ok,
      call_id: call.id,
      endpoint: result.endpoint || null,
      reason:   result.reason || null,
    });
  } catch (err) {
    console.error('[calls] lead hangup error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

/* ── POST /api/caller/calls/:call_id/hangup ──
   Best-effort termination of an active call. Used by the Complete Call button
   in the post-call note modal so submitting the form also drops the line.
   Always returns 200 — if the call is already ended, the no-op is harmless. */
router.post('/calls/:call_id/hangup', async (req, res) => {
  const callId = req.params.call_id;
  if (!callId) return res.status(400).json({ error: 'call_id required' });

  try {
    // Verify the call belongs to this caller and grab the provider id
    const { rows } = await pool.query(
      `SELECT c.id, c.provider_call_id, c.status,
              u.tata_account_type, u.tata_smartflo_api_key
         FROM calls c
         LEFT JOIN crm_users u ON u.id = c.caller_id
        WHERE c.id = $1 AND c.caller_id = $2`,
      [callId, req.caller.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'call not found' });
    const call = rows[0];

    // If the call is already ended/missed/failed, nothing to do
    if (['ended', 'missed', 'failed'].includes(call.status)) {
      return res.json({ success: true, already_ended: true });
    }
    if (!call.provider_call_id) {
      return res.json({ success: true, no_provider_id: true });
    }

    const result = await tata.hangup({
      providerCallId: call.provider_call_id,
      accountType:    call.tata_account_type || undefined,
      perUserKey:     call.tata_smartflo_api_key || undefined,
    });

    // Mark call as ended in DB regardless — the webhook will reconcile the
    // exact end time/duration when Tata posts the hangup event back.
    if (result.ok) {
      await pool.query(
        `UPDATE calls
            SET status = 'ended', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
          WHERE id = $1`,
        [callId]
      );
    }

    res.json({
      success: !!result.ok,
      endpoint: result.endpoint || null,
      reason:   result.reason || null,
    });
  } catch (err) {
    console.error('[calls] hangup error:', err.message);
    // Never block the form save — return 200 with success:false
    res.json({ success: false, error: err.message });
  }
});

/* ── GET /api/caller/calls?lead_id=... ── */
router.get('/calls', async (req, res) => {
  const { lead_id } = req.query;
  if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.duration_sec, c.recording_url,
              c.started_at, c.answered_at, c.ended_at, c.error_message
         FROM calls c
         JOIN leads l ON l.id = c.lead_id
        WHERE c.lead_id = $1
          AND l.assigned_user_id = $2
        ORDER BY c.started_at DESC
        LIMIT 50`,
      [lead_id, req.caller.id]
    );
    res.json({ calls: rows });
  } catch (err) {
    console.error('[calls] list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
