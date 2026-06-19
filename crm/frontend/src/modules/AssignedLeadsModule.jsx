import { useState, useEffect, useCallback, useRef } from 'react';
import Lottie from 'lottie-react';
import LeadCallNoteModal from './LeadCallNoteModal';
import CallerLeadsTable from '../components/CallerLeadsTable';
// One robot everywhere — the same robot-idle.json the Call page uses.
// (Kept the `happyBot*` names to avoid churn; it's the idle robot now.)
import happyBotRaw     from '../assets/bot/robot-idle.json';
import confettiData    from '../assets/bot/confetti.json';
import { lockArmsDown, normalizeLoop } from '../utils/patchRobotArm';
import { setActivityStatus, setActivitySub } from '../utils/callerActivity';
import { playRobotClip, stopRobotClip, ROBOT_CLIP } from '../utils/robotAudio';
import SourceBadge from '../components/SourceBadge';
import useRobotNudge from '../hooks/useRobotNudge';
import RobotGuide, { stopAllRobotGuideAudio } from '../components/RobotGuide';
import { useTimerSettings } from '../context/TimerSettingsContext';
// Tag-specific celebration audio. Played alongside the speech-bubble line.
import hotLeadMp3   from '../assets/audio/hot-lead.mp3';
import warmLeadMp3  from '../assets/audio/warm-lead.mp3';
import coldLeadMp3  from '../assets/audio/cold-lead.mp3';
import junkLeadMp3  from '../assets/audio/junk-lead.mp3';
import noTagMp3     from '../assets/audio/no-tag.mp3';
// HOT lead has 2 paired voice clips (h1, h2) — each one matches the
// matching bubble line in COOLDOWN_LINES.HOT below, so the caller hears
// the same sentence they read.
import hotH1Mp3     from '../assets/audio/hot/h1.mp3';
import hotH2Mp3     from '../assets/audio/hot/h2.mp3';

/* Fixed internal display-refresh cadence for the cooldown / auto-advance /
   break-picker countdowns. This is a technical render rate, not an
   admin-tunable setting — kept permanently as a code constant. */
const COUNTDOWN_TICK_MS = 250;

const TAG_AUDIO = {
  HOT:  hotLeadMp3,   // fallback only — HOT now uses per-line clips
  WARM: warmLeadMp3,
  COLD: coldLeadMp3,
  JUNK: junkLeadMp3,
};
// Patch once at module load — apply the canonical "both arms hanging
// at sides, anatomically mirrored" pose used everywhere in the CRM.
const happyBotData = normalizeLoop(lockArmsDown(happyBotRaw));

/* Post-call celebration speech-bubble lines. Each tag has multiple
   variations; the cooldown overlay picks one at random per call so the
   bubble feels fresh instead of repeating the same line every time.

   HOT entries are `{ text, audio }` pairs so the voice clip played
   matches the line shown in the bubble. The other tags remain plain
   strings (one shared audio clip per tag via TAG_AUDIO). */
const COOLDOWN_LINES = {
  HOT: [
    { text: 'hot lead secured nanba! un vibe customer ku direct ah connect aagiduchu va next call ah yum mass ah close pannalam', clip: 11 },
    { text: 'semma handling nanba! hot lead ready ah hook aagiduchu va next conversational innum mass katalam', clip: 12 },
  ],
  WARM: [
    { text: 'warm lead nanba va next lead ku polam', clip: 13 },
    { text: 'super nanba ithu warm lead va next call pannlam', clip: 14 },
  ],
  COLD: [
    { text: 'cold lead nu kavaapadatha nanba next lead la pathukalam', clip: 15 },
    { text: 'cold lead nu strees aagatha nanba next call big win pannalam', clip: 16 },
  ],
  JUNK: [
    { text: 'ithu junk lead mathiri theriyuthu nanba va next lead ku polam', clip: 17 },
    { text: 'ithu junk lead tha nanba but next hot lead waitingla irukku va call panlam', clip: 18 },
  ],
  // Fallback for outcomes without a tag (not_picked, auto_paused, etc.)
  DEFAULT: [
    { text: 'super ah call ah finish pannita nanba va next call pannlam', clip: 19 },
    { text: 'semma nanba va next call pannlam', clip: 20 },
  ],
};

const SUGAR_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}

function fmtPhone(p) {
  if (!p) return '—';
  const digits = String(p).replace(/\D/g, '');
  return digits.startsWith('91') ? '+' + digits : '+91 ' + digits;
}

