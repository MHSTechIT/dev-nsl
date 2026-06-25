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
  if (perUserKey) {
    console.log('[tata.resolveApiKey]', { source: 'per_user', accountType, keyPrefix: String(perUserKey).slice(0, 16) + '...' });
    return perUserKey;
  }
  if (accountType) {
    const envName = `TATA_TELE_API_KEY_${accountType}`;
    const k = process.env[envName];
    if (k) {
      console.log('[tata.resolveApiKey]', { source: envName, accountType, keyPrefix: String(k).slice(0, 16) + '...' });
      return k;
    }
    console.warn('[tata.resolveApiKey]', { source: 'fallback_to_default', accountType, missingEnv: envName });
  }
  const fallback = process.env.TATA_TELE_API_KEY || '';
  console.log('[tata.resolveApiKey]', { source: 'TATA_TELE_API_KEY_default', accountType: accountType || '(none)', keyPrefix: fallback.slice(0, 16) + '...' });
  return fallback;
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

  // Diagnosis (probed live against this account, 2026-06-17):
  //   POST /v1/call/hangup with { call_id } → 422 "Invalid Call ID" for an
  //   already-ended call (the FIELD is accepted; the value just no longer
  //   maps to a live call). { uuid }/{ ref_id } → 422 "Invalid request body"
  //   (the field itself is wrong). So `call_id` is the ONLY field Tata's
  //   hangup accepts here — lead with it.
  //
  // The id Tata sends in webhooks (and that we store as provider_call_id)
  // looks like "DR6-D6-1781660841.351748" — a dialplan-prefixed telephony
  // uuid. Tata's hangup may want either the full string or the bare uuid
  // ("1781660841.351748"), so try both. The remaining legacy/uuid shapes are
  // kept as last-resort fallbacks for older plans.
  // `call_id` (JSON) is the proven shape for this account. We try the full id
  // and the bare telephony uuid, then keep `uuid` as a single legacy fallback
  // for older plans. The endpoint calls this per candidate id, so we keep the
  // variant list tight to avoid a request storm.
  const bareUuid = String(providerCallId).replace(/^[A-Za-z0-9]+-[A-Za-z0-9]+-/, '');
  const bodyVariants = [
    { call_id: providerCallId },                    // proven field, full id
    ...(bareUuid !== providerCallId ? [{ call_id: bareUuid }] : []), // bare telephony uuid
    { uuid: providerCallId },                        // legacy fallback (older plans)
  ];

  // JSON is the accepted content type (urlencoded added nothing in testing).
  const contentTypes = ['application/json'];

  // Tata returns the SAME 422 for two very different conditions:
  //   1) body schema is wrong (try the next variant)
  //   2) the call_id we sent references a call that has already ended on
  //      Tata's side (no body variant will ever succeed — the call object
  //      itself is gone). The fingerprint for #2 is a 422 where Tata's
  //      validation complains that BOTH call_id AND ref_id are missing,
  //      even though we sent one of them. Treat that as "already ended"
  //      and short-circuit the variant loop — saves 13 wasted HTTP calls
  //      and stops spamming the log on every cleanup hangup.
  function looksLikeAlreadyEnded(status, data) {
    if (status !== 422) return false;
    const d = data && typeof data === 'object' ? data : {};
    const msg = JSON.stringify(d).toLowerCase();
    // Tata's "this call no longer exists" fingerprints, seen across plans:
    //   - "invalid call id"  → call_id field accepted but the call is gone
    //   - both "call id field is required" AND "ref id field is required"
    //     (older schema's way of saying neither matched a live call)
    if (msg.includes('invalid call id')) return true;
    return msg.includes('call id field is required')
        && msg.includes('ref id field is required');
  }

  const attempts = [];
  // "Invalid Call ID" is ambiguous: it can mean either (a) the call already
  // ended, or (b) this id format isn't the one Tata wants for a still-live
  // call. We must NOT short-circuit on it mid-loop, or we'd skip the bare-uuid
  // call_id variant and fail to cut a live call. Instead we remember that we
  // saw a "call gone" response and only conclude already_ended AFTER every
  // call_id-shaped variant has been tried and none succeeded.
  let sawCallGone = null;
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

        if (looksLikeAlreadyEnded(res.status, data)) {
          sawCallGone = { contentType: ct, body, data };
        }
      } catch (e) {
        attempts.push({ contentType: ct, body, err: e.message });
      }
    }
  }
  // Every variant failed. If at least one call_id-shaped attempt came back
  // "call gone", the call is simply no longer active on Tata's side — a
  // hangup is a harmless no-op, so report success (the row gets marked ended
  // either way and the caller shouldn't retry).
  if (sawCallGone) {
    console.log('[tata.hangup] call already ended on provider', providerCallId);
    return { ok: true, endpoint: url, ...sawCallGone, reason: 'already_ended', attempts };
  }
  console.error('[tata.hangup] all body variants failed for call', providerCallId, '\n',
                JSON.stringify(attempts, null, 2));
  return { ok: false, reason: 'all_variants_failed', attempts };
}

