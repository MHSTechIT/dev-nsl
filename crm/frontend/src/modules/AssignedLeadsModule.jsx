import { useState, useEffect, useCallback, useRef } from 'react';
import Lottie from 'lottie-react';
import LeadCallNoteModal from './LeadCallNoteModal';
import happyBotRaw     from '../assets/bot/robot-happy.json';
import confettiData    from '../assets/bot/confetti.json';
import { lockArmsDown, normalizeLoop } from '../utils/patchRobotArm';
import { emitCallerState } from '../utils/callerActivity';
// Tag-specific celebration audio. Played alongside the speech-bubble line.
import hotLeadMp3   from '../assets/audio/hot-lead.mp3';
import warmLeadMp3  from '../assets/audio/warm-lead.mp3';
import coldLeadMp3  from '../assets/audio/cold-lead.mp3';
import junkLeadMp3  from '../assets/audio/junk-lead.mp3';
import noTagMp3     from '../assets/audio/no-tag.mp3';
// HOT lead has 4 paired voice clips (h1..h4) — each one matches the
// matching bubble line in COOLDOWN_LINES.HOT below, so the caller hears
// the same sentence they read.
import hotH1Mp3     from '../assets/audio/hot/h1.mp3';
import hotH2Mp3     from '../assets/audio/hot/h2.mp3';
import hotH3Mp3     from '../assets/audio/hot/h3.mp3';
import hotH4Mp3     from '../assets/audio/hot/h4.mp3';
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
    {
      text:  'hot lead secured nanba! un vibe customer ku direct ah connect aagiduchu va next call ah yum mass ah close pannalam',
      audio: hotH1Mp3,
    },
    {
      text:  'semma handling nanba! hot lead ready ah hook aagiduchu va next conversational innum mass katalam',
      audio: hotH2Mp3,
    },
    {
      text:  'nee pesuna vibe vera level nanba leads um intrestku vanthiruchu ippo next call poitu streak continue pannalam',
      audio: hotH3Mp3,
    },
    {
      text:  'un voice ku customer straight ah connect aagitanga nanba come on next call waiting kalakuvom',
      audio: hotH4Mp3,
    },
  ],
  WARM: [
    "Hey buddy, you got a Warm Lead! Keep the conversation going!",
    "Warm lead in hand — one more push and it's HOT!",
    "Nice — warm lead. Follow up sema-a panna, deal close pannalaam!",
    "Warm one captured! Keep the heat building!",
    "Patience-um effort-um pay aagum. Nalla warm lead!",
    "Warm catch boss — followup vechukinga, deal varum!",
  ],
  COLD: [
    "Hey buddy, you got a Cold Lead! Don't worry, every call matters!",
    "Cold lead's okay — every call is practice for the next big one!",
    "Adho oru cold lead. Parava illa, motha effort-um count aagum!",
    "Cold one — move on, hot lead waiting right after!",
    "Cold lead, no stress. Next call could be the big one!",
    "Every dial-um experience. Cold today, hot tomorrow!",
  ],
  JUNK: [
    "Hey buddy, this one looks like a Junk Lead! Let's move to the next win!",
    "Junk lead spotted! Filter pannitu next-ku po!",
    "Junk! Time pazhakidaadhe — next call ready-a iruga!",
    "Junk one — adhu pochu pochu. Hot lead waiting up next!",
    "Junk lead aana parava illa — pure focus, gold-um varum!",
  ],
  // Fallback for outcomes without a tag (not_picked, auto_paused, etc.)
  DEFAULT: [
    "Great work — call completed!",
    "Boss work! Mass-a finish pannitu next move!",
    "Sema effort! Next lead-um waiting for you!",
    "One down — keep the rhythm going!",
    "Call complete! On to the next opportunity!",
    "Nicely handled. Next-ku ready-aagu!",
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

export default function AssignedLeadsModule({ jwt, externalHighlightId, setMood, pendingAutoStart, clearPendingAutoStart }) {
  const [leads, setLeads]         = useState([]);
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
  const [autoQueue, setAutoQueue]       = useState([]);
  const [autoIndex, setAutoIndex]       = useState(0);
  const [autoTotal, setAutoTotal]       = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [autoError, setAutoError]       = useState('');
  const cooldownTimerRef = useRef(null);
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
  const [otherMinutes, setOtherMinutes]   = useState(10);
  const breakTimerRef = useRef(null);

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

  /* Granular activity emitter — VIEWING_LEAD when the call-note modal opens,
     BREAK_PICKER / BREAK_OTHER_PICKER for the break-reason flow. Each useEffect
     fires a `replace` so the admin Activity Log shows one row at a time:
     ON_PAGE_ASSIGNED → VIEWING_LEAD → ON_CALL (server-side) → AFTER_CALL_FORM
     (LeadCallNoteModal) → ON_PAGE_ASSIGNED again.

     We track the previous value via a ref so the first paint with null state
     doesn't double-emit on top of CallerShell's page-level emit. */
  const prevEditLeadIdRef = useRef(null);
  useEffect(() => {
    if (!jwt) return;
    const curId = editLead?.id || null;
    const prevId = prevEditLeadIdRef.current;
    if (curId && curId !== prevId) {
      emitCallerState(jwt, {
        action: 'replace',
        tag: 'VIEWING_LEAD',
        context: { lead_name: editLead.full_name, lead_id: editLead.id },
      });
    } else if (!curId && prevId) {
      // Modal closed — return to the Assigned Leads page row in the timeline.
      emitCallerState(jwt, { action: 'replace', tag: 'ON_PAGE_ASSIGNED' });
    }
    prevEditLeadIdRef.current = curId;
  }, [editLead, jwt]);

  const prevBreakStepRef = useRef(null);
  useEffect(() => {
    if (!jwt) return;
    const prev = prevBreakStepRef.current;
    if (breakStep === 'choose' && prev !== 'choose') {
      emitCallerState(jwt, { action: 'replace', tag: 'BREAK_PICKER' });
    } else if (breakStep === 'other' && prev !== 'other') {
      emitCallerState(jwt, { action: 'replace', tag: 'BREAK_OTHER_PICKER' });
    } else if (breakStep === null && (prev === 'choose' || prev === 'other')) {
      // Picker closed — return to page state. The heartbeat poll will pick
      // up an actual BREAK if the caller selected a reason. We do NOT emit
      // BREAK here because BREAK lives outside the modal/page sweep list,
      // and the heartbeat owns its lifecycle.
      emitCallerState(jwt, { action: 'replace', tag: 'ON_PAGE_ASSIGNED' });
    }
    prevBreakStepRef.current = breakStep;
  }, [breakStep, jwt]);

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

  async function triggerCall(lead) {
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

     If the call POST fails, we still open the modal — the user can retry
     via the Start Auto Call button — but with last_call_id explicitly
     null so the modal stays at idle (no stale id leaking in). */
  async function triggerCallAndOpen(lead, errorSetter) {
    try {
      const data = await triggerCall(lead);
      setEditLead({ ...lead, last_call_id: data?.call_id || null });
    } catch (e) {
      (errorSetter || setError)(e.message || 'Call failed');
      setEditLead({ ...lead, last_call_id: null });
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

  function stopAutoMode() {
    clearCooldownTimer();
    setAutoMode('off');
    setAutoQueue([]);
    setAutoIndex(0);
    setAutoTotal(0);
    setCooldownLeft(0);
    setAutoError('');
  }

  /* 10-s inactivity countdown for the break-picker card. Deadline-anchored
     for the same StrictMode-safety reasons as the cooldown / advance timers.
     On expiry: increment strike count; if < 3, restart for another 10 s with
     an inline nudge visible; on the 3rd strike, stop auto-call and close
     the modal. */
  function startBreakChooseTimer() {
    clearBreakChooseTimer();
    const deadline = Date.now() + 10000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setBreakChooseLeft(left);
      if (left <= 0) {
        clearBreakChooseTimer();
        const next = breakChooseStrikesRef.current + 1;
        breakChooseStrikesRef.current = next;
        setBreakChooseStrikes(next);
        if (next >= 3) {
          setBreakStep(null);
          stopAutoMode();
        } else {
          startBreakChooseTimer();
        }
      }
    };
    tick();  // paint "10" immediately
    breakChooseTimerRef.current = setInterval(tick, 250);
  }

  /* Stop the auto-call AND start a break with a countdown banner. The
     existing stopAutoMode() guarantees no further calls will trigger
     until the caller manually presses Start Auto-Call again. */
  function startBreak(reason, minutes, message = '') {
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
    setOtherMinutes(10);
    try { localStorage.setItem(breakStorageKey, JSON.stringify(info)); } catch { /* quota / sandbox */ }
  }
  /* End the break and (if possible) immediately kick off auto-call. Only
     called from the in-modal "Start Auto-Call" button — there is no
     standalone "End break" anywhere else, by design. */
  function endBreakAndStartAutoCall() {
    setBreakInfo(null);
    setBreakTimeLeft(0);
    setBreakElapsed(0);
    if (breakTimerRef.current) {
      clearInterval(breakTimerRef.current);
      breakTimerRef.current = null;
    }
    try { localStorage.removeItem(breakStorageKey); } catch { /* sandbox */ }
    if (leads.length) {
      startAutoMode();
    }
    // If no leads loaded yet (e.g., right after a tab restore), the modal
    // closes and the page's Start Auto-Call button takes over once leads
    // arrive — the caller is back in normal manual mode.
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
      setTimeout(() => setReopenToast(''), 4000);
    } catch (e) {
      setReopenToast('⚠ ' + (e.message || 'Reopen failed'));
      setTimeout(() => setReopenToast(''), 4000);
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
    const payload = { status, break: breakPayload, updatedAt: Date.now() };
    try { localStorage.setItem(activityStorageKey, JSON.stringify(payload)); } catch { /* sandbox */ }
    try { window.dispatchEvent(new CustomEvent('mhs:activity:changed', { detail: payload })); } catch { /* no-op */ }
  }, [editLead, autoMode, breakInfo, activityStorageKey]);

  function startAutoMode() {
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
    const queue = [...arr];          // snapshot of the fresh list
    setAutoQueue(queue);
    setAutoIndex(0);
    setAutoTotal(queue.length);
    setAutoError('');
    setAutoMode('calling');
    const first = queue[0];
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
    setAutoQueue(prev => {
      const remaining = prev.slice(1);
      if (remaining.length === 0) {
        // Reached the end of the queue — pop the refill modal so the caller
        // can pull DNP / Missed-Call rows back to the top in one click
        // instead of leaving them stranded in other tabs.
        setAutoMode('off');
        setAutoIndex(0);
        setAutoTotal(0);
        setQueueEndReason('auto_finished');
        setQueueEndDismissed(false);
        setQueueEndOpen(true);
        return [];
      }
      const next = remaining[0];
      setAutoIndex(i => i + 1);
      setAutoMode('calling');
      setAutoError('');
      triggerCallAndOpen(next, setAutoError);
      return remaining;
    });
  }

  /* Kick off the 5-second card after Complete Call.

     Deadline-anchored: each tick computes remaining seconds from Date.now()
     against a fixed deadline. This survives React StrictMode's double-invoke
     of state updaters (which would otherwise fire the "prev <= 1" side-effect
     branch twice — clearing the timer + advancing the call before the full
     5 s have elapsed). Wall-clock duration is now guaranteed. */
  function startCooldown() {
    clearCooldownTimer();
    const deadline = Date.now() + 5000;
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
    cooldownTimerRef.current = setInterval(tick, 250);
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
    // Don't override an already-running auto session.
    if (autoMode !== 'off') {
      if (typeof clearPendingAutoStart === 'function') clearPendingAutoStart();
      return;
    }
    startAutoMode();
    if (typeof clearPendingAutoStart === 'function') clearPendingAutoStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoStart, loading, leads.length, autoMode]);

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

  /* Auto-refetch every 60s so leads with `follow_up_at` due appear at the top
     without a manual refresh. */
  useEffect(() => {
    if (!jwt) return;
    const t = setInterval(() => fetchLeads(), 60000);
    return () => clearInterval(t);
  }, [jwt, fetchLeads]);

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
          // Next-Batch promotions (admin started a new batch — parked leads
          // come back as overdue follow-ups). The SSE payload only carries
          // {id, promoted_from:'next_batch'} so we can't optimistically merge.
          // Do a full refetch — the backend sort places overdue follow-ups
          // at the very TOP, so the promoted leads land at row 0..N.
          if (msg.lead.promoted_from === 'next_batch') {
            fetchLeads();
            setHighlight(msg.lead.id);
            setTimeout(() => setHighlight(h => h === msg.lead.id ? null : h), 3000);
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
          setTimeout(() => setHighlight(h => h === msg.lead.id ? null : h), 2500);
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
  }, [jwt]);

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
      {/* Auto-dial button — standalone, no card chrome */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, fontFamily: 'Outfit, sans-serif', flexWrap: 'wrap' }}>
        {autoError && (
          <div style={{ fontSize: '0.74rem', color: '#DC2626' }}>⚠ {autoError}</div>
        )}
        {!autoActive ? (
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
        )}
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
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: '#5B21B6', textAlign: 'left' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>Sugar</th>
                  <th style={thStyle}>Webinar</th>
                  <th style={thStyle}>Registered</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(l => {
                  const sugar = SUGAR_BADGE[l.sugar_level] || { bg: '#F3F4F6', fg: '#4B5563' };
                  const followUpDue = l.last_note_outcome === 'follow_up'
                                   && l.follow_up_at
                                   && new Date(l.follow_up_at) <= new Date();
                  return (
                    <tr key={l.id}
                      ref={el => { if (el) rowRefs.current[l.id] = el; else delete rowRefs.current[l.id]; }}
                      style={{
                      borderTop: '1px solid rgba(91,33,182,0.18)',
                      background: followUpDue
                        ? 'rgba(245,158,11,0.18)'
                        : highlightId === l.id
                          ? 'rgba(91,33,182,0.28)'
                          : 'transparent',
                      transition: 'background 800ms ease',
                    }}>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, color: '#3B0764' }}>{l.full_name || '—'}</span>
                          {followUpDue && (
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: 50,
                              background: 'rgba(245,158,11,0.18)', color: '#B45309',
                              fontSize: '0.66rem', fontWeight: 700,
                              textTransform: 'uppercase', letterSpacing: '0.04em',
                              whiteSpace: 'nowrap',
                            }}>
                              Follow-up due
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{l.email || '—'}</div>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.80rem' }}>
                        {fmtPhone(l.whatsapp_number)}
                      </td>
                      <td style={tdStyle}>
                        <span style={badgeStyle(sugar)}>{l.sugar_level || '—'}</span>
                      </td>
                      <td style={{ ...tdStyle, fontSize: '0.82rem', color: '#3B0764', fontWeight: 600 }}>
                        {l.webinar_name || '—'}
                      </td>
                      <td style={{ ...tdStyle, fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)' }}>
                        {fmtDate(l.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editLead && (
        <LeadCallNoteModal
          // Force a fresh modal instance per lead — without this React reuses
          // the same component when editLead changes, leaking phase / refs /
          // dedup history from the previous lead's call into the new one.
          key={editLead.id}
          jwt={jwt}
          lead={editLead}
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
            const remaining = leads.filter(x => x.id !== finishedLead.id);
            setLeads(remaining);
            // Capture the lead tag (HOT/WARM/COLD/JUNK) so the celebration
            // bubble can show the matching message. Stays in state until
            // the next call's save overwrites it.
            setLastCompletedTag(meta?.lead_tag || null);
            // Pick the bubble line + matching audio in one place so they
            // can never drift out of sync. For HOT the pool is
            // `{text,audio}[]`; for other tags it's `string[]` and we
            // fall back to TAG_AUDIO[tag] for the voice clip.
            const tag       = meta?.lead_tag;
            const pool      = COOLDOWN_LINES[tag] || COOLDOWN_LINES.DEFAULT;
            const pick      = pool[Math.floor(Math.random() * pool.length)];
            const pickText  = typeof pick === 'string' ? pick : pick.text;
            const pickAudio = typeof pick === 'string'
              ? (TAG_AUDIO[tag] || noTagMp3)
              : pick.audio;
            setCelebrationLine(pickText);
            // Play tag-specific celebration audio — only for "real" call
            // completions (form was actually filled). Skip DNP / auto-paused
            // since those aren't celebratory moments.
            const REAL_OUTCOMES = new Set(['completed', 'follow_up', 'not_interested']);
            if (REAL_OUTCOMES.has(outcome)) {
              try {
                const audio = new Audio(pickAudio);
                audio.volume = 0.85;
                // .play() returns a promise that rejects if autoplay is
                // blocked (no user gesture). The Complete-Call button IS a
                // user gesture in the same task, so this almost always
                // resolves — but swallow errors either way.
                audio.play().catch(() => {});
              } catch { /* sandboxed env / no Audio API */ }
            }
            // Call was successfully completed — full-screen celebration
            // (centred bot + confetti) for ~4.5s, then back to idle corner.
            if (typeof setMood === 'function') setMood('happy', 4500);
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
              clearAdvanceTimer();
              const deadline = Date.now() + 5000;
              const tick = () => {
                const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
                setAdvanceLeft(left);
                if (left <= 0) {
                  clearAdvanceTimer();
                  setTimeout(() => triggerCallAndOpen(nextLead), 0);
                }
              };
              tick();  // paint "5" immediately
              advanceTimerRef.current = setInterval(tick, 250);
            }
          }}
        />
      )}

      {/* Always-on auto-advance: 5-sec countdown badge (top-right) */}
      {advanceLeft > 0 && (
        <div style={{
          position: 'fixed', top: 18, right: 18, zIndex: 9600,
          background: 'rgba(91,33,182,0.95)', color: '#fff',
          padding: '10px 16px', borderRadius: 50,
          fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.86rem',
          boxShadow: '0 8px 24px rgba(91,33,182,0.40)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>Next call in {advanceLeft}s</span>
          <button
            onClick={() => { clearAdvanceTimer(); setAdvanceLeft(0); }}
            style={{ border: 'none', background: 'rgba(255,255,255,0.20)', color: '#fff',
                     padding: '3px 10px', borderRadius: 50, cursor: 'pointer',
                     fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.74rem' }}>
            Stop
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
                onClick={() => { clearCooldownTimer(); setCooldownLeft(0); setBreakStep('choose'); }}
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
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9600,
            background: 'rgba(15,0,40,0.55)',
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 16px', fontFamily: 'Outfit, sans-serif',
          }}
          onClick={() => setBreakStep(null)}
        >
          <div onClick={e => e.stopPropagation()} style={{
            width: '100%', maxWidth: 380, background: '#fff', borderRadius: 22,
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                onClick={() => startBreak('Tea Break', 15)}
                style={{
                  height: '3rem', borderRadius: 12, border: '1px solid rgba(180,83,9,0.20)',
                  background: 'rgba(254,243,199,0.50)', color: '#92400E',
                  fontWeight: 700, fontSize: '0.92rem', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0 14px',
                }}
              >
                <span>☕ Tea Break</span>
                <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(146,64,14,0.75)' }}>15 min</span>
              </button>
              <button
                onClick={() => startBreak('Lunch Break', 45)}
                style={{
                  height: '3rem', borderRadius: 12, border: '1px solid rgba(5,150,105,0.25)',
                  background: 'rgba(209,250,229,0.50)', color: '#065F46',
                  fontWeight: 700, fontSize: '0.92rem', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0 14px',
                }}
              >
                <span>🍱 Lunch Break</span>
                <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(6,95,70,0.75)' }}>45 min</span>
              </button>
              <button
                onClick={() => setBreakStep('other')}
                style={{
                  height: '3rem', borderRadius: 12, border: '1px solid rgba(91,33,182,0.25)',
                  background: 'rgba(237,234,248,0.50)', color: '#5B21B6',
                  fontWeight: 700, fontSize: '0.92rem', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0 14px',
                }}
              >
                <span>📝 Other</span>
                <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(91,33,182,0.75)' }}>Custom</span>
              </button>
            </div>
            <button
              onClick={() => setBreakStep(null)}
              style={{
                width: '100%', marginTop: 14, height: '2.4rem', borderRadius: 8,
                border: 'none', background: 'transparent', color: 'rgba(91,33,182,0.65)',
                fontWeight: 600, fontSize: '0.84rem', cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── "Other" reason — custom message + minutes ── */}
      {breakStep === 'other' && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9600,
            background: 'rgba(15,0,40,0.55)',
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 16px', fontFamily: 'Outfit, sans-serif',
          }}
          onClick={() => setBreakStep('choose')}
        >
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
              max={240}
              value={otherMinutes}
              onChange={e => setOtherMinutes(Math.max(1, Math.min(240, parseInt(e.target.value, 10) || 1)))}
              style={{
                width: '100%', height: '2.6rem', padding: '0 12px', borderRadius: 10,
                border: '1px solid rgba(91,33,182,0.20)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.92rem',
                color: '#3B0764', outline: 'none', marginBottom: 18, boxSizing: 'border-box',
              }}
            />
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
                disabled={!otherMinutes || otherMinutes < 1}
                style={{
                  flex: 1, height: '2.6rem', borderRadius: 10, border: 'none',
                  background: '#5B21B6', color: '#fff',
                  fontWeight: 700, fontSize: '0.86rem',
                  cursor: (otherMinutes >= 1) ? 'pointer' : 'not-allowed',
                  opacity: (otherMinutes >= 1) ? 1 : 0.5,
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
              {queueEndReason === 'auto_finished'
                ? 'Will you take any more calls? Add some from a bucket below and we’ll start auto-calling right away.'
                : 'Your Assigned page is empty. Pull leads from another bucket and we’ll start auto-calling right away.'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                onClick={() => reopenFrom('missed')}
                disabled={!!reopening}
                style={{
                  height: '2.9rem', borderRadius: 12, border: 'none',
                  background: reopening === 'missed' ? 'rgba(91,33,182,0.45)' : '#5B21B6',
                  color: '#fff', fontWeight: 700, fontSize: '0.92rem',
                  cursor: reopening ? 'wait' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  boxShadow: '0 4px 14px rgba(91,33,182,0.30)',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
                {reopening === 'missed' ? 'Moving…' : 'Missed Calls'}
              </button>
              <button
                onClick={() => reopenFrom('dnp')}
                disabled={!!reopening}
                style={{
                  height: '2.9rem', borderRadius: 12,
                  border: '1px solid rgba(91,33,182,0.25)',
                  background: reopening === 'dnp' ? 'rgba(237,234,248,0.80)' : '#fff',
                  color: '#5B21B6', fontWeight: 700, fontSize: '0.92rem',
                  cursor: reopening ? 'wait' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)"/>
                  <line x1="2" y1="22" x2="22" y2="2"/>
                </svg>
                {reopening === 'dnp' ? 'Moving…' : 'Not Picked (DNP)'}
              </button>
              <button
                onClick={() => reopenFrom('untouched')}
                disabled={!!reopening}
                title="Coming soon — the Untouched bucket definition is pending."
                style={{
                  height: '2.9rem', borderRadius: 12,
                  border: '1px dashed rgba(91,33,182,0.30)',
                  background: reopening === 'untouched' ? 'rgba(237,234,248,0.80)' : '#fff',
                  color: 'rgba(91,33,182,0.65)', fontWeight: 700, fontSize: '0.92rem',
                  cursor: reopening ? 'wait' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {reopening === 'untouched' ? 'Checking…' : 'Untouched (soon)'}
              </button>
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
         resume calls. Survives reloads / logouts via localStorage. */}
      {breakInfo && (() => {
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
