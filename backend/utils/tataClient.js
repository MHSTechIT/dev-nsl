/**
 * Tata Smartflo Click-to-Call client.
 *
 * Per-user settings come from each caller's CRM user row (Smartflo Settings form):
 *   tata_account_type     – e.g. "OR165136" (suffix used for per-account env key)
 *   tata_extension        – Smartflo extension (fallback agent identifier)
 *   tata_agent_number     – the number Smartflo rings first (preferred)
 *   tata_caller_id        – the DID the lead sees as the incoming number
 *   tata_smartflo_api_key – per-user API key override (rarely needed)
 *
 * Env (in priority order from TOP-down for the API key):
 *   TATA_TELE_API_KEY_<AccountType>   – per-account override (e.g. _OR165136)
 *   TATA_TELE_API_KEY                 – global fallback
 *   TATA_TELE_DID                     – default caller_id when user has none
 *   TATA_TELE_AGENT_EXTENSION         – default extension when user has none
 *   TATA_TELE_API_BASE_URL            – defaults to api-smartflo.tatateleservices.com
 *   TATA_TELE_CLICK_TO_CALL_PATH      – defaults to /v1/click_to_call
 *   TATA_TELE_WEBHOOK_SECRET          – HMAC secret for verifying inbound webhooks
 */

const crypto = require('crypto');

const BASE_URL = process.env.TATA_TELE_API_BASE_URL    || 'https://api-smartflo.tatateleservices.com';
const PATH     = process.env.TATA_TELE_CLICK_TO_CALL_PATH || '/v1/click_to_call';
const WEBHOOK_SECRET = process.env.TATA_TELE_WEBHOOK_SECRET || '';

/* ── API key resolution: per-user → per-account → global ── */
function resolveApiKey({ perUserKey, accountType }) {
  if (perUserKey) return perUserKey;
  if (accountType) {
    const k = process.env[`TATA_TELE_API_KEY_${accountType}`];
    if (k) return k;
  }
  return process.env.TATA_TELE_API_KEY || '';
}

function isConfigured() {
  return Boolean(BASE_URL && process.env.TATA_TELE_API_KEY);
}

/* ── Smartflo "200 OK + status:false" reclassifier ── */
function smartfloIsFailure(httpStatus, data) {
  if (httpStatus >= 400) return true;
  if (data?.status === false || data?.status === 'fail') return true;
  const msg = String(data?.message || data?.error || '').toLowerCase();
  if (/(not logged|offline|unauthorized|invalid|denied|not.*found)/i.test(msg)) return true;
  return false;
}

/* Strip everything except digits — Smartflo /v1/click_to_call wants digits only */
function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * Place a Smartflo click-to-call.
 * Smartflo rings the agent's `agent_number` first; once they pick up, it bridges
 * to `destination_number` (the lead) showing `caller_id` (the DID) on screen.
 *
 * @param {object} opts
 * @param {string} [opts.agentNumber]       – preferred Smartflo identifier (the phone Smartflo rings)
 * @param {string} [opts.extension]         – fallback extension if agentNumber is missing
 * @param {string} opts.destinationNumber   – the lead's phone (will be normalized)
 * @param {string} [opts.callerId]          – DID shown on the lead's phone
 * @param {string} [opts.accountType]       – Smartflo Account Type (used for env key suffix)
 * @param {string} [opts.perUserKey]        – per-user API key override
 * @param {object} [opts.customIdentifier]  – round-tripped to webhooks (e.g. { lead_id, lead_name })
 * @returns {Promise<{ provider_call_id: string|null, raw: any, stubbed?: boolean, reason?: string }>}
 */
async function startCall({
  agentNumber,
  extension,
  destinationNumber,
  callerId,
  accountType,
  perUserKey,
  customIdentifier,
}) {
  const apiKey = resolveApiKey({ perUserKey, accountType });

  if (!apiKey) {
    return {
      provider_call_id: null,
      stubbed: true,
      reason: 'no_api_key',
      raw: { error: 'TATA_TELE_API_KEY not set in backend/.env' },
    };
  }

  const agent = digitsOnly(agentNumber || extension || process.env.TATA_TELE_AGENT_EXTENSION || '');
  const dest  = digitsOnly(destinationNumber);
  const did   = digitsOnly(callerId || process.env.TATA_TELE_DID || '');

  if (!agent) {
    const err = new Error('No Smartflo agent_number or extension configured for this caller.');
    err.status = 409;
    throw err;
  }
  if (!dest) {
    const err = new Error('Lead destination number is invalid.');
    err.status = 422;
    throw err;
  }

  const body = {
    agent_number:       agent,
    destination_number: dest,
    caller_id:          did,
    async:              1,
    custom_identifier:  customIdentifier || undefined,
  };

  const url = `${BASE_URL.replace(/\/$/, '')}${PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': apiKey,            // RAW — no "Bearer "
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (smartfloIsFailure(res.status, data)) {
    const msg = data?.message || data?.error || `Tata API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status >= 400 ? res.status : 400;
    err.body = data;
    throw err;
  }

  // Smartflo uses different field names across docs/products — cover the common ones.
  // Newer Smartflo accounts return `ref_id` (the originate-queue reference); older ones
  // return `call_id`/`uuid`. We accept both — webhook handler upgrades ref_id → uuid
  // later if Tata sends a separate call_id in the answered/ended events.
  const provider_call_id =
    data?.call_id || data?.callId || data?.id || data?.uuid ||
    data?.request_id || data?.ref_id || data?.refId ||
    data?.data?.call_id || data?.data?.ref_id || null;

  return { provider_call_id, raw: data, stubbed: false };
}

