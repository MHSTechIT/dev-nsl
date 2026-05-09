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

/* Single handler used by both webhook paths */
async function handleTataWebhook(req, res) {
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
    if (event.duration_sec != null) { sets.push(`duration_sec = $${i++}`); params.push(event.duration_sec); }
    if (event.recording_url) { sets.push(`recording_url = $${i++}`); params.push(event.recording_url); }
    if (event.error_message) { sets.push(`error_message = $${i++}`); params.push(event.error_message); }
    if (leadId) { sets.push(`lead_id = COALESCE(lead_id, $${i++})`); params.push(leadId); }

    const { rows } = await pool.query(
      `UPDATE calls SET ${sets.join(', ')}
        WHERE provider_call_id = $1
        RETURNING id, lead_id, caller_id, status, recording_url, duration_sec, provider_call_id`,
      params
    );

    if (rows.length === 0) {
      // Webhook for a call we never recorded (e.g. inbound, or out-of-order arrival)
      // Insert a fresh row so we don't lose the recording.
      const ins = await pool.query(
        `INSERT INTO calls (lead_id, provider_call_id, status, duration_sec,
                            recording_url, error_message, raw_payload,
                            answered_at, ended_at)
         VALUES ($1, $2, COALESCE($3,'ended'), $4, $5, $6, $7,
                 CASE WHEN $3 = 'answered' THEN NOW() ELSE NULL END,
                 CASE WHEN $3 IN ('ended','missed','failed') THEN NOW() ELSE NULL END)
         RETURNING id, lead_id, caller_id, status, recording_url, duration_sec, provider_call_id`,
        [
          leadId, event.provider_call_id, event.status, event.duration_sec,
          event.recording_url, event.error_message, req.body,
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

  // 5. Push SSE update to the caller's CRM tab (if assigned)
  if (callRow.caller_id) {
    callerSse.pushTo(callRow.caller_id, { type: 'call.update', call: callRow });
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
}

router.post('/tata',                    rawBodyParser, handleTataWebhook);
router.post('/tata-tele/recording',     rawBodyParser, handleTataWebhook);
router.post('/tata-tele/answered-by-agent',    rawBodyParser, handleTataWebhook);
router.post('/tata-tele/answered-by-customer', rawBodyParser, handleTataWebhook);
router.post('/tata-tele/hangup',        rawBodyParser, handleTataWebhook);
router.post('/tata-tele/missed',        rawBodyParser, handleTataWebhook);

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
    console.log('[webhooks/tata/dialplan] inbound call:', { phone10, uuid: body.uuid });

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
        if (rows.length && rows[0].assigned_user_id) {
          callerSse.pushTo(rows[0].assigned_user_id, {
            type: 'call.incoming',
            lead_id:    rows[0].id,
            full_name:  rows[0].full_name,
            phone:      phone10,
            uuid:       body.uuid || null,
          });
        }
      } catch (e) {
        console.error('[webhooks/tata/dialplan] lookup error:', e.message);
      }
    }

    // Empty body → Tata uses the default dialplan
    res.status(200).json({});
  } catch (e) {
    console.error('[webhooks/tata/dialplan] error:', e.message);
    res.status(200).json({});  // never block Tata's call routing
  }
});

module.exports = router;
