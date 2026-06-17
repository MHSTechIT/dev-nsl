/* ──────────────────────────────────────────────────────────────────────────
   timerSchema.js — single source of truth for every admin-tunable timing.

   The admin "Timer" page renders an editable card per editable group. The
   caller app reads effective values via TimerSettingsContext (schema defaults
   overlaid with the admin-saved values). Backend validation bounds live in a
   parallel CommonJS copy at crm/backend/utils/timerDefaults.js — KEEP THE TWO
   IN SYNC (frontend and backend deploy separately).

   Each item: { key, label, unit:'ms'|'sec'|'count', default, min, max, help }

   EDITABLE_KEYS lists the timings the admin can change — every caller "card"
   (except the DNP alert) plus the idle nudges. Everything else is fixed at
   its default: still present so the caller app has a value to read, but not
   shown on the Timer page.
   ────────────────────────────────────────────────────────────────────────── */

export const TIMER_GROUPS = [
  /* ── EDITABLE — one card per caller surface ───────────────────────────── */
  {
    id: 'idle',
    label: 'Idle nudges (Call / Assigned / review pages)',
    items: [
      { key: 'robotNudgeIntervalMs', label: 'Idle nudge interval', unit: 'ms', default: 30000, min: 5000, max: 600000,
        help: 'How often the robot re-nudges a caller sitting idle on the Call, Assigned or review pages.' },
      { key: 'autoPauseNudgeCount', label: 'Idle nudges before auto-pause', unit: 'count', default: 5, min: 1, max: 20,
        help: 'Unanswered idle nudges before the account auto-pauses.' },
    ],
  },
  {
    id: 'extcard',
    label: 'SmartFlow extension alert',
    items: [
      { key: 'extAlertNudgeIntervalMs', label: 'Nudge interval', unit: 'ms', default: 30000, min: 5000, max: 600000,
        help: 'How often the robot re-asks on the "Is your SmartFlow extension on?" alert.' },
      { key: 'extAlertNudgeCount', label: 'Nudges before auto-pause', unit: 'count', default: 5, min: 1, max: 20,
        help: 'Ignored nudges on the extension alert before the account auto-pauses.' },
    ],
  },
  {
    id: 'agentcard',
    label: 'Agent reason card',
    items: [
      { key: 'agentReasonNudgeIntervalMs', label: 'Nudge interval', unit: 'ms', default: 30000, min: 5000, max: 600000,
        help: "How often the robot re-asks on the agent reason card (the caller's own SmartFlow line didn't pick up)." },
      { key: 'agentReasonNudgeCount', label: 'Nudges before auto-pause', unit: 'count', default: 5, min: 1, max: 20,
        help: 'Ignored nudges on the agent reason card before the account auto-pauses.' },
      { key: 'agentRetryCap', label: 'Retry attempts before blocking the caller', unit: 'count', default: 15, min: 1, max: 50,
        help: 'How many times the agent reason card may retrigger the SmartFlow call — the "Attempt X of Y" counter. Once this many attempts are reached, the account is auto-paused (blocked) instead of retrying again. Default 15.' },
    ],
  },
  {
    id: 'formcard',
    label: 'Form reason card',
    items: [
      { key: 'formReasonNudgeIntervalMs', label: 'Nudge interval', unit: 'ms', default: 30000, min: 5000, max: 600000,
        help: 'How often the robot re-asks the caller to fill the post-call reason form.' },
      { key: 'formReasonNudgeCount', label: 'Nudges before auto-pause', unit: 'count', default: 5, min: 1, max: 20,
        help: 'Ignored nudges on the form reason card before the account auto-pauses.' },
      { key: 'formTimerLongCallThresholdMs', label: 'Long-call threshold (no 45s form timer)', unit: 'min', default: 180000, min: 60000, max: 1800000,
        help: 'When a connected call lasts AT LEAST this long, the post-call form opens WITHOUT the 45-second countdown — the caller fills it at their own pace. Calls shorter than this are treated as customer-cut and trigger the urgent 45s window. Range: 1 minute to 30 minutes. Default 3 minutes.' },
    ],
  },
  {
    id: 'custombreakcard',
    label: 'Custom-break ("Other") card',
    items: [
      { key: 'customBreakNudgeIntervalMs', label: 'Nudge interval', unit: 'ms', default: 30000, min: 5000, max: 600000,
        help: 'How often the robot re-asks on the custom-break ("Other") card.' },
      { key: 'customBreakNudgeCount', label: 'Nudges before auto-pause', unit: 'count', default: 4, min: 1, max: 20,
        help: 'Ignored nudges on the custom-break card before the account auto-pauses.' },
    ],
  },
  {
    id: 'latecard',
    label: 'Late-return card',
    items: [
      { key: 'lateReturnNudgeIntervalMs', label: 'Nudge interval', unit: 'ms', default: 30000, min: 5000, max: 600000,
        help: 'How often the robot re-asks on the late-return reason card.' },
      { key: 'lateReturnNudgeCount', label: 'Nudges before auto-pause', unit: 'count', default: 5, min: 1, max: 20,
        help: 'Ignored nudges on the late-return card before the account auto-pauses.' },
    ],
  },
  {
    id: 'breakpickercard',
    label: 'Break-picker card',
    items: [
      { key: 'breakPickerCountdownMs', label: 'Inactivity countdown', unit: 'ms', default: 10000, min: 3000, max: 120000,
        help: 'Inactivity window on the break-picker card before a strike is counted.' },
      { key: 'breakPickerStrikeCount', label: 'Strikes before auto-pause', unit: 'count', default: 3, min: 1, max: 20,
        help: 'Inactivity strikes on the break-picker card before the account auto-pauses.' },
    ],
  },

  /* ── TL & Assistant sub-page ───────────────────────────────────────────── */
  {
    id: 'mgralerts',
    page: 'tl',
    label: 'Manager alert — empty assigned leads',
    items: [
      { key: 'mgrEmptyLeadsAlertDelayMs', label: 'Alert manager after Assigned leads stay empty for', unit: 'min', default: 600000, min: 60000, max: 3600000,
        help: "When a caller's Assigned page has zero leads for this long, the MANAGER gets an alert. (The TL & assistant manager are alerted immediately; the manager only after this delay.) Range 1–60 minutes. Default 10 minutes." },
    ],
  },

  /* ── FIXED — present for caller-app defaults, not shown on the Timer page ── */
  {
    id: 'fixedbreak',
    label: 'Break cards (fixed)',
    items: [
      { key: 'breakBubbleHideMs', label: 'Break robot speech-bubble duration', unit: 'ms', default: 10000, min: 2000, max: 60000,
        help: 'How long the robot speech bubble stays visible on break / late-return cards.' },
      { key: 'breakOverrunGraceSec', label: 'Break overrun grace', unit: 'sec', default: 600, min: 0, max: 3600,
        help: 'Seconds a caller may exceed their break before they must submit a late-return reason.' },
    ],
  },
  {
    id: 'robot',
    label: 'Robot responses (fixed)',
    items: [
      { key: 'greetingBubbleFadeMs', label: 'Greeting bubble fade', unit: 'ms', default: 420, min: 100, max: 3000,
        help: 'Fade-out duration of the Call-page greeting speech bubble.' },
      { key: 'robotBubbleHideMs', label: 'Robot bubble default duration', unit: 'ms', default: 10000, min: 2000, max: 60000,
        help: 'Default time a RobotGuide speech bubble stays visible before its text fades.' },
      { key: 'robotBubbleFadeMs', label: 'Robot bubble fade', unit: 'ms', default: 420, min: 100, max: 3000,
        help: 'Fade/translate duration of RobotGuide bubble text.' },
      { key: 'resumeRobotPulseMs', label: 'Resume robot flash duration', unit: 'ms', default: 7000, min: 1000, max: 30000,
        help: 'How long the resume robot flashes before auto-clearing.' },
      { key: 'postCallCelebrationMs', label: 'Post-call celebration duration', unit: 'ms', default: 4500, min: 1000, max: 30000,
        help: 'How long the happy post-call celebration mood shows before reverting to idle.' },
    ],
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat & sync (fixed)',
    items: [
      { key: 'heartbeatIntervalMs', label: 'Activity heartbeat interval', unit: 'ms', default: 30000, min: 10000, max: 120000,
        help: 'How often the caller browser POSTs its activity heartbeat.' },
      { key: 'recordingPollMs', label: 'Call recording poll interval', unit: 'ms', default: 4000, min: 1000, max: 30000,
        help: 'How often the call-note modal polls for a recording while a call is live.' },
    ],
  },
  {
    id: 'leadlists',
    label: 'Lead lists & auto-advance (fixed)',
    items: [
      { key: 'assignedRefetchIntervalMs', label: 'Assigned list auto-refresh', unit: 'ms', default: 60000, min: 10000, max: 600000,
        help: 'How often the Assigned Leads list auto-refetches.' },
      { key: 'completedRefetchIntervalMs', label: 'Completed list auto-refresh', unit: 'ms', default: 60000, min: 10000, max: 600000,
        help: 'How often the Completed / Not-Picked list auto-refetches.' },
      { key: 'cooldownCountdownMs', label: 'Post-call cooldown countdown', unit: 'ms', default: 10000, min: 1000, max: 60000,
        help: 'Cooldown window after Complete Call before advancing to the next lead.' },
      { key: 'autoAdvanceCountdownMs', label: 'Auto-advance countdown', unit: 'ms', default: 10000, min: 1000, max: 60000,
        help: 'Countdown before the auto-call dials the next lead.' },
      { key: 'autoCallRetryDelayMs', label: 'Auto-call retry delay', unit: 'ms', default: 2500, min: 500, max: 15000,
        help: 'When /calls/start fails inside the auto-call loop (often because Tata hasn’t released the previous leg), wait this long and retry once before skipping the lead.' },
      { key: 'hangupCorroborateMs', label: 'Hangup corroboration window', unit: 'ms', default: 5000, min: 1000, max: 15000,
        help: 'When Tata stamps a single terminal signal (ended_at OR status=ended OR hangup_by alone) while the customer is on the call, wait this long for a SECOND corroborating signal before flipping the modal to the 45-second form window. Defends against Tata’s known mid-call leg-blip CDR writes that look like a real hangup but aren’t.' },
      { key: 'smartflowConfirmTtlMs', label: 'SmartFlow extension confirmation cache', unit: 'ms', default: 28800000, min: 60000, max: 86400000,
        help: 'Once the caller clicks "Yes & Proceed" on the SmartFlow extension prompt, the modal remembers the confirmation for this long and auto-skips the prompt on subsequent leads (sessionStorage; resets on browser-tab close or admin re-tune). Default 8 hours covers one work-day session.' },
      { key: 'dnpAutoAdvanceDelayMs', label: 'DNP auto-advance delay', unit: 'ms', default: 1500, min: 0, max: 15000,
        help: 'Delay showing the confirmation before auto-advancing after a Did-Not-Pick.' },
      { key: 'dnpAutoPauseDelayMs', label: 'Idle-form auto-pause delay', unit: 'ms', default: 1800, min: 0, max: 15000,
        help: 'Delay before auto-pausing after the caller ignores the idle "complete the form" prompt.' },
    ],
  },
  {
    id: 'toasts',
    label: 'Toasts & highlights (fixed)',
    items: [
      { key: 'leadHighlightResetMs', label: 'Lead row highlight reset', unit: 'ms', default: 4000, min: 500, max: 30000,
        help: 'How long a lead row stays highlighted after being opened from a toast.' },
      { key: 'netRecoverPulseMs', label: 'Network-recovered robot duration', unit: 'ms', default: 7000, min: 1000, max: 30000,
        help: 'How long the "network is back" robot flashes after the connection recovers.' },
      { key: 'reopenToastMs', label: 'Reopen toast duration', unit: 'ms', default: 4000, min: 500, max: 30000,
        help: 'How long the "leads moved to top" toast stays visible.' },
      { key: 'promoHighlightShortMs', label: 'Promoted-lead highlight (short)', unit: 'ms', default: 2500, min: 500, max: 30000,
        help: 'Highlight duration for a lead pushed in via organic SSE.' },
      { key: 'promoHighlightLongMs', label: 'Promoted-lead highlight (long)', unit: 'ms', default: 3000, min: 500, max: 30000,
        help: 'Highlight duration for a next-batch / missed-call promoted lead.' },
      { key: 'incomingToastDismissMs', label: 'Incoming-call toast auto-dismiss', unit: 'ms', default: 30000, min: 5000, max: 300000,
        help: 'How long an incoming-call toast stays before auto-dismissing.' },
      { key: 'incomingToastMaxVisible', label: 'Incoming-call toasts stacked', unit: 'count', default: 3, min: 1, max: 10,
        help: 'Maximum incoming-call toasts shown at once.' },
      { key: 'recallToastMs', label: 'Call-error toast duration', unit: 'ms', default: 3500, min: 500, max: 30000,
        help: 'How long call-failed / DNP-failed / recall-failed toasts stay visible.' },
      { key: 'recallProgressToastMs', label: 'Calling-progress toast duration', unit: 'ms', default: 2500, min: 500, max: 30000,
        help: 'How long the transient "Calling…" toast stays visible.' },
      { key: 'toastDefaultMs', label: 'Generic toast duration', unit: 'ms', default: 2800, min: 500, max: 30000,
        help: 'Default auto-hide duration for the generic Toast component.' },
      { key: 'toastDoneDelayMs', label: 'Toast dismiss callback delay', unit: 'ms', default: 250, min: 0, max: 2000,
        help: 'Delay after a toast fades before its onDone callback fires.' },
    ],
  },
  {
    id: 'animations',
    label: 'Animations (fixed)',
    items: [
      { key: 'btnPulseMs', label: 'Start-Call button pulse', unit: 'ms', default: 2400, min: 400, max: 10000,
        help: 'Pulse animation cycle of the Start Call button.' },
      { key: 'glowBreatheInnerMs', label: 'Robot inner glow cycle', unit: 'ms', default: 4000, min: 400, max: 20000,
        help: 'Breathing cycle of the robot inner glow.' },
      { key: 'glowBreatheOuterMs', label: 'Robot outer glow cycle', unit: 'ms', default: 6000, min: 400, max: 20000,
        help: 'Breathing cycle of the robot outer glow.' },
      { key: 'greetingBubbleInMs', label: 'Greeting bubble entry', unit: 'ms', default: 320, min: 50, max: 5000,
        help: 'Entry/fade-in duration of the greeting speech bubble.' },
      { key: 'greetingBubbleFloatMs', label: 'Greeting bubble float cycle', unit: 'ms', default: 4200, min: 400, max: 20000,
        help: 'Floating-bob animation cycle of the greeting bubble.' },
      { key: 'incomingSlideInMs', label: 'Incoming-toast slide-in', unit: 'ms', default: 220, min: 50, max: 5000,
        help: 'Slide-in/scale entrance of an incoming-call toast.' },
      { key: 'incomingPulseMs', label: 'Incoming-toast pulse cycle', unit: 'ms', default: 1600, min: 200, max: 10000,
        help: 'Pulsing green-ring animation cycle of an incoming-call toast.' },
    ],
  },
  {
    id: 'backend',
    label: 'Caller backend watchdogs (fixed)',
    items: [
      { key: 'activityReaperIntervalMs', label: 'Activity-span reaper interval', unit: 'ms', default: 60000, min: 10000, max: 600000,
        help: 'How often the watchdog scans for stale (offline) caller activity spans.' },
      { key: 'activityStaleAfterMs', label: 'Caller offline threshold', unit: 'ms', default: 90000, min: 30000, max: 600000,
        help: 'No-heartbeat duration after which a caller is treated as offline.' },
      { key: 'staleCallReaperIntervalMs', label: 'Stale-call reaper interval', unit: 'ms', default: 60000, min: 10000, max: 600000,
        help: "How often a caller's stuck call rows are scanned and recovered." },
      { key: 'staleCallStaleAfterMs', label: 'Stale-call threshold', unit: 'ms', default: 180000, min: 30000, max: 1800000,
        help: 'How long a call may stay in a non-terminal state before being marked failed.' },
      { key: 'tataInboundSyncIntervalMs', label: 'Inbound missed-call sync interval', unit: 'ms', default: 120000, min: 30000, max: 1800000,
        help: "How often inbound missed calls are polled for the caller's Missed Calls page." },
    ],
  },
];