export default function AssignedLeadsModule({ jwt, isActive, externalHighlightId, setMood, pendingAutoStart, clearPendingAutoStart, onCount, onRobotMessage, onBreakInfo, onCallActive, previewMode = false, callPageMode = false }) {
  const t = useTimerSettings();
  const [leads, setLeads]         = useState([]);
  // Mirror of `leads` for callbacks that need the FRESHEST value (e.g.
  // advanceAutoCall checking "did new leads arrive while the queue was
  // draining?" so we can refill the auto-queue instead of falsely showing
  // "Queue complete" while the table still has rows behind the modal).
  const leadsRef = useRef([]);
  useEffect(() => { leadsRef.current = leads; }, [leads]);
  // Bubble the lead count up to CallerShell so it can render the "N
  // leads" chip under the page header. Fires on every length change.
  useEffect(() => { if (typeof onCount === 'function') onCount(leads.length); }, [leads.length, onCount]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [highlightId, setHighlight] = useState(null);
  const [editLead, setEditLead]   = useState(null);   // which lead's note modal is open

  const sseRef = useRef(null);
  const rowRefs = useRef({});

  /* Always-on auto-advance: when the modal saves a note (Complete / DNP /
     auto-DNP), wait 5 s and dial the next lead in the current list. Toast
     if no leads remain. Independent of the legacy autoMode toggle. */
  const [advanceLeft, setAdvanceLeft] = useState(0);   // 5 → 0
  const [advanceToast, setAdvanceToast] = useState('');
  const advanceTimerRef = useRef(null);
  // The lead queued to dial when the between-calls countdown reaches 0. Held in
  // a ref so the interval choice-card ("Continue now") can dial it immediately.
  const pendingNextLeadRef = useRef(null);
  function clearAdvanceTimer() {
    if (advanceTimerRef.current) { clearInterval(advanceTimerRef.current); advanceTimerRef.current = null; }
  }

  /* ── Auto-dial state machine ────────────────────────────────────────────
     Modes:
       'off'      — manual mode, default
       'calling'  — current lead being called + note modal open
       'cooldown' — 5-second card showing between leads
     The queue is a list of LEAD OBJECTS captured when auto-mode starts;
     each entry is processed in order. Processing one lead = trigger
     click-to-call API → open note modal → wait for "Complete Call" →
     5s cooldown → next.                                                    */
  const [autoMode, setAutoMode]         = useState('off');
  // Ref mirror of autoMode so async fetch callbacks (triggerCallAndOpen
  // retries, etc.) read the FRESH value when they resume — not the
  // stale closure capture from render time.
  const autoModeRef                     = useRef('off');
  useEffect(() => { autoModeRef.current = autoMode; }, [autoMode]);
  const [autoQueue, setAutoQueue]       = useState([]);
  // Ref mirror of autoQueue so advanceAutoCall can read the freshest
  // snapshot without doing work inside a setAutoQueue updater (which
  // React StrictMode invokes twice in dev → double Tata calls).
  const autoQueueRef                    = useRef([]);
  useEffect(() => { autoQueueRef.current = autoQueue; }, [autoQueue]);
  const [autoIndex, setAutoIndex]       = useState(0);
  const [autoTotal, setAutoTotal]       = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [autoError, setAutoError]       = useState('');
  /* Bumped on every fresh "Start Auto Call". Folded into the call-note
     modal's key so a deliberate fresh start ALWAYS remounts the modal at
     ext_check (the SmartFlow extension card) — even when the same lead was
     just reopened by a stale refresh-restore snapshot at agent_ringing_1.
     Without this, React reuses the old modal instance (same lead id) and the
     fresh ext_check phase never appears. */
  const [autoSession, setAutoSession]   = useState(0);
  const cooldownTimerRef = useRef(null);

  /* ── Modal-state persistence across browser refreshes ────────────────
     A single sessionStorage key holds the snapshot needed to rebuild
     the exact card the caller saw before refresh:
       { lead_id, phase, cutCount, customerAttempt, agentAttempts,
         dnpRetry, formTimerDeadline, autoMode, savedAt }
     The MODAL reports its own state (phase / counters / timer deadline)
     up via the onStateChange prop; this module merges in lead_id +
     autoMode and writes the whole thing.

     Must be declared AFTER `autoMode` is in scope — otherwise the
     useEffect's dep array hits a temporal-dead-zone ReferenceError
     during the first render. */
  const MODAL_STATE_KEY        = 'mhs_caller_modal_state';
  const MODAL_RESTORE_MAX_AGE  = 30 * 60 * 1000; // 30 min freshness cap
  // Whitelist of phases that are SAFE to resume after a refresh.
  // Includes only phases where the caller is genuinely "waiting" for
  // something — confirming the extension, on a live call, filling the
  // form, choosing a DNP reason, or seeing the paused screen.
  //
  // Ringing-class phases (agent_ringing_*, customer_ringing,
  // recall_ringing) are DELIBERATELY excluded — by the time the page
  // reloads, Tata's call has timed out and the banner would lie about
  // an in-flight call. agent_reason_card is excluded because its state
  // depends on counters that already reset on refresh. dnp_alert is a
  // 1.5 s transient that auto-advances.
  //
  // When the saved phase isn't in this set, the snapshot is wiped and
  // the modal opens to ext_check (fresh start) — which is what the
  // user expects when they click Start Auto Call.
  const VALID_RESTORE_PHASES = new Set([
    'ext_check',
    // Ring phases — preserved so refresh keeps the same banner the
    // caller saw before reload (no spurious "first call again"
    // transition). Pairs with the modal hydrating agentAttempts and
    // phaseDeadline from the snapshot so the synthetic 35s timer
    // resumes from its original deadline instead of restarting and
    // accidentally placing a second Tata call.
    'agent_ringing_1',
    'agent_ringing_2',
    'customer_ringing',
    'recall_ringing',
    'customer_on_call',
    'form_window',
    'form_reason_card',
    'dnp_choice',
    'auto_paused',
  ]);
  const restoredOnceRef        = useRef(false);
  // Tracks whether we've ever had an editLead set. Prevents the mount-
  // time fire of the snapshot-write effect (when editLead is still
  // null) from wiping a perfectly good sessionStorage snapshot before
  // the restore effect has had a chance to read it. Only flips true
  // once a modal is actually opened OR a snapshot is restored.
  const hadEditLeadRef         = useRef(false);
  const [restoredSnapshot, setRestoredSnapshot] = useState(null);
  const [modalStateFromChild,  setModalStateFromChild] = useState(null);

  // Write the snapshot whenever editLead, autoMode, or the child's
  // reported modal-state changes. Wipes ONLY when a previously-open
  // modal closes (an intentional close) — never on the initial mount
  // where editLead starts null.
  useEffect(() => {
    try {
      if (!editLead?.id) {
        // No modal currently open. Wipe ONLY if a modal was previously
        // open in this session (real close action). On the initial
        // mount of a fresh page, hadEditLeadRef is false so we leave
        // the saved snapshot alone — the restore effect needs it.
        if (hadEditLeadRef.current) {
          sessionStorage.removeItem(MODAL_STATE_KEY);
        }
        return;
      }
      // A modal is now open — note that for the rest of this session.
      hadEditLeadRef.current = true;
      const child = modalStateFromChild || {};
      const snap = {
        lead_id:              editLead.id,
        phase:                child.phase || null,
        cutCount:             child.cutCount ?? 0,
        customerAttempt:      child.customerAttempt ?? 1,
        agentAttempts:        child.agentAttempts ?? 0,
        dnpRetry:             !!child.dnpRetry,
        customerAnsweredOnce: !!child.customerAnsweredOnce,
        formTimerDeadline:    child.formTimerDeadline ?? null,
        phaseDeadline:        child.phaseDeadline ?? null,
        autoMode,
        savedAt:              Date.now(),
      };
      sessionStorage.setItem(MODAL_STATE_KEY, JSON.stringify(snap));
    } catch { /* sandbox / storage disabled */ }
  }, [editLead?.id, autoMode, modalStateFromChild]);

  /* On leads load, restore the snapshot ONCE per mount — picks the saved
     lead out of the freshly-fetched queue and pre-loads the modal with
     the saved phase / counters / timer. Skips if:
       • a modal is already open (e.g. fresh click)
       • leads haven't loaded yet
       • snapshot missing, stale (>30 min), corrupt, or its lead is no
         longer in this caller's queue (admin reassigned it) */
  useEffect(() => {
    if (restoredOnceRef.current || editLead || !leads.length) return;
    let snap = null;
    try {
      const raw = sessionStorage.getItem(MODAL_STATE_KEY);
      if (raw) snap = JSON.parse(raw);
    } catch { /* corrupt JSON — wipe */ }
    if (!snap || !snap.lead_id) { try { sessionStorage.removeItem(MODAL_STATE_KEY); } catch {} return; }
    if ((Date.now() - (snap.savedAt || 0)) > MODAL_RESTORE_MAX_AGE) {
      try { sessionStorage.removeItem(MODAL_STATE_KEY); } catch {}
      return;
    }
    // Lead-membership check — if the saved lead is no longer in this
    // caller's queue (e.g. admin reassigned), wipe and skip.
    const match = leads.find(l => l.id === snap.lead_id);
    if (!match) {
      try { sessionStorage.removeItem(MODAL_STATE_KEY); } catch {}
      return;
    }
    // Phase resumability check — some phases (ringing, reason cards,
    // transient alerts) can't be safely resumed because Tata's call
    // state has moved on. Instead of wiping the snapshot entirely and
    // dropping the user back on the queue, we ALWAYS reopen the modal
    // for the lead — but null out the phase so the modal falls back
    // to its default (lead.last_call_id ? agent_ringing_1 : ext_check).
    // The formTimerDeadline is also nulled because it only makes sense
    // alongside form_window / form_reason_card. This means a refresh
    // during ringing returns you to ext_check on the same lead, ready
    // to confirm the extension and place a fresh call.
    let safeSnap = snap;
    if (snap.phase && !VALID_RESTORE_PHASES.has(snap.phase)) {
      // Phase isn't safely resumable — null out the phase AND any
      // phase-specific timers so the modal opens at its default
      // (ext_check / agent_ringing_1 from lead.last_call_id) without
      // resuming a stale form-window countdown or ring-timer deadline.
      safeSnap = { ...snap, phase: null, formTimerDeadline: null, phaseDeadline: null };
    }
    restoredOnceRef.current = true;
    /* Wipe inactivity nudge timestamps on restore — a refresh is itself
       a deliberate user action, so it should reset "you've been idle"
       timers instead of resuming them. Without this, refreshing during
       ext_check (or any reason-card) re-reads the deadline-anchored
       start time, may compute a count past maxRepeats, and immediately
       fires onExhausted → self-pauses the account.

       Task timers (the 45-second form-window countdown) are NOT touched
       here — they live in snap.formTimerDeadline and resume correctly. */
    try {
      ['ext', 'agent', 'form'].forEach(kind => {
        localStorage.removeItem(`mhs_nudge_${kind}_${match.id}`);
      });
    } catch { /* localStorage disabled */ }
    if (safeSnap.autoMode) setAutoMode(safeSnap.autoMode);
    setRestoredSnapshot(safeSnap);
    setEditLead(match);
  }, [leads, editLead]);
  /* Tag from the just-saved lead — used to pick the right speech-bubble
     message in the post-call celebration overlay. Cleared between calls
     so a stale tag never blends into the next celebration. */
  const [lastCompletedTag, setLastCompletedTag] = useState(null);
  // The exact celebration line to render in the bubble. Picked ONCE per
  // call inside the save-handler so the bubble text stays in sync with
  // the voice clip we played, instead of being re-rolled on every render.
  const [celebrationLine, setCelebrationLine] = useState('');

  /* Break picker — opened when caller hits Stop in the cooldown card.
       breakStep    : null | 'choose' | 'other'   (modal flow)
       breakInfo    : null | { reason, minutes, message?, endsAt, startedAt }
                      (active break — persisted to localStorage so it survives
                       reloads / logouts / browser restarts. Only ends when
                       the caller presses Start Auto-Call.)
       otherMessage / otherMinutes — fields inside the "other" step       */
  const breakStorageKey = (() => {
    try {
      const [, payload] = (jwt || '').split('.');
      const uid = JSON.parse(atob(payload || ''))?.user_id;
      return uid ? `mhs_break_${uid}` : 'mhs_break_anon';
    } catch { return 'mhs_break_anon'; }
  })();
  const [breakStep, setBreakStep]       = useState(null);
  const [breakInfo, setBreakInfo]       = useState(() => {
    // Restore on mount — handles tab close / logout / PC restart.
    try {
      const raw = localStorage.getItem(breakStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.endsAt === 'number') return parsed;
    } catch { /* fall through to null */ }
    return null;
  });
  const [breakTimeLeft, setBreakTimeLeft] = useState(0);
  const [breakElapsed,  setBreakElapsed]  = useState(0);
  const [otherMessage, setOtherMessage]   = useState('');
  const [otherMinutes, setOtherMinutes]   = useState(30);
  const breakTimerRef = useRef(null);
  // Delays the post-break call start until the resume robot finishes speaking.
  const resumeStartTimerRef = useRef(null);
  useEffect(() => () => { if (resumeStartTimerRef.current) clearTimeout(resumeStartTimerRef.current); }, []);

  /* Bubble the current break state up to the shell (Call-page status card). */
  useEffect(() => {
    if (typeof onBreakInfo === 'function') onBreakInfo(breakInfo || null);
  }, [breakInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Tell the Call page when a call-note modal is open (a call is in progress)
     so CallModule suspends its idle "never pressed Start Call" auto-pause —
     a caller on the phone isn't idle. Cleared on unmount too. */
  useEffect(() => {
    if (typeof onCallActive === 'function') onCallActive(!!editLead);
    return () => { if (typeof onCallActive === 'function') onCallActive(false); };
  }, [editLead]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Daily break budget — fetched from GET /api/caller/break-budget each time
     the break picker opens. Drives per-option greying (Tea ×2/day, Lunch ×1,
     2-hr ×1) and the Custom-break minute cap (shared 30-min/day pool).
     null until the first fetch resolves — nothing is greyed until then. */
  const [breakBudget, setBreakBudget] = useState(null);

  /* Activity heartbeat — mirror the caller's real-time state to localStorage
     so CallerShell's heartbeat poller (every 30s) reports it to the server.
     Each state transition also dispatches `mhs:activity:changed` so CallerShell
     can fire an immediate heartbeat without waiting for the next 30s tick.

     Status derivation:
       - breakInfo set                          → 'on_break' (always, even mid-call)
       - editLead set OR autoMode === 'calling' → 'working'
       - otherwise                              → 'idle' */
  const activityStorageKey = breakStorageKey.replace('mhs_break_', 'mhs_activity_');

  /* Inactivity guard for the "Stopping the auto-call?" card.
     Each time the modal opens the caller has 10 s to pick a reason. If the
     window expires we show an inline nudge and restart the countdown. After
     3 consecutive expiries the auto-call is stopped silently — the caller
     clearly stepped away from the desk. */
  const [breakChooseLeft, setBreakChooseLeft] = useState(0);
  const [breakChooseStrikes, setBreakChooseStrikes] = useState(0);
  const breakChooseTimerRef    = useRef(null);
  const breakChooseStrikesRef  = useRef(0);

  /* Break activity sub-tag — BREAK_PICKER while the break-reason picker is
     open, ON_BREAK once a break is running. Transition-tracked via a ref so
     that while neither is active we don't clobber the sub-tag the call-note
     modal owns (ON_CALL / IN_FORM / REASON_CARD). */
  const prevBreakSubRef = useRef(null);
  useEffect(() => {
    if (!jwt || previewMode) return;   // read-only preview: no activity writes
    let sub = null;
    if (breakStep === 'choose' || breakStep === 'other') sub = 'BREAK_PICKER';
    else if (breakInfo) sub = 'ON_BREAK';
    if (sub !== prevBreakSubRef.current) {
      if (sub === 'ON_BREAK') {
        setActivitySub(jwt, 'ON_BREAK', { reason: breakInfo?.reason, minutes: breakInfo?.minutes });
      } else if (sub === 'BREAK_PICKER') {
        setActivitySub(jwt, 'BREAK_PICKER', null);
      } else if (prevBreakSubRef.current) {
        setActivitySub(jwt, null, null);
      }
      prevBreakSubRef.current = sub;
    }
  }, [breakStep, breakInfo, jwt]);

  /* Leaving the Assigned page clears any sub-tag this module set so the next
     page's tag isn't shadowed by a stale ON_BREAK / picker tag. */
  useEffect(() => () => { if (jwt && !previewMode) setActivitySub(jwt, null, null); }, [jwt]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Daily break budget ──────────────────────────────────────────────────
     Fetched fresh each time the picker opens (breakStep → 'choose'). Greys
     Tea after 2/day, Lunch after 1, 2-hr after 1; "Other" draws from a
     shared 30-min/day pool. Window resets at 08:00 IST (server-computed). */
  useEffect(() => {
    if (breakStep !== 'choose' || !jwt) return undefined;
    let alive = true;
    fetch('/api/caller/break-budget', { headers: { Authorization: `Bearer ${jwt}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d) setBreakBudget(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [breakStep, jwt]);

  /* Derived budget flags — a null budget (not yet loaded) greys nothing. */
  const teaExhausted   = !!breakBudget && breakBudget.tea_used   >= breakBudget.limits.tea;
  const lunchExhausted = !!breakBudget && breakBudget.lunch_used >= breakBudget.limits.lunch;
  const twohrExhausted = !!breakBudget && breakBudget.twohr_used >= breakBudget.limits.twohr;
  const otherMinutesRemaining = breakBudget
    ? Math.max(0, breakBudget.limits.other_minutes - breakBudget.other_minutes_used)
    : 30;

  /* Keep the Custom-break minute field inside the remaining daily pool —
     re-clamp when the step opens or the budget resolves. */
  useEffect(() => {
    if (breakStep !== 'other') return;
    setOtherMinutes(m => Math.max(1, Math.min(otherMinutesRemaining, m || 30)));
  }, [breakStep, breakBudget]);  // eslint-disable-line react-hooks/exhaustive-deps

  /* Robot speech-bubble auto-fade — every robot line disappears after 10 s
     (the functional card underneath stays put). The bubble re-shows whenever
     the line CHANGES: a break-picker strike (breakChooseStrikes) or a
     Custom-break nudge (otherNudgeCount) bumps the dependency and restarts
     the 10 s timer with the fresh text. */
  const [chooseBubbleShown, setChooseBubbleShown] = useState(true);
  const [otherBubbleShown,  setOtherBubbleShown]  = useState(true);
  useEffect(() => {
    if (breakStep !== 'choose') { setChooseBubbleShown(true); return undefined; }
    setChooseBubbleShown(true);
    const id = setTimeout(() => setChooseBubbleShown(false), t.breakBubbleHideMs);
    return () => clearTimeout(id);
  }, [breakStep, breakChooseStrikes, t.breakBubbleHideMs]);

  /* Robot nudge for the Custom-break ("Other") card — if the caller opens it
     and doesn't act, the robot re-asks "nanba irukkiya" every 30 s and after
     4 unanswered nudges the account auto-pauses (POST /api/caller/self-pause
     → CallerShell shows the paused robot). */
  const { count: otherNudgeCount } = useRobotNudge({
    active: breakStep === 'other',
    intervalMs: t.customBreakNudgeIntervalMs,
    maxRepeats: t.customBreakNudgeCount,
    storageKey: breakStorageKey.replace('mhs_break_', 'mhs_nudge_breakother_'),
    onExhausted: () => {
      fetch('/api/caller/self-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ reason: 'Custom-break card ignored' }),
      }).catch(() => {});
      setBreakStep(null);
    },
  });
  /* Custom-break bubble fade — re-shows on each "nanba irukkiya" nudge. */
  useEffect(() => {
    if (breakStep !== 'other') { setOtherBubbleShown(true); return undefined; }
    setOtherBubbleShown(true);
    const id = setTimeout(() => setOtherBubbleShown(false), t.breakBubbleHideMs);
    return () => clearTimeout(id);
  }, [breakStep, otherNudgeCount, t.breakBubbleHideMs]);

  /* Late-return flow — when a caller resumes MORE than 10 min over their
     allotted break, they must type why before auto-call restarts. The robot
     re-asks "nanba irukkiya" every 30 s until they submit. */
  const [lateReasonStep,   setLateReasonStep]   = useState(null);  // null | 'ask'
  const [lateReasonText,   setLateReasonText]   = useState('');
  const [lateOverBySec,    setLateOverBySec]    = useState(0);
  const [resumeRobotPulse, setResumeRobotPulse] = useState(0);     // resume-msg flash
  const { count: lateNudgeCount } = useRobotNudge({
    active: lateReasonStep === 'ask',
    intervalMs: t.lateReturnNudgeIntervalMs,
    maxRepeats: t.lateReturnNudgeCount,
    storageKey: breakStorageKey.replace('mhs_break_', 'mhs_nudge_late_'),
    onExhausted: () => {
      fetch('/api/caller/self-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ reason: 'Late-return card ignored' }),
      }).catch(() => {});
    },
  });
  /* "Why late" bubble fade — text hides after 10 s, re-shows on each nudge. */
  const [lateBubbleShown, setLateBubbleShown] = useState(true);
  useEffect(() => {
    if (lateReasonStep !== 'ask') { setLateBubbleShown(true); return undefined; }
    setLateBubbleShown(true);
    const id = setTimeout(() => setLateBubbleShown(false), t.breakBubbleHideMs);
    return () => clearTimeout(id);
  }, [lateReasonStep, lateNudgeCount, t.breakBubbleHideMs]);

  /* Resume-message robot flash — auto-clears after the configured duration. */
  useEffect(() => {
    if (resumeRobotPulse === 0) return undefined;
    const id = setTimeout(() => setResumeRobotPulse(0), t.resumeRobotPulseMs);
    return () => clearTimeout(id);
  }, [resumeRobotPulse, t.resumeRobotPulseMs]);

  /* On the Call page, route the post-break resume line to the center robot
     (CallModule) instead of flashing a separate corner robot. */
  useEffect(() => {
    if (!callPageMode || resumeRobotPulse === 0 || typeof onRobotMessage !== 'function') return;
    onRobotMessage({
      text: 'enna nanba break ah enjoy panningala vaanga call start pannalam',
      clip: 42,
      key: `resume-${resumeRobotPulse}`,
    });
  }, [callPageMode, resumeRobotPulse]); // eslint-disable-line react-hooks/exhaustive-deps

  // Queue-end refill modal — pops in two cases:
  //   1. 'auto_finished' — the auto-call queue just drained
  //   2. 'initial_empty' — the Assigned page loaded with zero leads
  // Either way the caller can refill from DNP / Missed / Untouched in one
  // click instead of navigating between tabs.
  const [queueEndOpen, setQueueEndOpen] = useState(false);
  const [queueEndReason, setQueueEndReason] = useState('initial_empty'); // 'initial_empty' | 'auto_finished'
  const [queueEndDismissed, setQueueEndDismissed] = useState(false);
  const [reopening, setReopening]       = useState(null); // 'dnp' | 'missed' | 'untouched' | null
  const [reopenToast, setReopenToast]   = useState('');

  /* Idle nudge — the caller is sitting on the Assigned page with leads
     waiting but auto-call OFF and no modal/break open. The robot re-asks
     "enna nanba call start pannalaya" every 30 s; 5 unanswered nudges
     auto-pause the account. */
  const idleActive = !editLead
    && autoMode === 'off'
    && !breakInfo
    && breakStep === null
    && lateReasonStep === null
    && !queueEndOpen
    && leads.length > 0
    && isActive === true    // never nudge while paused — the paused overlay owns the screen
    && !callPageMode;       // on the Call page, CallModule's center robot owns idle nudges
  const { count: idleNudgeCount } = useRobotNudge({
    active: idleActive,
    intervalMs: t.robotNudgeIntervalMs,
    maxRepeats: t.autoPauseNudgeCount,
    storageKey: breakStorageKey.replace('mhs_break_', 'mhs_nudge_idle_'),
    onExhausted: () => {
      fetch('/api/caller/self-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ reason: 'Idle — auto-call never started' }),
      }).catch(() => {});
    },
  });

  async function triggerCall(lead) {
    // Admin preview is read-only — never place a real call. (Backend also
    // blocks calls/start for preview tokens; this avoids the error toast.)
    if (previewMode) throw new Error('Preview mode — calling is disabled.');
    const res = await fetch('/api/caller/calls/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      body: JSON.stringify({ lead_id: lead.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to start call');
    return data;
  }

  /* Trigger a Tata call AND open the modal with the freshly-created
     last_call_id so the modal can immediately reflect the in-flight call
     (banner = "Your first call is triggered. Please pick the call.")
     instead of sitting at the idle "Ready to start auto call." banner.

     Failure handling (auto-call loop continuity):
       1. First POST failure → wait t.autoCallRetryDelayMs (~2.5 s) and
          retry once. Tata routinely rejects a /start when the previous
          DNP/hangup leg hasn't fully released; the brief retry covers
          that window without bothering the caller.
       2. Second failure → DO NOT dump the caller back into ext_check
          (which is what the old "setEditLead with last_call_id=null"
          path produced). Instead show a toast and advance the auto-call
          loop to the lead after this one. Keeps the queue moving when
          one specific lead is permanently un-dialable (bad number,
          carrier reject, etc.).
       3. When auto-mode is OFF (manual click), preserve the legacy
          behaviour: open the modal at ext_check so the caller can
          retry the Start button. */
  async function triggerCallAndOpen(lead, errorSetter) {
    const reportError = errorSetter || setError;
    const inAutoLoop  = autoModeRef.current === 'calling';
    try {
      const data = await triggerCall(lead);
      setEditLead({ ...lead, last_call_id: data?.call_id || null });
      return;
    } catch (e1) {
      // First attempt failed. Outside the auto loop the user can retry
      // manually — open the modal at ext_check as before.
      if (!inAutoLoop) {
        reportError(e1.message || 'Call failed');
        setEditLead({ ...lead, last_call_id: null });
        return;
      }
      // Inside the auto loop: wait briefly and try once more before
      // giving up on this lead.
      await new Promise(r => setTimeout(r, t.autoCallRetryDelayMs || 2500));
      try {
        const data = await triggerCall(lead);
        setEditLead({ ...lead, last_call_id: data?.call_id || null });
        return;
      } catch (e2) {
        // Second attempt failed → soft-skip. Drop this lead from the
        // auto-queue and dial the lead after it, so the caller doesn't
        // get stranded at a manual ext_check for a lead Tata won't
        // accept right now.
        const msg = e2.message || e1.message || 'Call failed';
        setAdvanceToast(`Couldn't dial ${lead.full_name || 'lead'} — moving on. (${msg})`);
        setTimeout(() => setAdvanceToast(''), 5000);
        // Advance: remove this lead from queue + leads state, recurse
        // into advanceAutoCall to dial the next one. Use setTimeout(0)
        // so the state updates from the current render commit before
        // advanceAutoCall reads autoQueueRef.
        setAutoQueue(q => q.filter(l => l.id !== lead.id));
        setLeads(ls => ls.filter(l => l.id !== lead.id));
        setEditLead(null);
        setTimeout(() => advanceAutoCall(), 0);
      }
    }
  }

  function clearCooldownTimer() {
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }

  function clearBreakChooseTimer() {
    if (breakChooseTimerRef.current) {
      clearInterval(breakChooseTimerRef.current);
      breakChooseTimerRef.current = null;
    }
  }

  /* Voice prompts for the break picker, custom-break and late-return
     overlays — primary clip on open, nudge clip each time it re-asks. */
  useEffect(() => {
    if (breakStep === 'choose') playRobotClip(43);
    else if (breakStep === 'other') playRobotClip(45);
  }, [breakStep]);
  useEffect(() => { if (breakChooseStrikes > 0) playRobotClip(44); }, [breakChooseStrikes]);
  useEffect(() => { if (otherNudgeCount  >= 1) playRobotClip(46); }, [otherNudgeCount]);
  useEffect(() => { if (lateReasonStep === 'ask') playRobotClip(47); }, [lateReasonStep]);
  useEffect(() => { if (lateNudgeCount  >= 1) playRobotClip(48); }, [lateNudgeCount]);

  function stopAutoMode() {
    clearCooldownTimer();
    setAutoMode('off');
    setAutoQueue([]);
    setAutoIndex(0);
    setAutoTotal(0);
    setCooldownLeft(0);
    setAutoError('');
  }

  /* Inactivity countdown for the break-picker card. Deadline-anchored for the
     same StrictMode-safety reasons as the cooldown / advance timers.
     On expiry: increment strike count; below the strike cap, restart for
     another window with an inline nudge visible; once the cap is reached,
     stop auto-call, close the modal, and auto-pause the account. */
  function startBreakChooseTimer() {
    clearBreakChooseTimer();
    const deadline = Date.now() + t.breakPickerCountdownMs;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setBreakChooseLeft(left);
      if (left <= 0) {
        clearBreakChooseTimer();
        const next = breakChooseStrikesRef.current + 1;
        breakChooseStrikesRef.current = next;
        setBreakChooseStrikes(next);
        if (next >= t.breakPickerStrikeCount) {
          setBreakStep(null);
          stopAutoMode();
          fetch('/api/caller/self-pause', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
            body: JSON.stringify({ reason: 'Break-picker card ignored' }),
          }).catch(() => {});
        } else {
          startBreakChooseTimer();
        }
      }
    };
    tick();  // paint "10" immediately
    breakChooseTimerRef.current = setInterval(tick, COUNTDOWN_TICK_MS);
  }

  /* Stop the auto-call AND start a break with a countdown banner. The
     existing stopAutoMode() guarantees no further calls will trigger
     until the caller manually presses Start Auto-Call again. */
  function startBreak(reason, minutes, message = '') {
    if (previewMode) return;   // read-only admin preview
    stopAutoMode();
    const totalSec = Math.max(1, Math.round(minutes * 60));
    const now = Date.now();
    const info = {
      reason,
      minutes,
      message,
      startedAt: now,
      endsAt: now + totalSec * 1000,
    };
    setBreakInfo(info);
    setBreakTimeLeft(totalSec);
    setBreakElapsed(0);
    setBreakStep(null);
    setOtherMessage('');
    setOtherMinutes(30);
    try { localStorage.setItem(breakStorageKey, JSON.stringify(info)); } catch { /* quota / sandbox */ }
  }
  /* End the break and (if possible) immediately kick off auto-call. Only
     called from the in-modal "Start Auto-Call" button — there is no
     standalone "End break" anywhere else, by design. */
  /* Actually clear the break + restart auto-call. Flashes the resume robot
     ("enjoy panniya va, call pannalam"). */
  function doEndBreakAndStart() {
    setBreakInfo(null);
    setBreakTimeLeft(0);
    setBreakElapsed(0);
    if (breakTimerRef.current) {
      clearInterval(breakTimerRef.current);
      breakTimerRef.current = null;
    }
    try { localStorage.removeItem(breakStorageKey); } catch { /* sandbox */ }
    setResumeRobotPulse(p => p + 1);   // robot speaks the resume line NOW
    // Start the call flow ONLY AFTER the resume robot finishes speaking — the
    // ext_check / first dial opens once the voice line (~resumeRobotPulseMs,
    // matched to clip 42's length) completes, instead of on top of it.
    if (leads.length) {
      if (resumeStartTimerRef.current) clearTimeout(resumeStartTimerRef.current);
      resumeStartTimerRef.current = setTimeout(() => {
        resumeStartTimerRef.current = null;
        startAutoMode();
      }, t.resumeRobotPulseMs || 7000);
    }
    // If no leads loaded yet (e.g., right after a tab restore), the modal
    // closes and the page's Start Auto-Call button takes over once leads
    // arrive — the caller is back in normal manual mode.
  }

  /* Resume from break. On time (or ≤10 min over) → resume straight away.
     MORE than 10 min over → open the "why late" reason card first; only
     after a reason is submitted does auto-call restart. */
  function endBreakAndStartAutoCall() {
    const overBy = breakInfo
      ? Math.max(0, breakElapsed - breakInfo.minutes * 60)
      : 0;
    if (overBy > t.breakOverrunGraceSec) {
      setLateOverBySec(overBy);
      setLateReasonText('');
      setLateReasonStep('ask');
      return;
    }
    doEndBreakAndStart();
  }

  /* "Why late" card submit — records the reason (admin-visible LATE_RETURN
     event via POST /api/caller/late-reason), then resumes. */
  async function submitLateReason() {
    const reason = lateReasonText.trim();
    if (!reason) return;
    try {
      await fetch('/api/caller/late-reason', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ reason, over_by_sec: lateOverBySec }),
      });
    } catch (_) { /* best-effort — never block the caller from resuming */ }
    setLateReasonStep(null);
    setLateReasonText('');
    doEndBreakAndStart();
  }

  /* Refill Assigned bucket from DNP / Missed Calls / Untouched. Hits
     POST /api/caller/leads/reopen with the chosen source. Backend stamps
     pinned_at = NOW() so the moved leads bubble to the TOP of the list
     (sort: pinned_at DESC NULLS LAST, assigned_at ASC). After the refetch
     we immediately kick off auto-call mode on the freshly-loaded leads so
     the caller doesn't have to press Start Auto-Call again. */
  async function reopenFrom(source) {
    if (reopening) return;
    setReopening(source);
    setReopenToast('');
    try {
      const res = await fetch('/api/caller/leads/reopen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reopen failed');
      const label = source === 'dnp'       ? 'DNP'
                  : source === 'missed'    ? 'Missed Calls'
                  : 'Untouched';
      if (data.pending_definition) {
        setReopenToast(`"Untouched" bucket isn't wired up yet — coming soon.`);
      } else if (data.moved > 0) {
        setReopenToast(`✓ ${data.moved} ${label} lead${data.moved === 1 ? '' : 's'} moved to the top — starting auto-call.`);
        // Refetch and capture the fresh leads, then auto-start calling.
        // We can't rely on the leads state being updated synchronously
        // before startAutoMode reads it, so we pass the array directly.
        const fresh = await fetchLeads({ returnLeads: true });
        if (fresh && fresh.length > 0) {
          startAutoModeWith(fresh);
        }
      } else {
        setReopenToast(`No ${label} leads to move right now.`);
      }
      setQueueEndOpen(false);
      setQueueEndDismissed(true);   // don't re-pop the modal immediately
      setTimeout(() => setReopenToast(''), t.reopenToastMs);
    } catch (e) {
      setReopenToast('⚠ ' + (e.message || 'Reopen failed'));
      setTimeout(() => setReopenToast(''), t.reopenToastMs);
    } finally {
      setReopening(null);
    }
  }

  /* Tick the break clock every second. After the allotted minutes are up the
     remaining countdown stays at 0 but the elapsed timer keeps climbing —
     the caller is still on (overrun) break until they press Start Auto-Call. */
  useEffect(() => {
    if (!breakInfo) return undefined;
    const update = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.round((breakInfo.endsAt - now) / 1000));
      const startedAt = breakInfo.startedAt || (breakInfo.endsAt - breakInfo.minutes * 60 * 1000);
      const elapsed   = Math.max(0, Math.round((now - startedAt) / 1000));
      setBreakTimeLeft(remaining);
      setBreakElapsed(elapsed);
    };
    update();  // paint once immediately on (re-)mount / restore
    breakTimerRef.current = setInterval(update, 1000);
    return () => {
      if (breakTimerRef.current) clearInterval(breakTimerRef.current);
      breakTimerRef.current = null;
    };
  }, [breakInfo]);

  /* Activity-state effect — derives status from (editLead, autoMode, breakInfo),
     mirrors to localStorage, and dispatches a window event so CallerShell can
     fire an immediate heartbeat instead of waiting for its 30s tick. */
  useEffect(() => {
    let status = 'idle';
    let breakPayload = null;
    if (breakInfo) {
      status = 'on_break';
      breakPayload = {
        reason:    breakInfo.reason,
        minutes:   breakInfo.minutes,
        startedAt: breakInfo.startedAt || (breakInfo.endsAt - breakInfo.minutes * 60 * 1000),
        endsAt:    breakInfo.endsAt,
      };
    } else if (editLead || autoMode === 'calling') {
      status = 'working';
    }
    setActivityStatus(jwt, status, breakPayload);
  }, [editLead, autoMode, breakInfo, jwt]);

  function startAutoMode() {
    if (previewMode) return;   // read-only admin preview
    if (!leads.length) return;
    startAutoModeWith(leads);
  }

  /* Same as startAutoMode but takes the leads array as an argument — needed
     by reopenFrom(), which calls await fetchLeads() then immediately wants
     to start auto-call. At that moment the React `leads` state hasn't
     re-rendered yet, so reading it via closure would see the stale (empty)
     array. */
  function startAutoModeWith(arr) {
    if (!arr || !arr.length) return;
    // Silence every robot audio source before opening the first lead so
    // the SmartFlow extension card opens to dead silence — both the
    // playRobotClip path (idle nudges, etc.) and the corner RobotGuide
    // path (clip 41 idle nudge) are killed atomically.
    try { stopRobotClip();           } catch { /* ignore */ }
    try { stopAllRobotGuideAudio();  } catch { /* ignore */ }
    // Fresh Start Auto Call → clear any restored snapshot so the modal
    // opens cleanly at ext_check. Without this, a snapshot left over
    // from a previous refresh-restore could trick the modal into
    // initializing at a stale phase (e.g. agent_ringing_2 → banner
    // says "Triggering the first call again" before the caller has
    // even confirmed the extension).
    setRestoredSnapshot(null);
    setModalStateFromChild(null);
    try { sessionStorage.removeItem(MODAL_STATE_KEY); } catch { /* ignore */ }
    /* Fresh Start Auto Call → wipe nudge start-timestamps for every lead
       in the queue so the ext_check / reason-card timers genuinely begin
       at 0. Without this, leftover timestamps from a previous session
       could make the amber "nanba irukkingala?" bubble (and any other
       nudge) fire immediately on the first render, instead of after
       the admin-configured `extAlertNudgeIntervalMs` of inaction.

       The snapshot-restore path (browser refresh) does NOT come through
       here, so mid-nudge state survives a refresh as intended. */
    try {
      arr.forEach(l => {
        if (!l?.id) return;
        ['ext', 'agent', 'form'].forEach(kind => {
          localStorage.removeItem(`mhs_nudge_${kind}_${l.id}`);
        });
      });
    } catch { /* localStorage disabled */ }
    const queue = [...arr];          // snapshot of the fresh list
    setAutoQueue(queue);
    setAutoIndex(0);
    setAutoTotal(queue.length);
    setAutoError('');
    setAutoMode('calling');
    const first = queue[0];
    // Force a brand-new modal instance for this fresh start so it can't
    // inherit a stale phase from a snapshot-restored modal of the same lead.
    setAutoSession(s => s + 1);
    // FRESH START: open the modal at idle so the user sees the SmartFlow
    // extension confirmation overlay (ext_check) BEFORE the first Tata call
    // gets dialed. Auto-advance flows (advanceAutoCall, onSaved auto-advance)
    // keep using triggerCallAndOpen because the user has already confirmed
    // their extension is on for this session — re-prompting on every lead
    // would break the auto flow.
    setEditLead({ ...first, last_call_id: null });
  }

  /* Called after the "Complete Call" button submits the note OR when the
     5s "skip now" button is pressed. Drops the just-finished lead from the
     queue and dials the next one (or finishes auto-mode if queue is empty). */
  function advanceAutoCall() {
    clearCooldownTimer();
    setCooldownLeft(0);
    // Compute the new queue PURELY first (no side effects), then run any
    // setState / fetch calls in event-handler scope. The previous version
    // called setAutoMode / setAutoIndex / triggerCallAndOpen INSIDE the
    // setAutoQueue updater — React StrictMode invokes that updater twice
    // in dev, which produced TWO /api/caller/calls/start POSTs and two
    // setEditLead writes for every queue advance. Tata routinely rejects
    // the second POST (or both, racing), which is one reason the auto-call
    // appeared to "stop" after the cooldown finished.
    const prevQueue   = autoQueueRef.current || [];
    const sliced      = prevQueue.slice(1);
    let nextLead      = null;
    let nextQueue     = sliced;
    let totalDelta    = 0;
    let queueExhausted = false;
    if (sliced.length > 0) {
      nextLead = sliced[0];
    } else {
      // Snapshot drained — but new leads may have arrived via SSE/poll
      // while the caller worked through this batch. Those landed in
      // `leads` (rendered in the table) but never made it into the
      // auto-queue snapshot. Pull them in NOW instead of falsely
      // declaring "Queue complete" with rows clearly visible behind
      // the modal. Read via leadsRef.current to get the freshest list.
      const fresh = (leadsRef.current || []).filter(l => l && l.id);
      if (fresh.length > 0) {
        nextLead   = fresh[0];
        nextQueue  = fresh;
        totalDelta = fresh.length;
      } else {
        queueExhausted = true;
      }
    }
    setAutoQueue(nextQueue);
    if (queueExhausted) {
      // Truly empty — pop the refill modal so the caller can pull DNP /
      // Missed-Call rows back to the top in one click instead of leaving
      // them stranded in other tabs.
      setAutoMode('off');
      setAutoIndex(0);
      setAutoTotal(0);
      setQueueEndReason('auto_finished');
      setQueueEndDismissed(false);
      setQueueEndOpen(true);
      return;
    }
    setAutoIndex(i => i + 1);
    if (totalDelta > 0) setAutoTotal(t => t + totalDelta);
    setAutoMode('calling');
    setAutoError('');
    triggerCallAndOpen(nextLead, setAutoError);
  }

  /* Kick off the 5-second card after Complete Call.

     Deadline-anchored: each tick computes remaining seconds from Date.now()
     against a fixed deadline. This survives React StrictMode's double-invoke
     of state updaters (which would otherwise fire the "prev <= 1" side-effect
     branch twice — clearing the timer + advancing the call before the full
     5 s have elapsed). Wall-clock duration is now guaranteed. */
  function startCooldown() {
    clearCooldownTimer();
    const deadline = Date.now() + t.cooldownCountdownMs;
    setAutoMode('cooldown');
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setCooldownLeft(remaining);
      if (remaining <= 0) {
        clearCooldownTimer();
        // Defer to next tick so React commits state first
        setTimeout(advanceAutoCall, 0);
      }
    };
    tick();  // paint "5" immediately
    cooldownTimerRef.current = setInterval(tick, COUNTDOWN_TICK_MS);
  }

  // Clean up timer if module unmounts mid-cooldown
  useEffect(() => () => clearCooldownTimer(), []);

  /* Auto-start trigger fired from the Call page's big glow button.
     Wait until leads have loaded and at least one is available, then kick
     off the same auto-call flow as the manual "Start Auto Call" button.
     Consume the flag once so re-mounting doesn't restart endlessly. */
  useEffect(() => {
    if (!pendingAutoStart) return;
    if (loading) return;
    if (!leads.length) return;
    // Resuming from a break? End it (handles the late-return reason card on
    // overrun) instead of a plain auto-start. On the Call page the break has
    // no full-screen overlay/button, so its compact banner's Start Auto-Call
    // routes the resume through here.
    if (breakInfo) {
      endBreakAndStartAutoCall();
      if (typeof clearPendingAutoStart === 'function') clearPendingAutoStart();
      return;
    }
    // Don't override an already-running auto session.
    if (autoMode !== 'off') {
      if (typeof clearPendingAutoStart === 'function') clearPendingAutoStart();
      return;
    }
    startAutoMode();
    if (typeof clearPendingAutoStart === 'function') clearPendingAutoStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoStart, loading, leads.length, autoMode, breakInfo]);

  /* Drive the break-picker inactivity timer off the modal-step state.
     Entering 'choose' resets strikes + starts the 10-s window. Leaving
     it (any other step, including 'other' / null) tears the timer down. */
  useEffect(() => {
    if (breakStep === 'choose') {
      breakChooseStrikesRef.current = 0;
      setBreakChooseStrikes(0);
      startBreakChooseTimer();
    } else {
      clearBreakChooseTimer();
      setBreakChooseLeft(0);
      setBreakChooseStrikes(0);
      breakChooseStrikesRef.current = 0;
    }
    return () => clearBreakChooseTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakStep]);

  /* When the shell asks us to highlight a lead (e.g. caller clicked an
     incoming-call toast), reflect it on the row and scroll into view. */
  useEffect(() => {
    if (!externalHighlightId) return;
    setHighlight(externalHighlightId);
    const el = rowRefs.current[externalHighlightId];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const t = setTimeout(() => setHighlight(h => h === externalHighlightId ? null : h), 3000);
    return () => clearTimeout(t);
  }, [externalHighlightId]);

  const fetchLeads = useCallback(async (opts = {}) => {
    if (!jwt) {
      setLeads([]);
      setLoading(false);
      setError('');
      return opts.returnLeads ? [] : undefined;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/caller/leads', { headers: { Authorization: `Bearer ${jwt}` } });
      if (!res.ok) throw new Error('Failed to load leads.');
      const data = await res.json();
      const arr  = data.leads || [];
      setLeads(arr);
      return opts.returnLeads ? arr : undefined;
    } catch (e) {
      setError(e.message || 'Failed to load leads.');
      return opts.returnLeads ? [] : undefined;
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  /* Auto-refetch on the configured interval so leads with `follow_up_at` due
     appear at the top without a manual refresh. */
  useEffect(() => {
    if (!jwt) return;
    const id = setInterval(() => fetchLeads(), t.assignedRefetchIntervalMs);
    return () => clearInterval(id);
  }, [jwt, fetchLeads, t.assignedRefetchIntervalMs]);

  /* Subscribe to SSE for instant lead push */
  useEffect(() => {
    if (!jwt) return;
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwt)}`;
    const es  = new EventSource(url);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'lead.assigned' && msg.lead) {
          // Promotions that must land at the TOP of the list:
          //  • next_batch  — admin started a new batch; parked leads come back
          //    as overdue follow-ups.
          //  • missed_call — a customer gave a missed call; the lead is pinned
          //    server-side so it bubbles above regular leads.
          // The SSE payload only carries {id, promoted_from} so we can't
          // optimistically merge — do a full refetch and let the backend sort
          // (overdue follow-ups, then pinned_at) place the lead correctly.
          if (msg.lead.promoted_from === 'next_batch' || msg.lead.promoted_from === 'missed_call') {
            fetchLeads();
            setHighlight(msg.lead.id);
            setTimeout(() => setHighlight(h => h === msg.lead.id ? null : h), t.promoHighlightLongMs);
            return;
          }
          setLeads(prev => {
            // Skip if we already have this lead (e.g. simultaneous fetch)
            if (prev.some(l => l.id === msg.lead.id)) return prev;
            // Organic SSE arrivals append to the BOTTOM of the queue —
            // only leads pulled in via the empty-state refill modal
            // (DNP / Missed / Untouched) get the top-of-list position
            // (handled server-side via the pinned_at column).
            return [...prev, msg.lead];
          });
          setHighlight(msg.lead.id);
          setTimeout(() => setHighlight(h => h === msg.lead.id ? null : h), t.promoHighlightShortMs);
        } else if (msg?.type === 'call.update' && msg.call) {
          // Merge call status/recording into the matching lead row
          setLeads(prev => prev.map(l => l.id === msg.call.lead_id ? {
            ...l,
            last_call_id:            msg.call.id,
            last_call_status:        msg.call.status,
            last_call_duration:      msg.call.duration_sec,
            last_call_recording_url: msg.call.recording_url,
          } : l));
        } else if (msg?.type === 'lead.note_saved' && msg.lead_id) {
          // Lead just got a note. If completed or future-scheduled follow-up,
          // it's no longer in our Assigned scope — drop it. If past follow-up,
          // a refetch will surface it at the top.
          fetchLeads();
        }
      } catch (_) { /* ignore malformed */ }
    };
    es.onerror = () => { /* auto-reconnect handled by EventSource */ };
    return () => { es.close(); sseRef.current = null; };
  }, [jwt, t.promoHighlightLongMs, t.promoHighlightShortMs]);

  /* Auto-pop the refill modal when the Assigned page is empty on load —
     so the caller is prompted to pull leads from DNP / Missed / Untouched
     instead of staring at a blank table. We suppress the prompt while:
       • leads are still loading
       • a fetch error is showing
       • the caller is on a break
       • a call note modal is open (in the middle of a call)
       • auto-call mode is already running
       • the caller dismissed the modal in this session
     Once leads arrive (organic SSE or refill), we reset the dismissed flag
     so the next "queue drained" event can pop it again. */
  useEffect(() => {
    if (leads.length > 0) {
      if (queueEndDismissed) setQueueEndDismissed(false);
      return;
    }
    if (loading || error)         return;
    if (breakInfo || editLead)    return;
    if (autoMode !== 'off')       return;
    if (queueEndOpen)             return;
    if (queueEndDismissed)        return;
    setQueueEndReason('initial_empty');
    setQueueEndOpen(true);
  }, [leads.length, loading, error, breakInfo, editLead, autoMode, queueEndOpen, queueEndDismissed]);

  const filtered = leads;

  const autoActive = autoMode !== 'off';
  const currentAutoLead = autoActive && autoQueue.length ? autoQueue[0] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* On the Call page (callPageMode) the leads table + Start/Stop button are
          hidden — only the engine + the call-note form and alert/break cards
          (overlays below) run, layered over the Call page. */}
      {!callPageMode && (<>
      {/* Auto-dial button — standalone, no card chrome */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, fontFamily: 'Outfit, sans-serif', flexWrap: 'wrap' }}>
        {autoError && (
          <div style={{ fontSize: '0.74rem', color: '#DC2626' }}>⚠ {autoError}</div>
        )}
        {/* Auto-Call is hidden in the admin preview (no telephony there); the
            real caller login still sees it. */}
        {!previewMode && (!autoActive ? (
          <button
            onClick={startAutoMode}
            disabled={!leads.length}
            style={{
              padding: '10px 18px', borderRadius: 50, border: 'none',
              background: leads.length ? '#059669' : 'rgba(5,150,105,0.40)',
              color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.85rem',
              cursor: leads.length ? 'pointer' : 'not-allowed',
              boxShadow: leads.length ? '0 4px 14px rgba(5,150,105,0.30)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start Auto-Call
          </button>
        ) : (
          <button
            onClick={stopAutoMode}
            style={{
              padding: '10px 18px', borderRadius: 50, border: 'none',
              background: '#DC2626', color: '#fff',
              fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.85rem',
              cursor: 'pointer', boxShadow: '0 4px 14px rgba(220,38,38,0.30)',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            Stop Auto-Call
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* Table */}
      <div className="shadow-card" style={{ padding: 0, overflow: 'hidden', background: '#EDEAF8', borderRadius: 8 }}>
        {loading ? (
          <EmptyState>Loading assigned leads…</EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={leads.length === 0 ? 'No leads assigned yet' : 'No matches'}
            subtitle="Your manager will assign leads here. Check back soon."
          />
        ) : (
          <div style={{ background: '#fff', borderRadius: 8 }}>
            <CallerLeadsTable
              leads={filtered}
              onRowClick={previewMode ? undefined : (l) => setEditLead(l)}
              rowRef={(l, el) => { if (el) rowRefs.current[l.id] = el; else delete rowRefs.current[l.id]; }}
              rowStyle={(l) => {
                const followUpDue = l.last_note_outcome === 'follow_up' && l.follow_up_at && new Date(l.follow_up_at) <= new Date();
                return {
                  background: followUpDue
                    ? 'rgba(245,158,11,0.18)'
                    : highlightId === l.id
                      ? 'rgba(91,33,182,0.28)'
                      : 'transparent',
                };
              }}
            />
          </div>
        )}
      </div>
      </>)}

      {editLead && (
        <LeadCallNoteModal
          // Force a fresh modal instance per lead — without this React reuses
          // the same component when editLead changes, leaking phase / refs /
          // dedup history from the previous lead's call into the new one.
          key={`${editLead.id}:${autoSession}`}
          jwt={jwt}
          lead={editLead}
          /* Refresh-restore plumbing. restoreState seeds the modal's
             initial phase / counters / timer when reopening after a
             refresh. onStateChange bubbles every change back up so the
             sessionStorage snapshot stays current. The snapshot is
             passed once on mount (key={editLead.id} guarantees a fresh
             instance) — subsequent state lives in the modal. */
          restoreState={restoredSnapshot && restoredSnapshot.lead_id === editLead.id ? restoredSnapshot : null}
          onStateChange={setModalStateFromChild}
          /* Mood bridge — flip the floating mascot to `thinking` whenever the
             modal lands on a reason card (caller is being asked why a call
             didn't connect or why the form wasn't filled). Return to `idle`
             on every other phase. */
          onPhaseChange={(phase) => {
            if (typeof setMood !== 'function') return;
            if (phase === 'form_reason_card' || phase === 'agent_reason_card') {
              setMood('thinking');
            } else {
              setMood('idle');
            }
          }}
          onClose={() => {
            const wasInAuto = autoMode === 'calling';
            setEditLead(null);
            // Closing modal mid auto-call without saving = caller bailed → exit auto.
            if (wasInAuto) stopAutoMode();
            // Reason-card overlay is gone — drop the mascot back to idle.
            if (typeof setMood === 'function') setMood('idle');
          }}
          onSaved={(outcome, meta) => {
            const finishedLead = editLead;
            setEditLead(null);
            // Drop any restored snapshot — the lead is done, we don't
            // want a subsequent leads-load to re-open it. The snapshot-
            // write effect also fires when editLead → null and removes
            // sessionStorage; this just resets the in-memory restore ref.
            setRestoredSnapshot(null);
            setModalStateFromChild(null);
            const remaining = leads.filter(x => x.id !== finishedLead.id);
            setLeads(remaining);
            // Call just finished (note already persisted by the modal). Tell the
            // status card to refetch NOW so the daily tag tiles + TOUCHED % (and
            // its 100% trophy celebration) update at call-finish — letting the
            // trophy play within the following cooldown instead of lagging a poll.
            try { window.dispatchEvent(new Event('mhs:activity:changed')); } catch { /* no-op */ }
            // Capture the lead tag (HOT/WARM/COLD/JUNK) so the celebration
            // bubble can show the matching message. Stays in state until
            // the next call's save overwrites it.
            setLastCompletedTag(meta?.lead_tag || null);
            // Pick the bubble line + matching audio in one place so they
            // can never drift out of sync. For HOT the pool is
            // `{text,audio}[]`; for other tags it's `string[]` and we
            // fall back to TAG_AUDIO[tag] for the voice clip.
            const tag       = meta?.lead_tag;
            const pool = COOLDOWN_LINES[tag] || COOLDOWN_LINES.DEFAULT;
            const pick = pool[Math.floor(Math.random() * pool.length)];
            setCelebrationLine(pick.text);
            // Play the matching celebration voice clip — preloaded, so it
            // fires instantly. Only for "real" call completions (form was
            // actually filled); skip DNP / auto-paused (not celebratory).
            const REAL_OUTCOMES = new Set(['completed', 'follow_up', 'not_interested']);
            if (REAL_OUTCOMES.has(outcome)) {
              playRobotClip(pick.clip);
            }
            // Call was successfully completed — full-screen celebration
            // (centred bot + confetti) for ~4.5s, then back to idle corner.
            if (typeof setMood === 'function') setMood('happy', t.postCallCelebrationMs);
            // Caller hit X → CloseConfirmDialog OK. We sent
            // outcome:'incomplete' + autoAdvance:false meaning "stop
            // the auto-call right now". Honour that BEFORE both
            // queue paths below.
            if ((outcome === 'incomplete' || outcome === 'auto_paused') && meta?.autoAdvance === false) {
              // 'incomplete' = caller hit X mid-call. 'auto_paused' = the agent
              // reason card / SmartFlow cap blocked the account (is_active=FALSE).
              // Either way STOP the auto-call loop — do not open the next lead.
              // For auto_paused the blocked overlay (driven by the caller.paused
              // SSE) then takes over the screen.
              setAutoMode('off');
              clearAdvanceTimer();
              setAdvanceLeft(0);
              return;
            }
            if (autoMode === 'calling') {
              // Legacy autoMode keeps its own queue
              startCooldown();
              return;
            }
            // Always-on auto-advance after any save.
            // Deadline-anchored (same reason as startCooldown) so the badge
            // visibly runs the full 5 s before the next call is dialed.
            if (meta?.autoAdvance) {
              if (remaining.length === 0) {
                setAdvanceToast('Queue is empty');
                setTimeout(() => setAdvanceToast(''), 4000);
                return;
              }
              const nextLead = remaining[0];
              pendingNextLeadRef.current = nextLead;
              clearAdvanceTimer();
              const deadline = Date.now() + t.autoAdvanceCountdownMs;
              const tick = () => {
                const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
                setAdvanceLeft(left);
                if (left <= 0) {
                  clearAdvanceTimer();
                  setTimeout(() => triggerCallAndOpen(nextLead), 0);
                }
              };
              tick();  // paint "5" immediately
              advanceTimerRef.current = setInterval(tick, COUNTDOWN_TICK_MS);
            }
          }}
        />
      )}

      {/* Between-calls interval choice card — during the auto-advance gap the
          caller can dial now, take a break, or stop the auto-call queue. */}
      {advanceLeft > 0 && (
        <div style={{
          position: 'fixed', top: 18, right: 18, zIndex: 9600,
          background: '#fff', color: '#3B0764',
          padding: '14px 16px', borderRadius: 16, width: 230,
          fontFamily: 'Outfit,sans-serif',
          boxShadow: '0 12px 32px rgba(15,0,40,0.28)',
          border: '1px solid rgba(139,92,246,0.20)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontWeight: 800, fontSize: '0.86rem' }}>Next call in</span>
            <span style={{ fontWeight: 800, fontSize: '1.3rem', color: '#5B21B6', fontVariantNumeric: 'tabular-nums' }}>{advanceLeft}s</span>
          </div>
          <button
            onClick={() => {
              clearAdvanceTimer(); setAdvanceLeft(0);
              if (pendingNextLeadRef.current) { const nl = pendingNextLeadRef.current; pendingNextLeadRef.current = null; triggerCallAndOpen(nl); }
            }}
            style={{ border: 'none', background: '#5B21B6', color: '#fff', padding: '9px 12px', borderRadius: 50,
                     cursor: 'pointer', fontFamily: 'Outfit,sans-serif', fontWeight: 800, fontSize: '0.82rem',
                     boxShadow: '0 4px 12px rgba(91,33,182,0.30)' }}>
            ▶ Continue now
          </button>
          <button
            onClick={() => { clearAdvanceTimer(); setAdvanceLeft(0); setBreakStep('choose'); }}
            style={{ border: '1.5px solid #5B21B6', background: '#fff', color: '#5B21B6', padding: '8px 12px', borderRadius: 50,
                     cursor: 'pointer', fontFamily: 'Outfit,sans-serif', fontWeight: 800, fontSize: '0.82rem' }}>
            ☕ Take a break
          </button>
          <button
            onClick={() => { setAutoMode('off'); clearAdvanceTimer(); setAdvanceLeft(0); pendingNextLeadRef.current = null; }}
            style={{ border: 'none', background: 'transparent', color: 'rgba(220,38,38,0.9)', padding: '4px', borderRadius: 50,
                     cursor: 'pointer', fontFamily: 'Outfit,sans-serif', fontWeight: 800, fontSize: '0.78rem' }}>
            ✕ Stop auto-call
          </button>
        </div>
      )}

      {/* Empty-queue toast */}
      {advanceToast && (
        <div style={{
          position: 'fixed', top: 18, right: 18, zIndex: 9600,
          background: 'rgba(91,33,182,0.95)', color: '#fff',
          padding: '10px 16px', borderRadius: 12,
          fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.86rem',
          boxShadow: '0 8px 24px rgba(91,33,182,0.40)',
        }}>
          ✓ {advanceToast}
        </div>
      )}

      {/* 5-second post-Complete-Call celebration overlay.
          Layers (back → front):
            1. Dim blurred backdrop
            2. Full-viewport confetti
            3. Centered vertical stack: speech-bubble → robot → timer → buttons.
          The speech bubble emerges from above the robot's head with a tail
          pointing down to it. Message text is hardcoded for now — wire to
          real per-call logic later. */}
      {autoMode === 'cooldown' && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9500,
            background: 'rgba(15,0,40,0.55)',
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 16px',
            animation: 'cdFade 200ms ease',
            fontFamily: 'Outfit, sans-serif',
          }}
        >
          <style>{`
            @keyframes cdFade    { from { opacity: 0; } to { opacity: 1; } }
            @keyframes cdPop     { 0% { transform: scale(0.55) translateY(40px); opacity: 0; }
                                   60% { transform: scale(1.06) translateY(0);   opacity: 1; }
                                   100% { transform: scale(1)   translateY(0);   opacity: 1; } }
            @keyframes cdRing    { 0% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: 251.2; } }
            @keyframes cdBubble  { 0%   { transform: scale(0.6) translateY(20px); opacity: 0; }
                                   60%  { transform: scale(1.04) translateY(0);    opacity: 1; }
                                   100% { transform: scale(1)    translateY(0);    opacity: 1; } }
            @keyframes cdBubbleFloat {
              0%   { transform: translateY(0); }
              50%  { transform: translateY(-4px); }
              100% { transform: translateY(0); }
            }
          `}</style>

          {/* Layer 2 — Full-viewport confetti, drawn behind the content stack */}
          <div style={{
            position: 'absolute', inset: 0,
            pointerEvents: 'none',
            zIndex: 0,
          }}>
            <Lottie
              animationData={confettiData}
              loop={false}
              autoplay
              style={{ width: '100%', height: '100%' }}
              rendererSettings={{ preserveAspectRatio: 'xMidYMid slice' }}
            />
          </div>

          <div style={{
            position: 'relative', zIndex: 1,
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 18, textAlign: 'center',
            animation: 'cdPop 480ms cubic-bezier(0.34,1.56,0.64,1) both',
          }}>
            {/* 0 — Speech bubble from the robot's head */}
            <div style={{
              position: 'relative',
              maxWidth: 'min(360px, 80vw)',
              padding: '14px 22px',
              background: '#fff',
              color: '#3B0764',
              borderRadius: 22,
              boxShadow: '0 12px 32px rgba(15,0,40,0.35), 0 2px 8px rgba(15,0,40,0.18)',
              fontWeight: 700, fontSize: '0.98rem', lineHeight: 1.35,
              marginBottom: -10,  // pulls the tail close to the robot's head
              animation: 'cdBubble 520ms cubic-bezier(0.34,1.56,0.64,1) both, cdBubbleFloat 2.6s ease-in-out 600ms infinite',
              animationDelay: '120ms, 740ms',  // bubble pops in slightly after the robot
            }}>
              {/* Read the line that was picked when the call saved — keeps
                  the bubble text perfectly in sync with the voice clip that
                  played, and avoids the line flickering on re-renders. */}
              {celebrationLine || 'Great work — call completed!'}
              {/* Bubble tail — pointed down toward the robot's head */}
              <div style={{
                position: 'absolute',
                bottom: -10, left: '50%',
                width: 0, height: 0,
                transform: 'translateX(-50%)',
                borderLeft:  '12px solid transparent',
                borderRight: '12px solid transparent',
                borderTop:   '12px solid #fff',
                filter: 'drop-shadow(0 4px 4px rgba(15,0,40,0.18))',
              }} />
            </div>

            {/* 1 — Robot. Shrunk from 260 → 180 px so the speech bubble
                above it sits clearly above the robot's head instead of
                being clipped by the head/antenna geometry. The 50vw cap
                keeps it from dominating very small phones. */}
            <div style={{ width: 'min(180px, 50vw)', height: 'min(180px, 50vw)' }}>
              <Lottie
                animationData={happyBotData}
                loop={false}
                autoplay
                style={{ width: '100%', height: '100%' }}
                rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
              />
            </div>

            {/* 2 — Countdown timer ring with the live seconds inside */}
            <div style={{ position: 'relative', width: 96, height: 96 }}>
              <svg width="96" height="96" viewBox="0 0 96 96" style={{ position: 'absolute', inset: 0 }}>
                <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(255,255,255,0.20)" strokeWidth="6"/>
              </svg>
              <svg width="96" height="96" viewBox="0 0 96 96" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
                <circle
                  cx="48" cy="48" r="40"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray="251.2"
                  style={{ animation: 'cdRing 5s linear forwards' }}
                />
              </svg>
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: '2.2rem', color: '#fff',
                textShadow: '0 2px 12px rgba(0,0,0,0.30)',
              }}>
                {cooldownLeft}
              </div>
            </div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', color: '#fff', marginTop: -4 }}>
              Next call in {cooldownLeft}s
            </div>
            <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.80)' }}>
              {autoQueue.length > 1
                ? `Up next: ${autoQueue[1]?.full_name || '—'} (${autoTotal - (autoIndex + 1)} more after this)`
                : 'Last call in this batch'}
            </div>

            {/* 3 — Action buttons */}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                onClick={advanceAutoCall}
                style={{
                  minWidth: 130, height: '2.6rem', padding: '0 22px', borderRadius: 50, border: 'none',
                  background: '#5B21B6', color: '#fff',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                  cursor: 'pointer', boxShadow: '0 6px 20px rgba(91,33,182,0.40)',
                }}
              >
                Skip wait
              </button>
              <button
                onClick={() => {
                  // Opening the break picker must FULLY stop the auto-call: clear
                  // the cooldown timer AND turn autoMode off, otherwise the
                  // cooldown keeps firing advanceAutoCall() in the background
                  // (dialing leads → retry-exhaustion → account auto-pause) and
                  // the cooldown card + its robot stay mounted alongside the
                  // break card (two robots at once).
                  clearCooldownTimer();
                  setCooldownLeft(0);
                  setAutoMode('off');
                  setBreakStep('choose');
                }}
                style={{
                  minWidth: 110, height: '2.6rem', padding: '0 22px', borderRadius: 50,
                  border: '1px solid rgba(255,255,255,0.50)',
                  background: 'rgba(255,255,255,0.10)', color: '#fff',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                  cursor: 'pointer', backdropFilter: 'blur(6px)',
                }}
              >
                Stop
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Break reason picker ── */}
      {breakStep === 'choose' && (
        <>
        {/* Single-column fallback for narrow phones — the 2x2 grid would
            squeeze each button too tight under ~420 px wide. */}
        <style>{`
          @media (max-width: 420px) {
            .break-picker-grid { grid-template-columns: 1fr !important; }
          }
        `}</style>
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9600,
            background: 'rgba(15,0,40,0.55)',
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 2, padding: '0 16px', fontFamily: 'Outfit, sans-serif',
          }}
          onClick={() => { setBreakStep(null); advanceAutoCall(); }}
        >
          {/* Robot guide — invites the break, or switches to the select-nudge
             line once an inactivity strike fires. Bubble text fades after
             10 s; re-shows when a strike changes the line. */}
          <div onClick={e => e.stopPropagation()} style={{
            position: 'relative', background: '#fff', color: '#3B0764',
            padding: '12px 20px', borderRadius: 20, maxWidth: 'min(360px, 88vw)',
            textAlign: 'center', fontWeight: 700, fontSize: '0.92rem', lineHeight: 1.35,
            boxShadow: '0 12px 32px rgba(15,0,40,0.30)', marginBottom: -6,
            opacity: chooseBubbleShown ? 1 : 0,
            transform: chooseBubbleShown ? 'translateY(0)' : 'translateY(-6px)',
            transition: 'opacity 420ms ease, transform 420ms ease',
          }}>
            {breakChooseStrikes > 0
              ? 'ethathu select pannunga nanba'
              : 'enna nanba break ah..... enjoy pannunga'}
            <div style={{
              position: 'absolute', bottom: -9, left: '50%',
              width: 0, height: 0, transform: 'translateX(-50%)',
              borderLeft: '11px solid transparent', borderRight: '11px solid transparent',
              borderTop: '11px solid #fff',
              filter: 'drop-shadow(0 4px 4px rgba(15,0,40,0.18))',
            }} />
          </div>
          <div onClick={e => e.stopPropagation()} style={{ width: 132, height: 132, pointerEvents: 'none' }}>
            <Lottie animationData={happyBotData} loop autoplay
              style={{ width: '100%', height: '100%' }}
              rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }} />
          </div>
          <div onClick={e => e.stopPropagation()} style={{
            // Wider card now that the four break buttons live in a 2x2
            // grid (Tea / Lunch on the left, 2-Hour / Other on the right)
            // instead of a tall single column. Cuts the card's height ~
            // in half so the whole prompt fits on short screens without
            // scrolling.
            width: '100%', maxWidth: 520, background: '#fff', borderRadius: 22,
            padding: '26px 22px', boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.05rem', color: '#3B0764' }}>
                Stopping the auto-call?
              </h3>
              {/* 10-s inactivity countdown — turns red below 4s as a nudge. */}
              <span style={{
                fontFamily: 'ui-monospace, monospace', fontWeight: 800,
                fontSize: '0.86rem', padding: '4px 10px', borderRadius: 50,
                background: breakChooseLeft <= 3
                  ? 'rgba(220,38,38,0.12)' : 'rgba(91,33,182,0.10)',
                color: breakChooseLeft <= 3 ? '#B91C1C' : '#5B21B6',
                whiteSpace: 'nowrap',
              }}>
                00:{String(breakChooseLeft).padStart(2, '0')}
              </span>
            </div>
            <p style={{ margin: '4px 0 14px', fontSize: '0.80rem', color: 'rgba(91,33,182,0.65)' }}>
              Pick a reason — your break time will be set automatically.
            </p>
            {/* Inactivity nudge — appears after the 10-s window expires once.
                Strike 3 stops auto-call silently, so this only renders for
                strikes 1 and 2. */}
            {breakChooseStrikes > 0 && breakChooseStrikes < 3 && (
              <div style={{
                marginBottom: 14, padding: '10px 14px', borderRadius: 8,
                background: 'rgba(254,226,226,0.55)', border: '1px solid rgba(220,38,38,0.30)',
                color: '#991B1B', fontSize: '0.80rem', fontWeight: 600,
              }}>
                Please select an option. {3 - breakChooseStrikes === 1
                  ? 'Next miss stops auto-call.'
                  : `${3 - breakChooseStrikes} chances left before auto-stop.`}
              </div>
            )}
            <div style={{
              // 2x2 grid: Tea + Lunch on the left, 2-Hour + Other on
              // the right. Auto-collapses to a single column under
              // 420 px viewport so phones still get a comfortable tap
              // target.
              display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
            }}
            className="break-picker-grid">
              <button
                onClick={() => { if (!teaExhausted) startBreak('Tea Break', 15); }}
                disabled={teaExhausted}
                style={{
                  height: '3rem', borderRadius: 12, border: '1px solid rgba(180,83,9,0.20)',
                  background: 'rgba(254,243,199,0.50)', color: '#92400E',
                  fontWeight: 700, fontSize: '0.92rem',
                  cursor: teaExhausted ? 'not-allowed' : 'pointer',
                  opacity: teaExhausted ? 0.45 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0 14px',
                }}
              >
                <span>☕ Tea Break</span>
                <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(146,64,14,0.75)' }}>
                  {teaExhausted ? 'Used 2/2 today' : '15 min'}
                </span>
              </button>
              <button
                onClick={() => { if (!lunchExhausted) startBreak('Lunch Break', 45); }}
                disabled={lunchExhausted}
                style={{
                  height: '3rem', borderRadius: 12, border: '1px solid rgba(5,150,105,0.25)',
                  background: 'rgba(209,250,229,0.50)', color: '#065F46',
                  fontWeight: 700, fontSize: '0.92rem',
                  cursor: lunchExhausted ? 'not-allowed' : 'pointer',
                  opacity: lunchExhausted ? 0.45 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0 14px',
                }}
              >
                <span>🍱 Lunch Break</span>
                <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(6,95,70,0.75)' }}>
                  {lunchExhausted ? 'Used 1/1 today' : '45 min'}
                </span>
              </button>
              <button
                onClick={() => { if (!twohrExhausted) startBreak('2 Hour Permission', 120); }}
                disabled={twohrExhausted}
                style={{
                  height: '3rem', borderRadius: 12, border: '1px solid rgba(37,99,235,0.25)',
                  background: 'rgba(219,234,254,0.55)', color: '#1E40AF',
                  fontWeight: 700, fontSize: '0.92rem',
                  cursor: twohrExhausted ? 'not-allowed' : 'pointer',
                  opacity: twohrExhausted ? 0.45 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0 14px',
                }}
              >
                <span>🕑 2-Hour Permission</span>
                <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(30,64,175,0.75)' }}>
                  {twohrExhausted ? 'Used 1/1 today' : '120 min'}
                </span>
              </button>
              <button
                onClick={() => { if (otherMinutesRemaining > 0) setBreakStep('other'); }}
                disabled={otherMinutesRemaining <= 0}
                style={{
                  height: '3rem', borderRadius: 12, border: '1px solid rgba(91,33,182,0.25)',
                  background: 'rgba(237,234,248,0.50)', color: '#5B21B6',
                  fontWeight: 700, fontSize: '0.92rem',
                  cursor: otherMinutesRemaining <= 0 ? 'not-allowed' : 'pointer',
                  opacity: otherMinutesRemaining <= 0 ? 0.45 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0 14px',
                }}
              >
                <span>📝 Other</span>
                <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(91,33,182,0.75)' }}>
                  {otherMinutesRemaining <= 0 ? 'Used 30/30 today' : `${otherMinutesRemaining} min left`}
                </span>
              </button>
            </div>
            <button
              onClick={() => { setBreakStep(null); advanceAutoCall(); }}
              style={{
                width: '100%', marginTop: 14, height: '2.4rem', borderRadius: 8,
                border: 'none', background: 'transparent', color: 'rgba(91,33,182,0.65)',
                fontWeight: 600, fontSize: '0.84rem', cursor: 'pointer',
              }}
            >
              Cancel — keep calling
            </button>
          </div>
        </div>
        </>
      )}

      {/* ── "Other" reason — custom message + minutes ── */}
      {breakStep === 'other' && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9600,
            background: 'rgba(15,0,40,0.55)',
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 2, padding: '0 16px', fontFamily: 'Outfit, sans-serif',
          }}
          onClick={() => setBreakStep('choose')}
        >
          {/* Robot guide — invites the break, switches to the "nanba irukkiya"
             nudge each 30 s; 4 unanswered nudges auto-pause the account. */}
          <div onClick={e => e.stopPropagation()} style={{
            position: 'relative', background: '#fff', color: '#3B0764',
            padding: '12px 20px', borderRadius: 20, maxWidth: 'min(360px, 88vw)',
            textAlign: 'center', fontWeight: 700, fontSize: '0.92rem', lineHeight: 1.35,
            boxShadow: '0 12px 32px rgba(15,0,40,0.30)', marginBottom: -6,
            opacity: otherBubbleShown ? 1 : 0,
            transform: otherBubbleShown ? 'translateY(0)' : 'translateY(-6px)',
            transition: 'opacity 420ms ease, transform 420ms ease',
          }}>
            {otherNudgeCount >= 1
              ? 'nanba irukkukingala reason fill pannunga'
              : 'enna nanba break ah reason sollitu ponga nanba ....'}
            <div style={{
              position: 'absolute', bottom: -9, left: '50%',
              width: 0, height: 0, transform: 'translateX(-50%)',
              borderLeft: '11px solid transparent', borderRight: '11px solid transparent',
              borderTop: '11px solid #fff',
              filter: 'drop-shadow(0 4px 4px rgba(15,0,40,0.18))',
            }} />
          </div>
          <div onClick={e => e.stopPropagation()} style={{ width: 132, height: 132, pointerEvents: 'none' }}>
            <Lottie animationData={happyBotData} loop autoplay
              style={{ width: '100%', height: '100%' }}
              rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }} />
          </div>
          <div onClick={e => e.stopPropagation()} style={{
            width: '100%', maxWidth: 380, background: '#fff', borderRadius: 22,
            padding: '26px 22px', boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
          }}>
            <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.05rem', color: '#3B0764' }}>
              Custom break
            </h3>
            <p style={{ margin: '4px 0 14px', fontSize: '0.80rem', color: 'rgba(91,33,182,0.65)' }}>
              Tell us what you're doing and set how long.
            </p>
            <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#3B0764', marginBottom: 4 }}>
              Reason
            </label>
            <textarea
              value={otherMessage}
              onChange={e => setOtherMessage(e.target.value)}
              placeholder="e.g. Quick personal call"
              rows={2}
              maxLength={120}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 10,
                border: '1px solid rgba(91,33,182,0.20)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem',
                color: '#3B0764', outline: 'none', resize: 'vertical',
                marginBottom: 14, boxSizing: 'border-box',
              }}
            />
            <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#3B0764', marginBottom: 4 }}>
              Duration (minutes)
            </label>
            <input
              type="number"
              min={1}
              max={otherMinutesRemaining}
              value={otherMinutes}
              onChange={e => setOtherMinutes(Math.max(1, Math.min(otherMinutesRemaining, parseInt(e.target.value, 10) || 1)))}
              style={{
                width: '100%', height: '2.6rem', padding: '0 12px', borderRadius: 10,
                border: '1px solid rgba(91,33,182,0.20)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.92rem',
                color: '#3B0764', outline: 'none', marginBottom: 6, boxSizing: 'border-box',
              }}
            />
            <p style={{ margin: '0 0 16px', fontSize: '0.74rem', color: 'rgba(91,33,182,0.60)' }}>
              {otherMinutesRemaining} min left in today&apos;s custom-break pool.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setBreakStep('choose')}
                style={{
                  flex: 1, height: '2.6rem', borderRadius: 10,
                  border: '1px solid rgba(91,33,182,0.20)',
                  background: '#fff', color: '#5B21B6',
                  fontWeight: 700, fontSize: '0.86rem', cursor: 'pointer',
                }}
              >
                Back
              </button>
              <button
                onClick={() => startBreak(otherMessage.trim() || 'Other', otherMinutes, otherMessage.trim())}
                disabled={!otherMinutes || otherMinutes < 1 || otherMinutes > otherMinutesRemaining}
                style={{
                  flex: 1, height: '2.6rem', borderRadius: 10, border: 'none',
                  background: '#5B21B6', color: '#fff',
                  fontWeight: 700, fontSize: '0.86rem',
                  cursor: (otherMinutes >= 1 && otherMinutes <= otherMinutesRemaining) ? 'pointer' : 'not-allowed',
                  opacity: (otherMinutes >= 1 && otherMinutes <= otherMinutesRemaining) ? 1 : 0.5,
                }}
              >
                Start Break
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Queue-end / empty-state refill modal ──
         Pops in two cases (see queueEndReason state):
           • 'initial_empty'  — caller opened the page with zero leads
           • 'auto_finished'  — the auto-call queue just drained
         Buttons hit POST /api/caller/leads/reopen which stamps pinned_at=NOW()
         so the moved leads bubble to the top of the list. */}
      {queueEndOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9600,
            background: 'rgba(15,0,40,0.55)',
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 16px', fontFamily: 'Outfit, sans-serif',
          }}
          onClick={() => {
            if (reopening) return;
            setQueueEndOpen(false);
            setQueueEndDismissed(true);
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{
            width: '100%', maxWidth: 420, background: '#fff', borderRadius: 22,
            padding: '28px 24px', boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
          }}>
            <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 16, background: 'rgba(5,150,105,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </div>
            <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.10rem', color: '#3B0764', textAlign: 'center' }}>
              {queueEndReason === 'auto_finished' ? 'Queue complete' : 'No leads in your queue'}
            </h3>
            <p style={{ margin: '6px 0 18px', fontSize: '0.84rem', color: 'rgba(91,33,182,0.65)', textAlign: 'center' }}>
              You have no leads now. Please contact your team leader to get leads assigned.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                onClick={() => { setQueueEndOpen(false); setQueueEndDismissed(true); }}
                disabled={!!reopening}
                style={{
                  height: '2.4rem', borderRadius: 8, border: 'none',
                  background: 'transparent', color: 'rgba(91,33,182,0.65)',
                  fontWeight: 600, fontSize: '0.84rem',
                  cursor: reopening ? 'wait' : 'pointer', marginTop: 4,
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reopen toast ── */}
      {reopenToast && (
        <div style={{
          position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9500, background: '#fff', borderRadius: 12,
          padding: '10px 16px', boxShadow: '0 8px 24px rgba(91,33,182,0.20)',
          border: '1px solid rgba(91,33,182,0.15)',
          fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', fontWeight: 600,
          color: reopenToast.startsWith('⚠') ? '#DC2626' : '#3B0764',
          maxWidth: 'calc(100vw - 32px)',
        }}>
          {reopenToast}
        </div>
      )}

      {/* ── Active break modal ──
         Big centered card that blocks the page until the caller presses
         Start Auto-Call. No End-break / Cancel — the only way out is to
         resume calls. Survives reloads / logouts via localStorage.
         On the Call page (callPageMode) this full-screen overlay is
         SUPPRESSED — the break shows compactly in the left CallStatsPanel
         banner instead, whose own Start Auto-Call button routes back here
         through the pendingAutoStart flow. */}
      {breakInfo && !callPageMode && (() => {
        const overrun = breakTimeLeft <= 0;
        const fmt = (s) => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
        return (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 9700,
            background: 'rgba(15,0,40,0.65)',
            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 16px', fontFamily: 'Outfit, sans-serif',
          }}>
            <div style={{
              width: '100%', maxWidth: 440, background: '#fff', borderRadius: 24,
              padding: '36px 28px 28px',
              boxShadow: '0 32px 80px rgba(91,33,182,0.40)',
              textAlign: 'center',
            }}>
              <div style={{
                display: 'inline-block', padding: '6px 14px', borderRadius: 50,
                background: overrun ? 'rgba(220,38,38,0.12)' : 'rgba(91,33,182,0.10)',
                color: overrun ? '#B91C1C' : '#5B21B6',
                fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.08em',
                textTransform: 'uppercase', marginBottom: 14,
              }}>
                On {breakInfo.reason}
              </div>
              <div style={{
                fontFamily: 'ui-monospace, monospace',
                fontWeight: 800, fontSize: '2.6rem',
                color: overrun ? '#B91C1C' : '#3B0764',
                lineHeight: 1.05, marginBottom: 6,
              }}>
                {overrun ? fmt(breakElapsed) : fmt(breakTimeLeft)}
              </div>
              <div style={{
                fontSize: '0.78rem', fontWeight: 600,
                color: overrun ? 'rgba(185,28,28,0.85)' : 'rgba(91,33,182,0.65)',
                marginBottom: breakInfo.message ? 6 : 18,
              }}>
                {overrun
                  ? `Break over · ${fmt(breakElapsed - breakInfo.minutes * 60)} overrun`
                  : `of ${breakInfo.minutes} min · elapsed ${fmt(breakElapsed)}`}
              </div>
              {breakInfo.message && (
                <div style={{
                  fontSize: '0.80rem', color: 'rgba(91,33,182,0.70)',
                  marginBottom: 18, padding: '8px 12px',
                  background: 'rgba(237,234,248,0.50)', borderRadius: 8,
                }}>
                  {breakInfo.message}
                </div>
              )}
              <div style={{
                fontSize: '0.80rem', color: 'rgba(91,33,182,0.65)',
                marginBottom: 20, lineHeight: 1.45,
              }}>
                Auto-call is paused. The break clock keeps running even if you
                close this tab or sign out — only <b>Start Auto-Call</b> ends it.
              </div>
              <button
                onClick={endBreakAndStartAutoCall}
                disabled={!leads.length}
                title={!leads.length ? 'Waiting for assigned leads to load…' : undefined}
                style={{
                  width: '100%', height: '3rem', borderRadius: 50, border: 'none',
                  background: leads.length ? '#059669' : 'rgba(5,150,105,0.40)',
                  color: '#fff', fontFamily: 'Outfit,sans-serif',
                  fontWeight: 800, fontSize: '0.95rem',
                  cursor: leads.length ? 'pointer' : 'not-allowed',
                  boxShadow: leads.length ? '0 6px 18px rgba(5,150,105,0.35)' : 'none',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Start Auto-Call
              </button>
              {!leads.length && (
                <div style={{
                  marginTop: 10, fontSize: '0.72rem',
                  color: 'rgba(91,33,182,0.55)',
                }}>
                  No assigned leads loaded yet — they'll appear once the page finishes loading.
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── "Why late?" reason card — shown when the caller resumes MORE
         than 10 min over their break. Robot asks why; re-nudges
         "nanba irukkiya" every 30 s until a reason is submitted. The
         reason is recorded for the admin (POST /api/caller/late-reason). */}
      {lateReasonStep === 'ask' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9750,
          background: 'rgba(15,0,40,0.65)',
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 2, padding: '0 16px', fontFamily: 'Outfit, sans-serif',
        }}>
          <div style={{
            position: 'relative', background: '#fff', color: '#3B0764',
            padding: '12px 20px', borderRadius: 20, maxWidth: 'min(380px, 88vw)',
            textAlign: 'center', fontWeight: 700, fontSize: '0.92rem', lineHeight: 1.35,
            boxShadow: '0 12px 32px rgba(15,0,40,0.30)', marginBottom: -6,
            opacity: lateBubbleShown ? 1 : 0,
            transform: lateBubbleShown ? 'translateY(0)' : 'translateY(-6px)',
            transition: 'opacity 420ms ease, transform 420ms ease',
          }}>
            {lateNudgeCount >= 1
              ? 'nanba irukkiya'
              : 'ennachu nanba why late ethachu praachanaya'}
            <div style={{
              position: 'absolute', bottom: -9, left: '50%',
              width: 0, height: 0, transform: 'translateX(-50%)',
              borderLeft: '11px solid transparent', borderRight: '11px solid transparent',
              borderTop: '11px solid #fff',
              filter: 'drop-shadow(0 4px 4px rgba(15,0,40,0.18))',
            }} />
          </div>
          <div style={{ width: 132, height: 132, pointerEvents: 'none' }}>
            <Lottie animationData={happyBotData} loop autoplay
              style={{ width: '100%', height: '100%' }}
              rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }} />
          </div>
          <div style={{
            width: '100%', maxWidth: 400, background: '#fff', borderRadius: 22,
            padding: '24px 22px', boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
          }}>
            <div style={{
              display: 'inline-block', padding: '4px 11px', borderRadius: 50,
              background: 'rgba(220,38,38,0.12)', color: '#B91C1C',
              fontSize: '0.72rem', fontWeight: 800, marginBottom: 10,
            }}>
              {Math.floor(lateOverBySec / 60)}m {lateOverBySec % 60}s over break
            </div>
            <textarea
              value={lateReasonText}
              onChange={e => setLateReasonText(e.target.value)}
              placeholder="What held you up?"
              autoFocus rows={3} maxLength={300}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 12,
                border: '1px solid rgba(91,33,182,0.25)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764',
                outline: 'none', resize: 'vertical', boxSizing: 'border-box', marginBottom: 14,
              }}
            />
            <button
              onClick={submitLateReason}
              disabled={!lateReasonText.trim()}
              style={{
                width: '100%', height: '2.8rem', borderRadius: 50, border: 'none',
                background: lateReasonText.trim() ? '#059669' : 'rgba(5,150,105,0.40)',
                color: '#fff', fontWeight: 800, fontSize: '0.92rem',
                cursor: lateReasonText.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              Submit &amp; resume calling
            </button>
          </div>
        </div>
      )}

      {/* ── Resume-message robot flash (auto-clears after 7 s) ──
         On the Call page (callPageMode) the corner robot is suppressed and the
         line is routed to CallModule's center robot instead (see the effect
         that calls onRobotMessage above). */}
      {/* Only when truly idle — never while a call modal, break card/picker or
          cooldown is showing, so two robots can't animate at once. */}
      {!callPageMode && resumeRobotPulse > 0 && !editLead && breakStep === null && !breakInfo && autoMode === 'off' && (
        <RobotGuide
          variant="corner"
          mood="happy"
          text="enna nanba break ah enjoy panningala vaanga call start pannalam"
          audioSrc={ROBOT_CLIP[42]}
          pulse={resumeRobotPulse}
          bubbleHideMs={6000}
        />
      )}

      {/* ── Idle nudge robot — appears only after the first 30 s window
         (idleNudgeCount >= 1), so it does NOT speak the moment the caller
         opens the page; then re-asks every 30 s, 5 misses auto-pause.
         Suppressed on the Call page — CallModule's center robot owns idle. ── */}
      {!callPageMode && idleActive && idleNudgeCount >= 1 && (
        <RobotGuide
          variant="corner"
          text="enna nanba call start pannalaya"
          audioSrc={ROBOT_CLIP[41]}
          pulse={idleNudgeCount}
          bubbleHideMs={10000}
        />
      )}
    </div>
  );
}

/* ── Subcomponents ── */

const CALL_STATUS_BADGE = {
  initiated: { bg: '#EDE9FE', fg: '#5B21B6', label: 'Calling…' },
  ringing:   { bg: '#FEF3C7', fg: '#92400E', label: 'Ringing'  },
  answered:  { bg: '#DBEAFE', fg: '#1D4ED8', label: 'On call'  },
  ended:     { bg: '#DCFCE7', fg: '#166534', label: 'Ended'    },
  missed:    { bg: '#FEE2E2', fg: '#B91C1C', label: 'Missed'   },
  failed:    { bg: '#FEE2E2', fg: '#B91C1C', label: 'Failed'   },
};

function fmtDuration(sec) {
  if (sec == null) return null;
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

/* Renders the "Last Call" cell: status pill + recording link when available. */
function CallStatusCell({ lead, jwt }) {
  const status = lead.last_call_status;
  if (!status) {
    return <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.40)' }}>—</span>;
  }
  const badge = CALL_STATUS_BADGE[status] || { bg: '#F3F4F6', fg: '#4B5563', label: status };
  const dur = fmtDuration(lead.last_call_duration);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <span style={badgeStyle(badge)}>{badge.label}{dur ? ` · ${dur}` : ''}</span>
      {lead.last_call_recording_url && lead.last_call_id && (
        <a
          href={`/api/caller/recordings/${lead.last_call_id}?token=${encodeURIComponent(jwt)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: '0.74rem', color: '#5B21B6', textDecoration: 'none', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          Recording
        </a>
      )}
    </div>
  );
}

