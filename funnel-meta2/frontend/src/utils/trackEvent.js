/**
 * Fire-and-forget button click tracker.
 * Sends a POST to /api/events. Never throws — a missed event is
 * better than a broken funnel experience.
 *
 * @param {string} eventName  - one of the VALID_EVENTS keys defined in backend/routes/events.js
 * @param {string|null} webinarAt - ISO string of the upcoming webinar (state.webinarConfig?.next_webinar_at)
 */

const META_FLAG_KEY = 'mhs_is_meta';
const VISITOR_ID_KEY = 'mhs_visitor_id';

/**
 * Returns a stable per-browser visitor id. Generated on first call and
 * persisted in localStorage so it survives reloads, tab switches, and
 * weeks-later return visits. Used by the dashboard to count UNIQUE
 * people instead of total page-load events.
 */
export function getVisitorId() {
  if (typeof window === 'undefined') return null;
  try {
    let id = localStorage.getItem(VISITOR_ID_KEY);
    if (id) return id;
    id = (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(VISITOR_ID_KEY, id);
    return id;
  } catch (_) { return null; /* localStorage blocked in incognito */ }
}

/**
 * Detects if the visitor landed via a Meta ad. Checks the URL for
 * `fbclid` (Facebook's auto-appended click id, present on every ad click)
 * or `utm_source=meta`. Caches the result in localStorage so subsequent
 * events in the same session keep the flag — even if the user navigates
 * away from the original URL.
 */
function isFromMetaAd() {
  if (typeof window === 'undefined') return false;
  try {
    if (localStorage.getItem(META_FLAG_KEY) === '1') return true;
    const params = new URLSearchParams(window.location.search);
    const fbclid = params.get('fbclid');
    const utmSrc = (params.get('utm_source') || '').toLowerCase();
    if (fbclid || utmSrc === 'meta' || utmSrc === 'facebook' || utmSrc === 'fb') {
      localStorage.setItem(META_FLAG_KEY, '1');
      return true;
    }
  } catch (_) { /* localStorage may be unavailable in incognito */ }
  return false;
}

export function trackEvent(eventName, webinarAt) {
  fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: eventName,
      webinar_at: webinarAt ?? null,
      is_meta: isFromMetaAd(),
      visitor_id: getVisitorId(),
    }),
  }).catch(() => {}); // intentionally silent — never block the user
}
