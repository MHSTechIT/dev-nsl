/**
 * Meta Pixel helpers — funnel app only.
 *
 * Every funnel decision the user makes (sugar level, diabetes
 * duration, medication, age group, occupation) is sent to Meta with a
 * monetary `value` derived from a lead-quality score so the
 * ad-optimization model learns which qualification profiles produce
 * buyers, not just leads.
 *
 * Base pixel + PageView fire from index.html before React mounts.
 * This module only emits the qualification + conversion events.
 *
 * Pixel ID: 1866739047322363
 */

const PIXEL_ID = '1866739047322363';
// `value` + `currency` are intentionally NOT sent on any pixel event.
// Meta's bid signal is driven only by the rolling_value custom metric
// and the qualification fields (sugar_level, diabetes_duration, etc.).

/* fbq is loaded by index.html; gracefully no-op when offline / blocked. */
const fbq = (...args) => {
  if (typeof window === 'undefined' || !window.fbq) return;
  try { window.fbq(...args); } catch (_) {}
};

/* Crypto-random per-event ID. Exported so callers (Screen4, WhatsAppPage)
   can mint an ID, fire the browser pixel with it, AND send the same ID
   to the backend so Conversions API server-side events dedupe. */
export function newEventID() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/** Read the _fbp / _fbc cookies that the Pixel script sets so we can
 *  forward them to the backend for CAPI user_data matching. */