/**
 * Smartflo "Live Calls" — every call currently active on this account.
 *   GET /v1/live_calls → [] or [{ call_id, id, uuid, did, destination, source,
 *                                 state, user_id, channel_id, ... }]
 * Used as the authoritative source of a live call's dialplan call_id when our
 * stored provider_call_id is only the short uuid (which Tata's hangup rejects).
 *
 * @returns {Promise<{ ok: boolean, calls: Array<object>, reason?: string }>}
 */
async function liveCalls({ accountType, perUserKey } = {}) {
  const apiKey = resolveApiKey({ perUserKey, accountType });
  if (!apiKey) return { ok: false, reason: 'no_api_key', calls: [] };
  const url = `${BASE_URL.replace(/\/$/, '')}/v1/live_calls`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': apiKey },
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (res.status >= 400) return { ok: false, reason: `http_${res.status}`, calls: [] };
    // Top-level array (observed), with a couple of defensive wrapper fallbacks.
    const calls = Array.isArray(data) ? data
                : Array.isArray(data?.data) ? data.data
                : Array.isArray(data?.results) ? data.results
                : Array.isArray(data?.live_calls) ? data.live_calls
                : [];
    return { ok: true, calls };
  } catch (e) {
    return { ok: false, reason: e.message, calls: [] };
  }
}

/**
 * Smartflo "Call Options" — supervisor live actions on an ACTIVE call.
 *   POST /v1/call/options  { type, call_id, agent_id?, intercom? }
 *   type: 1=Monitor (silent listen), 2=Whisper, 3=Barge, 4=Transfer.
 *
 * For Monitor (live listen) Smartflo connects the supervisor (agent_id — the
 * Smartflo-registered number/extension that will RING so they can hear) to the
 * live call_id silently. The call_id must belong to the same Smartflo account
 * whose API key we send, so the caller's account is passed in.
 *
 * @param {object} opts
 * @param {number|string} opts.type            – 1 monitor / 2 whisper / 3 barge / 4 transfer
 * @param {string} opts.callId                 – Tata provider_call_id of the LIVE call
 * @param {string} [opts.agentId]              – supervisor identifier (rings to listen) — monitor/whisper
 * @param {string|string[]} [opts.intercom]    – transfer target (type 4)
 * @param {string} [opts.accountType]
 * @param {string} [opts.perUserKey]
 * @returns {Promise<{ ok: true, raw: any }>}  – throws on Smartflo failure
 */