/**
 * Disconnect an active Smartflo call.
 *
 * Smartflo's hangup endpoint isn't documented uniformly across plans — different
 * accounts get different paths. We try the three known patterns in order and
 * return success if any of them returns OK.  Caller can ignore failures: if the
 * call is already ended, every endpoint will 404/410 anyway.
 *
 * @param {object} opts
 * @param {string} opts.providerCallId   – Tata's call_id / uuid from startCall()
 * @param {string} [opts.accountType]
 * @param {string} [opts.perUserKey]
 * @returns {Promise<{ ok: boolean, endpoint?: string, raw?: any, reason?: string }>}
 */
async function hangup({ providerCallId, accountType, perUserKey }) {
  const apiKey = resolveApiKey({ perUserKey, accountType });
  if (!apiKey)         return { ok: false, reason: 'no_api_key' };
  if (!providerCallId) return { ok: false, reason: 'no_call_id' };

  const url = `${BASE_URL.replace(/\/$/, '')}/v1/call/hangup`;

  // Diagnosis from the previous round:
  //   /v1/call/hangup returned 422 "Invalid request body" — endpoint and auth
  //   are correct, body schema is wrong. Iterate through the field-shape
  //   variants Tata is known to accept across plans. First non-422 wins.
  const bodyVariants = [
    { uuid: providerCallId },                       // most common live-call shape
    { ref_id: providerCallId },                     // newer originate-ref shape
    { call_id: providerCallId },                    // legacy
    { call_id: providerCallId, action: 'hangup' },
    { request_id: providerCallId },
    { id: providerCallId },
    { uuid: providerCallId, action: 'disconnect' },
  ];

  // Some Tata variants want form-urlencoded; we try both content types.
  const contentTypes = ['application/json', 'application/x-www-form-urlencoded'];

  const attempts = [];
  for (const ct of contentTypes) {
    for (const body of bodyVariants) {
      const encoded = ct === 'application/json'
        ? JSON.stringify(body)
        : new URLSearchParams(body).toString();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type':  ct,
            'Accept':        'application/json',
            'Authorization': apiKey,
          },
          body: encoded,
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }

        attempts.push({ contentType: ct, body, status: res.status, data });

        if (!smartfloIsFailure(res.status, data)) {
          console.log('[tata.hangup] SUCCESS', JSON.stringify({ contentType: ct, body, data }));
          return { ok: true, endpoint: url, contentType: ct, body, raw: data, attempts };
        }
      } catch (e) {
        attempts.push({ contentType: ct, body, err: e.message });
      }
    }
  }
  console.error('[tata.hangup] all body variants failed for call', providerCallId, '\n',
                JSON.stringify(attempts, null, 2));
  return { ok: false, reason: 'all_variants_failed', attempts };
}

/* ── Webhook signature verification (HMAC-SHA256) ── */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) return true; // dev mode — accept anything until secret is set
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader).trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ── Map Tata payload → normalized event shape ── */
function normalizeWebhookEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const provider_call_id =
    payload.call_id || payload.callId || payload.CallId || payload.uuid ||
    payload.CallSid || payload.id || payload.request_id || null;

  const rawEvent = String(
    payload.event || payload.event_type || payload.status || payload.call_status || ''
  ).toLowerCase();

  let status = null;
  if (rawEvent.includes('initiat')) status = 'initiated';
  else if (rawEvent.includes('ring')) status = 'ringing';
  else if (rawEvent.includes('answer')) status = 'answered';
  else if (rawEvent.includes('miss'))   status = 'missed';
  else if (rawEvent.includes('busy'))   status = 'missed';   // map busy → missed for our enum
  else if (rawEvent.includes('fail') || rawEvent.includes('reject')) status = 'failed';
  else if (rawEvent.includes('end') || rawEvent.includes('disconnect') || rawEvent.includes('hangup')) status = 'ended';

  const recording_url =
    payload.recording_url || payload.recordingUrl || payload.recording ||
    payload.RecordingUrl || payload.RecordUrl || null;

  const duration_sec =
    payload.duration_sec || payload.duration || payload.call_duration ||
    payload.CallDuration || payload.DurationSeconds || null;

  // Lead matching hints — for the 4-tier match in the webhook handler
  const custom_lead_id =
    (payload.custom_identifier && payload.custom_identifier.lead_id) ||
    payload.lead_id || payload.leadId || null;

  const customer_number =
    payload.to || payload.destination_number || payload.customer_number ||
    payload.ToNumber || payload.DestinationNumber || payload.callee || null;

  const caller_number =
    payload.from || payload.caller_id || payload.FromNumber || payload.from_number || null;

  return {
    provider_call_id,
    status,
    recording_url,
    duration_sec: duration_sec != null ? Number(duration_sec) : null,
    error_message: payload.error || payload.failure_reason || null,
    custom_lead_id,
    customer_number,
    caller_number,
  };
}

module.exports = {
  isConfigured,
  resolveApiKey,
  startCall,
  hangup,
  verifyWebhookSignature,
  normalizeWebhookEvent,
};