export function getFbpFbc() {
  if (typeof document === 'undefined') return { fbp: null, fbc: null };
  const out = { fbp: null, fbc: null };
  for (const part of (document.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    const v = rest.join('=');
    if (k === '_fbp') out.fbp = v;
    else if (k === '_fbc') out.fbc = v;
  }
  return out;
}

/* ── Lead-quality scoring used as Meta `value` so the optimization
   model learns which qualification profiles convert to buyers. The
   scale is arbitrary but consistent: higher = more valuable. */
const SCORE_MAP = {
  sugar:   { '150-250': 80, '250+': 120 },
  duration: { new: 60, mid: 100, long: 150 },
  medication: { none: 60, tablets: 110, insulin: 160 },
  // The age-range question has been replaced by "Do you know Tamil?".
  // Only the yes/no answer feeds the rolling_value now — Tamil-yes is
  // weighted higher because the webinar is delivered in Tamil. No legacy
  // age-bucket values ('35-45' / '45-55' / '55+') are scored anymore.
  tamil:   { yes: 120, no: 50 },
  occupation: { working: 130, retired: 110, housewife: 90 },
};
function scoreFor(category, key) {
  return (SCORE_MAP[category] && SCORE_MAP[category][key]) || 50;
}

/* Computes the rolling buyer-intent value from everything we know so
   far. Meta sees this as the bid value — climbs as the funnel deepens. */
function rollingValue(state = {}) {
  let v = 0;
  if (state.sugarLevel)      v += scoreFor('sugar', state.sugarLevel);
  if (state.diabetesDuration) v += scoreFor('duration', state.diabetesDuration);
  if (state.onMedication)    v += scoreFor('medication', state.onMedication);
  // `state.ageGroup` is kept as the variable name for back-compat with
  // FunnelContext / API payload (`age_group` DB column), but its value
  // is now the Tamil-knowledge answer ('yes' / 'no') for Meta-funnel
  // leads. Look up in the `tamil` bucket of SCORE_MAP accordingly.
  if (state.ageGroup)        v += scoreFor('tamil', state.ageGroup);
  if (state.occupation)      v += scoreFor('occupation', state.occupation);
  return v;
}

/* ─────────────────────────────────────────────────────────────────
   Top-of-funnel signals
   ───────────────────────────────────────────────────────────────── */

/** Fires once when the landing hero is visible. Tells Meta the user
 *  consumed the offer page (vs. immediate bounce). */
export const pixelViewContent = (utm = {}) => fbq('track', 'ViewContent', {
  content_name: 'diabetes_reversal_landing',
  content_category: 'webinar_offer',
  content_type: 'product',
  ...utm,
}, { eventID: newEventID() });

/** "Check Your Eligibility" CTA tap — funnel commitment. */
export const pixelStartQualification = (utm = {}) => fbq('track', 'InitiateCheckout', {
  content_name: 'webinar_eligibility_quiz',
  content_category: 'qualification_start',
  ...utm,
}, { eventID: newEventID() });

/* ─────────────────────────────────────────────────────────────────
   Step-level qualification — one event per answer with the
   per-answer value rolled into Meta's bid signal.
   ───────────────────────────────────────────────────────────────── */

export const pixelSugarSelected = (level, state) => fbq('trackCustom', 'SugarLevelSelected', {
  sugar_level: level,
  content_category: 'qualification_q1',
  rolling_value: rollingValue({ ...(state || {}), sugarLevel: level }),
}, { eventID: newEventID() });

export const pixelDisqualified = (reason, state) => fbq('trackCustom', 'Disqualified_Lead', {
  reason,
  content_category: 'qualification_failed',
  rolling_value: rollingValue(state || {}),
}, { eventID: newEventID() });

export const pixelDurationSelected = (duration, state) => fbq('trackCustom', 'DiabetesDurationSelected', {
  diabetes_duration: duration,
  content_category: 'qualification_q2a',
  rolling_value: rollingValue({ ...(state || {}), diabetesDuration: duration }),
}, { eventID: newEventID() });

export const pixelMedicationSelected = (medication, state) => fbq('trackCustom', 'MedicationSelected', {
  on_medication: medication,
  content_category: 'qualification_q2b',
  rolling_value: rollingValue({ ...(state || {}), onMedication: medication }),
}, { eventID: newEventID() });

// Renamed from `pixelAgeSelected` — the funnel now asks "Do you know
// Tamil?" instead of an age bucket. The function signature is kept (same
// arg name `ageGroup` so existing call sites still compile) but the value
// is 'yes' / 'no' and the Meta event + custom-data key now reflect that.
// Old `pixelAgeSelected` export is kept as an alias below in case any
// imported usage still references it (no breaking change in dev).
export const pixelTamilKnowledgeSelected = (ageGroup, state) => fbq('trackCustom', 'TamilKnowledgeSelected', {
  knows_tamil: ageGroup,
  content_category: 'qualification_q3a',
  rolling_value: rollingValue({ ...(state || {}), ageGroup }),
}, { eventID: newEventID() });
// Back-compat alias — any leftover `pixelAgeSelected(…)` import still works.
export const pixelAgeSelected = pixelTamilKnowledgeSelected;

export const pixelOccupationSelected = (occupation, state) => fbq('trackCustom', 'OccupationSelected', {
  occupation,
  content_category: 'qualification_q3b',
  rolling_value: rollingValue({ ...(state || {}), occupation }),
}, { eventID: newEventID() });

/* ─────────────────────────────────────────────────────────────────
   Bottom-of-funnel — conversion events.
   ───────────────────────────────────────────────────────────────── */

/** Fires when the registration form (name/email/phone) opens. */
export const pixelFormOpened = (state) => fbq('trackCustom', 'RegistrationFormOpened', {
  content_name: 'registration_form',
  content_category: 'form_view',
  rolling_value: rollingValue(state || {}),
}, { eventID: newEventID() });

/** Fires the first time the user types into any form field. */
export const pixelFormStarted = (state) => fbq('trackCustom', 'RegistrationFormStarted', {
  content_category: 'form_engagement',
  rolling_value: rollingValue(state || {}),
}, { eventID: newEventID() });

/** Lead — Meta's primary conversion event. Re-inits the pixel with
 *  Advanced Matching (email/phone/name) and fires with the full
 *  qualification value rolled in so Meta optimizes for **this profile**
 *  not just "anyone who submitted a form". */
export function pixelLead({ fullName, email, whatsappNumber, leadScore }, state = {}, ids = {}) {
  if (typeof window === 'undefined' || !window.fbq) return { leadEventID: null, crEventID: null };

  // Re-init with Advanced Matching parameters. SDK hashes client-side
  // before sending so PII never leaves the user's browser in plaintext.
  const [firstName, ...rest] = (fullName || '').trim().split(/\s+/);
  const lastName = rest.join(' ');
  try {
    window.fbq('init', PIXEL_ID, {
      em: (email || '').trim().toLowerCase(),
      ph: whatsappNumber ? `91${whatsappNumber}` : undefined,
      fn: firstName ? firstName.toLowerCase() : undefined,
      ln: lastName ? lastName.toLowerCase() : undefined,
      country: 'in',
    });
  } catch (_) {}

  const leadEventID = ids.leadEventID || newEventID();
  const crEventID   = ids.crEventID   || newEventID();

  fbq('track', 'Lead', {
    content_name: 'webinar_registration',
    content_category: 'lead',
    lead_score: leadScore || null,
    rolling_value: rollingValue(state),
    sugar_level: state.sugarLevel || null,
    diabetes_duration: state.diabetesDuration || null,
    on_medication: state.onMedication || null,
    // Meta now sees the Tamil-knowledge answer (yes/no) instead of an
    // age range. Key renamed `age_group` → `knows_tamil` so Events
    // Manager column names are accurate for the new question.
    knows_tamil: state.ageGroup || null,
    occupation: state.occupation || null,
  }, { eventID: leadEventID });

  // CompleteRegistration alongside Lead so campaigns optimizing for
  // either standard event get the signal.
  fbq('track', 'CompleteRegistration', {
    content_name: 'webinar_registration',
    status: true,
    lead_score: leadScore || null,
    rolling_value: rollingValue(state),
  }, { eventID: crEventID });

  return { leadEventID, crEventID };
}

/** Fires when the user actually taps "Join WhatsApp Group" on the
 *  confirmation screen — strongest commitment signal we have. */
export function pixelScheduleConfirmed(leadScore, state = {}, explicitEventID) {
  const eventID = explicitEventID || newEventID();
  fbq('track', 'Schedule', {
    content_name: 'webinar_attendance_committed',
    content_category: 'schedule',
    lead_score: leadScore || null,
    rolling_value: rollingValue(state),
  }, { eventID });
  return eventID;
}
