import { useState, useEffect, useRef, useMemo } from 'react';
import Lottie from 'lottie-react';
import DateTimePicker from '../admin/DateTimePicker';
import LeadTagBadge from '../components/LeadTagBadge';
import { classifyLeadTag } from '../utils/leadTagging';
// One robot everywhere — the same robot-idle.json the Call page uses.
// (Kept the `sadBot*` names to avoid churn; it's the idle robot now.)
import sadBotRaw from '../assets/bot/robot-idle.json';
import { lockArmsDown, normalizeLoop } from '../utils/patchRobotArm';
import pickTheCallMp3 from '../assets/audio/pick-the-call.mp3';
import formFillMp3   from '../assets/audio/form-fill.mp3';
import { setActivitySub } from '../utils/callerActivity';
import { playRobotClip, stopRobotClip, getRobotVolume } from '../utils/robotAudio';
import { stopAllRobotGuideAudio } from '../components/RobotGuide';
import useRobotNudge from '../hooks/useRobotNudge';
import { useTimerSettings } from '../context/TimerSettingsContext';

/* Robot nudge lines for the reason cards. The primary line is shown on
   entry; if the caller doesn't act, the robot re-asks every 30 s and
   auto-pauses after 5 unanswered nudges. */
const AGENT_REASON_PRIMARY = 'enna nanba en call attend pannala';
const AGENT_REASON_NUDGE   = 'nanba irukkingala answer pannunga';
const FORM_REASON_PRIMARY  = 'enna nanba en card fill pannala';
const FORM_REASON_NUDGE    = 'nanba irukingala form complete pannunga';
// Robot-bubble copy for the SmartFlow extension prompt. PRIMARY shows on
// first open; NUDGE replaces it once the robot starts repeating the cue
// (after extAlertNudgeIntervalMs of inaction).
// Single short Tanglish line shown in the amber speech bubble on the
// SmartFlow extension overlay. Same text for first open and every
// subsequent nudge — no reminder counter, no logo, just the question.
const EXT_CHECK_PRIMARY    = 'nanba irukkingala?';
const EXT_CHECK_NUDGE      = 'nanba irukkingala?';

// Subtag options for the "Reason for not interested" dropdown. value is
// what gets persisted (snake_case), label is what the caller sees. Order
// matches the most common call-decline patterns first. Must stay in sync
// with ALLOWED_OUTCOME_SUBTAGS in backend/routes/caller.js.
export const INTERESTED_SUBTAGS = [
  { value: 'wrong_number',              label: 'Wrong number' },
  { value: 'call_disconnected',         label: 'Call disconnected' },
  { value: 'other_languages',           label: 'Other languages' },
  { value: 'no_diabetes',               label: 'No diabetes' },
  { value: 'no_sugar_interested',       label: 'No sugar — interested' },
  { value: 'no_sugar_not_interested',   label: 'No sugar — not interested' },
  { value: 'already_paid',              label: 'Already paid' },
  { value: 'already_attended',          label: 'Already attended webinar' },
  { value: 'not_available_for_webinar', label: 'Not available for webinar' },
  { value: 'not_register',              label: 'Not registered' },
  { value: 'just_for_knowledge',        label: 'Just for knowledge' },
];

// Subtag options for the second-DNP choice card. The fourth option (DNP)
// is rendered separately so it can route through the original triggerDnp()
// path instead of the JUNK-tagged not_interested path the other three use.
export const DNP_JUNK_SUBTAGS = [
  { value: 'switch_off',     label: 'Switch Off' },
  { value: 'out_of_service', label: 'Out of Service' },
  { value: 'no_ring',        label: 'No Ring' },
];
// Patch once at module load — canonical "both arms hanging at sides,
// anatomically mirrored" pose used everywhere else in the CRM.
const sadBotData = normalizeLoop(lockArmsDown(sadBotRaw));

/* One-shot audio helper. Each reason card plays its prompt once when it
   opens. .play() may reject if the browser blocks autoplay; we swallow
   the error rather than crashing. Volume now reads from the persisted
   Robot Voice slider in the account dropdown — was hardcoded 0.9 before. */
function playClipOnce(src) {
  try {
    const audio = new Audio(src);
    audio.volume = getRobotVolume();
    if (audio.volume <= 0) return;
    audio.play().catch(() => {});
  } catch { /* no Audio API */ }
}

/* ──────────────────────────────────────────────────────────────────────────
   Lead Call Note Modal — opens when caller clicks the pencil icon on a lead.
   Drives a 13-state auto-call workflow that distinguishes caller-leg
   (agent's SmartFlow phone) events from customer-leg events. State is fed
   by typed SSE events the backend emits per Tata webhook trigger.
   ────────────────────────────────────────────────────────────────────────── */

export const RANGES = [
  { value: '250+',         label: '250+' },
  { value: '200-250',      label: '200–250' },
  { value: '100-200',      label: '100–200' },
  { value: 'no_diabetes',  label: 'No Diabetes' },
];

export const AGE_BUCKETS = [
  { value: '0-18',     label: '0–18' },
  { value: '19-24',    label: '19–24' },
  { value: '25-34',    label: '25–34' },
  { value: '35-44',    label: '35–44' },
  { value: '45-54',    label: '45–54' },
  { value: 'above-54', label: 'Above 54' },
];

export const RANGE_FOR  = [{ value: 'personal', label: 'Personal' }, { value: 'family', label: 'For Family' }];
export const MEDICINE   = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
export const YES_NO     = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

export const HBA1C = [
  { value: 'gt_7_5',    label: 'HbA1c > 7.5' },
  { value: '6_5_to_7_5', label: 'HbA1c 6.5 – 7.5' },
  { value: '5_7_to_6_5', label: 'HbA1c 5.7 – 6.5' },
];

export const WORKING_PROFESSIONAL = [
  'Business', 'Daily Wages', 'Unemployed', 'House Wife', 'Private',
  'IT', 'Retired', 'Student', 'Working Professional', 'Government', 'Not Working',
].map(label => ({ value: label.toLowerCase().replace(/\s+/g, '_'), label }));

const LOCATIONS_RAW = [
  // Cleaned canonical list — 52 Tamil Nadu districts/towns (all 38 districts +
  // 14 major towns) + 11 nearby / other-state entries. Misspelling variants and
  // junk entries removed.
  'ariyalur', 'chengalpattu', 'chennai', 'coimbatore', 'cuddalore', 'dharmapuri',
  'dindigul', 'erode', 'hosur', 'kallakurichi', 'kanchipuram', 'kanyakumari',
  'karaikudi', 'karur', 'krishnagiri', 'kumbakonam', 'madurai', 'mayiladuthurai',
  'nagapattinam', 'nagalapuram', 'nagercoil', 'namakkal', 'nilgiris', 'palani',
  'perambalur', 'pollachi', 'pudukkottai', 'rajapalayam', 'ramanathapuram', 'ranipet',
  'salem', 'sivaganga', 'sivakasi', 'tenkasi', 'thanjavur', 'theni', 'thoothukudi',
  'tiruchendur', 'tirunelveli', 'tirupathur', 'tiruppur', 'tiruttani', 'tiruvallur',
  'tiruvannamalai', 'tiruvarur', 'tiruchirappalli', 'ulundurpettai', 'vandavasi',
  'vellore', 'villupuram', 'virudhachalam', 'virudhunagar',
  // Nearby union territory / other states
  'andaman', 'andhra pradesh', 'bangalore', 'karnataka', 'kerala', 'maharashtra',
  'munnar', 'nellore', 'pondicherry', 'telangana', 'thiruvananthapuram',
];
export const LOCATIONS = Array.from(new Set(LOCATIONS_RAW.map(s => s.trim().toLowerCase())))
  .sort()
  .map(v => ({ value: v, label: v.replace(/\b\w/g, c => c.toUpperCase()) }));

/* Append the caller's "delay reasons" (one per timer expiry) and "agent miss
   reasons" (one per SmartFlow miss) to the note so they're preserved in the
   saved record. */
function buildNoteWithDelays(noteText, delayReasons, agentReasons) {
  const note = (noteText || '').trim();
  const delays = (delayReasons || []).filter(Boolean);
  const agents = (agentReasons || []).filter(Boolean);
  const blocks = [];
  if (agents.length) {
    blocks.push(`[Agent miss reasons]\n` + agents.map((r, i) => `  ${i + 1}. ${r}`).join('\n'));
  }
  if (delays.length) {
    blocks.push(`[Form delay reasons]\n` + delays.map((r, i) => `  ${i + 1}. ${r}`).join('\n'));
  }
  if (blocks.length === 0) return note || null;
  return note ? [note, ...blocks].join('\n\n') : blocks.join('\n\n');
}

const FORM_WINDOW_SECS = 45;
// When the caller exceeds this many SmartFlow miss-reason submissions on a
// single lead, the lead is auto-paused AND the caller's account is auto-
// paused server-side (POST /api/caller/leads/:id/note flips
// crm_users.is_active=FALSE). Only a super admin can resume the caller.
const AGENT_RETRY_CAP  = 15;

// Tata's webhooks are noisy: they routinely fire `customer.missed` and
// sometimes `call.hangup` mid-call even while the audio is still bridged.
// The legacy 8-second phantom filter only catches the immediate post-
// answer ghost; it doesn't help on 3-minute calls where Tata sends a
// stray miss event because of a CDR hiccup.
//
// This helper is the stricter gate: only believe the call actually
// ended when at least ONE of these corroborating signals is present on
// the merged `calls` row. The webhook handler updates these together,
// so any genuine hangup will produce at least one of them.
const TERMINAL_CALL_STATUS = new Set(['ended', 'failed', 'missed']);
function callDefinitelyEnded(call) {
  if (!call) return false;
  if (call.ended_at)  return true;
  if (call.hangup_by) return true;
  if (call.duration_sec != null && Number(call.duration_sec) > 0) return true;
  if (TERMINAL_CALL_STATUS.has(call.status)) return true;
  return false;
}

/* Whether the 45-second form-fill timer should run for THIS hangup.
   Product rule (per the latest user spec):
     - Customer answered → ALWAYS run the 45s timer, regardless of
       call duration. The calm "Call ended, fill when ready" card is
       explicitly disallowed — every customer-cut hangup must show
       the urgent 45-second countdown so the caller fills the form
       immediately while the conversation is fresh.
     - Customer never answered → form_window isn't reached at all
       (the customer.missed → DNP path runs instead), so this
       predicate doesn't apply.
     - Agent explicitly closes via the X button → handled by
       handleCloseClick which now shows CloseConfirmDialog and
       saves outcome='incomplete' directly, bypassing form_window
       entirely.

   The `longCallThresholdMs` argument is kept in the signature for
   backward compatibility with any caller that still passes it (and
   the admin Timer page still surfaces the setting). It is no longer
   consulted — the function unconditionally returns true for any
   call where customer_answered_at is present. If the product team
   wants to bring back duration-based suppression later, swap this
   body back to compare `dur < thresholdSec`. */
function shouldRunFormTimerFor(call, _longCallThresholdMs) {
  return !!call?.customer_answered_at;
}

/* How MANY independent terminal signals are present? Used to gate the
   mid-call "Customer disconnected" transition: a SINGLE signal during
   customer_on_call is treated as suspicious (Tata leg-blip CDR write)
   and held inside a corroboration window; TWO OR MORE signals together
   are high-confidence and commit immediately. The four signals are
   independent enough that Tata's normal end-of-call write produces all
   four within milliseconds; a leg blip only produces one. */
function countTerminalSignals(call) {
  if (!call) return 0;
  let n = 0;
  if (call.ended_at)  n++;
  if (call.hangup_by) n++;
  if (call.duration_sec != null && Number(call.duration_sec) > 0) n++;
  if (TERMINAL_CALL_STATUS.has(call.status)) n++;
  return n;
}