async function callOptions({ type, callId, agentId, intercom, accountType, perUserKey }) {
  const apiKey = resolveApiKey({ perUserKey, accountType });
  if (!apiKey) { const e = new Error('TATA_TELE_API_KEY not set in backend/.env'); e.status = 500; throw e; }
  if (!callId) { const e = new Error('No live call id to act on.'); e.status = 422; throw e; }

  const body = { type: String(type), call_id: callId };
  if (agentId)  body.agent_id = digitsOnly(agentId) || String(agentId);
  if (intercom) body.intercom = intercom;

  const url = `${BASE_URL.replace(/\/$/, '')}/v1/call/options`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (smartfloIsFailure(res.status, data)) {
    const msg = data?.message || data?.error || `Tata API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status >= 400 ? res.status : 400;
    err.body = data;
    throw err;
  }
  return { ok: true, raw: data };
}

/* Convenience: silent live-listen (Monitor, type 1). */
async function monitorCall(opts) { return callOptions({ ...opts, type: 1 }); }

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

  // Tata's hangup payload may indicate which side disconnected the call.
  // Real Tata webhook payloads use these keys (verified against live data):
  //   reason_key                   e.g. "Call Disconnected By Callee" / "Caller"
  //   hangup_cause_key             e.g. "NORMAL_CLEARING", "INTERWORKING"
  //   hangup_cause_description     human-readable cause
  //   hangup_cause_code            Q.850 numeric code
  // Plus the legacy / hypothetical names below as fallbacks. We collect
  // every candidate string and scan all of them so a "Callee" / "Caller"
  // wording in any field still classifies correctly.
  const candidates = [
    payload.reason_key,
    payload.hangup_cause_description,
    payload.hangup_cause_key,
    payload.hangup_by,
    payload.hangup_cause,
    payload.disconnected_by,
    payload.terminated_by,
    payload.who_hung_up,
    payload.end_reason,
    payload.hangup_side,
    payload.hangupBy,
  ].filter(v => v != null).map(v => String(v));
  const hangup_by_raw = candidates[0] || null;
  let hangup_by = null;
  for (const v of candidates) {
    const lower = v.toLowerCase();
    if (lower.includes('callee') || lower.includes('customer') || lower.includes('client')) {
      hangup_by = 'customer'; break;
    }
    if (lower.includes('caller') || lower.includes('agent')) {
      hangup_by = 'agent'; break;
    }
  }

  return {
    provider_call_id,
    status,
    recording_url,
    duration_sec: duration_sec != null ? Number(duration_sec) : null,
    error_message: payload.error || payload.failure_reason || null,
    custom_lead_id,
    customer_number,
    caller_number,
    hangup_by,
    hangup_by_raw,
  };
}

/**
 * Pull recent inbound call records from Tata Smartflo. Used by the
 * scheduled poller to detect missed customer calls that didn't arrive
 * via webhook (Smartflo dashboards don't always expose webhook config).
 *
 * Tata's CDR endpoint name varies by plan / generation:
 *   /v1/call/records          – most common
 *   /v1/cdr                   – older accounts
 *   /v1/call/cdr              – some Smartflo deployments
 * We try them in order until one returns a JSON body with a calls array.
 *
 * @param {object} opts
 * @param {number} [opts.lookbackMinutes=10]  – fetch calls started within this window
 * @returns {Promise<{ ok: boolean, endpoint?: string, calls: any[], raw?: any, error?: string }>}
 */
async function fetchInboundMissedCalls({ lookbackMinutes = 10 } = {}) {
  const apiKey = process.env.TATA_TELE_API_KEY || '';
  if (!apiKey) return { ok: false, error: 'TATA_TELE_API_KEY not set', calls: [] };

  const now      = new Date();
  const since    = new Date(now.getTime() - lookbackMinutes * 60 * 1000);
  const fmtTata  = d => d.toISOString().slice(0, 19).replace('T', ' '); // "YYYY-MM-DD HH:MM:SS"
  const fmtDate  = d => d.toISOString().slice(0, 10);                   // "YYYY-MM-DD"

  // Candidate endpoint shapes ordered by likelihood for Smartflo accounts.
  // Each entry: { path, params } — params will be URL-encoded.
  const variants = [
    { path: '/v1/call/records', params: { from_date: fmtTata(since), to_date: fmtTata(now), call_type: 'inbound' } },
    { path: '/v1/call/records', params: { from_date: fmtDate(since), to_date: fmtDate(now), direction: 'inbound' } },
    { path: '/v1/call/records', params: { from_date: fmtDate(since), to_date: fmtDate(now) } },
    { path: '/v1/cdr',          params: { from_date: fmtTata(since), to_date: fmtTata(now), direction: 'inbound' } },
    { path: '/v1/call/cdr',     params: { from_date: fmtTata(since), to_date: fmtTata(now), direction: 'inbound' } },
  ];

  const attempts = [];
  for (const v of variants) {
    const qs  = new URLSearchParams(v.params).toString();
    const url = `${BASE_URL.replace(/\/$/, '')}${v.path}?${qs}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: apiKey, Accept: 'application/json' },
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      attempts.push({ url, status: res.status, sample: typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : null });

      // Tata responses we've observed: { results: [...], count: N }, { data: [...] }, or [{...}, ...]
      const calls =
        (Array.isArray(data?.results) && data.results) ||
        (Array.isArray(data?.data) && data.data) ||
        (Array.isArray(data?.calls) && data.calls) ||
        (Array.isArray(data) && data) ||
        null;

      if (calls && !smartfloIsFailure(res.status, data)) {
        // Filter to inbound + missed (some Tata responses don't honor the direction filter)
        const inbound = calls.filter(c => {
          const dir = String(c.direction || c.call_type || c.type || '').toLowerCase();
          return dir.includes('in') || (!c.direction && c.from); // tolerate missing direction
        });
        const missed = inbound.filter(c => {
          const status = String(c.status || c.call_status || c.disposition || '').toLowerCase();
          const answered = c.answered_at || c.answered_seconds || c.bill_duration || c.duration;
          // Treat as missed if explicitly marked OR call had no bill_duration (rang but unanswered)
          return /miss|fail|noanswer|no-answer|cancel|reject|abandon/.test(status)
              || (!answered || Number(answered) === 0);
        });
        return { ok: true, endpoint: v.path, calls: missed, raw: data, attempts };
      }
    } catch (e) {
      attempts.push({ url, error: e.message });
    }
  }
  return { ok: false, error: 'no Tata CDR endpoint responded with a parseable calls list', calls: [], attempts };
}

