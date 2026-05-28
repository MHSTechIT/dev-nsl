/* ──────────────────────────────────────────────────────────────────────────
   timerDefaults.js — backend copy of the admin-tunable timing bounds.

   This is the CommonJS counterpart of crm/frontend/src/config/timerSchema.js.
   Frontend and backend deploy separately so the schema can't be shared as one
   file — KEEP THE BOUNDS BELOW IN SYNC with timerSchema.js.

   Used for: PUT /api/admin/timer-settings validation/clamping, seeding the
   timer_settings row, and starting the backend schedulers.
   ────────────────────────────────────────────────────────────────────────── */

// { key: [default, min, max] } — every admin-tunable timing.
const BOUNDS = {
  // idle nudges + per-card nudges (all admin-editable)
  robotNudgeIntervalMs:        [30000,  5000,  600000],
  autoPauseNudgeCount:         [5,      1,     20],
  extAlertNudgeIntervalMs:     [30000,  5000,  600000],
  extAlertNudgeCount:          [5,      1,     20],
  agentReasonNudgeIntervalMs:  [30000,  5000,  600000],
  agentReasonNudgeCount:       [5,      1,     20],
  formReasonNudgeIntervalMs:   [30000,  5000,  600000],
  formReasonNudgeCount:        [5,      1,     20],
  formTimerLongCallThresholdMs:[180000, 60000, 1800000],
  customBreakNudgeIntervalMs:  [30000,  5000,  600000],
  customBreakNudgeCount:       [4,      1,     20],
  lateReturnNudgeIntervalMs:   [30000,  5000,  600000],
  lateReturnNudgeCount:        [5,      1,     20],
  breakPickerStrikeCount:      [3,      1,     20],
  // break cards
  breakPickerCountdownMs:     [10000,   3000,  120000],
  breakBubbleHideMs:          [10000,   2000,  60000],
  breakOverrunGraceSec:       [600,     0,     3600],
  // robot responses
  greetingBubbleFadeMs:       [420,     100,   3000],
  robotBubbleHideMs:          [10000,   2000,  60000],
  robotBubbleFadeMs:          [420,     100,   3000],
  resumeRobotPulseMs:         [7000,    1000,  30000],
  postCallCelebrationMs:      [4500,    1000,  30000],
  // heartbeat & sync
  heartbeatIntervalMs:        [30000,   10000, 120000],
  recordingPollMs:            [4000,    1000,  30000],
  // lead lists & auto-advance
  assignedRefetchIntervalMs:  [60000,   10000, 600000],
  completedRefetchIntervalMs: [60000,   10000, 600000],
  cooldownCountdownMs:        [10000,   1000,  60000],
  autoAdvanceCountdownMs:     [10000,   1000,  60000],
  dnpAutoAdvanceDelayMs:      [1500,    0,     15000],
  dnpAutoPauseDelayMs:        [1800,    0,     15000],
  // toasts & highlights
  leadHighlightResetMs:       [4000,    500,   30000],
  netRecoverPulseMs:          [7000,    1000,  30000],
  reopenToastMs:              [4000,    500,   30000],
  promoHighlightShortMs:      [2500,    500,   30000],
  promoHighlightLongMs:       [3000,    500,   30000],
  incomingToastDismissMs:     [30000,   5000,  300000],
  incomingToastMaxVisible:    [3,       1,     10],
  recallToastMs:              [3500,    500,   30000],
  recallProgressToastMs:      [2500,    500,   30000],
  toastDefaultMs:             [2800,    500,   30000],
  toastDoneDelayMs:           [250,     0,     2000],
  // animations
  btnPulseMs:                 [2400,    400,   10000],
  glowBreatheInnerMs:         [4000,    400,   20000],
  glowBreatheOuterMs:         [6000,    400,   20000],
  greetingBubbleInMs:         [320,     50,    5000],
  greetingBubbleFloatMs:      [4200,    400,   20000],
  incomingSlideInMs:          [220,     50,    5000],
  incomingPulseMs:            [1600,    200,   10000],
  // caller backend watchdogs (leadsAlert + linkSwap are funnel/marketing
  // schedulers — intentionally NOT admin-tunable, so they are excluded here)
  activityReaperIntervalMs:   [60000,   10000, 600000],
  activityStaleAfterMs:       [90000,   30000, 600000],
  staleCallReaperIntervalMs:  [60000,   10000, 600000],
  staleCallStaleAfterMs:      [180000,  30000, 1800000],
  tataInboundSyncIntervalMs:  [120000,  30000, 1800000],
};

// Keys that drive caller-facing backend watchdogs (the rest are caller-
// frontend timings). leadsAlert / linkSwap are deliberately not included.
const BACKEND_KEYS = [
  'activityReaperIntervalMs', 'activityStaleAfterMs',
  'staleCallReaperIntervalMs', 'staleCallStaleAfterMs',
  'tataInboundSyncIntervalMs',
];

// Admin-editable timings — idle nudges + one card per caller surface
// (except the DNP alert). Every other timing is fixed at its default.
const EDITABLE_KEYS = [
  'robotNudgeIntervalMs', 'autoPauseNudgeCount',
  'extAlertNudgeIntervalMs', 'extAlertNudgeCount',
  'agentReasonNudgeIntervalMs', 'agentReasonNudgeCount',
  'formReasonNudgeIntervalMs', 'formReasonNudgeCount',
  'formTimerLongCallThresholdMs',
  'customBreakNudgeIntervalMs', 'customBreakNudgeCount',
  'lateReturnNudgeIntervalMs', 'lateReturnNudgeCount',
  'breakPickerCountdownMs', 'breakPickerStrikeCount',
];

// Flat { key: default }.
const TIMER_DEFAULTS = Object.fromEntries(
  Object.entries(BOUNDS).map(([k, [d]]) => [k, d]),
);

/* Clamp one value to its bounds; returns the default for non-numbers or
   unknown keys with a default. Unknown keys return undefined. */
function clampTimer(key, value) {
  const b = BOUNDS[key];
  if (!b) return undefined;
  const [def, min, max] = b;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* Merge stored values over defaults. Only the EDITABLE_KEYS are honoured —
   every other timing is forced to its fixed default, so non-editable timings
   can never drift from a stale stored row or a crafted request. */
function mergeTimerSettings(stored) {
  const out = { ...TIMER_DEFAULTS };
  if (stored && typeof stored === 'object') {
    for (const key of EDITABLE_KEYS) {
      if (stored[key] !== undefined && stored[key] !== null) {
        out[key] = clampTimer(key, stored[key]);
      }
    }
  }
  return out;
}

module.exports = { BOUNDS, BACKEND_KEYS, EDITABLE_KEYS, TIMER_DEFAULTS, clampTimer, mergeTimerSettings };