export default function LeadCallNoteModal({ jwt, lead, onClose, onSaved, onPhaseChange, restoreState, onStateChange }) {
  const t = useTimerSettings();
  // Admin-tunable (Timer page → Agent reason card): how many SmartFlow retrigger
  // attempts the agent reason card allows before the account is blocked
  // (auto-paused). Falls back to the hard default if the setting is missing.
  const agentRetryCap = Math.max(1, Number(t.agentRetryCap) || AGENT_RETRY_CAP);
  const [fullName, setFullName]                   = useState(lead.full_name || '');
  const [phoneNumber]                             = useState(lead.whatsapp_number || '');
  const [confirmedRange, setConfirmedRange]       = useState('');
  const [rangeFor, setRangeFor]                   = useState('personal');
  const [patientAge, setPatientAge]               = useState('');
  const [takesMedicine, setTakesMedicine]         = useState('');
  const [note, setNote]                           = useState('');
  const [hba1c, setHba1c]                             = useState('');
  /* Subtag picked from the "Reason for not interested" dropdown OR from
     the second-DNP choice card. Backed by the lead_call_notes.outcome_subtag
     column. When non-empty, forces the lead_tag to JUNK (override of the
     classifier) and is shown as a secondary chip in Completed Calls. */
  const [interestedSubtag, setInterestedSubtag]       = useState('');
  const [workingProfessional, setWorkingProfessional] = useState('');
  const [location, setLocation]                       = useState('');
  const [webinarAttended, setWebinarAttended]         = useState('');
  const [availableForWebinar, setAvailableForWebinar] = useState('');
  const [nextBatchJoining, setNextBatchJoining]       = useState('');
  const [interested, setInterested]               = useState('');
  const [wantsFollowUp, setWantsFollowUp]         = useState(false);
  const [followUpAtLocal, setFollowUpAtLocal]     = useState('');
  const [error, setError]                         = useState('');
  const [saving, setSaving]                       = useState(false);
  const [recalling, setRecalling]                 = useState(false);
  const [recallToast, setRecallToast]             = useState('');
  // DNP press count:
  //   0 → first press redials the same lead and shows the "Second call is
  //       triggered" banner (treated as another customer-no-answer attempt,
  //       NOT a caller hangup).
  //   1 → second press saves the lead as not_picked and advances.
  const [cutCount, setCutCount]                   = useState(() => restoreState?.cutCount ?? 0);
  const [dnpRetry, setDnpRetry]                   = useState(() => restoreState?.dnpRetry ?? false);
  const [cuttingCall, setCuttingCall]             = useState(false);
  // Confirm dialog state for the X button. When non-null, the
  // CloseConfirmDialog overlay renders. `saving` flag inside the dialog
  // dedups double-clicks and disables the OK button while the POST runs.
  const [closeConfirm, setCloseConfirm]           = useState(null); // null | { saving: boolean }

  /* ── Form-draft persistence ───────────────────────────────────────────
     Browser refreshes during a call would otherwise wipe every value
     the caller has typed. We snapshot every form field to localStorage
     keyed by the lead id, restore on mount, and clear once the note is
     successfully saved (in callOnSaved below) so re-opening a finished
     lead from Completed Calls starts blank.

     localStorage (not session) — survives a browser crash too. */
  const draftKey = `mhs_form_draft_${lead?.id || 'x'}`;

  // Restore — runs once when the lead changes.
  useEffect(() => {
    if (!lead?.id) return;
    // Base layer — prefill the qualification answers from the lead's previously
    // saved note (last_note_*), so a returning follow-up / assigned lead shows
    // what was already filled instead of opening blank. Follow-up scheduling
    // fields are left fresh — a NEW follow-up is being decided.
    if (lead.last_note_confirmed_range)       setConfirmedRange(lead.last_note_confirmed_range);
    if (lead.last_note_range_for)             setRangeFor(lead.last_note_range_for);
    if (lead.last_note_patient_age)           setPatientAge(lead.last_note_patient_age);
    if (lead.last_note_takes_medicine)        setTakesMedicine(lead.last_note_takes_medicine);
    if (lead.last_note_text)                  setNote(lead.last_note_text);
    if (lead.last_note_hba1c)                 setHba1c(lead.last_note_hba1c);
    if (lead.last_note_working_professional)  setWorkingProfessional(lead.last_note_working_professional);
    if (lead.last_note_location)              setLocation(lead.last_note_location);
    if (lead.last_note_webinar_attended)      setWebinarAttended(lead.last_note_webinar_attended);
    if (lead.last_note_available_for_webinar) setAvailableForWebinar(lead.last_note_available_for_webinar);
    if (lead.last_note_next_batch_joining)    setNextBatchJoining(lead.last_note_next_batch_joining);
    const prevInterested = lead.last_note_interested_in_note || lead.last_note_interested;
    if (prevInterested)                       setInterested(prevInterested);
    if (lead.last_note_outcome_subtag)        setInterestedSubtag(lead.last_note_outcome_subtag);

    // Overlay — an in-progress draft (e.g. a mid-call browser refresh) wins,
    // but ONLY for fields the caller actually entered. Empty draft values must
    // NOT wipe out the prefilled answers above, so we overlay truthy values only.
    let draft = null;
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) draft = JSON.parse(raw);
    } catch { /* corrupt JSON → just skip */ }
    if (draft) {
      if (draft.fullName)            setFullName(draft.fullName);
      if (draft.confirmedRange)      setConfirmedRange(draft.confirmedRange);
      if (draft.rangeFor)            setRangeFor(draft.rangeFor);
      if (draft.patientAge)          setPatientAge(draft.patientAge);
      if (draft.takesMedicine)       setTakesMedicine(draft.takesMedicine);
      if (draft.note)                setNote(draft.note);
      if (draft.hba1c)               setHba1c(draft.hba1c);
      if (draft.workingProfessional) setWorkingProfessional(draft.workingProfessional);
      if (draft.location)            setLocation(draft.location);
      if (draft.webinarAttended)     setWebinarAttended(draft.webinarAttended);
      if (draft.availableForWebinar) setAvailableForWebinar(draft.availableForWebinar);
      if (draft.nextBatchJoining)    setNextBatchJoining(draft.nextBatchJoining);
      if (draft.interested)          setInterested(draft.interested);
      if (draft.interestedSubtag)    setInterestedSubtag(draft.interestedSubtag);
      if (draft.wantsFollowUp)       setWantsFollowUp(draft.wantsFollowUp);
      if (draft.followUpAtLocal)     setFollowUpAtLocal(draft.followUpAtLocal);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id]);

  // Save — runs whenever any tracked form field changes.
  useEffect(() => {
    if (!lead?.id) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({
        fullName, confirmedRange, rangeFor, patientAge, takesMedicine,
        note, hba1c, workingProfessional, location,
        webinarAttended, availableForWebinar, nextBatchJoining,
        interested, interestedSubtag, wantsFollowUp, followUpAtLocal,
      }));
    } catch { /* localStorage full → drop the save silently */ }
  }, [
    draftKey,
    fullName, confirmedRange, rangeFor, patientAge, takesMedicine,
    note, hba1c, workingProfessional, location,
    webinarAttended, availableForWebinar, nextBatchJoining,
    interested, interestedSubtag, wantsFollowUp, followUpAtLocal,
  ]);

  /* ── Auto-call state machine ──────────────────────────────────────────
     States:
       idle              — initial; only seen if no call has been placed yet
       ext_check         — centered overlay asking "Is SmartFlow extension on?"
       agent_ringing_1   — banner "First call triggered. Pick the call."
       agent_ringing_2   — banner "Triggering again. Manager notified." (auto-redial)
       agent_reason_card — centered overlay asking why they missed both rings
       customer_ringing  — banner "Calling customer…"
       customer_on_call  — banner "Customer is on the call."
       form_window       — banner with 30-s countdown to fill form
       form_reason_card  — centered overlay asking why form wasn't filled in time
       recall_ringing    — banner "Recall triggered. Pick the call."
       dnp_alert         — centered overlay "Lead moved to DNP", auto-saves
       auto_paused       — centered overlay "5 attempts hit, moving on", auto-saves
  */
  // Initial phase decided in priority order:
  //   1. restoreState.phase   — the snapshot saved before a browser
  //      refresh. Highest priority so a refresh during ext_check /
  //      form_window / dnp_choice / etc. drops the caller back on the
  //      exact same card.
  //   2. lead.last_call_id    — no snapshot, but a call is already
  //      in flight (auto-advance post-DNP/Complete). Reflect as
  //      agent_ringing_1.
  //   3. ext_check            — fresh start.
  // Whitelist guard: only accept restored phases the modal actually
  // knows how to render — otherwise fall through to the lead-based
  // default. Without this, a stale snapshot from a previous build
  // (e.g. a removed phase) would blank the modal.
  const _VALID_PHASES = new Set([
    'idle','ext_check','agent_ringing_1','agent_ringing_2','agent_reason_card',
    'customer_ringing','customer_on_call','recall_ringing',
    'form_window','form_reason_card','dnp_alert','auto_paused',
  ]);
  const [callPhase, setCallPhase] = useState(() => {
    const p = restoreState?.phase;
    if (p && _VALID_PHASES.has(p)) return p;
    return lead?.last_call_id ? 'agent_ringing_1' : 'ext_check';
  });
  // Sticky flag: true once the customer has answered AT LEAST ONCE during
  // this lead's modal session. Used to gate the Complete Call button — the
  // caller can't submit until the customer actually attends the call.
  // Survives recall flows (resetCallSignalForNewAttempt does NOT clear it),
  // resets only when the modal remounts (i.e. a new lead).
  // Restored from snapshot on browser-refresh so DNP visibility +
  // Complete-button enablement stay correct after reload.
  const [customerAnsweredOnce, setCustomerAnsweredOnce] = useState(() => !!restoreState?.customerAnsweredOnce);
  // agentAttempts PRESERVES across refresh — it's the missed-ring
  // retry counter that drives the agent_ringing_1 → agent_ringing_2
  // → reason_card progression. Resetting it on refresh would cause
  // the post-refresh 35s synthetic timeout to fire handleAgentMissed
  // with attempts=0, jumping back to agent_ringing_2 AND placing a
  // duplicate Tata call (the "Triggering first call again" double-dial
  // bug). The phase + counters must move together so the state machine
  // continues from where it was, not from scratch.
  const [agentAttempts, setAgentAttempts]     = useState(() => {
    const v = Number(restoreState?.agentAttempts);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  });
  // customerAttempt PRESERVES across refresh — it's a PROGRESS counter
  // (which whole-call retry we're on). retryCallToCustomer bumps this
  // to 2 when the customer misses the first attempt; resetting on
  // refresh would silently demote it to 1, mis-label the retry banner
  // as "first call", and could re-fire the retry path.
  const [customerAttempt, setCustomerAttempt] = useState(() => restoreState?.customerAttempt ?? 1);
  const [agentReasons, setAgentReasons]       = useState([]);  // appended every reason submit
  const [agentReason, setAgentReason]         = useState('');
  const [delayReasons, setDelayReasons]       = useState([]);
  const [delayReason, setDelayReason]         = useState('');
  // Form-window timer — restores from the saved deadline (epoch ms) so a
  // refresh resumes the countdown from the right second instead of
  // restarting at FORM_WINDOW_SECS. Already-expired deadlines collapse
  // to 0 and the modal's expiry effect will fire normally.
  const [formTimerSecs, setFormTimerSecs]     = useState(() => {
    const dl = restoreState?.formTimerDeadline;
    if (!dl) return 0;
    return Math.max(0, Math.floor((dl - Date.now()) / 1000));
  });
  // Whether the 45-second form-window countdown should actually run.
  // True ⇒ classic behavior (timer + auto-advance to form_reason_card on
  //         expiry + Complete Call button gated to "before time runs out").
  // False ⇒ form opens but no countdown UI, no auto-advance, no time
  //         pressure on the caller. Used when the AGENT (sales rep)
  //         hangs up the call themselves — they chose to end it, they
  //         can take their time filling the form. Per product rule:
  //         only run the timer when hangup_by === 'customer'.
  // Default true preserves the legacy behavior for any code path that
  // doesn't explicitly set it (e.g. form_reason_card → form_window
  // retry, where the caller is actively asking for another 45s window).
  const [formTimerEnabled, setFormTimerEnabled] = useState(() => {
    const v = restoreState?.formTimerEnabled;
    return v == null ? true : !!v;
  });
  const [activeCallId, setActiveCallId]       = useState(lead?.last_call_id || null);
  // Phase-timer deadline (epoch ms) for the synthetic 35s / 50s
  // ring-timeout safety net. Persists across refresh so the timer
  // resumes from its ORIGINAL deadline instead of restarting at 35s
  // every reload — without this, a refresh during agent_ringing_1
  // grants the call a fresh 35s window before auto-redial, which then
  // fires handleAgentMissed → setCallPhase('agent_ringing_2') +
  // postStartCall (the spurious duplicate Tata call the user saw as
  // "Triggering the first call again" right after refresh). Scoped
  // to its owning phase so a leftover deadline from agent_ringing_1
  // doesn't fire stale on the agent_ringing_2 useEffect re-run.
  const [phaseDeadline, setPhaseDeadline]     = useState(() => {
    const dl = Number(restoreState?.phaseDeadline);
    const ph = restoreState?.phase;
    if (Number.isFinite(dl) && dl > 0 && ph) return { phase: ph, when: dl };
    return null;
  });

  /* Modal-state snapshot — bubbles every state change up to the parent
     (AssignedLeadsModule) which writes it to sessionStorage. Captures
     every piece of state needed to redraw the same card after a
     refresh: phase, DNP counter, retry counters, dnpRetry flag, and
     the form-window deadline (epoch ms so the countdown resumes from
     the right second).

     Placed AFTER every state it reads is declared — earlier placement
     hits a temporal-dead-zone ReferenceError because the dep array
     evaluates `callPhase` / `formTimerSecs` etc. before their useState
     lines have executed on the first render. */
  useEffect(() => {
    if (typeof onStateChange !== 'function') return;
    onStateChange({
      phase:               callPhase,
      cutCount,
      customerAttempt,
      agentAttempts,
      dnpRetry,
      customerAnsweredOnce,
      formTimerDeadline:   formTimerSecs > 0 ? Date.now() + formTimerSecs * 1000 : null,
      formTimerEnabled,
      phaseDeadline:       (phaseDeadline && phaseDeadline.phase === callPhase) ? phaseDeadline.when : null,
    });
  }, [callPhase, cutCount, customerAttempt, agentAttempts, dnpRetry, customerAnsweredOnce, formTimerSecs, formTimerEnabled, phaseDeadline, onStateChange]);

  // Refs mirror state for closures inside SSE/poll callbacks.
  //   agentAttemptsRef preserves the restored value so the post-refresh
  //   synthetic ring-timeout in handleAgentMissed reads the correct
  //   attempt and advances to reason-card or auto-paused, not back to
  //   agent_ringing_2 + duplicate postStartCall.
  //   customerAttemptRef preserves the restored value so post-refresh
  //   SSE handlers see attempt=2 if the retry had already kicked off,
  //   instead of falsely reverting to 1.
  const callPhaseRef       = useRef(callPhase);
  const agentAttemptsRef   = useRef(Number(restoreState?.agentAttempts) || 0);
  const customerAttemptRef = useRef(restoreState?.customerAttempt ?? 1);
  const wasAgentAnsweredRef = useRef(false);
  const wasCustomerAnsweredRef = useRef(false);
  // Mirror of dnpRetry state for closures inside SSE/poll callbacks. Tells
  // the agent.answered handler whether the in-flight call is a TRUE recall
  // (customer was on the line, both legs reconnect on agent pickup) or a
  // DNP first-press redial (brand-new dial, customer leg still ringing).
  const dnpRetryRef = useRef(false);
  const lastSeenSigsRef    = useRef(new Set());
  const customerMissedTimerRef = useRef(null);
  /* Holds the setTimeout id for the hangup-corroboration window. When
     Tata stamps ONE terminal signal mid-call (often a leg-blip CDR
     write that DOESN'T correspond to a real hangup), we don't flip the
     modal to form_window immediately — we schedule this timer for
     t.hangupCorroborateMs and wait for a SECOND independent terminal
     signal. If the second signal arrives before the timer fires, we
     cancel + commit. If the timer fires with still only one signal,
     we STAY on customer_on_call (treating it as a confirmed leg blip).
     The user can manually press Recall / X / DNP if needed. */
  const pendingHangupTimerRef  = useRef(null);
  // Dedup guard for saveIncompleteAndClose — without it, rapid double-
  // clicks on the X button could fire two POST /note requests in flight
  // for the same lead.
  const savingIncompleteRef    = useRef(false);
  // Unmount safety net: if the modal closes while a hangup corroboration
  // window is still pending, clear the timer so it doesn't fire against
  // a torn-down component (no-op state setters → React warning).
  useEffect(() => () => {
    if (pendingHangupTimerRef.current) {
      clearTimeout(pendingHangupTimerRef.current);
      pendingHangupTimerRef.current = null;
    }
  }, []);
  /* Latest call object seen by handleCallEvent. Lets long-lived
     callbacks (e.g. the 3-second customer.missed deferred retry) read
     the freshest call state instead of the stale `call` they captured
     at register time — so a customer who's still ringing isn't
     retried just because Tata fired a phantom customer.missed earlier. */
  const latestCallRef          = useRef(null);
  // Earliest started_at we accept signals from in the polling fallback.
  // Set every time we kick off a fresh /calls/start so old completed calls'
  // end-signals don't leak into the current attempt's aggregation. When the
  // modal opens mid-call (auto-advance flow), seed it from the existing
  // call's started_at so polling picks up the in-flight signals straight
  // away. Otherwise (fresh start) it stays null until confirmExtensionAndStart
  // runs after Yes & Proceed.
  const sessionStartIsoRef = useRef(
    lead?.last_call_id
      ? (lead.last_call_started_at
          ? new Date(new Date(lead.last_call_started_at).getTime() - 2000).toISOString()
          : new Date(Date.now() - 60000).toISOString())
      : null
  );
  const activeCallIdRef    = useRef(lead?.last_call_id || null);
  // Set while a /calls/start POST is in flight. Prevents accidentally firing
  // two parallel Tata calls if a stale agent.missed and a fresh customer.missed
  // both want to retry within the same tick.
  const startingCallRef    = useRef(false);
  // Set once when the modal advances the parent (onSaved). Prevents the
  // 1.5-s dnp_alert/auto_paused timer from racing with a manual DNP click
  // and double-advancing to the next-next lead.
  const savedRef           = useRef(false);
  // Phase-timeout safety net — Tata's click-to-call doesn't reliably fire
  // agent.missed / customer.missed webhooks when nobody picks up, so the
  // state machine can stall in a ringing phase indefinitely. We synthesize
  // the missed event after a ring-window expires.
  const phaseTimeoutRef    = useRef(null);
  useEffect(() => { callPhaseRef.current = callPhase; },             [callPhase]);
  useEffect(() => { dnpRetryRef.current  = dnpRetry;  },             [dnpRetry]);

  /* Bubble phase changes up to the shell so the floating mascot can react
     (e.g. flip to `thinking` while a reason card is open). Optional prop —
     the modal works fine without it. */
  useEffect(() => {
    if (typeof onPhaseChange === 'function') {
      try { onPhaseChange(callPhase); } catch { /* never let UI listeners crash the modal */ }
    }
  }, [callPhase, onPhaseChange]);

  /* Reason-card audio cues — fire each prompt's MP3 exactly once when the
     overlay opens. Effect depends on callPhase so re-opening the same card
     replays the clip. */
  useEffect(() => {
    if (callPhase === 'agent_reason_card') playRobotClip(21);
    else if (callPhase === 'form_reason_card') playRobotClip(22);
    else if (callPhase === 'dnp_alert') playRobotClip(51);
    // ext_check intentionally silent on first open per request — only the
    // robot nudge ticks (after extAlertNudgeIntervalMs) speak via the
    // extNudgeCount effect below, which keeps the auto-pause guard intact.
  }, [callPhase]);

  /* Robot repeat-nudges for the two reason cards. While a card is open and the
     caller hasn't acted, the robot re-asks every nudge interval (~30 s). BOTH
     cards BLOCK the account if the caller never responds:
       • agent_reason_card — after `agentReasonNudgeCount` unanswered nudges
         (Timer → Agent reason card, default 5) the account is blocked.
       • form_reason_card  — after `formReasonNudgeCount` unanswered nudges
         (Timer → Form reason card, default 5) the account is blocked.
     Both route through saveAutoPaused() → outcome='auto_paused' → is_active=FALSE
     on the backend, and (autoAdvance:false) stop the auto-call so the blocked
     overlay takes over rather than opening the next lead. */
  const { count: agentNudgeCount } = useRobotNudge({
    active: callPhase === 'agent_reason_card',
    intervalMs: t.agentReasonNudgeIntervalMs,
    maxRepeats: t.agentReasonNudgeCount,
    storageKey: `mhs_nudge_agent_${lead?.id || 'x'}`,
    onExhausted: () => { setCallPhase('auto_paused'); saveAutoPaused(); },
  });
  const { count: formNudgeCount } = useRobotNudge({
    active: callPhase === 'form_reason_card',
    intervalMs: t.formReasonNudgeIntervalMs,
    maxRepeats: t.formReasonNudgeCount,
    storageKey: `mhs_nudge_form_${lead?.id || 'x'}`,
    onExhausted: () => { setCallPhase('auto_paused'); saveAutoPaused(); },
  });

  /* SmartFlow-extension alert ("Is your extension on?") — if the caller
     never answers it the account auto-pauses after the configured nudges,
     same idle treatment as the Call / Assigned pages. We now also EXPOSE
     the tick count so the overlay can show a visible robot bubble + audio
     cue on each repeat (matching the agent/form reason-card UX). */
  const { count: extNudgeCount } = useRobotNudge({
    active: callPhase === 'ext_check',
    intervalMs: t.extAlertNudgeIntervalMs,
    maxRepeats: t.extAlertNudgeCount,
    storageKey: `mhs_nudge_ext_${lead?.id || 'x'}`,
    onExhausted: () => {
      fetch('/api/caller/self-pause', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body:    JSON.stringify({ reason: 'SmartFlow extension alert ignored' }),
      }).catch(() => {});
    },
  });

  /* Voice the reason-card repeat-nudges (clips 49 / 50) and the
     SmartFlow-extension nudge (clip 40, reused from CallModule's idle
     nudge — generic "do something" prompt). */
  useEffect(() => { if (agentNudgeCount >= 1) playRobotClip(49); }, [agentNudgeCount]);
  useEffect(() => { if (formNudgeCount  >= 1) playRobotClip(50); }, [formNudgeCount]);
  useEffect(() => { if (extNudgeCount   >= 1) playRobotClip(40); }, [extNudgeCount]);

  /* Activity sub-tag — maps the call phase to the single-tag activity log:
       agent/form reason cards → REASON_CARD
       form_window / idle      → IN_FORM
       ringing / on-call       → ON_CALL
     CallerShell's heartbeat picks this up; the second effect clears it when
     the modal unmounts so the page tag resumes. */
  useEffect(() => {
    if (!jwt) return;
    const ctx = { lead_name: lead?.full_name || '', lead_id: lead?.id || null };
    let sub;
    if (callPhase === 'agent_reason_card' || callPhase === 'form_reason_card') {
      sub = 'REASON_CARD';
      ctx.kind = callPhase === 'agent_reason_card' ? 'agent_dnp' : 'form_skip';
      if (callPhase === 'agent_reason_card') ctx.attempt = (cutCount || 0) + 1;
    } else if (callPhase === 'form_window' || callPhase === 'idle'
               || callPhase === 'dnp_alert' || callPhase === 'auto_paused') {
      sub = 'IN_FORM';
    } else {
      sub = 'ON_CALL';
    }
    setActivitySub(jwt, sub, ctx);
  }, [callPhase, jwt, lead?.full_name, lead?.id, cutCount]);

  /* Clear the sub-tag when the modal unmounts so the page tag resumes. */
  useEffect(() => () => { if (jwt) setActivitySub(jwt, null, null); }, [jwt]);

  /* Structured log on every phase transition. One JSON line per change —
     greppable in browser DevTools and forwarded to any client-side log
     collector (e.g. Sentry breadcrumbs) so we can replay a stuck call. */
  useEffect(() => {
    try {
      console.log(JSON.stringify({
        type:             'call_phase',
        lead_id:          lead?.id,
        phase:            callPhase,
        customer_attempt: customerAttemptRef.current,
        agent_attempts:   agentAttemptsRef.current,
        at:               new Date().toISOString(),
      }));
    } catch (_) { /* logging is best-effort */ }
  }, [callPhase, lead?.id]);
  useEffect(() => { agentAttemptsRef.current = agentAttempts; },     [agentAttempts]);
  useEffect(() => { customerAttemptRef.current = customerAttempt; }, [customerAttempt]);
  useEffect(() => { activeCallIdRef.current = activeCallId; },       [activeCallId]);