/* Flat { key: default } map. */
export const TIMER_DEFAULTS = Object.fromEntries(
  TIMER_GROUPS.flatMap(g => g.items.map(i => [i.key, i.default])),
);

/* Flat { key: item } lookup. */
export const TIMER_ITEMS = Object.fromEntries(
  TIMER_GROUPS.flatMap(g => g.items.map(i => [i.key, i])),
);

/* The admin-editable timings — one card per caller surface (except the DNP
   alert, which has no nudge) plus the idle nudges. Every other timing is
   fixed permanently at its default: present in the schema so the caller app
   has a value to read, but not shown on the Timer page and not changeable. */
export const EDITABLE_KEYS = [
  'robotNudgeIntervalMs', 'autoPauseNudgeCount',
  'extAlertNudgeIntervalMs', 'extAlertNudgeCount',
  'agentReasonNudgeIntervalMs', 'agentReasonNudgeCount', 'agentRetryCap',
  'formReasonNudgeIntervalMs', 'formReasonNudgeCount',
  'formTimerLongCallThresholdMs',
  'customBreakNudgeIntervalMs', 'customBreakNudgeCount',
  'lateReturnNudgeIntervalMs', 'lateReturnNudgeCount',
  'breakPickerCountdownMs', 'breakPickerStrikeCount',
  'mgrEmptyLeadsAlertDelayMs',
];

/* Clamp a single value to its schema bounds; falls back to the default
   when the value is not a finite number. */
export function clampTimer(key, value) {
  const item = TIMER_ITEMS[key];
  if (!item) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return item.default;
  return Math.min(item.max, Math.max(item.min, Math.round(n)));
}

/* Merge admin-saved values over the schema defaults. Only the EDITABLE_KEYS
   are honoured from `stored` — every other timing is forced to its fixed
   default, so non-editable timings can never drift even if the stored row
   (or a crafted request) carries a value for them. */
export function mergeTimerSettings(stored) {
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