function RowActions({ lead, jwt, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  const startCall = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/caller/calls/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.message || data?.error || 'Failed to start call';
        throw new Error(msg);
      }
      if (data.stubbed) {
        setErr('Stub mode — Tata credentials not set');
        setTimeout(() => setErr(''), 4000);
      }
      // Real status arrives via SSE call.update; nothing else to do here.
    } catch (e) {
      setErr(e.message || 'Call failed');
      setTimeout(() => setErr(''), 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', position: 'relative' }}>
      <IconBtn
        onClick={lead.whatsapp_number ? startCall : null}
        color="#5B21B6"
        title={lead.whatsapp_number ? 'Call via Smartflo' : 'No phone number'}
        disabled={busy}
      >
        {busy ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" opacity="0.25" />
            <path d="M22 12a10 10 0 0 1-10 10">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/>
            </path>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z"/>
          </svg>
        )}
      </IconBtn>
      <IconBtn onClick={onEdit} color="#5B21B6" title="Fill call note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9"/>
          <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z"/>
        </svg>
      </IconBtn>
      {err && (
        <span style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4,
          background: '#FEE2E2', color: '#B91C1C', borderRadius: 6, padding: '2px 8px',
          fontSize: '0.70rem', fontWeight: 600, whiteSpace: 'nowrap',
        }}>{err}</span>
      )}
    </div>
  );
}