/* Reduce a typed call event into a phase transition. Read from refs so the
     callback (registered once at mount) sees fresh values.

     Tata occasionally fires "Call missed by Customer" even when the customer
     DID answer (likely fired on any premature hangup of the customer leg).
     We treat the per-leg timestamp columns + ref flags as ground truth and
     ignore *.missed events whenever the corresponding *.answered already
     happened on the same call. */
  function handleCallEvent(eventType, call) {
    if (call && call.lead_id && call.lead_id !== lead.id) return;

    // Dedup by (call.id, eventType). lastSeenSigsRef is NEVER cleared (only
    // grown) so a stale Tata retry of an event from a previous attempt's
    // call.id can't slip past — the signature is already in the set from
    // the first time we processed it. Tata uses different call.ids per
    // attempt and per leg (agent leg vs customer leg), so genuine new
    // events always have fresh signatures.
    const sig = `${call?.id || ''}:${eventType}`;
    if (lastSeenSigsRef.current.has(sig)) return;
    lastSeenSigsRef.current.add(sig);

    if (call?.id) {
      setActiveCallId(call.id);
      activeCallIdRef.current = call.id;
    }
    // Track latest real call object so deferred callbacks (like the
    // 3-second customer.missed retry timer) can re-check the truth
    // when they fire. Skip synthetic events — they carry no real
    // timestamp columns and would clobber the last valid snapshot.
    if (call && !(typeof call.id === 'string' && call.id.startsWith('synthetic-'))) {
      latestCallRef.current = call;
    }

    const phase = callPhaseRef.current;
    const agentAnswered    = wasAgentAnsweredRef.current    || !!call?.agent_answered_at;
    const customerAnswered = wasCustomerAnsweredRef.current || !!call?.customer_answered_at;

    if (eventType === 'agent.answered') {
      wasAgentAnsweredRef.current = true;
      // recall_ringing covers TWO distinct flows that look identical to the
      // state machine until we read dnpRetryRef:
      //
      //   (a) TRUE Recall — caller clicked the Recall button after the
      //       customer dropped during form_window. Tata's click-to-call
      //       reuses the existing customer leg, so agent.answered means
      //       both legs reconnected → jump straight to 'customer_on_call'
      //       and pre-flip wasCustomerAnsweredRef so a later customer.missed
      //       lands form_window correctly.
      //
      //   (b) DNP first-press — caller pressed DNP, which redials the same
      //       lead with a brand-new outbound call. agent.answered here only
      //       confirms the CALLER picked their SmartFlow; the customer leg
      //       is still ringing. Going to 'customer_on_call' would lie
      //       ("Customer is on the call.") — go to 'customer_ringing' so
      //       the banner stays "Calling customer…" until the real
      //       customer.answered (or customer.missed) lands.
      if (phase === 'recall_ringing' || phase === 'form_window' || phase === 'form_reason_card') {
        if (dnpRetryRef.current) {
          setCallPhase('customer_ringing');
          return;
        }
        wasCustomerAnsweredRef.current = true;
        setCustomerAnsweredOnce(true);
        setCallPhase('customer_on_call');
        return;
      }
      // Already past the agent-decision point — don't regress to customer_ringing.
      // (A stale agent.answered re-delivery, or a fragment row's late-arriving
      // signal, shouldn't flip the banner backwards from "Customer is on the
      // call" to "Calling customer…".)
      if (['customer_ringing','customer_on_call','dnp_alert','auto_paused',
           'agent_reason_card'].includes(phase)) {
        return;
      }
      setCallPhase('customer_ringing');
      return;
    }

    if (eventType === 'customer.answered') {
      wasCustomerAnsweredRef.current = true;
      // Sticky: once the customer has answered, the Complete Call button
      // becomes available for the rest of this lead's modal session.
      setCustomerAnsweredOnce(true);
      // Cancel any pending customer.missed retry timer — customer DID answer.
      if (customerMissedTimerRef.current) {
        clearTimeout(customerMissedTimerRef.current);
        customerMissedTimerRef.current = null;
      }
      setCallPhase('customer_on_call');
      return;
    }

    if (eventType === 'customer.missed') {
      // Tata fires "Call missed by Customer" right after customer.answered
      // (within ~1 s) on every click-to-call, even when the customer picked
      // up. Two scenarios:
      //   (A) Both events arrive in order, customerAnswered already true
      //       → elapsed < 8 s = spurious post-answer fire, IGNORE
      //       → elapsed ≥ 8 s = real customer hangup, go to form_window
      //   (B) customer.missed lands BEFORE customer.answered (race)
      //       → defer the retry decision 3 s; if customer.answered arrives
      //          during the wait, cancel the retry entirely.
      if (customerAnswered) {
        // Phantom filter (legacy, narrow): Tata fires a spurious
        // customer.missed within ~1 s of customer.answered on click-to-
        // call. If BOTH timestamps are present AND the gap is short,
        // it's the immediate-post-answer ghost → ignore.
        const ans  = call?.customer_answered_at ? new Date(call.customer_answered_at).getTime() : null;
        const miss = call?.customer_missed_at   ? new Date(call.customer_missed_at).getTime()   : null;
        if (ans != null && miss != null && (miss - ans) < 8000) return;

        // Stricter mid-call filter: Tata also fires stray customer.missed
        // events MINUTES into long calls (CDR hiccups, brief audio drops,
        // re-bridging). The 8-second guard above doesn't catch those.
        // Refuse to treat this as a real customer disconnect unless the
        // calls row carries `recording_url` — the ONE signal Tata never
        // writes mid-call (it lands only after the bridge tears down and
        // the recording is finalized). The other terminal fields
        // (ended_at, hangup_by, duration_sec, status) can all be stamped
        // mid-call by Tata's leg-blip CDR writes, so we ignore them as
        // a stand-alone trigger here. The next poll that brings
        // recording_url will fire commit naturally.
        if (!call?.recording_url) return;

        if (phase !== 'form_window' && phase !== 'form_reason_card') {
          // Per product rule: 45s timer only when the customer hung up.
          // Agent-initiated hangups open the form with no time pressure.
          const runTimer = shouldRunFormTimerFor(call, t.formTimerLongCallThresholdMs);
          setFormTimerEnabled(runTimer);
          setCallPhase('form_window');
          setFormTimerSecs(prev => {
            if (!runTimer) return 0;
            return prev > 0 ? prev : FORM_WINDOW_SECS;
          });
        }
        return;
      }
      // Suppress in phases where customer.missed cannot be a real customer-side
      // miss for the current attempt:
      //   – Pre-customer-leg phases (idle, ext_check, agent_ringing_1/2,
      //     agent_reason_card): the agent hasn't picked yet, so the customer
      //     leg never started. Any customer.missed arriving here must be a
      //     phantom (e.g. Tata firing the trigger on the first attempt's row
      //     where the agent timed out, or a leftover signal in a fragment
      //     row). Without this guard, the deferred retry would prematurely
      //     bump customerAttempt to 2 and the next genuine customer miss
      //     would jump straight to DNP without a second attempt.
      //   – Post-decision phases (form_window, form_reason_card, dnp_alert,
      //     auto_paused, recall_ringing, customer_on_call): we're past the
      //     point where retry/DNP is the right action.
      const PRE_CUSTOMER = ['idle','ext_check','agent_ringing_1','agent_ringing_2','agent_reason_card'];
      const POST_DECISION = ['form_window','form_reason_card','dnp_alert','auto_paused','recall_ringing','customer_on_call'];
      if (PRE_CUSTOMER.includes(phase) || POST_DECISION.includes(phase)) return;
      // Race protection: defer the retry. If customer.answered arrives
      // within 3 s OR phase moves into a non-retryable state, abort.
      // Capture whether the originating event was synthetic (the 50 s
      // phase-timeout safety net) — synthetic events ARE the "ring time
      // exhausted, assume miss" trigger, so they should retry even
      // without a corroborating ended_at on the calls row.
      const cameFromSynthetic = typeof call?.id === 'string' && call.id.startsWith('synthetic-');
      if (customerMissedTimerRef.current) clearTimeout(customerMissedTimerRef.current);
      customerMissedTimerRef.current = setTimeout(() => {
        customerMissedTimerRef.current = null;
        if (wasCustomerAnsweredRef.current) return;
        const p = callPhaseRef.current;
        if (PRE_CUSTOMER.includes(p) || POST_DECISION.includes(p)) return;
        // The fix for "second call triggers while customer is still
        // ringing": a REAL customer.missed during ringing is Tata's
        // known phantom (fires before the customer actually picks up).
        // Refuse to retry unless the call has truly ended — ended_at,
        // hangup_by, duration_sec, or a terminal status on the latest
        // call row. Synthetic events (phase timeout) bypass this since
        // they're the "Tata never fired anything, assume miss" signal.
        if (!cameFromSynthetic && !callDefinitelyEnded(latestCallRef.current)) return;
        if (customerAttemptRef.current < 2) {
          retryCallToCustomer();
        } else {
          triggerDnp();
        }
      }, 3000);
      return;
    }

    if (eventType === 'agent.missed') {
      // Agent already picked SmartFlow → not actually a miss; ignore.
      if (agentAnswered) return;
      // Suppress in any phase past the agent-decision point AND while waiting
      // for the user's reason input (a stale agent.missed from a previous
      // attempt shouldn't be allowed to bump the attempt counter or auto-pause
      // the lead while the caller is mid-typing).
      // recall_ringing is INTENTIONALLY allowed to fall through — per spec,
      // agent.missed during recall_ringing must transition to agent_ringing_2.
      if (['form_window','form_reason_card','dnp_alert','auto_paused',
           'customer_on_call','customer_ringing',
           'agent_reason_card'].includes(phase)) return;
      handleAgentMissed();
      return;
    }

    if (eventType === 'call.hangup') {
      if (customerAnswered) {
        // Tata's call.hangup fires spuriously mid-call (brief bridge
        // resets, leg blips, late-arriving CDR events). On some accounts
        // the leg-blip CDR write stamps MULTIPLE terminal columns at
        // once (ended_at + duration_sec + status='ended'), so counting
        // signals isn't enough — the form was opening while the audio
        // bridge was still up.
        //
        // The ONLY signal Tata cannot fake mid-call is `recording_url`.
        // It is written strictly AFTER the bridge tears down and the
        // recording is finalized. So that is now the hard commit gate.
        //
        // Strategy:
        //   recording_url set        → commit immediately (high confidence).
        //   recording_url missing    → ignore the hangup. The poller fires
        //                              call.hangup on every tick that the
        //                              row looks terminal, so as soon as
        //                              recording_url lands on a later
        //                              poll we'll come back here and
        //                              commit. Until then the modal stays
        //                              on customer_on_call — the caller
        //                              sees "Customer on call" exactly
        //                              like the original spec.
        //
        // The previous corroboration window (t.hangupCorroborateMs) is
        // kept only to throttle/log: we log "awaiting recording_url" once
        // per window so the console doesn't spam, but no state change
        // happens on window expiry. Subsequent polls retry naturally.
        const sigCount = countTerminalSignals(call);
        if (sigCount === 0) return;

        function commitHangup() {
          if (pendingHangupTimerRef.current) {
            clearTimeout(pendingHangupTimerRef.current);
            pendingHangupTimerRef.current = null;
          }
          const p = callPhaseRef.current;
          if (p !== 'form_window' && p !== 'form_reason_card') {
            // Per product rule: 45s timer only when the customer hung up.
            // Agent-initiated hangups open the form with no time pressure.
            const runTimer = shouldRunFormTimerFor(call, t.formTimerLongCallThresholdMs);
            setFormTimerEnabled(runTimer);
            setCallPhase('form_window');
            setFormTimerSecs(prev => {
              if (!runTimer) return 0;
              return prev > 0 ? prev : FORM_WINDOW_SECS;
            });
          }
        }

        if (call.recording_url) {
          // Recording finalized → bridge is truly down. Commit.
          commitHangup();
          return;
        }

        // No recording_url yet. Keep waiting on customer_on_call and
        // log the wait (once per window) so the console isn't spammed.
        if (pendingHangupTimerRef.current) return;
        try {
          // eslint-disable-next-line no-console
          console.warn('[caller] hangup terminal signal seen WITHOUT recording_url — waiting for bridge teardown', {
            leadId: lead?.id,
            sigCount,
            signals: {
              ended_at:     !!call.ended_at,
              hangup_by:    !!call.hangup_by,
              duration_sec: call.duration_sec ?? null,
              status:       call.status ?? null,
            },
            waitMs: t.hangupCorroborateMs,
          });
        } catch { /* console may be stripped */ }
        pendingHangupTimerRef.current = setTimeout(() => {
          pendingHangupTimerRef.current = null;
          // Window only throttles the log line — staying on customer_on_call
          // is the correct behaviour. The next poll that brings recording_url
          // will fire commitHangup above.
        }, t.hangupCorroborateMs);
      }
      // If customer never answered, the agent.missed / customer.missed events
      // will arrive separately and drive the right transition.
      return;
    }
  }

  /* Listen to caller-scoped SSE for typed call events. */
  useEffect(() => {
    if (!jwt || !lead?.id) return;
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwt)}`;
    const es  = new EventSource(url);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (!msg?.type) return;
        if (msg.type === 'agent.answered'    || msg.type === 'agent.missed' ||
            msg.type === 'customer.answered' || msg.type === 'customer.missed' ||
            msg.type === 'call.hangup') {
          handleCallEvent(msg.type, msg.call || {});
          return;
        }
        // Backward-compat: legacy generic 'call.update' — derive from status
        if (msg.type === 'call.update' && msg.call) {
          const c = msg.call;
          if (c.agent_answered_at && !wasAgentAnsweredRef.current) handleCallEvent('agent.answered', c);
          if (c.customer_answered_at && !wasCustomerAnsweredRef.current) handleCallEvent('customer.answered', c);
        }
      } catch (_) {}
    };
    es.onerror = () => { /* auto-reconnect */ };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, lead?.id]);

  /* Polling fallback — Tata webhooks arrive with their own provider_call_id
     that doesn't always match the /calls/start row, so a single logical call
     can fragment across multiple `calls` rows in the DB. We aggregate signals
     across the most recent N rows for this lead so a hangup signal landing on
     ANY fragment is enough to advance the state machine. */
  useEffect(() => {
    if (!jwt || !lead?.id) return;
    const ACTIVE = new Set([
      'agent_ringing_1', 'agent_ringing_2', 'customer_ringing',
      'customer_on_call', 'recall_ringing',
    ]);
    if (!ACTIVE.has(callPhase)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/caller/calls?lead_id=${encodeURIComponent(lead.id)}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const since = sessionStartIsoRef.current;
        const all = Array.isArray(data.calls) ? data.calls : [];
        // A timestamp value qualifies as "from this attempt's session" if
        // it occurred at-or-after sessionStartIso. Used both for filtering
        // rows and for filtering individual columns within the merge.
        const fresh = (ts) => ts && (!since || ts >= since);

        // Row-level filter: include a row if it has any session-relevant
        // signal — either its own start, or one of the per-leg timestamps
        // that fired during this session (covers Tata's leg-fragmentation
        // where a customer-leg row was created before sessionStartIso but
        // received customer_answered_at within the session).
        //
        // CRITICAL: do NOT filter by updated_at alone. A stale row from a
        // previous attempt can have its updated_at bumped by a late PCA
        // arrival or catch-all webhook touch — that does not make its
        // stale agent_answered_at suddenly relevant to the current attempt.
        //
        // ALSO CRITICAL: do NOT include a row whose ONLY fresh signal is
        // ended_at. That row is always a previous attempt's hangup arriving
        // late — e.g. after the caller pressed DNP/Recall, the OLD call's
        // hangup webhook lands AFTER sessionStartIso reset. Letting that
        // ended_at into the merge causes the synthesis below to fire a
        // phantom agent.missed (no fresh agent_answered_at anywhere) which
        // jumps the phase from recall_ringing to agent_ringing_2.
        const calls = (since
          ? all.filter(c =>
              fresh(c.started_at) || fresh(c.agent_answered_at) ||
              fresh(c.customer_answered_at) || fresh(c.customer_missed_at)
            )
          : all
        ).slice(0, 6);
        if (cancelled || calls.length === 0) return;

        // Per-column freshness in the merge: each timestamp must itself be
        // from this session. Without this, a row included for one fresh
        // column would leak its other (stale) columns into the merge.
        const merged = {
          id:                   calls[0].id,
          status:               calls[0].status,
          agent_answered_at:    calls.find(c => fresh(c.agent_answered_at))?.agent_answered_at    || null,
          customer_answered_at: calls.find(c => fresh(c.customer_answered_at))?.customer_answered_at || null,
          customer_missed_at:   calls.find(c => fresh(c.customer_missed_at))?.customer_missed_at   || null,
          ended_at:             calls.find(c => fresh(c.ended_at))?.ended_at             || null,
          // recording_url, duration_sec, hangup_by lack their own timestamps
          // so we trust them only when their host row also has at least one
          // fresh timestamp signal (proving the row participated in this
          // attempt — not just got its updated_at bumped by a late event).
          recording_url:        calls.find(c => c.recording_url && (fresh(c.agent_answered_at) || fresh(c.customer_answered_at) || fresh(c.customer_missed_at) || fresh(c.ended_at) || fresh(c.started_at)))?.recording_url || null,
          duration_sec:         calls.find(c => c.duration_sec != null && Number(c.duration_sec) > 0 && (fresh(c.agent_answered_at) || fresh(c.customer_answered_at) || fresh(c.customer_missed_at) || fresh(c.ended_at) || fresh(c.started_at)))?.duration_sec || null,
          hangup_by:            calls.find(c => c.hangup_by && (fresh(c.agent_answered_at) || fresh(c.customer_answered_at) || fresh(c.customer_missed_at) || fresh(c.ended_at) || fresh(c.started_at)))?.hangup_by || null,
        };

        // Process answered events first so the *.missed guards can short-circuit.
        if (merged.agent_answered_at && !wasAgentAnsweredRef.current) {
          handleCallEvent('agent.answered', { ...merged, lead_id: lead.id });
        }
        if (merged.customer_answered_at && !wasCustomerAnsweredRef.current) {
          handleCallEvent('customer.answered', { ...merged, lead_id: lead.id });
        }
        if (merged.customer_missed_at) {
          handleCallEvent('customer.missed', { ...merged, lead_id: lead.id });
        }
        // Detect call-end via any of these database signals.
        const TERMINAL = new Set(['ended','missed','failed']);
        const anyTerminalStatus = calls.some(c => TERMINAL.has(c.status));
        const callEnded = !!merged.ended_at || !!merged.recording_url
          || (merged.duration_sec != null && Number(merged.duration_sec) > 0)
          || anyTerminalStatus;
        if (callEnded) {
          if (!merged.agent_answered_at) handleCallEvent('agent.missed', { ...merged, lead_id: lead.id });
          handleCallEvent('call.hangup', { ...merged, lead_id: lead.id });
        }
      } catch (_) {}
    };
    const id = setInterval(tick, t.recordingPollMs);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, lead?.id, callPhase, t.recordingPollMs]);

  /* Phase-timeout safety net — synthesize agent.missed / customer.missed
     when a ringing phase runs longer than Tata's typical ring window with
     no real webhook arriving. Timeouts are defensive only; if Tata fires
     a real event sooner, the phase will have transitioned and this effect
     will clean up the timer.

     Ring windows used (covers Tata's typical timeout + buffer):
       agent_ringing_*  / recall_ringing → 35 s  (Tata rings agent ~25-30 s)
       customer_ringing                  → 50 s  (Tata rings customer ~30-45 s)
  */
  useEffect(() => {
    if (phaseTimeoutRef.current) {
      clearTimeout(phaseTimeoutRef.current);
      phaseTimeoutRef.current = null;
    }
    const TIMEOUTS = {
      agent_ringing_1: 35000,
      agent_ringing_2: 35000,
      recall_ringing:  35000,
      customer_ringing: 50000,
    };
    const ms = TIMEOUTS[callPhase];
    if (!ms) {
      // Non-ringing phase — clear any stale deadline so it doesn't
      // leak into the snapshot for an unrelated phase.
      if (phaseDeadline != null) setPhaseDeadline(null);
      return;
    }
    // Pick (or seed) the deadline. Scoped by phase: a leftover deadline
    // from a previous ring phase (e.g. agent_ringing_1) is ignored when
    // a new ring phase starts (agent_ringing_2) so the new timer gets
    // a fresh 35s. On a restored mount where the deadline matches the
    // restored phase, we reuse it so the timer fires at the ORIGINAL
    // moment, not 35s later — preventing the post-refresh duplicate-
    // call bug.
    let deadline = (phaseDeadline && phaseDeadline.phase === callPhase)
      ? phaseDeadline.when
      : null;
    if (!deadline) {
      deadline = Date.now() + ms;
      setPhaseDeadline({ phase: callPhase, when: deadline });
    }
    const remaining = Math.max(0, deadline - Date.now());
    phaseTimeoutRef.current = setTimeout(() => {
      phaseTimeoutRef.current = null;
      const p = callPhaseRef.current;
      // Diagnostic: spell out exactly when/why we synthesize a missed
      // event. Pairs with the backend [webhook→sse] log so an empty
      // backend log + this line = "no Tata webhook arrived, safety
      // net fired", while a backend [webhook→sse] line + this absent
      // = "real webhook drove the transition".
      try {
        // eslint-disable-next-line no-console
        console.warn('[caller] synthetic phase-timeout fired', {
          phase: p,
          leadId: lead?.id,
          deadlineMs: deadline,
          plannedMs: ms,
          actualRemainingMs: remaining,
        });
      } catch { /* console may be stripped */ }
      // Build a synthetic call object with a unique id so the dedup signature
      // doesn't collide with any real event for the same call.
      const synthetic = {
        id:        `synthetic-timeout-${Date.now()}`,
        lead_id:   lead.id,
        // Don't include started_at — the stale-event filter shouldn't
        // mistakenly drop our synthetic event.
      };
      if (p === 'customer_ringing') {
        // Customer leg never picked up after agent answered → simulate the
        // customer.missed Tata trigger so retry/DNP runs.
        handleCallEvent('customer.missed', synthetic);
      } else if (p === 'agent_ringing_1' || p === 'agent_ringing_2'
                 || p === 'recall_ringing') {
        // Agent's SmartFlow leg never picked up → simulate the agent.missed
        // signal so handleAgentMissed runs (auto-redial / reason card).
        handleCallEvent('agent.missed', synthetic);
      }
    }, remaining);
    return () => {
      if (phaseTimeoutRef.current) {
        clearTimeout(phaseTimeoutRef.current);
        phaseTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callPhase]);

  /* 30-s form-fill countdown. Strictly gated on form_window — pressing Recall
     (or DNP, or any other phase-shift) flips callPhase away from form_window,
     which tears down this effect immediately. Without the phase gate, a tick
     queued by the browser milliseconds before clearInterval can still fire,
     read the just-zeroed state via the functional updater, and bump phase to
     form_reason_card — leaving the caller staring at a reason card instead of
     the recall banner. */
  useEffect(() => {
    // Gate on formTimerEnabled too: when the agent hung up (not the
    // customer) we set formTimerEnabled=false and want NO countdown and
    // NO auto-advance to form_reason_card. The caller fills the form
    // at their own pace and clicks Complete Call when ready.
    if (callPhase !== 'form_window' || !formTimerEnabled || formTimerSecs <= 0) return;
    const id = setInterval(() => {
      if (callPhaseRef.current !== 'form_window') {
        clearInterval(id);
        return;
      }
      setFormTimerSecs(s => {
        if (s <= 1) {
          clearInterval(id);
          setCallPhase('form_reason_card');
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [callPhase, formTimerEnabled, formTimerSecs > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetCallSignalForNewAttempt() {
    wasAgentAnsweredRef.current = false;
    wasCustomerAnsweredRef.current = false;
    // DON'T clear lastSeenSigsRef — keep dedup history forever so a stale
    // Tata retry of an event from the previous attempt's call.id can't slip
    // past. Tata uses fresh call.ids for each new attempt's events, so this
    // doesn't block legitimate signals.
    sessionStartIsoRef.current = new Date(Date.now() - 2000).toISOString();
    if (customerMissedTimerRef.current) {
      clearTimeout(customerMissedTimerRef.current);
      customerMissedTimerRef.current = null;
    }
    // A new attempt voids any pending hangup corroboration from the
    // previous attempt — the suspected leg-blip is no longer relevant.
    if (pendingHangupTimerRef.current) {
      clearTimeout(pendingHangupTimerRef.current);
      pendingHangupTimerRef.current = null;
    }
  }

  async function postStartCall() {
    // Reentrancy guard — if a previous /calls/start is still in flight, skip
    // this one entirely. Otherwise back-to-back retries (e.g. a stale
    // agent.missed and a customer.missed firing nearly simultaneously) would
    // dial Tata twice and ring two phones for the same lead.
    if (startingCallRef.current) return null;
    startingCallRef.current = true;
    try {
      // Capture the moment we kick off this attempt. Polling only aggregates
      // call rows that started at or after this timestamp so previous calls'
      // end-signals (recording_url, ended_at, duration_sec) can't leak into
      // the current attempt's state machine.
      sessionStartIsoRef.current = new Date(Date.now() - 2000).toISOString();
      const res = await fetch('/api/caller/calls/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to start call');
      // Backend returns { success, call_id, provider_call_id, stubbed }.
      const newCallId = data?.call_id || data?.call?.id || null;
      if (newCallId) {
        setActiveCallId(newCallId);
        activeCallIdRef.current = newCallId;
      }
      return data;
    } finally {
      startingCallRef.current = false;
    }
  }

  /* Caller clicked "Yes & Proceed" on the SmartFlow extension prompt.
     The sessionStorage confirmation timestamp is set only AFTER the
     call actually succeeds — caching a failed confirmation traps the
     caller in a re-mount loop (auto-skip fires → call fails → falls
     back to ext_check → next mount auto-skips again). */
  async function confirmExtensionAndStart() {
    if (recalling) return;
    resetCallSignalForNewAttempt();
    setAgentAttempts(0);
    agentAttemptsRef.current = 0;
    setCustomerAttempt(1);
    customerAttemptRef.current = 1;
    setAgentReasons([]);
    setDelayReasons([]);
    setRecalling(true);
    setRecallToast('');
    setCallPhase('agent_ringing_1');
    try {
      await postStartCall();
      // postStartCall threw? caught below. Otherwise call is in flight
      // — only NOW cache the confirmation. Successful Tata response
      // means the extension is valid.
      try {
        sessionStorage.setItem('mhs_smartflow_confirmed_at', String(Date.now()));
      } catch { /* sessionStorage disabled */ }
    } catch (e) {
      // Drop any stale auto-skip timestamp so the next modal mount
      // shows the card (not a silent auto-retry that would loop on
      // the same Tata rejection). The caller needs to see the toast,
      // not have it disappear under another retry.
      try {
        sessionStorage.removeItem('mhs_smartflow_confirmed_at');
      } catch { /* sessionStorage disabled */ }
      setCallPhase('ext_check');
      // Pass Tata's actual error verbatim — "Invalid Agent Extension
      // Entered" tells the admin the caller's tata_extension field
      // needs fixing; the generic "Smartflo extension off?" hid that
      // diagnosis. Truncate so the toast doesn't overflow.
      const msg = String(e.message || '').slice(0, 160) || 'Call failed';
      setRecallToast(msg);
      setTimeout(() => setRecallToast(''), Math.max(t.recallToastMs || 0, 8000));
    } finally {
      setRecalling(false);
    }
  }

  /* Auto-skip the SmartFlow extension prompt when a recent confirmation
     exists. The caller confirmed once at session start; we don't want
     to nag them on every subsequent lead. The timestamp lives in
     sessionStorage so it resets when the tab closes (a fresh session
     should re-confirm to catch the "I closed and reopened my browser
     but my SmartFlow is now off" case). The TTL is admin-tunable via
     t.smartflowConfirmTtlMs — default 8 hours covers a work-day. */
  useEffect(() => {
    if (callPhase !== 'ext_check') return;
    let ts = 0;
    try {
      const raw = sessionStorage.getItem('mhs_smartflow_confirmed_at');
      if (raw) ts = Number(raw) || 0;
    } catch { /* sessionStorage disabled */ }
    const ttl = Number(t.smartflowConfirmTtlMs) > 0 ? Number(t.smartflowConfirmTtlMs) : 8 * 3600 * 1000;
    if (ts && (Date.now() - ts) < ttl) {
      // Within the confirmation window — skip the prompt and place the
      // call immediately. confirmExtensionAndStart writes a fresh
      // timestamp on its way through, so the TTL slides forward.
      confirmExtensionAndStart();
    }
    // Run once per mount — re-running on phase change would loop the
    // call placement on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

/* Agent missed the SmartFlow ring. attempt 1 → silent auto-redial,
     attempt ≥ 2 → reason card (after 5 reason loops, auto-pause and advance). */
  async function handleAgentMissed() {
    const attempts = agentAttemptsRef.current + 1;
    agentAttemptsRef.current = attempts;
    setAgentAttempts(attempts);

    if (attempts >= agentRetryCap) {
      setCallPhase('auto_paused');
      saveAutoPaused();
      return;
    }

    if (attempts === 1) {
      // First miss: silent auto-redial, banner switches to "Triggering again."
      resetCallSignalForNewAttempt();
      setCallPhase('agent_ringing_2');
      try { await postStartCall(); } catch (_) {}
      return;
    }

    // Second+ miss: ask for reason
    setAgentReason('');
    setCallPhase('agent_reason_card');
  }

  async function submitAgentReason() {
    const reason = agentReason.trim();
    if (!reason) return;
    setAgentReasons(prev => [...prev, reason]);
    setAgentReason('');
    resetCallSignalForNewAttempt();
    setCallPhase('agent_ringing_1');
    try { await postStartCall(); } catch (_) {}
  }

  async function retryCallToCustomer() {
    setCustomerAttempt(2);
    customerAttemptRef.current = 2;
    resetCallSignalForNewAttempt();
    setCallPhase('agent_ringing_1');
    try { await postStartCall(); } catch (_) {}
  }

  // Counts form-window → form_reason_card → form-window cycles on THIS call.
  // After 3 the caller is clearly stuck — pause instead of looping forever.
  const formLoopCountRef = useRef(0);
  function submitDelayReason() {
    const reason = delayReason.trim();
    if (!reason) return;
    setDelayReasons(prev => [...prev, reason]);
    setDelayReason('');
    formLoopCountRef.current += 1;
    if (formLoopCountRef.current > 3) {
      setCallPhase('auto_paused');
      saveAutoPaused();
      return;
    }
    // form_reason_card retry: the caller asked for another 45s window,
    // so make sure the timer is on regardless of the original hangup_by.
    setFormTimerEnabled(true);
    setFormTimerSecs(FORM_WINDOW_SECS);
    setCallPhase('form_window');
  }

  /* DNP — fast-forward when the customer isn't picking up.
       First press : hang up the current Tata call → immediately redial the
                     SAME lead and show the "Second call is triggered" banner.
                     This is treated as another customer-no-answer attempt,
                     never as a caller hangup.
       Second press: save the lead as "not_picked", move it to Do-Not-Picked,
                     and let the parent auto-advance to the next lead. */
  async function handleCutCall() {
    if (cuttingCall) return;
    setCuttingCall(true);
    try {
      if (cutCount === 0) {
        try {
          await fetch(`/api/caller/leads/${lead.id}/hangup`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${jwt}` },
          });
        } catch (_) { /* non-fatal — Tata may have already ended the leg */ }
        resetCallSignalForNewAttempt();
        agentAttemptsRef.current = 0;
        setAgentAttempts(0);
        customerAttemptRef.current = 1;
        setCustomerAttempt(1);
        setFormTimerSecs(0);
        setRecallToast('');
        setDnpRetry(true);
        setCallPhase('recall_ringing');
        await postStartCall();
        setCutCount(1);
      } else {
        // Second DNP press: move the lead straight to Do Not Picked
        // (saves outcome=not_picked) — no intermediate choice card.
        triggerDnp();
      }
    } catch (e) {
      setRecallToast(e?.message || 'DNP failed');
      setTimeout(() => setRecallToast(''), t.recallToastMs);
    } finally {
      setCuttingCall(false);
    }
  }

  /* Manual Recall — caller chose to redial from inside the form window.
     Resets attempt counters (matches DNP first-press behavior): without
     this reset, repeated Recalls during a tough lead can accidentally
     trip the 5-attempt SmartFlow auto-pause cap. */
  async function handleRecall() {
    if (recalling) return;
    setDnpRetry(false);
    resetCallSignalForNewAttempt();
    agentAttemptsRef.current = 0;
    setAgentAttempts(0);
    customerAttemptRef.current = 1;
    setCustomerAttempt(1);
    setFormTimerSecs(0);
    setRecalling(true);
    setRecallToast('');
    setCallPhase('recall_ringing');
    try {
      await postStartCall();
      setRecallToast('Calling…');
      setTimeout(() => setRecallToast(''), t.recallProgressToastMs);
    } catch (e) {
      setRecallToast(e.message || 'Recall failed');
      setTimeout(() => setRecallToast(''), t.recallToastMs);
    } finally {
      setRecalling(false);
    }
  }

  /* Single-shot wrapper for onSaved. The dnp_alert / auto_paused setTimeout
     paths can race with a manual DNP click; this guard ensures the parent
     advances exactly once.

     We compute the live HOT/WARM/COLD/JUNK tag from the current form state
     and bubble it up via `opts.lead_tag` so the parent (and eventually the
     backend) has a single canonical classification per save. */
  function callOnSaved(outcome, opts) {
    if (savedRef.current) return;
    savedRef.current = true;
    // Drop the localStorage form draft now that the note is committed —
    // we don't want yesterday's saved-and-done lead to repopulate if
    // someone reopens it from the Completed Calls list later.
    try { localStorage.removeItem(`mhs_form_draft_${lead?.id || 'x'}`); } catch { /* ignore */ }
    // Classifier output for the "happy path" — otherwise overridden by
    // one of three special cases:
    //   1. Already-Attended shortcut (highest priority) — caller picked
    //      Webinar Attended = Yes on the Interested-Yes path. Lead is
    //      a strong HOT + auto-stamped 'already_attended' subtag,
    //      regardless of what the classifier returns.
    //   2. Subtag present (Not Interested dropdown or second-DNP card)
    //      → forces JUNK so the lead lands in the right bucket.
    //   3. Otherwise the classifier's HOT/WARM/COLD/JUNK output stands.
    const classifierTag = classifyLeadTag({
      confirmedRange, hba1c, takesMedicine,
      webinarAttended, availableForWebinar, nextBatchJoining, patientAge,
      workingProfessional,
    });
    let subtag;
    let leadTag;
    if (alreadyAttendedShortcut) {
      // 1. Shortcut wins outright.
      subtag  = 'already_attended';
      leadTag = 'HOT';
    } else {
      subtag = (opts && opts.outcome_subtag) || interestedSubtag || null;
      // 2. Subtag (Not Interested / second-DNP) forces JUNK.
      // 3. Otherwise classifier's call stands.
      leadTag = subtag ? 'JUNK' : classifierTag;
    }
    onSaved?.(outcome, { ...(opts || {}), lead_tag: leadTag, outcome_subtag: subtag });
  }

  /* Guarded close handler — if the customer was on the call at any point,
     the caller MUST capture an outcome before closing. Hitting X mid-call
     hangs up the live leg and surfaces the standard 30-second form_window
     so the caller fills the form and submits. Without this, abandoned
     calls leave the lead at `last_note_outcome = NULL` indefinitely. */
  function handleCloseClick() {
    // Truly idle — no call in progress AND the customer never connected → there
    // is nothing in flight to save, so just close.
    if (!customerAnsweredOnce && callPhase === 'idle') {
      onClose?.();
      return;
    }
    // Otherwise a call is triggering / ringing (agent_ringing, customer_ringing,
    // recall_ringing, ext_check) OR the customer already connected. Either way,
    // confirm before bailing: OK → hang up the leg, save the partial form as
    // incomplete, and stop the auto-call queue. Cancel → modal stays put.
    setCloseConfirm({ saving: false });
  }

  /* Save the current partial form as outcome='incomplete' and close the
     modal WITHOUT auto-advancing to the next lead. Called when the
     caller confirms the X-close dialog — they explicitly chose to bail,
     so the auto-call loop must stop (autoAdvance: false). The partial
     answers they typed are preserved so admin / TL can follow up. */
  async function confirmCloseAsIncomplete() {
    if (savingIncompleteRef.current) return;     // dedup double-clicks
    savingIncompleteRef.current = true;
    setCloseConfirm(c => (c ? { ...c, saving: true } : c));
    try {
      // Hang up the Tata leg if the audio is somehow still up.
      fetch(`/api/caller/leads/${lead.id}/hangup`, {
        method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
      }).catch(() => {});

      // Best-effort save of whatever the caller filled in. Backend
      // marks 'incomplete' as a NO_CONTACT_OUTCOMES outcome so the
      // discovery-field validations are skipped and any partial value
      // is accepted.
      const sugarConfirmation = confirmedRange
        ? (confirmedRange === lead.sugar_level ? 'same' : 'different')
        : null;
      // Surface backend failures (e.g. constraint violations, 5xx) instead
      // of swallowing them — previously the silent .catch hid the
      // 'incomplete' check-constraint rejection and left the lead at
      // last_note_outcome=NULL while the UI happily auto-advanced.
      try {
        const res = await fetch(`/api/caller/leads/${lead.id}/note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({
            full_name:             (fullName || '').trim() || lead.full_name || null,
            sugar_confirmation:    sugarConfirmation,
            confirmed_range:       confirmedRange || null,
            range_for:             rangeFor || null,
            patient_age:           patientAge || null,
            takes_medicine:        takesMedicine || null,
            note:                  (note || '').trim() || 'Caller closed the form without completing.',
            hba1c:                 hba1c || null,
            working_professional:  workingProfessional || null,
            location:              location || null,
            webinar_attended:      webinarAttended || null,
            available_for_webinar: availableForWebinar || null,
            next_batch_joining:    nextBatchJoining || null,
            outcome:               'incomplete',
            call_id:               activeCallIdRef.current || lead.last_call_id || null,
            interested:            interested === 'yes' || interested === 'no' ? interested : null,
            outcome_subtag:        interestedSubtag || null,
            lead_tag:              null, // leave the classifier alone — caller didn't finish
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // eslint-disable-next-line no-console
          console.error('[saveIncompleteAndClose] POST /note failed', res.status, body);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[saveIncompleteAndClose] network error', err);
      }
    } finally {
      savingIncompleteRef.current = false;
      setCloseConfirm(null);
      // autoAdvance:false → AssignedLeadsModule's onSaved handler will
      // NOT start the next-call countdown. The auto-call queue stops
      // exactly as the user requested.
      callOnSaved('incomplete', { autoAdvance: false });
    }
  }

  /* ── DNP / auto-paused auto-saves ─────────────────────────────────── */
  async function triggerDnp() {
    setCallPhase('dnp_alert');
    // Cancel any pending customer-miss retry timer that might also be
    // counting down; we're moving to DNP now.
    if (customerMissedTimerRef.current) {
      clearTimeout(customerMissedTimerRef.current);
      customerMissedTimerRef.current = null;
    }
    const attempts = Math.max(1, customerAttemptRef.current);
    try {
      await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name: (fullName || lead.full_name || '').trim() || null,
          outcome:   'not_picked',
          note:      buildNoteWithDelays(
            `Auto-marked: customer did not pick after ${attempts} attempt${attempts !== 1 ? 's' : ''}.`,
            delayReasons,
            agentReasons,
          ),
          call_id:   activeCallIdRef.current || lead.last_call_id || null,
        }),
      });
    } catch (_) {}
    fetch(`/api/caller/leads/${lead.id}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
    }).catch(() => {});
    // Brief moment to let the user see the alert before advancing
    setTimeout(() => callOnSaved('not_picked', { autoAdvance: true }), t.dnpAutoAdvanceDelayMs);
  }

  /* JUNK route for the second-DNP card. The three non-DNP options
     (Switch Off / Out of Service / No Ring) save as outcome=not_interested
     with lead_tag=JUNK and the picked subtag, so the lead lands in
     Completed Calls (NOT Do Not Picked) carrying a "JUNK · <reason>" chip
     that the team can later analyse. */
  async function triggerDnpJunk(subtag) {
    if (!subtag) return;
    // Per spec: skip every intermediate overlay (no Tanglish bubble, no
    // robot voice, no countdown card) and hand off DIRECTLY to the
    // parent's celebration overlay — that screen already owns the 10 s
    // ring + Skip wait / Stop buttons, so reproducing them here would
    // double up.
    try { stopRobotClip();          } catch { /* ignore */ }
    try { stopAllRobotGuideAudio(); } catch { /* ignore */ }
    if (customerMissedTimerRef.current) {
      clearTimeout(customerMissedTimerRef.current);
      customerMissedTimerRef.current = null;
    }
    const attempts = Math.max(1, customerAttemptRef.current);
    try {
      await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name: (fullName || lead.full_name || '').trim() || null,
          outcome:   'not_interested',
          note:      buildNoteWithDelays(
            `Auto-marked: ${subtag.replace(/_/g, ' ')} after ${attempts} attempt${attempts !== 1 ? 's' : ''}.`,
            delayReasons,
            agentReasons,
          ),
          call_id:        activeCallIdRef.current || lead.last_call_id || null,
          outcome_subtag: subtag,
          lead_tag:       'JUNK',
          interested:     'no',
        }),
      });
    } catch (_) {}
    fetch(`/api/caller/leads/${lead.id}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
    }).catch(() => {});
    // No setTimeout — advance immediately. AssignedLeadsModule will
    // render its celebration overlay (with the 10 s cooldown) on top of
    // the next lead, picking up lead_tag=JUNK from opts.
    callOnSaved('not_interested', { autoAdvance: true, outcome_subtag: subtag, lead_tag: 'JUNK' });
  }

  async function saveAutoPaused() {
    try {
      await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name: (fullName || lead.full_name || '').trim() || null,
          outcome:   'auto_paused',
          note:      buildNoteWithDelays(
            `Auto-paused after ${agentRetryCap} SmartFlow misses by caller.`,
            delayReasons,
            agentReasons,
          ),
          call_id:   activeCallIdRef.current || lead.last_call_id || null,
        }),
      });
    } catch (_) {}
    fetch(`/api/caller/leads/${lead.id}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
    }).catch(() => {});
    // Block (not advance): the note above already flipped the caller's account
    // to is_active=FALSE on the backend, which pushes a `caller.paused` SSE so
    // CallerShell shows the blocked overlay. autoAdvance:false stops the
    // auto-call loop instead of opening the next lead — otherwise the block is
    // invisible because the next call starts on top of it.
    setTimeout(() => callOnSaved('auto_paused', { autoAdvance: false }), t.dnpAutoPauseDelayMs);
  }

  /* ── Form derived state ───────────────────────────────────────────── */
  const derivedOutcome = wantsFollowUp
    ? 'follow_up'
    : interested === 'yes'
      ? 'completed'
      : interested === 'no'
        ? 'not_interested'
        : '';

  const noOverride        = interested === 'no';
  const followUpOnly      = !noOverride && wantsFollowUp;
  /* Already-Attended shortcut. The product rule: if the customer says
     they already attended a webinar, they're a strong HOT signal —
     they took the funnel action. Skip every other mandatory field,
     auto-tag the lead HOT, and stamp outcome_subtag='already_attended'.
     Activates only on the "Interested = Yes" path (Not Interested
     already has its own subtag flow). */
  const alreadyAttendedShortcut = !noOverride && webinarAttended === 'yes';
  const detailsMandatory  = !noOverride && !wantsFollowUp && !alreadyAttendedShortcut;

  function validate() {
    if (!fullName.trim()) return 'Name cannot be empty.';
    if (interested !== 'yes' && interested !== 'no') {
      return 'Pick Interested — Yes or No.';
    }
    if (noOverride) {
      // Not Interested path: subtag is the ONLY mandatory field.
      // Everything above (range / age / medicine / etc.) is optional.
      if (!interestedSubtag) return 'Pick a reason for "Not interested".';
      return null;
    }
    if (alreadyAttendedShortcut) {
      // Webinar-Attended-Yes shortcut: nothing else is mandatory.
      // Lead saves as HOT + already_attended subtag via callOnSaved.
      return null;
    }
    if (followUpOnly) {
      // Follow-up: the ONLY thing we need is WHEN to call back. No sugar, no
      // discovery fields, no note required.
      if (!followUpAtLocal)               return 'Pick a follow-up date and time.';
      return null;
    }
    if (!confirmedRange)        return 'Pick the patient’s confirmed sugar range.';
    if (!rangeFor)              return 'Pick whether the value is for personal or family use.';
    if (!patientAge)            return 'Pick the patient age range.';
    if (!takesMedicine)         return 'Pick whether the patient takes medicine.';
    if (!workingProfessional)   return 'Pick the patient’s occupation.';
    if (!location)              return 'Pick the patient’s location.';
    if (!webinarAttended)       return 'Pick whether the patient attended the webinar.';
    if (!availableForWebinar)   return 'Pick whether the patient is available for the next webinar.';
    if (!nextBatchJoining)      return 'Pick whether the patient is joining the next batch.';
    return null;
  }

  async function submitDnp() {
    if (!confirm('Are you sure to move this lead to not picked calls?')) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name: fullName.trim() || null,
          outcome:   'not_picked',
          // Preserve any agent-miss reasons + form-delay reasons so the
          // saved record explains why this lead ended up DNP.
          note:      buildNoteWithDelays(
            (note || '').trim() || 'Caller marked as Did Not Pick.',
            delayReasons,
            agentReasons,
          ),
          call_id:   activeCallIdRef.current || lead.last_call_id || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save.');
      fetch(`/api/caller/leads/${lead.id}/hangup`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}` },
      }).catch(() => {});
      callOnSaved('not_picked', { autoAdvance: true });
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    const v = validate();
    if (v) { setError(v); return; }

    let followUpAt = null;
    if (wantsFollowUp && followUpAtLocal) {
      const [date, time] = followUpAtLocal.split('T');
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm, ss = 0] = (time || '').split(':').map(Number);
      const local = new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0);
      followUpAt = local.toISOString();
    }

    setSaving(true);
    setError('');
    try {
      const sugarConfirmation = confirmedRange === lead.sugar_level ? 'same' : 'different';
      const res = await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name:             fullName.trim(),
          sugar_confirmation:    sugarConfirmation,
          confirmed_range:       confirmedRange || null,
          range_for:             rangeFor,
          patient_age:           patientAge,
          takes_medicine:        takesMedicine || null,
          hba1c:                 hba1c || null,
          working_professional:  workingProfessional || null,
          location:              location || null,
          webinar_attended:      webinarAttended || null,
          available_for_webinar: availableForWebinar || null,
          next_batch_joining:    nextBatchJoining || null,
          note:                  buildNoteWithDelays(note, delayReasons, agentReasons),
          outcome:               derivedOutcome,
          follow_up_at:          followUpAt,
          call_id:               activeCallIdRef.current || lead.last_call_id || null,
          interested:            interested || null,
          // Subtag persists the specific decline reason picked from the
          // Not Interested dropdown. JUNK is forced server-side when set.
          outcome_subtag:        interestedSubtag || null,
          // The classifier override mirrors what callOnSaved computes so
          // the leads.lead_tag column reflects the same JUNK badge the
          // caller saw on screen before saving.
          lead_tag:              interestedSubtag ? 'JUNK' : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save.');

      // Cut the live Tata call BEFORE auto-advancing. Awaited (not
      // fire-and-forget) so the current leg is dropped before the parent
      // kicks off the next auto-dial — otherwise the new originate can race
      // the hangup and the old call is left up. Non-fatal: the note is
      // already saved, so a hangup hiccup must not block completion.
      try {
        await fetch(`/api/caller/leads/${lead.id}/hangup`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${jwt}` },
        });
      } catch (_) { /* Tata may have already ended the leg */ }

      callOnSaved(derivedOutcome, { autoAdvance: true });
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  /* ── Render ────────────────────────────────────────────────────────── */
  const overlayPhase = ['ext_check', 'agent_reason_card', 'form_reason_card', 'dnp_alert', 'auto_paused']
    .includes(callPhase) ? callPhase : null;

  return (
    <div
      onClick={e => e.target === e.currentTarget && handleCloseClick()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(15,0,40,0.45)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
        animation: 'fadeIn 200ms ease',
      }}
    >
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
        @keyframes pulseDot { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
        .lcn-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 18px; row-gap: 0; }
        .lcn-form-grid > .lcn-wide { grid-column: 1 / -1; }
        @media (max-width: 720px) {
          .lcn-form-grid { grid-template-columns: 1fr; }
        }
        .lcn-modal { scrollbar-width: none; -ms-overflow-style: none; }
        .lcn-modal::-webkit-scrollbar { width: 0; height: 0; display: none; }
      `}</style>

      <div className="lcn-modal" style={{
        width: '100%', maxWidth: 920, maxHeight: '92vh',
        background: 'rgba(255,255,255,0.97)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderRadius: 12,
        border: '1px solid rgba(147,51,234,0.18)',
        boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
        padding: '24px 22px 18px',
        fontFamily: 'Outfit, sans-serif',
        animation: 'scaleIn 200ms ease',
        overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 style={{ fontWeight: 700, fontSize: '1.05rem', color: '#3B0764', margin: 0 }}>Fill up call details</h2>
            {/* Live HOT / WARM / COLD / JUNK classifier — updates as the
               form's hard-criteria fields change. */}
            <LeadTagBadge
              fields={{
                confirmedRange,
                hba1c,
                takesMedicine,
                webinarAttended,
                availableForWebinar,
                nextBatchJoining,
                patientAge,
                workingProfessional,
              }}
              forceTag={interestedSubtag ? 'JUNK' : null}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* DNP button visibility — single allowlist of phases where
                the button makes sense:
                  • customer_ringing — agent is bridged, customer not yet
                    answered; DNP fast-forwards the wait.
                  • form_window / form_reason_card — call ended; DNP here
                    is the second-press path that opens the JUNK choice
                    card (Switch Off / Out of Service / No Ring / DNP).
                Every other phase HIDES the button entirely:
                  • idle / ext_check / agent_ringing_* / agent_reason_card
                    / recall_ringing — agent hasn't picked up for this
                    attempt yet, so DNP is meaningless.
                  • customer_on_call — live call; we can't let the caller
                    accidentally hang up.
                  • dnp_alert / dnp_choice / auto_paused — overlay covers
                    the form anyway. */}
            {(() => {
              const DNP_VISIBLE_PHASES = new Set([
                'customer_ringing',
                'form_window',
                'form_reason_card',
              ]);
              if (!DNP_VISIBLE_PHASES.has(callPhase)) return null;
              // DNP stays visible even after the customer has answered —
              // the caller might still want to mark the lead as DNP for
              // their own reasons (junk call, dropped line, hostile lead,
              // etc.). The previous `customerAnsweredOnce` hide-guard has
              // been removed at user request so the button is reachable
              // throughout the form_window / form_reason_card phases.
              return (
            <button
              onClick={handleCutCall}
              disabled={cuttingCall}
              aria-label={cutCount === 0 ? 'DNP — redial' : 'DNP — mark and move on'}
              title={cutCount === 0
                ? 'DNP — hang up and redial this lead once more'
                : 'DNP — mark as Did Not Pick and move to the next lead'}
              style={{
                height: 30, padding: '0 12px', borderRadius: 6, border: 'none',
                background: cuttingCall
                  ? 'rgba(220,38,38,0.55)'
                  : 'linear-gradient(135deg,#DC2626,#B91C1C)',
                color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.78rem',
                cursor: cuttingCall ? 'wait' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 5,
                boxShadow: cuttingCall ? 'none' : '0 2px 8px rgba(220,38,38,0.35)',
                whiteSpace: 'nowrap',
              }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                {/* Phone hang-up icon (rotated phone) */}
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)"/>
                <line x1="2" y1="22" x2="22" y2="2"/>
              </svg>
              {cuttingCall ? 'DNP…' : 'DNP'}
            </button>
              );
            })()}
            {/* Recall is only actionable during the 30-s form_window — i.e.,
                customer disconnected and the caller has the timer running.
                During ringing / on-call phases, recalling would interrupt a
                live or in-progress call, so the button is greyed out. */}
            <button
              onClick={handleRecall}
              disabled={recalling || callPhase !== 'form_window' || formTimerSecs <= 0}
              aria-label="Recall lead"
              title={recalling
                ? 'Calling…'
                : (callPhase === 'form_window' && formTimerSecs > 0
                    ? 'Call this lead again'
                    : 'Available only after the customer disconnects and the form timer is running')}
              style={{
                height: 30, padding: '0 12px', borderRadius: 6, border: 'none',
                background: (recalling || callPhase !== 'form_window' || formTimerSecs <= 0)
                  ? 'rgba(22,163,74,0.35)'
                  : 'linear-gradient(135deg,#16A34A,#15803D)',
                color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.78rem',
                cursor: (recalling || callPhase !== 'form_window' || formTimerSecs <= 0) ? 'not-allowed' : 'pointer',
                opacity: (callPhase !== 'form_window' || formTimerSecs <= 0) && !recalling ? 0.6 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 5,
                boxShadow: (recalling || callPhase !== 'form_window' || formTimerSecs <= 0) ? 'none' : '0 2px 8px rgba(22,163,74,0.35)',
                whiteSpace: 'nowrap',
              }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
              {recalling ? 'Calling…' : 'Recall'}
            </button>
            <button onClick={handleCloseClick} aria-label="Close"
              style={{ width: 30, height: 30, borderRadius: 6, border: 'none', background: 'rgba(91,33,182,0.08)', color: '#5B21B6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Lead-context strip — which webinar batch this lead belongs to,
           when the lead registered, and whether this is a follow-up call
           or a missed-call lead (vs a fresh lead). */}
        {(() => {
          const batch = lead?.webinar_name || '—';
          const arrived = lead?.created_at
            ? new Date(lead.created_at).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
                hour: '2-digit', minute: '2-digit', hour12: true })
            : '—';
          const isFollowUp = lead?.last_note_outcome === 'follow_up';
          const isMissed   = !isFollowUp && !!lead?.last_call_customer_missed_at;
          const type = isFollowUp
            ? { label: 'Follow-up call', bg: 'rgba(37,99,235,0.12)',  fg: '#1E40AF' }
            : isMissed
              ? { label: 'Missed call',  bg: 'rgba(217,119,6,0.14)',  fg: '#B45309' }
              : { label: 'New lead',     bg: 'rgba(22,163,74,0.12)',  fg: '#15803D' };
          const chip = (bg, fg) => ({
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 11px', borderRadius: 999,
            fontFamily: 'Outfit, sans-serif', fontSize: '0.74rem', fontWeight: 700,
            background: bg, color: fg, whiteSpace: 'nowrap',
          });
          return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <span style={chip('rgba(91,33,182,0.10)', '#5B21B6')}>📋 Batch: {batch}</span>
              <span style={chip('rgba(91,33,182,0.07)', 'rgba(91,33,182,0.78)')}>🕒 Registered: {arrived}</span>
              <span style={chip(type.bg, type.fg)}>{type.label}</span>
            </div>
          );
        })()}

        {recallToast && (
          <div style={{
            margin: '-6px 0 12px', padding: '8px 12px', borderRadius: 6,
            background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)',
            color: '#15803D', fontSize: '0.80rem', fontWeight: 600,
          }}>{recallToast}</div>
        )}

        <BannerStatus
          phase={callPhase}
          formTimerSecs={formTimerSecs}
          formTimerEnabled={formTimerEnabled}
          totalWindow={FORM_WINDOW_SECS}
          customerAttempt={customerAttempt}
          dnpRetry={dnpRetry}
        />

        <div className="lcn-form-grid">
          <FieldRow label="1. Name" mandatory wide>
            <input type="text" value={fullName} onChange={e => setFullName(e.target.value)}
              placeholder="Patient name" style={inputStyle} maxLength={120} />
          </FieldRow>

          <FieldRow label="2. Phone Number" wide>
            <input type="text" value={phoneNumber ? '+91 ' + phoneNumber : '—'} readOnly
              style={{ ...inputStyle, background: 'rgba(237,234,248,0.50)', cursor: 'default' }} />
          </FieldRow>

          <FieldRow
            label={
              <>
                3. Confirm Range{' '}
                <span style={{ fontWeight: 500, color: 'rgba(91,33,182,0.65)', fontStyle: 'italic' }}>
                  (registered as <span style={{ fontWeight: 700, color: '#3B0764' }}>{lead.sugar_level || '—'}</span>)
                </span>
              </>
            }
            mandatory={detailsMandatory}
          >
            <RadioRow options={RANGES} value={confirmedRange} onChange={setConfirmedRange} wrap />
          </FieldRow>

          <FieldRow label="4. This value is for" mandatory={detailsMandatory}>
            <RadioRow options={RANGE_FOR} value={rangeFor} onChange={setRangeFor} />
          </FieldRow>

          <FieldRow
            label={<>5. Patient Age <RegisteredAs value={lead.age_group} /></>}
            mandatory={detailsMandatory}
          >
            <RadioRow options={AGE_BUCKETS} value={patientAge} onChange={setPatientAge} wrap />
          </FieldRow>

          <FieldRow label="6. HbA1c" hint="(optional)">
            <RadioRow options={HBA1C} value={hba1c} onChange={setHba1c} wrap />
          </FieldRow>

          <FieldRow
            label={<>7. Medicine <RegisteredAs value={lead.on_medication} /></>}
            mandatory={detailsMandatory}
            hint={detailsMandatory ? null : '(optional)'}
          >
            <RadioRow options={MEDICINE} value={takesMedicine} onChange={setTakesMedicine} />
          </FieldRow>

          <FieldRow
            label={<>8. Working Professional <RegisteredAs value={lead.occupation} /></>}
            mandatory={detailsMandatory}
            hint={detailsMandatory ? null : '(optional)'}
          >
            <SelectField value={workingProfessional} onChange={setWorkingProfessional}
              options={WORKING_PROFESSIONAL} placeholder="Select occupation…" />
          </FieldRow>

          <FieldRow label="9. Location" mandatory={detailsMandatory} hint={detailsMandatory ? null : '(optional)'}>
            <SelectField value={location} onChange={setLocation} options={LOCATIONS} placeholder="Select location…" />
          </FieldRow>

          <FieldRow label="10. Webinar Attended" mandatory={detailsMandatory} hint={detailsMandatory ? null : '(optional)'}>
            <RadioRow options={YES_NO} value={webinarAttended} onChange={setWebinarAttended} />
          </FieldRow>

          <FieldRow label="11. Available for Webinar" mandatory={detailsMandatory} hint={detailsMandatory ? null : '(optional)'}>
            <RadioRow options={YES_NO} value={availableForWebinar} onChange={setAvailableForWebinar} />
          </FieldRow>

          <FieldRow label="12. Next Batch Joining" mandatory={detailsMandatory} hint={detailsMandatory ? null : '(optional)'}>
            <RadioRow options={YES_NO} value={nextBatchJoining} onChange={setNextBatchJoining} />
          </FieldRow>

          <FieldRow label="13. Note" mandatory={followUpOnly || noOverride} hint={(followUpOnly || noOverride) ? null : '(optional)'} wide>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder="Anything noteworthy from the conversation…" rows={3}
              style={{
                width: '100%', padding: '10px 12px',
                borderRadius: 6, border: '1px solid rgba(209,196,240,0.7)',
                background: 'rgba(237,234,248,0.30)',
                fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764',
                outline: 'none', resize: 'vertical', boxSizing: 'border-box',
              }} />
          </FieldRow>

          {wantsFollowUp && (
            <FieldRow label="14. Follow-up schedule" mandatory wide>
              <DateTimePicker value={followUpAtLocal} onChange={setFollowUpAtLocal}
                placeholder="Pick the callback date & time" />
            </FieldRow>
          )}

          {error && (
            <div className="lcn-wide" style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 6, padding: '8px 12px', marginTop: 6 }}>
              <p style={{ fontSize: '0.80rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
            </div>
          )}

          <div className="lcn-wide" style={{ marginTop: 18, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.74rem', color: '#3B0764', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Interested <span style={{ color: '#DC2626', marginLeft: 2 }}>*</span>
              </span>
              <div style={{ display: 'flex', background: 'rgba(237,234,248,0.50)', border: '1px solid rgba(209,196,240,0.7)', borderRadius: 8, padding: 4, gap: 4 }}>
                <button type="button"
                  onClick={() => setInterested(interested === 'yes' ? '' : 'yes')}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: 6, border: 'none',
                    background: interested === 'yes' ? '#10B981' : 'transparent',
                    color: interested === 'yes' ? '#fff' : 'rgba(91,33,182,0.65)',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                    cursor: 'pointer',
                    boxShadow: interested === 'yes' ? '0 4px 12px rgba(16,185,129,0.30)' : 'none',
                    transition: 'all 150ms',
                  }}>YES</button>
                <button type="button"
                  onClick={() => {
                    const turningOn = interested !== 'no';
                    setInterested(turningOn ? 'no' : '');
                    if (turningOn) setWantsFollowUp(false);
                  }}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: 6, border: 'none',
                    background: interested === 'no' ? '#DC2626' : 'transparent',
                    color: interested === 'no' ? '#fff' : 'rgba(91,33,182,0.65)',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                    cursor: 'pointer',
                    boxShadow: interested === 'no' ? '0 4px 12px rgba(220,38,38,0.30)' : 'none',
                    transition: 'all 150ms',
                  }}>NO</button>
              </div>
            </div>

            <button type="button"
              onClick={() => {
                // Toggle follow-up. Keep both state updates OUTSIDE the functional
                // updater (calling setInterested inside it is impure and can
                // misfire under StrictMode, leaving follow-up half-set so the form
                // still demanded sugar/discovery fields).
                const turningOn = !wantsFollowUp;
                setWantsFollowUp(turningOn);
                if (turningOn && interested !== 'yes') setInterested('yes');
              }}
              style={{
                flex: '1 1 200px', alignSelf: 'flex-end', height: '2.85rem',
                padding: '0 18px', borderRadius: 8, border: 'none',
                background: wantsFollowUp ? '#F59E0B' : 'rgba(245,158,11,0.10)',
                color: wantsFollowUp ? '#fff' : '#B45309',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.92rem',
                cursor: 'pointer',
                boxShadow: wantsFollowUp ? '0 4px 16px rgba(245,158,11,0.35)' : 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'all 150ms',
              }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              Follow Up
            </button>
          </div>

          {/* Reason for "Not interested" — only visible when the caller
              toggled NO. Mandatory in that case (validate() blocks save
              when missing). Picking a reason forces lead_tag=JUNK via
              the override path in callOnSaved, and the lead lands in
              Completed Calls with a "JUNK · <reason>" chip. */}
          {interested === 'no' && (
            <div className="lcn-wide" style={{ marginTop: 14 }}>
              <FieldRow label="Reason for not interested" mandatory wide>
                <SelectField
                  value={interestedSubtag}
                  onChange={setInterestedSubtag}
                  options={INTERESTED_SUBTAGS}
                  placeholder="Pick a reason…"
                />
              </FieldRow>
            </div>
          )}
        </div>

        {/* Submit */}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.40)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* DNP button removed from the form per design — manual DNP can still
              be triggered via submitDnp() from the auto-call state machine.
              Complete Call is gated on customer having actually answered. */}
          {(() => {
            const interestedSet = interested === 'yes' || interested === 'no';
            const canComplete   = !saving && interestedSet && customerAnsweredOnce;
            return (
              <>
                <button type="button" onClick={submit}
                  disabled={!canComplete}
                  title={!customerAnsweredOnce ? 'Waiting for the customer to attend the call…' : undefined}
                  style={{ width: '100%', height: '2.8rem', borderRadius: 8, border: 'none',
                           background: !canComplete ? 'rgba(5,150,105,0.55)' : '#059669',
                           color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.92rem',
                           cursor: canComplete ? 'pointer' : 'not-allowed',
                           boxShadow: '0 4px 16px rgba(5,150,105,0.35)',
                           opacity: canComplete ? 1 : 0.55 }}>
                  {saving ? 'Saving…' : 'Complete Call'}
                </button>
                {!customerAnsweredOnce && interestedSet && !saving && (
                  <p style={{
                    margin: '6px 0 0', textAlign: 'center', fontSize: '0.74rem',
                    color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit, sans-serif',
                  }}>
                    Complete Call unlocks once the customer answers the call.
                  </p>
                )}
              </>
            );
          })()}
        </div>
      </div>

      {/* Centered overlay above the form for action prompts */}
      {overlayPhase && (
        <CenteredOverlay
          phase={overlayPhase}
          onCancelExt={() => {
            // Cancel = "don't dial right now". Clear the auto-skip
            // confirmation so the next time the caller opens a lead
            // they get the prompt back (instead of a silent retry of
            // the same failing call placement they just dismissed).
            try { sessionStorage.removeItem('mhs_smartflow_confirmed_at'); } catch { /* ignore */ }
            onClose?.();
          }}
          onConfirmExt={confirmExtensionAndStart}
          starting={recalling}
          agentReason={agentReason}
          onAgentReasonChange={setAgentReason}
          onAgentReasonSubmit={submitAgentReason}
          delayReason={delayReason}
          onDelayReasonChange={setDelayReason}
          onDelayReasonSubmit={submitDelayReason}
          totalWindow={FORM_WINDOW_SECS}
          agentAttempts={agentAttempts}
          retryCap={agentRetryCap}
          agentBubbleText={agentNudgeCount >= 1 ? AGENT_REASON_NUDGE : AGENT_REASON_PRIMARY}
          formBubbleText={formNudgeCount >= 1 ? FORM_REASON_NUDGE : FORM_REASON_PRIMARY}
          agentBubblePulse={agentNudgeCount}
          formBubblePulse={formNudgeCount}
          extBubbleText={extNudgeCount >= 1 ? EXT_CHECK_NUDGE : EXT_CHECK_PRIMARY}
          extBubblePulse={extNudgeCount}
          /* Second-DNP choice card props. onChoose receives the picked
             subtag or the literal 'dnp' (the legacy path). */
          onDnpChoose={(value) => {
            if (value === 'dnp') triggerDnp();
            else triggerDnpJunk(value);
          }}
          dnpJunkSubtags={DNP_JUNK_SUBTAGS}
        />
      )}

      {/* Centered themed confirm dialog for the X button. Renders ONLY
          when the caller hit X after the customer connected. OK saves
          the lead as 'incomplete' (auto-call stops); Cancel just hides
          the dialog and leaves the modal where it was. */}
      {closeConfirm && (
        <CloseConfirmDialog
          leadName={(fullName || lead.full_name || 'this lead').trim()}
          saving={!!closeConfirm.saving}
          onCancel={() => { if (!closeConfirm.saving) setCloseConfirm(null); }}
          onConfirm={confirmCloseAsIncomplete}
        />
      )}
    </div>
  );
}

/* ── Close-confirmation dialog ────────────────────────────────────────
   Themed overlay shown when the caller clicks the X button while a
   customer has already connected. Pressing OK saves the lead as
   incomplete AND stops the auto-call queue (the parent receives
   autoAdvance:false from callOnSaved). Pressing Cancel hides the
   dialog without touching anything. Esc = Cancel, Enter = OK. */
function CloseConfirmDialog({ leadName, saving, onCancel, onConfirm }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      if (e.key === 'Enter')  { e.preventDefault(); if (!saving) onConfirm(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm, saving]);

  return (
    <div
      onClick={() => { if (!saving) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9700,
        background: 'rgba(15,0,40,0.55)',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        animation: 'fadeIn 180ms ease',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)',
          background: '#fff',
          borderRadius: 18,
          boxShadow: '0 24px 60px rgba(15,0,40,0.45), 0 4px 12px rgba(15,0,40,0.18)',
          padding: '22px 22px 18px',
          fontFamily: 'Outfit, sans-serif',
          animation: 'scaleIn 180ms ease',
        }}
      >
        {/* Icon + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12,
            background: 'rgba(245,158,11,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8"  x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, color: '#3B0764', fontWeight: 800, fontSize: '1.05rem' }}>
              Close this lead?
            </h3>
            <p style={{ margin: '4px 0 0', color: 'rgba(91,33,182,0.65)', fontSize: '0.82rem' }}>
              The lead will move to <strong>Completed Calls</strong> with the <strong>Incomplete</strong> tag, and the auto-call will stop.
            </p>
          </div>
        </div>

        {/* Lead being closed */}
        <div style={{
          padding: '10px 14px',
          background: 'rgba(237,234,248,0.55)',
          border: '1px solid rgba(209,196,240,0.55)',
          borderRadius: 10,
          margin: '6px 0 16px',
          fontSize: '0.88rem', fontWeight: 700, color: '#3B0764',
        }}>
          {leadName}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            style={{
              padding: '9px 18px', borderRadius: 10,
              border: '1px solid rgba(91,33,182,0.20)',
              background: '#fff', color: '#3B0764',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.55 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            style={{
              padding: '9px 22px', borderRadius: 10,
              border: 'none',
              background: '#5B21B6', color: '#fff',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
              cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: saving ? 'none' : '0 4px 14px rgba(91,33,182,0.32)',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Subcomponents ── */

function FieldRow({ label, mandatory, hint, wide, children }) {
  return (
    <div className={wide ? 'lcn-wide' : undefined} style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={fieldLabelStyle}>{label}</span>
        {mandatory && <span style={{ color: '#DC2626', fontSize: '0.70rem' }}>*</span>}
        {hint && <span style={{ color: 'rgba(91,33,182,0.45)', fontSize: '0.70rem', fontWeight: 500 }}>{hint}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function RadioRow({ options, value, onChange, wrap }) {
  return (
    <div style={{ display: 'flex', flexWrap: wrap ? 'wrap' : 'nowrap', gap: 5 }}>
      {options.map(opt => {
        const selected = value === opt.value;
        return (
          <button key={opt.value} type="button" onClick={() => onChange(opt.value)}
            style={{
              padding: '5px 10px', borderRadius: 5,
              border: selected ? 'none' : '1px solid rgba(91,33,182,0.20)',
              background: selected ? '#5B21B6' : '#fff',
              color: selected ? '#fff' : 'rgba(91,33,182,0.75)',
              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.72rem',
              cursor: 'pointer', whiteSpace: 'nowrap',
              boxShadow: selected ? '0 2px 6px rgba(91,33,182,0.22)' : 'none',
            }}>{opt.label}</button>
        );
      })}
    </div>
  );
}

/* Yellow status banner — the in-flight call message at the top of the modal.
   Action prompts (extension check, reason cards, DNP alert) live in the
   centered overlay rendered separately. */
function BannerStatus({ phase, formTimerSecs, formTimerEnabled = true, totalWindow, customerAttempt, dnpRetry }) {
  const cardBase = {
    marginBottom: 16, padding: '14px 18px',
    borderRadius: 6, border: '1.5px dashed #F59E0B',
    background: 'rgba(254,243,199,0.55)', color: '#92400E',
    fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem', fontWeight: 600,
  };
  const dot = (
    <span style={{
      width: 8, height: 8, borderRadius: '50%', background: '#F59E0B',
      animation: 'pulseDot 1s ease-in-out infinite', flexShrink: 0,
    }} />
  );
  const Row = ({ children }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{children}</div>
  );

  // 'idle' phase intentionally renders nothing — the modal initializes
  // directly to ext_check (fresh start) or agent_ringing_1 (auto-advance),
  // so the in-modal Start Auto Call button has been removed permanently.
  // The parent's "Start Auto-Call" button is now the sole entry point;
  // it opens the modal which lands on the SmartFlow extension overlay.
  if (phase === 'agent_ringing_1') {
    // When this is the SECOND whole-call attempt to the customer (i.e. the
    // first attempt's customer leg never picked up), the wording focuses on
    // the customer angle even though Tata is technically ringing the agent
    // first — the caller's phone is already configured to auto-pick on
    // retry from the user's perspective.
    if (customerAttempt === 2) {
      return <div style={cardBase}><Row>{dot}<span>Second call is triggered. Calling customer…</span></Row></div>;
    }
    return <div style={cardBase}><Row>{dot}<span>Your first call is triggered. Please pick the call.</span></Row></div>;
  }
  if (phase === 'agent_ringing_2') {
    // DNP first-press flow lands here when Tata fires agent.missed during
    // the auto-retry ring. The caller pressed DNP to compensate for Tata's
    // slow customer-missed signal — so the wording must NOT imply the caller
    // failed to pick. Real agent-miss path (no DNP) keeps the original
    // manager-notification wording.
    if (dnpRetry) {
      return (
        <div style={cardBase}>
          <Row>{dot}<span>Second call is triggered. Please pick the call.</span></Row>
        </div>
      );
    }
    return (
      <div style={{ ...cardBase, border: '1.5px dashed #DC2626', background: 'rgba(254,226,226,0.55)', color: '#991B1B' }}>
        <Row>{dot}<span>Triggering the first call again. If you do not pick this call, your manager will be notified.</span></Row>
      </div>
    );
  }
  if (phase === 'customer_ringing') {
    const second = customerAttempt === 2;
    return (
      <div style={cardBase}>
        <Row>{dot}<span>{second ? 'Second call is triggered. Calling customer…' : 'Calling customer…'}</span></Row>
      </div>
    );
  }
  if (phase === 'customer_on_call') {
    return (
      <div style={{ ...cardBase, border: '1.5px dashed #059669', background: 'rgba(220,252,231,0.55)', color: '#065F46' }}>
        <Row><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10B981', animation: 'pulseDot 1s ease-in-out infinite', flexShrink: 0 }} /><span>Customer is on the call.</span></Row>
      </div>
    );
  }
  if (phase === 'recall_ringing') {
    const msg = dnpRetry
      ? 'Second call is triggered. Please pick the call.'
      : 'Recall is triggered. Please pick the call.';
    return <div style={cardBase}><Row>{dot}<span>{msg}</span></Row></div>;
  }
  if (phase === 'form_window') {
    // When the timer is disabled (agent ended the call themselves),
    // we drop the urgency styling entirely and show no countdown digits.
    // The caller fills the form at their own pace.
    if (!formTimerEnabled) {
      return (
        <div style={{
          ...cardBase,
          border: '1.5px solid rgba(91,33,182,0.25)',
          background: 'rgba(237,234,248,0.55)',
          color: '#3B0764',
        }}>
          <Row>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', background: '#5B21B6', flexShrink: 0,
            }} />
            <span>Call ended. Fill the form when you're ready, then press Complete Call.</span>
          </Row>
        </div>
      );
    }
    const urgent = formTimerSecs <= 10;
    return (
      <div style={{
        ...cardBase,
        border: urgent ? '1.5px dashed #DC2626' : cardBase.border,
        background: urgent ? 'rgba(254,226,226,0.55)' : cardBase.background,
        color: urgent ? '#991B1B' : cardBase.color,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <Row>{dot}<span>Customer disconnected the call. Please fill the form within {totalWindow} seconds.</span></Row>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '1.05rem', fontWeight: 800, letterSpacing: '0.04em' }}>
            00:{String(formTimerSecs).padStart(2, '0')}
          </span>
        </div>
      </div>
    );
  }
  return null;
}

/* Centered overlay for prompts that block the form: extension check, reason
   cards, DNP / auto-pause confirmations. */
function CenteredOverlay({
  phase, onCancelExt, onConfirmExt, starting,
  agentReason, onAgentReasonChange, onAgentReasonSubmit,
  delayReason, onDelayReasonChange, onDelayReasonSubmit, totalWindow,
  agentAttempts, retryCap,
  agentBubbleText, formBubbleText, agentBubblePulse = 0, formBubblePulse = 0,
  extBubbleText, extBubblePulse = 0,
  onDnpChoose, dnpJunkSubtags = [],
}) {
  /* Robot speech-bubble text auto-hides 10 s after it (re)appears — the
     functional card stays. `bubbleShown` flips back true whenever the phase
     or a nudge pulse changes, then fades out again. */
  const [bubbleShown, setBubbleShown] = useState(true);
  useEffect(() => {
    setBubbleShown(true);
    const id = setTimeout(() => setBubbleShown(false), 10000);
    return () => clearTimeout(id);
  }, [phase, agentBubblePulse, formBubblePulse, extBubblePulse]);

  const cardStyle = {
    width: '100%', maxWidth: 440,
    background: '#fff', borderRadius: 10,
    boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
    padding: '26px 24px',
    fontFamily: 'Outfit, sans-serif',
    border: '1px solid rgba(147,51,234,0.18)',
  };

  const wrap = (children) => (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9500,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15,0,40,0.55)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        padding: '0 16px',
        animation: 'fadeIn 200ms ease',
      }}
    >
      {children}
    </div>
  );

  if (phase === 'ext_check') {
    return wrap(
      <div style={cardStyle}>
        {/* Robot speech bubble — surfaces a friendly nudge above the title
            when the caller has been sitting on the prompt without acting.
            Visible from the first nudge tick onward (extBubblePulse >= 1),
            re-pops each repeat thanks to the keyed bubbleShown effect, and
            never auto-presses Yes & Proceed — the only paths out remain
            the two manual buttons or the silent self-pause once the nudge
            count exhausts. */}
        {extBubblePulse >= 1 && extBubbleText && (
          <div
            key={`ext-bubble-${extBubblePulse}`}
            style={{
              position: 'relative',
              background: 'linear-gradient(135deg, #FEF3C7, #FDE68A)',
              color: '#78350F',
              padding: '12px 16px',
              borderRadius: 14,
              marginBottom: 18,
              fontFamily: 'Outfit, sans-serif',
              fontSize: '0.86rem',
              fontWeight: 700,
              lineHeight: 1.35,
              textAlign: 'center',
              border: '1px solid rgba(245,158,11,0.45)',
              boxShadow: '0 6px 18px rgba(245,158,11,0.25)',
              opacity: bubbleShown ? 1 : 0.65,
              transition: 'opacity 420ms ease',
              animation: 'extBubblePop 480ms cubic-bezier(0.34,1.56,0.64,1) both',
            }}
          >
            <style>{`
              @keyframes extBubblePop {
                0%   { transform: scale(0.85) translateY(-6px); opacity: 0; }
                60%  { transform: scale(1.03) translateY(0);    opacity: 1; }
                100% { transform: scale(1)    translateY(0);    opacity: 1; }
              }
            `}</style>
            {extBubbleText}
          </div>
        )}

        <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.05rem', color: '#3B0764', textAlign: 'center' }}>
          Is your SmartFlow extension turned on?
        </h3>
        <p style={{ margin: '10px 0 22px', fontSize: '0.86rem', color: 'rgba(91,33,182,0.65)', textAlign: 'center' }}>
          We'll dial the SmartFlow extension first. If it's off, the call won't connect.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={onCancelExt}
            style={{
              flex: 1, height: '2.6rem', borderRadius: 6,
              border: '1px solid rgba(91,33,182,0.25)', background: 'rgba(237,234,248,0.50)',
              color: '#5B21B6', fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer',
            }}>
            Cancel
          </button>
          <button type="button" onClick={onConfirmExt} disabled={starting}
            style={{
              flex: 1.2, height: '2.6rem', borderRadius: 6, border: 'none',
              background: starting ? 'rgba(5,150,105,0.55)' : '#059669',
              color: '#fff', fontWeight: 800, fontSize: '0.88rem',
              cursor: starting ? 'wait' : 'pointer',
              boxShadow: '0 4px 16px rgba(5,150,105,0.35)',
            }}>
            {starting ? 'Calling…' : 'Yes & Proceed'}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'agent_reason_card') {
    return wrap(
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 14, width: '100%', maxWidth: 480,
        fontFamily: 'Outfit, sans-serif',
      }}>
        <style>{`
          @keyframes sadBubblePop {
            0%   { transform: scale(0.6)  translateY(16px); opacity: 0; }
            60%  { transform: scale(1.04) translateY(0);    opacity: 1; }
            100% { transform: scale(1)    translateY(0);    opacity: 1; }
          }
          @keyframes sadBubbleFloat {
            0%, 100% { transform: translateY(0); }
            50%      { transform: translateY(-4px); }
          }
        `}</style>

        {/* Speech bubble — emerges from above the robot's head with a tail
           pointing down to it. */}
        <div style={{
          position: 'relative',
          background: '#fff',
          color: '#3B0764',
          padding: '14px 22px',
          borderRadius: 22,
          maxWidth: 'min(420px, 90vw)',
          textAlign: 'center',
          fontWeight: 700, fontSize: '0.98rem', lineHeight: 1.35,
          boxShadow: '0 12px 32px rgba(15,0,40,0.35), 0 2px 8px rgba(15,0,40,0.18)',
          marginBottom: -10,
          opacity: bubbleShown ? 1 : 0,
          transition: 'opacity 420ms ease',
          animation: 'sadBubblePop 480ms cubic-bezier(0.34,1.56,0.64,1) both, sadBubbleFloat 2.6s ease-in-out 700ms infinite',
        }}>
          {agentBubbleText}
          <div style={{
            position: 'absolute', bottom: -10, left: '50%',
            width: 0, height: 0, transform: 'translateX(-50%)',
            borderLeft:  '12px solid transparent',
            borderRight: '12px solid transparent',
            borderTop:   '12px solid #fff',
            filter: 'drop-shadow(0 4px 4px rgba(15,0,40,0.18))',
          }} />
        </div>

        {/* Sad robot */}
        <div style={{ width: 200, height: 200 }}>
          <Lottie
            animationData={sadBotData}
            loop
            autoplay
            style={{ width: '100%', height: '100%' }}
            rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
          />
        </div>

        {/* Attempt indicator */}
        <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.85)', textAlign: 'center' }}>
          Submitting will retrigger the call. Attempt {agentAttempts + 1} of {retryCap}.
        </div>

        {/* Reason textarea (box option) */}
        <textarea
          value={agentReason}
          onChange={e => onAgentReasonChange(e.target.value)}
          placeholder="e.g. SmartFlow not ready, away from desk…"
          autoFocus rows={3}
          style={{
            width: 'min(420px, 90vw)',
            padding: '12px 14px', borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.40)',
            background: 'rgba(255,255,255,0.95)',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.92rem', color: '#3B0764',
            outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            boxShadow: '0 8px 24px rgba(15,0,40,0.25)',
          }}
        />

        {/* Submit button */}
        <button type="button" onClick={onAgentReasonSubmit} disabled={!agentReason.trim()}
          style={{
            width: 'min(420px, 90vw)',
            height: '2.8rem', borderRadius: 50, border: 'none',
            background: agentReason.trim()
              ? 'linear-gradient(135deg, #DC2626, #B91C1C)'
              : 'rgba(220,38,38,0.35)',
            color: '#fff', fontWeight: 800, fontSize: '0.92rem',
            cursor: agentReason.trim() ? 'pointer' : 'not-allowed',
            boxShadow: agentReason.trim() ? '0 8px 24px rgba(220,38,38,0.40)' : 'none',
            transition: 'transform 140ms ease',
          }}
          onMouseEnter={e => { if (agentReason.trim()) e.currentTarget.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
        >
          Submit Reason &amp; Retry
        </button>
      </div>
    );
  }

  if (phase === 'form_reason_card') {
    return wrap(
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 14, width: '100%', maxWidth: 480,
        fontFamily: 'Outfit, sans-serif',
      }}>
        {/* Reuses the same keyframes injected by the agent_reason_card branch
           — both cards use class-less inline animations referencing
           sadBubblePop / sadBubbleFloat; declared once below for safety. */}
        <style>{`
          @keyframes sadBubblePop {
            0%   { transform: scale(0.6)  translateY(16px); opacity: 0; }
            60%  { transform: scale(1.04) translateY(0);    opacity: 1; }
            100% { transform: scale(1)    translateY(0);    opacity: 1; }
          }
          @keyframes sadBubbleFloat {
            0%, 100% { transform: translateY(0); }
            50%      { transform: translateY(-4px); }
          }
        `}</style>

        {/* Speech bubble */}
        <div style={{
          position: 'relative',
          background: '#fff',
          color: '#3B0764',
          padding: '14px 22px',
          borderRadius: 22,
          maxWidth: 'min(420px, 90vw)',
          textAlign: 'center',
          fontWeight: 700, fontSize: '0.98rem', lineHeight: 1.35,
          boxShadow: '0 12px 32px rgba(15,0,40,0.35), 0 2px 8px rgba(15,0,40,0.18)',
          marginBottom: -10,
          opacity: bubbleShown ? 1 : 0,
          transition: 'opacity 420ms ease',
          animation: 'sadBubblePop 480ms cubic-bezier(0.34,1.56,0.64,1) both, sadBubbleFloat 2.6s ease-in-out 700ms infinite',
        }}>
          {formBubbleText}
          <div style={{
            position: 'absolute', bottom: -10, left: '50%',
            width: 0, height: 0, transform: 'translateX(-50%)',
            borderLeft:  '12px solid transparent',
            borderRight: '12px solid transparent',
            borderTop:   '12px solid #fff',
            filter: 'drop-shadow(0 4px 4px rgba(15,0,40,0.18))',
          }} />
        </div>

        {/* Sad robot */}
        <div style={{ width: 200, height: 200 }}>
          <Lottie
            animationData={sadBotData}
            loop
            autoplay
            style={{ width: '100%', height: '100%' }}
            rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
          />
        </div>

        {/* Restart-timer indicator */}
        <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.85)', textAlign: 'center' }}>
          Submitting restarts the {totalWindow}-second timer.
        </div>

        {/* Reason textarea */}
        <textarea
          value={delayReason}
          onChange={e => onDelayReasonChange(e.target.value)}
          placeholder="e.g. Looking up patient history, asking supervisor…"
          autoFocus rows={3}
          style={{
            width: 'min(420px, 90vw)',
            padding: '12px 14px', borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.40)',
            background: 'rgba(255,255,255,0.95)',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.92rem', color: '#3B0764',
            outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            boxShadow: '0 8px 24px rgba(15,0,40,0.25)',
          }}
        />

        {/* Submit button */}
        <button type="button" onClick={onDelayReasonSubmit} disabled={!delayReason.trim()}
          style={{
            width: 'min(420px, 90vw)',
            height: '2.8rem', borderRadius: 50, border: 'none',
            background: delayReason.trim()
              ? 'linear-gradient(135deg, #DC2626, #B91C1C)'
              : 'rgba(220,38,38,0.35)',
            color: '#fff', fontWeight: 800, fontSize: '0.92rem',
            cursor: delayReason.trim() ? 'pointer' : 'not-allowed',
            boxShadow: delayReason.trim() ? '0 8px 24px rgba(220,38,38,0.40)' : 'none',
            transition: 'transform 140ms ease',
          }}
          onMouseEnter={e => { if (delayReason.trim()) e.currentTarget.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
        >
          Submit Reason
        </button>
      </div>
    );
  }

  if (phase === 'dnp_alert') {
    return wrap(
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, fontFamily: 'Outfit, sans-serif' }}>
        {/* Robot announces the DNP move, then the flow auto-advances to the
           next call (the 1.5 s timer in triggerDnp). */}
        <div style={{
          position: 'relative', background: '#fff', color: '#3B0764',
          padding: '14px 22px', borderRadius: 22, maxWidth: 'min(420px, 90vw)',
          textAlign: 'center', fontWeight: 700, fontSize: '0.98rem', lineHeight: 1.35,
          boxShadow: '0 12px 32px rgba(15,0,40,0.35), 0 2px 8px rgba(15,0,40,0.18)',
          marginBottom: -10,
        }}>
          na itha DNP calls ku move pannre nanba va namma next call pesalam
          <div style={{
            position: 'absolute', bottom: -10, left: '50%',
            width: 0, height: 0, transform: 'translateX(-50%)',
            borderLeft: '12px solid transparent', borderRight: '12px solid transparent',
            borderTop: '12px solid #fff',
            filter: 'drop-shadow(0 4px 4px rgba(15,0,40,0.18))',
          }} />
        </div>
        <div style={{ width: 180, height: 180 }}>
          <Lottie animationData={sadBotData} loop autoplay
            style={{ width: '100%', height: '100%' }}
            rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }} />
        </div>
      </div>
    );
  }

  if (phase === 'auto_paused') {
    return wrap(
      <div style={{ ...cardStyle, textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: '50%', background: 'rgba(91,33,182,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
          </svg>
        </div>
        <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.05rem', color: '#3B0764' }}>
          Account blocked — no response.
        </h3>
        <p style={{ margin: '10px 0 0', fontSize: '0.86rem', color: 'rgba(91,33,182,0.65)' }}>
          You didn't respond to the call card. Ask your TL or admin to resume you.
        </p>
      </div>
    );
  }

  return null;
}

/* Custom searchable dropdown — replaces the native <select> so it
   matches the rest of the CRM (no blue OS highlight, no system font,
   per-row hover + selected pills). Built-in search box auto-focuses
   on open so the caller can type to filter the ~150 location options
   or the 11 occupation options instantly.

   Same API as the old SelectField — { value, onChange, options,
   placeholder } — so every existing call site picks it up unchanged. */
/* Inline "(registered as X)" annotation for form question labels — the
   funnel pre-collects sugar level, age group, medication and occupation
   so the caller can verify each answer against what the lead originally
   registered with. Mirrors the Q3 Confirm Range label pattern that was
   already in place. Renders nothing when the field is empty so brand-
   new leads (or leads that skipped a funnel step) don't show a stray
   "registered as —" line. */
function RegisteredAs({ value, transform }) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return null;
  const display = typeof transform === 'function' ? transform(raw) : raw;
  return (
    <span style={{ fontWeight: 500, color: 'rgba(91,33,182,0.65)', fontStyle: 'italic' }}>
      (registered as <span style={{ fontWeight: 700, color: '#3B0764', fontStyle: 'normal' }}>{display}</span>)
    </span>
  );
}

function SelectField({ value, onChange, options, placeholder }) {
  const [open, setOpen]     = useState(false);
  const [query, setQuery]   = useState('');
  const wrapRef             = useRef(null);
  const inputRef            = useRef(null);

  // Close on outside click + Escape so the panel feels like a real
  // dropdown and never gets stuck behind other UI.
  useEffect(() => {
    if (!open) return undefined;
    function onDocDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);

  // Auto-focus the search box the moment the panel opens, and clear
  // any leftover query from a previous opening.
  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => { try { inputRef.current?.focus(); } catch {} }, 0);
    }
  }, [open]);

  const selected   = options.find(o => o.value === value);
  const triggerLbl = selected ? selected.label : (placeholder || 'Select…');

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(o => String(o.label || '').toLowerCase().includes(q)
                       || String(o.value || '').toLowerCase().includes(q))
    : options;

  function pick(v) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {/* Trigger button — visually mirrors the inputStyle used for the
         text/textarea fields elsewhere in this modal. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', height: '2.6rem', padding: '0 36px 0 12px',
          borderRadius: 6,
          border: open ? '1.5px solid rgba(91,33,182,0.50)' : '1px solid rgba(209,196,240,0.8)',
          background: open ? '#fff' : 'rgba(237,234,248,0.30)',
          color: selected ? '#3B0764' : 'rgba(91,33,182,0.50)',
          fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem',
          fontWeight: selected ? 600 : 500,
          textAlign: 'left',
          cursor: 'pointer', outline: 'none', boxSizing: 'border-box',
          position: 'relative',
          transition: 'border-color 200ms, background 200ms',
        }}
      >
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerLbl}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{
            position: 'absolute', right: 12, top: '50%',
            transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
            transition: 'transform 200ms', pointerEvents: 'none',
          }}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Popover panel */}
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
            background: '#fff',
            borderRadius: 12,
            border: '1px solid rgba(209,196,240,0.60)',
            boxShadow: '0 12px 36px rgba(91,33,182,0.18)',
            padding: 6,
            zIndex: 50,
            maxHeight: 320,
            display: 'flex', flexDirection: 'column',
            fontFamily: 'Outfit, sans-serif',
          }}
        >
          {/* Search box — sticky-top inside the panel. The list below
             scrolls; the search stays put. */}
          <div style={{ position: 'relative', padding: '2px 2px 6px' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.50)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-30%)', pointerEvents: 'none' }}>
              <circle cx="11" cy="11" r="7"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              style={{
                width: '100%', height: '2.1rem',
                padding: '0 12px 0 32px',
                borderRadius: 8,
                border: '1px solid rgba(209,196,240,0.6)',
                background: 'rgba(237,234,248,0.40)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
                color: '#3B0764', outline: 'none', boxSizing: 'border-box',
              }}
              onKeyDown={(e) => {
                // Enter on a single-match list picks it instantly — handy
                // for the location dropdown ("type 'chen' + Enter").
                if (e.key === 'Enter' && filtered.length === 1) {
                  e.preventDefault();
                  pick(filtered[0].value);
                }
              }}
            />
          </div>

          {/* Scrollable options list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 ? (
              <div style={{
                padding: '14px 10px', textAlign: 'center',
                fontSize: '0.80rem', color: 'rgba(91,33,182,0.55)',
                fontStyle: 'italic',
              }}>
                No matches for "{query}"
              </div>
            ) : filtered.map(opt => {
              const isSel = opt.value === value;
              return (
                <DropdownOption
                  key={opt.value}
                  label={opt.label}
                  selected={isSel}
                  onClick={() => pick(opt.value)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* One option row — hover wash, purple-tinted selected state, check
   mark when picked. Extracted so the row can manage its own hover state
   without re-rendering the whole list. */
function DropdownOption({ label, selected, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '8px 12px',
        borderRadius: 8,
        border: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'Outfit, sans-serif',
        fontSize: '0.85rem',
        fontWeight: selected ? 700 : 500,
        color: '#3B0764',
        background: selected
          ? 'rgba(91,33,182,0.10)'
          : hover
            ? 'rgba(237,234,248,0.60)'
            : 'transparent',
        transition: 'background 120ms',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {selected && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
    </button>
  );
}

const fieldLabelStyle = {
  fontSize: '0.80rem',
  fontWeight: 700,
  color: '#3B0764',
};

const inputStyle = {
  width: '100%', height: '2.6rem', padding: '0 12px',
  borderRadius: 6,
  border: '1px solid rgba(209,196,240,0.8)',
  background: 'rgba(237,234,248,0.30)',
  fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem',
  color: '#3B0764', outline: 'none', boxSizing: 'border-box',
};
