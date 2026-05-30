/* ────────────────────────────────────────────────────────────────────────
   Meta Conversions API (CAPI) — server-side event sender.
   ----------------------------------------------------------------------
   Pairs with `frontend/src/utils/metaPixel.js`. Every event the browser
   fires via fbq is ALSO mirrored to /api/meta/event (see routes/meta.js);
   the route hands the payload to `sendCapiEvent()` here. Both events
   carry the SAME `event_id`, which is the dedup key Meta uses to merge
   them into a single conversion.

   Why CAPI as well as the browser pixel:
     • Browser pixel is blocked by ad-blockers, iOS Safari ITP, brave,
       enterprise filters, etc. — losses of 20-40% are typical.
     • CAPI fires from the server (which the user's network can't
       intercept). Meta merges the two via event_id so we get one
       conversion record even when both signals reach Meta.
     • CAPI also lets us forward HASHED user data (email, phone, name)
       which dramatically improves match rates. We hash sha256 here
       (Meta's documented format) before transmission.

   ENV — set in funnel-meta2/backend/.env:
     META_PIXEL_ID         = 1866739047322363
     META_ACCESS_TOKEN     = <long EAA... token from Events Manager>
     META_TEST_EVENT_CODE  = TEST69061   (optional — strips to live mode
                             when unset; "TEST69061" routes to Meta's
                             Test Events panel in Events Manager)
     META_CAPI_API_VERSION = v18.0        (optional, default v18.0)

   Doc reference:
   https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/
   ──────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');

const PIXEL_ID         = process.env.META_PIXEL_ID         || '1866739047322363';
const ACCESS_TOKEN     = process.env.META_ACCESS_TOKEN     || '';
const TEST_EVENT_CODE  = process.env.META_TEST_EVENT_CODE  || '';
const API_VERSION      = process.env.META_CAPI_API_VERSION || 'v18.0';

/* Sha256 a string after normalizing — Meta documents the exact rules:
   lowercase, trim, strip non-digits for phone, strip @-suffix for
   country codes never. We follow the same. */
function sha256(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  return crypto.createHash('sha256').update(s).digest('hex');
}

/* Phone needs digits-only AND country code prefix. India default +91
   when the caller didn't include one. Trim leading zeros (some forms
   collect 0xxx-xxxx-xxxx). */
function normalizePhone(raw) {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10) digits = '91' + digits;        // assume India
  if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  return digits;
}

/* Build the user_data block Meta expects. All identifiers are hashed
   per Meta's spec; raw values never leave this function. fbp, fbc,
   client_ip_address, client_user_agent stay un-hashed (Meta wants
   them raw). */
function buildUserData(input) {
  const u = input || {};
  const out = {};
  const em  = sha256(u.email);
  const ph  = sha256(normalizePhone(u.phone));
  const fn  = sha256(u.first_name || (u.full_name || '').split(' ').slice(0, 1).join(' '));
  const ln  = sha256(u.last_name  || (u.full_name || '').split(' ').slice(1).join(' '));
  const ct  = sha256(u.city);
  const st  = sha256(u.state);
  const zp  = sha256(u.zip);
  const cn  = sha256(u.country || 'in');
  const ext = sha256(u.visitor_id || u.external_id);
  if (em)  out.em  = [em];
  if (ph)  out.ph  = [ph];
  if (fn)  out.fn  = [fn];
  if (ln)  out.ln  = [ln];
  if (ct)  out.ct  = [ct];
  if (st)  out.st  = [st];
  if (zp)  out.zp  = [zp];
  if (cn)  out.country = [cn];
  if (ext) out.external_id = [ext];
  if (u.fbp) out.fbp = u.fbp;
  if (u.fbc) out.fbc = u.fbc;
  if (u.client_ip_address) out.client_ip_address = u.client_ip_address;
  if (u.client_user_agent) out.client_user_agent = u.client_user_agent;
  return out;
}

/* Send one event to Meta's Conversions API. Fire-and-forget by
   default — callers may await the returned promise if they want the
   Meta API response (e.g. for logging events_received counts).

   Required:  event_name, event_time
   Recommended: event_id (dedup key shared with the browser pixel),
                event_source_url, action_source, user_data
   ──────────────────────────────────────────────────────────────────── */
async function sendCapiEvent({
  event_name,
  event_id,
  event_time,
  event_source_url,
  action_source = 'website',
  user_data,
  custom_data,
}) {
  if (!ACCESS_TOKEN) {
    // No token configured — silently no-op so dev environments and
    // CI don't spam the logs. The browser pixel still fires; the
    // server-side mirror just doesn't get sent.
    return { skipped: 'no_access_token' };
  }
  if (!event_name) return { skipped: 'no_event_name' };

  const payload = {
    data: [{
      event_name,
      event_id:         event_id || undefined,
      event_time:       event_time || Math.floor(Date.now() / 1000),
      event_source_url: event_source_url || undefined,
      action_source,
      user_data:        buildUserData(user_data),
      custom_data:      custom_data || {},
    }],
  };
  if (TEST_EVENT_CODE) payload.test_event_code = TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-json */ }
    if (!res.ok) {
      console.warn('[metaCapi] non-OK', res.status, body && body.error && body.error.message);
      return { ok: false, status: res.status, error: body && body.error };
    }
    return { ok: true, body };
  } catch (err) {
    console.warn('[metaCapi] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendCapiEvent,
  // exposed for unit tests
  _internals: { sha256, normalizePhone, buildUserData },
};
