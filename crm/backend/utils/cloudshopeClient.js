/**
 * CloudShope voice-call (IVR) client — WF-06 reminder model.
 *
 *   POST https://panelv3.cloudshope.com/api/sendVoiceCall
 *   Authorization: Bearer <CLOUDSHOPE_TOKEN>
 *   body: {
 *     sendTo:"Numbers", number, cli_number, voice_file_id, credit_type_id,
 *     silent_duration:0, campagin_type:"SimpleVoiceCall", campaign_name,
 *     retry_did, schedulled_at
 *   }
 *   Quirks (Cloudshope's, keep verbatim):
 *     • `campagin_type`  — misspelt; the API expects the misspelling.
 *     • `schedulled_at`  — misspelt; IST "YYYY-MM-DD HH:MM:SS" (use now to fire now).
 *     • The API replies HTTP 200 even on errors, with { status: 500, message }.
 *       So we key success off the JSON `status`, not the HTTP code.
 *     • `retry_did` — Cloudshope auto-retries unconnected calls on ITS side.
 *       Do NOT add an app retry loop (double-bills credits).
 *
 * Account-dependent values (env):
 *   CLOUDSHOPE_TOKEN          — Bearer JWT (secret).
 *   CLOUDSHOPE_CLI_NUMBER     — caller-ID + retry DID shown to the recipient.
 *   CLOUDSHOPE_CREDIT_TYPE_ID — which credit the account spends. 23 = "Answer
 *                               Transactional" (DLT-approved). The account must
 *                               actually HOLD this credit, else 402 / "invalid
 *                               credit_type_id".
 */
const BASE = (process.env.CLOUDSHOPE_BASE_URL || 'https://panelv3.cloudshope.com/api').replace(/\/+$/, '');
const TOKEN = (process.env.CLOUDSHOPE_TOKEN || '').trim();
const CREDIT_TYPE_ID = (process.env.CLOUDSHOPE_CREDIT_TYPE_ID || '23').trim();
const CLI_NUMBER = (process.env.CLOUDSHOPE_CLI_NUMBER || '6746845006').trim();

function isConfigured() { return Boolean(TOKEN); }

/** Bare 10-digit Indian number (Cloudshope `number` wants no country code). */
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

/** Current IST timestamp as "YYYY-MM-DD HH:MM:SS" (fires the call immediately). */
function nowIstStamp() {
  return new Date(Date.now() + 5.5 * 3600 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Fire a single voice call.
 * @param {object} a
 * @param {string} a.phone        — destination (any format; trimmed to last 10 digits)
 * @param {number|string} a.voiceFileId — Cloudshope voice_file_id for this campaign
 * @param {string} [a.campaignName]
 * @returns {Promise<object>} the CloudShope JSON on success.
 * @throws on misconfig / bad input / API failure (err.body holds the response).
 */
async function triggerCall({ phone, voiceFileId, campaignName }) {
  if (!isConfigured()) {
    const e = new Error('CLOUDSHOPE_TOKEN not set');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const number = normalizePhone(phone);
  if (number.length !== 10) throw new Error('valid 10-digit phone required');
  if (!voiceFileId) throw new Error('voiceFileId required');

  const campaign = 'IVR-' + String(campaignName || 'Lead')
    .replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30);

  const body = {
    sendTo:          'Numbers',
    number,
    cli_number:      CLI_NUMBER,
    voice_file_id:   Number(voiceFileId),
    credit_type_id:  CREDIT_TYPE_ID,
    silent_duration: 0,
    campagin_type:   'SimpleVoiceCall',   // Cloudshope's spelling — keep
    campaign_name:   campaign,
    retry_did:       CLI_NUMBER,
    schedulled_at:   nowIstStamp(),        // Cloudshope's spelling — keep
  };

  const res = await fetch(`${BASE}/sendVoiceCall`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

  const status = data && (data.status ?? data.code);
  const ok = res.ok && (status === 200 || status === '200' || data.Campaign_id || data.success === true);
  if (!ok) {
    const err = new Error(`cloudshope sendVoiceCall failed: ${(data && data.message) || res.status}`);
    err.body = data;
    throw err;
  }
  return data;
}

module.exports = { isConfigured, normalizePhone, nowIstStamp, triggerCall, CREDIT_TYPE_ID, CLI_NUMBER };