function IconBtn({ href, onClick, color, title, children, disabled }) {
  const interactive = !disabled && !!(href || onClick);
  const common = {
    width: 30, height: 30, borderRadius: 8,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: '#fff', border: `1px solid ${color}33`, color,
    cursor: interactive ? 'pointer' : 'not-allowed',
    opacity: interactive ? 1 : 0.4,
    textDecoration: 'none',
    padding: 0,
    font: 'inherit',
  };
  if (href && !disabled) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} style={common}>
        {children}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} style={common} disabled={!!disabled}>
        {children}
      </button>
    );
  }
  return <span style={common} title={title}>{children}</span>;
}

function EmptyState({ title, subtitle, children }) {
  return (
    <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
      {children
        ? <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>{children}</div>
        : <>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>{title}</div>
            {subtitle && <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem' }}>{subtitle}</div>}
          </>
      }
    </div>
  );
}

/* ── Styles ── */

const thStyle = {
  padding: '12px 16px',
  fontSize: '0.72rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#fff',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '14px 16px',
  fontSize: '0.86rem',
  color: '#3B0764',
  verticalAlign: 'middle',
};

function badgeStyle(badge) {
  return {
    display: 'inline-block', padding: '3px 10px', borderRadius: 50,
    fontSize: '0.72rem', fontWeight: 700,
    background: badge.bg, color: badge.fg,
    whiteSpace: 'nowrap',
  };
}
