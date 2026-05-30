/* ────────────────────────────────────────────────────────────────────────
   Meta Pixel — optimized client-side wrapper.
   ----------------------------------------------------------------------
   ALL Meta events fired from this app go through `mpTrack()` /
   `mpTrackCustom()`. Never call `window.fbq` directly from a screen.

   Why everything goes through here:
     1. Every fire gets a freshly minted `event_id` (UUIDv4). The same
        id is forwarded to the backend so a server-side Conversions API
        event with the same id can dedupe browser ↔ server pings on
        Meta's side. This is the dedup-key Meta documents at
        https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events/.
     2. fbp + fbc cookies are read once and attached to every event so
        Meta can attribute the event to the same browser regardless of
        which screen fires it.
     3. UTM context (utm_source / utm_campaign / utm_content / fbclid /
        gclid) is captured once on first mount and forwarded as
        `custom_data` on every event.
     4. Events are dual-sent: client-side via fbq AND server-side via
        POST /api/meta/event so the backend can call Conversions API
        with the same event_id (browser may be blocked by ad-blockers,
        the server-side fire never is).
     5. Every event carries a `qualified` boolean + lead-quality custom
        fields. Meta's Smart Bidding then learns to bid up for the
        prospects whose downstream actions actually convert.

   Standard Meta events emitted by this app:
     PageView              — on every screen mount (route changes)
     ViewContent           — landing screen (Screen1A) visible
     Search                — language disqualification path
     AddToCart             — first form field completed (Screen3)
     InitiateCheckout      — user starts the qualification questions
                             (Screen3 mount with all gating fields)
     AddPaymentInfo        — both qualification answers committed
                             (sugar_level + diabetes_duration set)
     Lead                  — POST /api/leads success
     CompleteRegistration  — WhatsApp page mount (post-redirect)
     Contact               — WhatsApp "Join Now" click
     SubmitApplication     — Screen4 submit clicked (validated)
     Schedule              — webinar slot displayed to user

   Custom events emitted (Meta accepts arbitrary names, treats them as
   custom audiences signals):
     ScreenView_<screen>      — every screen change
     FieldSelect_<field>      — every dropdown / radio / button pick
                                with the picked VALUE in custom_data
     FieldFocus_<field>       — input focused
     FieldBlur_<field>        — input blurred (value if non-empty)
     ScrollDepth              — 25/50/75/100% scroll milestones
     TimeOnPage               — 15/30/60/120/300s milestones
     EngagementHigh           — composite high-intent signal
                                (3+ field selects within 60s)
     LandingHero              — hero CTA tapped
     ButtonClick_<name>       — labelled button clicks
     ExitIntent               — pointer leaves viewport top
   ──────────────────────────────────────────────────────────────────── */

const PIXEL_ID = '1866739047322363';
const SERVER_EVENT_ENDPOINT = '/api/meta/event';

/* ────────── Internal helpers ────────── */

function isBrowser() { return typeof window !== 'undefined'; }

