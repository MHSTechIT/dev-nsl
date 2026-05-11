/**
 * Public webhook receivers. Mounted at /api/webhooks.
 *
 *   POST /api/webhooks/tata                   – original Tata endpoint (kept for back-compat)
 *   POST /api/webhooks/tata-tele/recording    – Smartflo's expected path (new alias)
 *
 * Tata posts JSON when a call's state changes (initiated/ringing/answered/
 * ended/missed/failed) or when a recording becomes available. The handler:
 *   1. Verifies the HMAC signature (when TATA_TELE_WEBHOOK_SECRET is set).
 *   2. Normalizes the payload via tataClient.normalizeWebhookEvent().
 *   3. Resolves the lead via 4-tier match: custom_identifier.lead_id →
 *      body.lead_id → previous calls row by provider_call_id → phone last-10.
 *   4. Upserts the calls row keyed by provider_call_id.
 *   5. If recording_url arrived, schedules a background download to local disk
 *      so the URL never expires.
 *   6. Pushes SSE 'call.update' to the caller so their CRM tab updates live.
 */
const express   = require('express');
const router    = express.Router();
const pool      = require('../db');
const tata      = require('../utils/tataClient');
const callerSse = require('../utils/callerSse');
const { downloadRecording } = require('../utils/recordingDownload');

/* Capture raw body so we can verify the HMAC signature exactly as Tata sent it.
   Edge case: app.js registers express.json() globally, so by the time the
   request reaches this router the body has already been consumed and the
   'data'/'end' events on the stream have already fired. Listening for them
   here would hang forever. We detect that case and use the parsed body
   directly (re-stringified) as the rawBody — fine for HMAC since the JSON
   round-trip is byte-exact for our payloads, and the secret isn't set in
   most dev environments anyway. */
function rawBodyParser(req, res, next) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    req.rawBody = JSON.stringify(req.body);
    return next();
  }
  if (req.readableEnded || req.complete) {
    req.rawBody = '';
    req.body = req.body || {};
    return next();
  }
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    if (data) {
      try { req.body = JSON.parse(data); } catch { req.body = {}; }
    } else {
      req.body = {};
    }
    next();
  });
}

