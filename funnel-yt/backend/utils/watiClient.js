/**
 * WATI (WhatsApp Team Inbox) Template Message client.
 *
 * Env vars:
 *   WATI_API_KEY        — Bearer token from WATI dashboard (the "Access Token")
 *   WATI_API_BASE_URL   — full base including tenant id, e.g.
 *                         https://live-mt-server.wati.io/<tenant_id>
 *                         (without the trailing /api/v1/...)
 *                         If only the host is given (no tenant id), the
 *                         WATI_TENANT_ID env var is appended.
 *   WATI_TENANT_ID      — optional, used when WATI_API_BASE_URL doesn't include tenant
 *
 * The function is a thin wrapper: takes a phone number and a template name,
 * fires a POST to WATI's /sendTemplateMessage endpoint. Returns
 * { ok, status, body } so callers can log the outcome.
 */

const RAW_KEY = process.env.WATI_API_KEY || '';
const BASE    = (process.env.WATI_API_BASE_URL || 'https://live-mt-server.wati.io').replace(/\/$/, '');
const TENANT  = process.env.WATI_TENANT_ID || '';

function buildBase() {
  // If BASE already contains the tenant segment (anything after a UUID-style
  // segment), use it as-is. Otherwise append TENANT.
  if (/\/\d+|\/[0-9a-fA-F-]{8,}/.test(BASE)) return BASE;
  if (TENANT) return `${BASE}/${TENANT}`;
  return BASE;
}

function authHeader() {
  // WATI tokens are sometimes pre-prefixed with "Bearer " by users, sometimes
  // raw. Normalize.
  const k = RAW_KEY.trim();
  if (!k) return null;
  return k.toLowerCase().startsWith('bearer ') ? k : `Bearer ${k}`;
}

function isConfigured() {
  return Boolean(RAW_KEY);
}

/**
 * Send a pre-approved template message via WATI.
 * @param {object} opts
 * @param {string} opts.phone            — destination, 10 or 12 digit, no plus
 * @param {string} opts.templateName     — pre-approved WATI template name
 * @param {Array}  [opts.parameters]     — template body params (default [])
 * @param {string} [opts.broadcastName]  — defaults to templateName
 * @returns {Promise<{ ok:boolean, status:number, body:any, error?:string }>}
 */
async function sendTemplate({ phone, templateName, parameters = [], broadcastName }) {
  if (!isConfigured()) return { ok: false, status: 0, body: null, error: 'WATI_API_KEY not set' };
  if (!phone || !templateName) return { ok: false, status: 0, body: null, error: 'phone and templateName required' };

  // WATI expects parameters as [{ name: "1", value: "..." }, ...] where
  // `name` is the variable index ("1" maps to {{1}} in the template body).
  // Accept simple values (strings/numbers) and auto-wrap, OR pre-formatted
  // objects — pass through.
  const watiParams = (parameters || []).map((p, i) => {
    if (p && typeof p === 'object' && 'name' in p) return p; // already shaped
    return { name: String(i + 1), value: String(p) };
  });

  // WATI wants the destination as digits with country code, no plus.
  const num = String(phone).replace(/\D/g, '');
  const whatsappNumber = num.length === 10 ? `91${num}` : num;

  // WATI has multiple URL shapes depending on account generation and tenant
  // configuration. Try each candidate until one returns non-404. The first
  // one that responds with an HTTP status (any status, not network error)
  // and is not 404 wins. This lets us tolerate missing WATI_TENANT_ID for
  // newer accounts that derive tenant from the bearer token.
  const candidates = [];
  const tenantBase = buildBase();
  // Pattern 1 — official "live-mt-server.wati.io/<tenant>/api/v1/..."
  candidates.push(`${tenantBase}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`);
  // Pattern 2 — older "/api/sendTemplateMessage" style
  candidates.push(`${tenantBase}/api/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`);

  // Pattern 3 — Some WATI accounts encode the tenant as the UUID after the
  // "wati_" prefix in the key itself. Try that on the standard host.
  if (!TENANT && !/\/\d|\/[0-9a-fA-F-]{8,}/.test(tenantBase)) {
    const uuidMatch = RAW_KEY.match(/^wati_([0-9a-fA-F-]{8,})/);
    if (uuidMatch) {
      candidates.push(`https://live-mt-server.wati.io/${uuidMatch[1]}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`);
    }
  }

  // Pattern 4 — app-server fallback (older accounts)
  if (!/live-mt-server/.test(tenantBase)) {
    candidates.push(`https://app-server.wati.io/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`);
  }

  const attempts = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json-patch+json',
          Authorization: authHeader(),
        },
        body: JSON.stringify({
          template_name:  templateName,
          broadcast_name: broadcastName || templateName,
          parameters:     watiParams,
        }),
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
      attempts.push({ url, status: res.status, body });
      if (res.status === 404) continue; // try next pattern
      // Success criteria: HTTP 2xx AND WATI's own result flag is truthy.
      // `validWhatsAppNumber` is an unreliable diagnostic flag — WATI often
      // returns it as false for contacts already imported via their own
      // platform, even when the template is successfully queued. The presence
      // of a `local_message_id` is a much better delivery indicator.
      const ok = res.ok && (body?.result === true || body?.result === 'success' || !!body?.local_message_id);
      return { ok, status: res.status, body, urlUsed: url, attempts };
    } catch (e) {
      attempts.push({ url, error: e.message });
    }
  }
  return { ok: false, status: 0, body: null, error: 'All WATI URL patterns failed', attempts };
}

module.exports = { isConfigured, sendTemplate };