function safeUuid() {
  if (isBrowser() && window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'e_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readCookie(name) {
  if (!isBrowser()) return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

/* fbp — Facebook browser ID. Set by the pixel itself; cookie name `_fbp`. */
function getFbp() { return readCookie('_fbp'); }
/* fbc — Facebook click ID, derived from `fbclid` URL param when the click
   lands. Already minted by the pixel script if `fbclid` was present. */
function getFbc() {
  const c = readCookie('_fbc');
  if (c) return c;
  // Fallback: build fbc from a fresh fbclid in the URL.
  if (!isBrowser()) return null;
  try {
    const fbclid = new URLSearchParams(window.location.search).get('fbclid');
    if (fbclid) return `fb.1.${Date.now()}.${fbclid}`;
  } catch { /* ignore */ }
  return null;
}

/* Read UTM-ish params once on first call, cache in sessionStorage so
   later page-loads in the same session still see them even after the
   user navigates internally and the query string is gone. */
const UTM_KEY = 'mhs_meta_utm';
function readUtmContext() {
  if (!isBrowser()) return {};
  try {
    const cached = sessionStorage.getItem(UTM_KEY);
    if (cached) return JSON.parse(cached);
    const params = new URLSearchParams(window.location.search);
    const utm = {
      utm_source:   params.get('utm_source')   || null,
      utm_medium:   params.get('utm_medium')   || null,
      utm_campaign: params.get('utm_campaign') || null,
      utm_content:  params.get('utm_content')  || null,
      utm_term:     params.get('utm_term')     || null,
      fbclid:       params.get('fbclid')       || null,
      gclid:        params.get('gclid')        || null,
      referrer:     document.referrer || null,
      landing_path: window.location.pathname || null,
    };
    sessionStorage.setItem(UTM_KEY, JSON.stringify(utm));
    return utm;
  } catch { return {}; }
}

/* Visitor id — stable across reloads. Used by Meta as `external_id` so
   CAPI events can stitch together. */
const VISITOR_KEY = 'mhs_meta_visitor_id';
function getVisitorId() {
  if (!isBrowser()) return null;
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = safeUuid();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch { return null; }
}

/* ────────── Server-side mirror ──────────
   Mirror every event to /api/meta/event so the backend can fire a
   matching Conversions API event with the same `event_id`. The fetch
   is fire-and-forget — analytics must NEVER block the funnel. */
function mirrorToServer(eventName, data, eventId, opts) {
  if (!isBrowser()) return;
  const payload = {
    event_name:        eventName,
    event_id:          eventId,
    event_time:        Math.floor(Date.now() / 1000),
    event_source_url:  window.location.href,
    fbp:               getFbp(),
    fbc:               getFbc(),
    visitor_id:        getVisitorId(),
    user_agent:        navigator.userAgent,
    utm:               readUtmContext(),
    custom_data:       data || {},
    user_data:         (opts && opts.user_data) || {}, // hashed by backend
    action_source:     'website',
  };
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(SERVER_EVENT_ENDPOINT, blob);
      return;
    }
  } catch { /* fall through to fetch */ }
  fetch(SERVER_EVENT_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    keepalive: true,
  }).catch(() => { /* never throw from analytics */ });
}

/* ────────── Public API ────────── */

/* Returns true once the fbq script has loaded. We don't gate calls on
   it — fbq enqueues calls made before load and replays them after. */
export function isPixelReady() {
  return isBrowser() && typeof window.fbq === 'function';
}

/* Track a STANDARD Meta event (PageView, Lead, CompleteRegistration,
   etc.). Returns the minted event_id so the caller can pass it to the
   server-side mirror if they have richer user_data to forward (e.g.
   email/phone) at the moment of `Lead`. */
export function mpTrack(eventName, data, opts) {
  const eventId = (opts && opts.event_id) || safeUuid();
  const customData = {
    ...readUtmContext(),
    ...(data || {}),
    visitor_id: getVisitorId(),
  };
  if (isPixelReady()) {
    try { window.fbq('track', eventName, customData, { eventID: eventId }); }
    catch { /* swallow */ }
  }
  mirrorToServer(eventName, customData, eventId, opts);
  return eventId;
}

/* Track a CUSTOM Meta event (any string name). Same dedup + mirror
   semantics as mpTrack. Use for the per-field, per-screen signals. */
export function mpTrackCustom(eventName, data, opts) {
  const eventId = (opts && opts.event_id) || safeUuid();
  const customData = {
    ...readUtmContext(),
    ...(data || {}),
    visitor_id: getVisitorId(),
  };
  if (isPixelReady()) {
    try { window.fbq('trackCustom', eventName, customData, { eventID: eventId }); }
    catch { /* swallow */ }
  }
  mirrorToServer(eventName, customData, eventId, opts);
  return eventId;
}

/* ────────── Convenience helpers ────────── */

export function trackPageView(extra) {
  return mpTrack('PageView', extra);
}

