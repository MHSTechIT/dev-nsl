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
const { workspaceConfig } = require('../utils/callerWorkspace');

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
  const cfg = workspaceConfig(req.caller.workspace);

  try {
    // Confirm the lead is assigned to this caller
    const { rows: leadRows } = await pool.query(
      `SELECT id, full_name, ${cfg.leadPhoneCol} AS whatsapp_number, assigned_user_id
         FROM ${cfg.leads}
        WHERE id = $1`,
      [lead_id]
    );
    if (leadRows.length === 0) return res.status(404).json({ error: 'lead not found' });
    const lead = leadRows[0];
    if (lead.assigned_user_id !== req.caller.id) {
      return res.status(403).json({ error: 'lead not assigned to you' });
    }

    // Look up the caller's Smartflo profile (set per-user in Users page).
    // is_active doubles as "paused by admin" — when an admin toggles Pause on
    // the Sales Performance kebab, we set is_active = FALSE and refuse to
    // dial. 423 Locked is the right semantic: the row exists but is
    // intentionally unavailable for outbound dialing.
    const { rows: agentRows } = await pool.query(
      `SELECT tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
              tata_smartflo_api_key, phone, is_active
         FROM ${cfg.users} WHERE id = $1`,
      [req.caller.id]
    );
    const agent = agentRows[0] || {};
    if (agent.is_active === false) {
      return res.status(423).json({
        error:   'paused_by_admin',
        message: 'Your account is paused by admin. Reach out to your manager to resume.',
      });
    }

    const customerNumber = toE164India(lead.whatsapp_number);
    if (!customerNumber) {
      return res.status(422).json({ error: 'invalid lead phone number' });
    }

    // Insert the call row up front so we always have a record even if the API call fails
    const { rows: callRows } = await pool.query(
      `INSERT INTO ${cfg.calls} (lead_id, caller_id, status)
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
        `UPDATE ${cfg.calls}
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
      `UPDATE ${cfg.calls}
          SET provider_call_id = $2,
              raw_payload      = $3,
              updated_at       = NOW()
        WHERE id = $1`,
      [callId, providerCallId, raw]
    );

    // Structured log — one line per outbound dial attempt.
    try {
      console.log(JSON.stringify({
        type:             'call_start',
        caller_id:        req.caller.id,
        lead_id,
        call_id:          callId,
        provider_call_id: providerCallId,
        stubbed,
        at:               new Date().toISOString(),
      }));
    } catch (_) { /* best-effort */ }

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
  const cfg = workspaceConfig(req.caller.workspace);

  try {
    // Gather ALL recent (last 15 min) call rows for this lead+caller — not
    // just one. A single logical Tata call fragments into several rows with
    // DIFFERENT id formats (the dialplan call_id "MUM3-T3-1781672769.368381",
    // the short uuid "6a322b412980a", the originate ref_id). Tata's hangup
    // only accepts the FULL dialplan call_id, which often lives in a sibling
    // row's raw_payload — not in the row whose provider_call_id we happened to
    // store. So we collect every candidate id across all rows and try each;
    // the one matching the live leg actually drops the call, the rest no-op.
    const { rows } = await pool.query(
      `SELECT c.id, c.provider_call_id, c.status, c.raw_payload,
              u.tata_account_type, u.tata_smartflo_api_key
         FROM ${cfg.calls} c
         LEFT JOIN ${cfg.users} u ON u.id = c.caller_id
        WHERE c.lead_id = $1
          AND c.caller_id = $2
          AND c.started_at > NOW() - INTERVAL '15 minutes'
        ORDER BY (c.status NOT IN ('ended','missed','failed')) DESC,
                 c.started_at DESC
        LIMIT 8`,
      [leadId, req.caller.id]
    );
    if (rows.length === 0) {
      return res.json({ success: true, no_active_call: true });
    }

    // Stub calls (test leads) never went to Tata — just mark the rows ended.
    const allStub = rows.every(r => String(r.provider_call_id || '').startsWith('stub-'));
    if (allStub) {
      await pool.query(
        `UPDATE ${cfg.calls} SET status = 'ended', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [rows.map(r => r.id)]
      );
      return res.json({ success: true, stubbed: true, rows: rows.length });
    }

    // Build the de-duped candidate id list: every row's stored
    // provider_call_id PLUS the call_id / uuid Tata embedded in its webhook
    // payload (that's where the hangup-accepted dialplan call_id usually is).
    const candidates = new Set();
    for (const r of rows) {
      const pid = String(r.provider_call_id || '');
      if (pid && !pid.startsWith('stub-')) candidates.add(pid);
      const p = r.raw_payload || {};
      if (p.call_id) candidates.add(String(p.call_id));
      if (p.uuid)    candidates.add(String(p.uuid));
    }
    // Per-user Tata creds (same across these rows — take the first non-null).
    const acct = rows.find(r => r.tata_account_type)?.tata_account_type || undefined;
    const key  = rows.find(r => r.tata_smartflo_api_key)?.tata_smartflo_api_key || undefined;

    let dropped = false;   // a REAL hangup landed (not an already-ended no-op)
    const attempts = [];
    for (const id of candidates) {
      const result = await tata.hangup({ providerCallId: id, accountType: acct, perUserKey: key });
      attempts.push({ id, ok: !!result.ok, reason: result.reason || null });
      // A real drop = ok AND it wasn't the "already ended" short-circuit.
      if (result.ok && result.reason !== 'already_ended') { dropped = true; break; }
    }

    // Fallback: none of our STORED ids actually dropped a live leg. This happens
    // when we only captured the short uuid (e.g. "6a3c021b61754") — Tata's
    // hangup needs the full dialplan call_id ("DR5-D4-1782316664.1164970"), and
    // that id never landed in any of our rows. Ask Tata which calls are live
    // RIGHT NOW and match ours by the lead's phone number, then hang up with the
    // authoritative call_id. This is what was leaving follow-up calls connected.
    if (!dropped) {
      const { rows: lr } = await pool.query(
        `SELECT whatsapp_number FROM ${cfg.leads} WHERE id = $1`, [leadId]
      );
      const leadLast10 = String(lr[0]?.whatsapp_number || '').replace(/\D/g, '').slice(-10);
      if (leadLast10.length === 10) {
        const live = await tata.liveCalls({ accountType: acct, perUserKey: key });
        for (const lc of (live.calls || [])) {
          const dest = String(lc.destination || lc.dst || lc.dest || lc.called_number || '').replace(/\D/g, '');
          if (!dest.endsWith(leadLast10)) continue;             // not this lead's call
          const liveId = lc.call_id || lc.id || lc.uuid;
          if (!liveId) continue;
          const r = await tata.hangup({ providerCallId: String(liveId), accountType: acct, perUserKey: key });
          attempts.push({ id: liveId, via: 'live_calls', ok: !!r.ok, reason: r.reason || null });
          if (r.ok && r.reason !== 'already_ended') { dropped = true; break; }
        }
      }
    }

    // Mark every recent non-terminal row ended regardless — the leg is gone
    // (either we just dropped it or it was already ended on Tata's side).
    await pool.query(
      `UPDATE ${cfg.calls}
          SET status = 'ended', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND status NOT IN ('ended','missed','failed')`,
      [rows.map(r => r.id)]
    );

    res.json({ success: true, dropped, candidates: candidates.size, attempts });
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
  const cfg = workspaceConfig(req.caller.workspace);

  try {
    // Verify the call belongs to this caller and grab the provider id
    const { rows } = await pool.query(
      `SELECT c.id, c.provider_call_id, c.status,
              u.tata_account_type, u.tata_smartflo_api_key
         FROM ${cfg.calls} c
         LEFT JOIN ${cfg.users} u ON u.id = c.caller_id
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
    // Stub calls (test leads) never went to Tata — just mark ended.
    if (String(call.provider_call_id).startsWith('stub-')) {
      await pool.query(
        `UPDATE ${cfg.calls} SET status = 'ended', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW() WHERE id = $1`,
        [callId]
      );
      return res.json({ success: true, stubbed: true });
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
        `UPDATE ${cfg.calls}
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
  const cfg = workspaceConfig(req.caller.workspace);

  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.duration_sec, c.recording_url,
              c.started_at, c.answered_at, c.ended_at, c.updated_at, c.error_message,
              c.agent_answered_at, c.customer_answered_at, c.customer_missed_at,
              c.hangup_by
         FROM ${cfg.calls} c
         JOIN ${cfg.leads} l ON l.id = c.lead_id
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