/**
 * Map one Tata CDR row → fields we INSERT into our `calls` table. Tata's
 * field names vary across accounts — try every common alias.
 */
function normalizeCdrRow(row) {
  const uuid =
    row.uuid || row.call_id || row.callId || row.id || row.reference_id ||
    row.ref_id || row.refId || null;
  const fromRaw   = row.caller_id_number || row.client_number || row.from || row.callerIdNumber || row.from_number || row.source || '';
  const toRaw     = row.called_number || row.did_number || row.destination_number || row.to || row.to_number || row.destination || '';
  // Tata's CDR splits the timestamp into two fields: `date` (YYYY-MM-DD) and
  // `time` (HH:MM:SS). When present, combine them; else fall back to the
  // single-field variants. All values get treated as IST then converted by pg.
  let startedAt =
    row.created_at || row.start_time || row.startTime || row.call_start || row.end_stamp || null;
  if (!startedAt && row.date && row.time) startedAt = `${row.date} ${row.time}+05:30`;
  else if (!startedAt && row.date)        startedAt = `${row.date}T00:00:00+05:30`;
  const durSec    = row.duration_sec || row.duration || row.bill_duration || row.call_duration || null;
  const recording = row.recording_url || row.recordingUrl || row.recording || null;
  return {
    provider_call_id: uuid ? String(uuid) : null,
    phone10:          String(fromRaw).replace(/\D/g, '').slice(-10),
    to_did:           String(toRaw).replace(/\D/g, '').slice(-10),
    started_at:       startedAt,
    duration_sec:     durSec != null ? Number(durSec) : null,
    recording_url:    recording || null,
    raw_payload:      row,
  };
}

module.exports = {
  isConfigured,
  resolveApiKey,
  startCall,
  hangup,
  liveCalls,
  callOptions,
  monitorCall,
  verifyWebhookSignature,
  normalizeWebhookEvent,
  fetchInboundMissedCalls,
  normalizeCdrRow,
};