export function trackScreenView(screenName, extra) {
  return mpTrackCustom(`ScreenView_${screenName}`, {
    screen:        screenName,
    content_name:  screenName,
    content_category: 'funnel_screen',
    ...(extra || {}),
  });
}

/* Field selection — used by every radio / dropdown / language picker.
   Sends the FIELD NAME + the SELECTED VALUE so Meta sees the user's
   stated intent at granular detail. Smart Bidding learns that
   `sugar_level=250+ AND diabetes_duration=long` is your highest-LTV
   audience because those signals are present on every converter. */
export function trackFieldSelect(field, value, extra) {
  // Side-channel signal so metaTracking.js's EngagementHigh composite
  // can count this without a hard import dependency.
  if (isBrowser()) {
    try { window.dispatchEvent(new Event('mhs:meta:field-select')); }
    catch { /* ignore */ }
  }
  return mpTrackCustom(`FieldSelect_${field}`, {
    field,
    value: String(value ?? ''),
    ...(extra || {}),
  });
}

export function trackFieldFocus(field) {
  return mpTrackCustom(`FieldFocus_${field}`, { field });
}

export function trackFieldBlur(field, value) {
  return mpTrackCustom(`FieldBlur_${field}`, {
    field,
    value_present: !!(value && String(value).trim()),
  });
}

export function trackButtonClick(name, extra) {
  return mpTrackCustom(`ButtonClick_${name}`, { button: name, ...(extra || {}) });
}

/* Lead — fired on /api/leads success. Pass the lead row + score so
   Meta gets the qualification context inline with the conversion. */
export function trackLead({ leadId, score, sugar, duration, lang, email, phone }) {
  const eventId = safeUuid();
  const data = {
    content_name:     'Diabetes Reversal Webinar',
    content_category: 'webinar_registration',
    content_ids:      leadId ? [leadId] : undefined,
    value:            score || 0,
    currency:         'INR',
    predicted_ltv:    (score || 0) * 1000, // rough Pixel-ranking hint
    qualified:        true,
    sugar_level:      sugar,
    diabetes_duration: duration,
    language:         lang,
    lead_id:          leadId,
  };
  // user_data is hashed server-side — never expose plaintext to fbq.
  return mpTrack('Lead', data, {
    event_id:  eventId,
    user_data: { email, phone },
  });
}

export function trackCompleteRegistration(extra) {
  return mpTrack('CompleteRegistration', {
    content_name:     'Diabetes Reversal Webinar',
    content_category: 'webinar_registration',
    status:           true,
    ...(extra || {}),
  });
}

export function trackContact(extra) {
  return mpTrack('Contact', { channel: 'whatsapp', ...(extra || {}) });
}

export function trackInitiateCheckout(extra) {
  return mpTrack('InitiateCheckout', {
    content_name:     'Diabetes Reversal Webinar',
    content_category: 'webinar_registration',
    ...(extra || {}),
  });
}

export function trackAddPaymentInfo(extra) {
  return mpTrack('AddPaymentInfo', extra);
}

export function trackAddToCart(extra) {
  return mpTrack('AddToCart', extra);
}

export function trackSubmitApplication(extra) {
  return mpTrack('SubmitApplication', extra);
}

export function trackViewContent(contentName, extra) {
  return mpTrack('ViewContent', {
    content_name:     contentName,
    content_category: 'funnel_screen',
    ...(extra || {}),
  });
}

export function trackSearch(query, extra) {
  return mpTrack('Search', { search_string: query, ...(extra || {}) });
}

/* Schedule — Meta standard event for "user booked a future session".
   Fits webinar slot confirmation perfectly. */
export function trackSchedule(extra) {
  return mpTrack('Schedule', {
    content_name:     'Diabetes Reversal Webinar',
    content_category: 'webinar_slot',
    ...(extra || {}),
  });
}

/* Expose the visitor id so callers can stamp it onto API payloads
   (e.g. POST /api/leads → leads.visitor_id column). */
export { getVisitorId, getFbp, getFbc, readUtmContext };