/* 4-tier lead matching. Returns lead_id or null. */
async function resolveLeadId(event, payload) {
  // 1. custom_identifier.lead_id (from our outbound payload)
  if (event.custom_lead_id) {
    const { rows } = await pool.query('SELECT id FROM leads WHERE id = $1', [event.custom_lead_id]);
    if (rows[0]) return rows[0].id;
  }

  // 2. body-level lead_id from various payload shapes
  const bodyLead = payload?.lead_id || payload?.leadId || payload?.LeadID || null;
  if (bodyLead) {
    const { rows } = await pool.query('SELECT id FROM leads WHERE id = $1', [bodyLead]);
    if (rows[0]) return rows[0].id;
  }

  // 3. previous calls row for the same provider_call_id
  if (event.provider_call_id) {
    const { rows } = await pool.query(
      'SELECT lead_id FROM calls WHERE provider_call_id = $1 AND lead_id IS NOT NULL LIMIT 1',
      [event.provider_call_id]
    );
    if (rows[0]?.lead_id) return rows[0].lead_id;
  }

  // 4. phone last-10 match against leads.whatsapp_number
  const customer = String(event.customer_number || '').replace(/\D/g, '').slice(-10);
  if (customer.length === 10) {
    const { rows } = await pool.query(
      `SELECT id FROM leads
        WHERE RIGHT(REGEXP_REPLACE(whatsapp_number, '\\D', '', 'g'), 10) = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [customer]
    );
    if (rows[0]) return rows[0].id;
  }

  return null;
}

/* Single handler used by every Tata webhook path. The `routeKind` argument
   identifies which Tata trigger fired and drives:
     – which per-leg timestamp column gets stamped on the calls row
     – which typed SSE event ('agent.answered' | 'customer.answered' |
       'customer.missed' | 'call.hangup' | 'agent.missed' | 'call.update') is
       pushed to the caller's tab so the auto-call state machine can react.
   The legacy generic 'call.update' event is still emitted alongside typed
   events for backward compat with anything reading the generic feed. */
function makeTataHandler(routeKind) {
  return async function handleTataWebhook(req, res) {
    // 0. Acknowledge first so Smartflo doesn't retry
    res.status(200).json({ ok: true });

    // 1. Verify signature (when secret is set)
    const signature =
      req.headers['x-tata-signature'] ||
      req.headers['x-smartflo-signature'] ||
      req.headers['x-webhook-signature'] ||
      '';
    if (!tata.verifyWebhookSignature(req.rawBody || '', signature)) {
      console.warn('[webhooks/tata] bad signature — dropping payload');
      return;
    }

    // 2. Normalize
    const event = tata.normalizeWebhookEvent(req.body);
    if (!event || !event.provider_call_id) {
      console.warn('[webhooks/tata] unrecognized payload:', JSON.stringify(req.body).slice(0, 500));
      return;
    }

    // 3. Resolve lead
    let leadId = null;
    try { leadId = await resolveLeadId(event, req.body); } catch (e) { /* non-fatal */ }

    // 3b. Re-link Tata's webhook to the original /calls/start row.
    //
    // Tata click-to-call webhooks arrive with their own provider_call_id
    // (their internal call_id), which doesn't match the UUID we stored when
    // /calls/start ran. Without re-linking, every webhook would INSERT a new
    // row and a single logical call ends up split across 3+ rows in the DB.
    //
    // Strategy: if no row exists yet for this Tata provider_call_id AND we
    // have a leadId, look for a recent (last 5 min) calls row for this lead
    // whose provider_call_id is either NULL or doesn't look like a Tata-style
    // ID. Adopt that row's provider_call_id to Tata's so subsequent webhooks
    // for the same call all converge on it.
    try {
      if (leadId) {
        const existing = await pool.query(
          `SELECT id, provider_call_id FROM calls
             WHERE provider_call_id = $1
             LIMIT 1`,
          [event.provider_call_id]
        );
        if (existing.rows.length === 0) {
          // No row yet for this Tata id — try to adopt a recent unmatched
          // /calls/start row for this lead.
          await pool.query(
            `UPDATE calls
                SET provider_call_id = $2,
                    updated_at = NOW()
              WHERE id = (
                SELECT id FROM calls
                 WHERE lead_id = $1
                   AND started_at > NOW() - INTERVAL '5 minutes'
                   AND status NOT IN ('ended','missed','failed')
                   AND (provider_call_id IS NULL OR provider_call_id !~ '^[0-9.]+$')
                 ORDER BY started_at DESC
                 LIMIT 1
              )`,
            [leadId, event.provider_call_id]
          );
        }
      }
    } catch (_) { /* non-fatal — fall through to upsert */ }

    // 4. Upsert calls row by provider_call_id
    let callRow = null;
    try {
      const sets = ['raw_payload = $2', 'updated_at = NOW()'];
      const params = [event.provider_call_id, req.body];
      let i = 3;
      if (event.status) {
        sets.push(`status = $${i++}`); params.push(event.status);
        if (event.status === 'answered') sets.push('answered_at = COALESCE(answered_at, NOW())');
        if (['ended','missed','failed'].includes(event.status)) sets.push('ended_at = COALESCE(ended_at, NOW())');
      }
      // Per-leg timestamps driven by the route the webhook hit
      if (routeKind === 'agent-answered')    sets.push('agent_answered_at    = COALESCE(agent_answered_at,    NOW())');
      if (routeKind === 'customer-answered') sets.push('customer_answered_at = COALESCE(customer_answered_at, NOW())');
      if (routeKind === 'customer-missed')   sets.push('customer_missed_at   = COALESCE(customer_missed_at,   NOW())');
      if (routeKind === 'hangup' && event.hangup_by) {
        sets.push(`hangup_by = COALESCE(hangup_by, $${i++})`); params.push(event.hangup_by);
      }
      // Route-based ended_at — Tata's payload often carries call_status='answered'
      // even on the hangup webhook (because the call WAS answered), causing
      // status-based ended_at logic to skip. The route itself is a definitive
      // signal that the call ended (or in PCA's case, has fully completed).
      if (routeKind === 'hangup' || routeKind === 'recording') {
        sets.push('ended_at = COALESCE(ended_at, NOW())');
      }
      if (event.duration_sec != null) { sets.push(`duration_sec = $${i++}`); params.push(event.duration_sec); }
      if (event.recording_url) { sets.push(`recording_url = $${i++}`); params.push(event.recording_url); }
      if (event.error_message) { sets.push(`error_message = $${i++}`); params.push(event.error_message); }
      if (leadId) { sets.push(`lead_id = COALESCE(lead_id, $${i++})`); params.push(leadId); }

      const { rows } = await pool.query(
        `UPDATE calls SET ${sets.join(', ')}
          WHERE provider_call_id = $1
          RETURNING id, lead_id, caller_id, status, recording_url, duration_sec, provider_call_id,
                    agent_answered_at, customer_answered_at, customer_missed_at, ended_at, hangup_by,
                    started_at, updated_at`,
        params
      );

      if (rows.length === 0) {
        // Webhook for a call we never recorded (e.g. inbound, or out-of-order arrival)
        // Insert a fresh row so we don't lose the recording.
        const ins = await pool.query(
          `INSERT INTO calls (lead_id, provider_call_id, status, duration_sec,
                              recording_url, error_message, raw_payload,
                              answered_at, ended_at,
                              agent_answered_at, customer_answered_at, customer_missed_at, hangup_by)
           VALUES ($1, $2, COALESCE($3,'ended'), $4, $5, $6, $7,
                   CASE WHEN $3 = 'answered' THEN NOW() ELSE NULL END,
                   CASE WHEN $3 IN ('ended','missed','failed') THEN NOW() ELSE NULL END,
                   CASE WHEN $8 = 'agent-answered'    THEN NOW() ELSE NULL END,
                   CASE WHEN $8 = 'customer-answered' THEN NOW() ELSE NULL END,
                   CASE WHEN $8 = 'customer-missed'   THEN NOW() ELSE NULL END,
                   $9)
           RETURNING id, lead_id, caller_id, status, recording_url, duration_sec, provider_call_id,
                     agent_answered_at, customer_answered_at, customer_missed_at, ended_at, hangup_by,
                     started_at, updated_at`,
          [
            leadId, event.provider_call_id, event.status, event.duration_sec,
            event.recording_url, event.error_message, req.body,
            routeKind, event.hangup_by || null,
          ]
        );
        callRow = ins.rows[0] || null;
      } else {
        callRow = rows[0];
      }
    } catch (err) {
      console.error('[webhooks/tata] db error:', err.message);
      return;
    }

    if (!callRow) return;

    // 5. Push SSE updates to the caller's CRM tab (if assigned).
    //    Always emit the legacy generic 'call.update' for backward compat,
    //    plus a typed event the new auto-call state machine reacts to.
    if (callRow.caller_id) {
      callerSse.pushTo(callRow.caller_id, { type: 'call.update', call: callRow });

      const TYPED = {
        'agent-answered':    'agent.answered',
        'customer-answered': 'customer.answered',
        'customer-missed':   'customer.missed',
        'hangup':            'call.hangup',
        // PCA fires AFTER the call has fully ended. Treat it as a call-end
        // signal so the auto-call state machine can advance even when the
        // dedicated /hangup webhook didn't fire (which is common on
        // click-to-call accounts that only have the recording webhook
        // configured for terminal events).
        'recording':         'call.hangup',
      };
      const typed = TYPED[routeKind];
      if (typed) {
        callerSse.pushTo(callRow.caller_id, { type: typed, call: callRow });
      }

      // On hangup-style events with no agent-answered, we infer the agent
      // (caller) never picked the SmartFlow ring. Click-to-call mode doesn't
      // expose a dedicated "Call missed by Agent" trigger, so this is how the
      // state machine learns the caller missed their leg.
      if ((routeKind === 'hangup' || routeKind === 'recording') && !callRow.agent_answered_at) {
        callerSse.pushTo(callRow.caller_id, { type: 'agent.missed', call: callRow });
        console.warn('[auto-call] caller missed SmartFlow leg', {
          call_id: callRow.id, lead_id: callRow.lead_id, caller_id: callRow.caller_id, routeKind,
        });
      }
    }

    // 6. Background-download the recording so the URL never expires
    if (event.recording_url && callRow.recording_url && !callRow.recording_url.startsWith('/uploads/')) {
      setImmediate(() => {
        downloadRecording({
          callId:       callRow.id,
          recordingUrl: event.recording_url,
          callerId:     callRow.caller_id,
        })
        .then(() => {
          // Push a follow-up SSE so the audio src refreshes to the local copy
          if (callRow.caller_id) {
            pool.query(
              `SELECT id, lead_id, caller_id, status, recording_url, duration_sec
                 FROM calls WHERE id = $1`,
              [callRow.id]
            ).then(r => {
              if (r.rows[0]) callerSse.pushTo(callRow.caller_id, { type: 'call.update', call: r.rows[0] });
            }).catch(() => {});
          }
        })
        .catch(e => console.error('[webhooks/tata] recording download error:', e.message));
      });
    }
  };
}

router.post('/tata',                           rawBodyParser, makeTataHandler('catch-all'));
router.post('/tata-tele/recording',            rawBodyParser, makeTataHandler('recording'));
router.post('/tata-tele/answered-by-agent',    rawBodyParser, makeTataHandler('agent-answered'));
router.post('/tata-tele/answered-by-customer', rawBodyParser, makeTataHandler('customer-answered'));
router.post('/tata-tele/customer-missed',      rawBodyParser, makeTataHandler('customer-missed'));
router.post('/tata-tele/hangup',               rawBodyParser, makeTataHandler('hangup'));
router.post('/tata-tele/missed',               rawBodyParser, makeTataHandler('hangup'));

/* ── /tata/dialplan ──
   Inbound-call "screen pop" webhook. Tata POSTs here when someone dials your
   DID. The response body can route the call dynamically; an empty {} tells
   Tata to use the default dialplan configured in their dashboard.

   For now we just log the incoming caller, look up the matching lead, and
   fire an SSE event to the lead's assigned caller so their CRM can pop up
   the lead card. Default routing is left to Tata. */
router.post('/tata/dialplan', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const phoneRaw = body.caller_id_number || body.callerIdNumber || body.from || '';
    const phone10  = String(phoneRaw).replace(/\D/g, '').slice(-10);
    const uuid     = body.uuid || body.call_id || body.callId || null;
    console.log('[webhooks/tata/dialplan] inbound call:', { phone10, uuid });

    let leadRow = null;
    if (phone10) {
      try {
        const { rows } = await pool.query(
          `SELECT id, full_name, assigned_user_id
             FROM leads
            WHERE RIGHT(REGEXP_REPLACE(whatsapp_number, '\\D', '', 'g'), 10) = $1
            ORDER BY assigned_at DESC NULLS LAST
            LIMIT 1`,
          [phone10]
        );
        if (rows.length) leadRow = rows[0];
      } catch (e) {
        console.error('[webhooks/tata/dialplan] lookup error:', e.message);
      }
    }

    // Log the inbound call so the Missed Calls page has data to show. If a
    // matched lead has an assigned caller, the row is owned by that caller;
    // otherwise it's unowned (caller_id NULL) — surfaces to all CRMs as
    // an "Unknown caller" entry the team can claim.
    if (uuid) {
      try {
        await pool.query(
          `INSERT INTO calls
             (lead_id, caller_id, provider_call_id, direction, status, raw_payload)
           VALUES ($1, $2, $3, 'inbound', 'ringing', $4)
           ON CONFLICT (provider, provider_call_id) DO NOTHING`,
          [leadRow?.id || null, leadRow?.assigned_user_id || null, uuid, body]
        );
      } catch (e) {
        // Falls through gracefully if the unique (provider, provider_call_id)
        // index doesn't exist; the row just won't be deduped.
        try {
          await pool.query(
            `INSERT INTO calls (lead_id, caller_id, provider_call_id, direction, status, raw_payload)
             VALUES ($1, $2, $3, 'inbound', 'ringing', $4)`,
            [leadRow?.id || null, leadRow?.assigned_user_id || null, uuid, body]
          );
        } catch (e2) {
          console.error('[webhooks/tata/dialplan] insert error:', e2.message);
        }
      }
    }

    // SSE notify the assigned caller (if any) so their CRM can pop the card
    if (leadRow?.assigned_user_id) {
      callerSse.pushTo(leadRow.assigned_user_id, {
        type: 'call.incoming',
        lead_id:    leadRow.id,
        full_name:  leadRow.full_name,
        phone:      phone10,
        uuid,
      });
    }

    // Empty body → Tata uses the default dialplan
    res.status(200).json({});
  } catch (e) {
    console.error('[webhooks/tata/dialplan] error:', e.message);
    res.status(200).json({});  // never block Tata's call routing
  }
});

module.exports = router;
