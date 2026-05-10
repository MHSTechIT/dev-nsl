import { useState, useEffect, useRef } from 'react';
import DateTimePicker from '../admin/DateTimePicker';

/* ──────────────────────────────────────────────────────────────────────────
   Lead Call Note Modal — opens when caller clicks the pencil icon on a lead.
   Drives a 13-state auto-call workflow that distinguishes caller-leg
   (agent's SmartFlow phone) events from customer-leg events. State is fed
   by typed SSE events the backend emits per Tata webhook trigger.
   ────────────────────────────────────────────────────────────────────────── */

const RANGES = [
  { value: '250+',         label: '250+' },
  { value: '200-250',      label: '200–250' },
  { value: '100-200',      label: '100–200' },
  { value: 'no_diabetes',  label: 'No Diabetes' },
];

const AGE_BUCKETS = [
  { value: '0-18',     label: '0–18' },
  { value: '19-24',    label: '19–24' },
  { value: '25-34',    label: '25–34' },
  { value: '35-44',    label: '35–44' },
  { value: '45-54',    label: '45–54' },
  { value: 'above-54', label: 'Above 54' },
];

const RANGE_FOR  = [{ value: 'personal', label: 'Personal' }, { value: 'family', label: 'For Family' }];
const DIET       = [{ value: 'yes', label: 'Yes' }, { value: 'not_interested', label: 'Not Interested' }];
const MEDICINE   = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
const YES_NO     = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

const HBA1C = [
  { value: 'gt_7_5',    label: 'HbA1c > 7.5' },
  { value: '6_5_to_7_5', label: 'HbA1c 6.5 – 7.5' },
  { value: '5_7_to_6_5', label: 'HbA1c 5.7 – 6.5' },
];

const WORKING_PROFESSIONAL = [
  'Business', 'Daily Wages', 'Unemployed', 'House Wife', 'Private',
  'IT', 'Retired', 'Student', 'Working Professional', 'Government', 'Not Working',
].map(label => ({ value: label.toLowerCase().replace(/\s+/g, '_'), label }));

const LOCATIONS_RAW = [
  'chennai','madurai','bangalore','theni','thiruvallur','salem','thirupur','coimbatore','trichy','vellore',
  'selam','villupuram','kerala','erode','kancheepuram','kanyakumari','viruthunagar','kadaloor','karur',
  'madhurai','namakkal','thirupathur','tanjore','thanjavur','thenkasi','vilupuram','puthukottai','sivagangai',
  'thiruvarur','thoothukudi','chengalpattu','dharmapuri','krishnagiri','pudhukottai','thiruchy',
  'thiruvannamalai','ariyalur','coyamuthur','kadalor','kallakurichi','karnataka','nagapatinam','nagapattinam',
  'ranipettai','thirunelveli','thiruppur','virudhunagar','dindigul','pondicherry','tirunelveli','dindukal',
  'kadalur','kalakurichi','kallakuruchi','kanniyakumari','kumbakonam','mailadurai','namakal','oosur',
  'pondicheery','thiruvanamalai','thuthukodi','thuthukudi','tiruppur','tiruvanamalai','aandhra','combathur',
  'comibatore','dhindukal','kalakuruchi','kerela','mayiladuthurai','neelagiri','nilagiri','perambalur',
  'pollachi','ramanadhapuram','ramnadu','sales','sivakasi','tenkasi','thanjaore','thirunalveli',
  'thirunelvelli','thiruvalur','thiruvanmalai','thiruvaru','thoothukodi','thuthukoodi','trirupur','cuddalore',
  'kirisnagriji','maiyiladurai','nilgiris','vellour','andamaan','andaman','andhra','andra pradhash',
  'chagalpattu','iyambakkam','kadallour','kadallur','kanchipuram','karaikal','karaikkal','karaikudi',
  'karanataka','karnaka','karnata','kirishanagiri','kirishnagiri','kirshnagiri','krishna giri','maharastra',
  'mayiladudurai','mudurai','muduri','munnar','myladudurai','myladurai','nagai','nagalapuram','nangarkovil',
  'nellur','osur','palani','pandichery','pera','permablur','pettaipettai','podicherry','pudhu',
  'pudukkottai','pudukottai','rajapalayam','ramanadu','ramanathanpuram','ranipet','ranipett','salam',
  'sithur','sivagagai','sivaganga','tanjavur','tanjjore','telungana','teni','thanjaur','thanvanamalai',
  'tharmapuri','thirchy','thirichy','thirippathur','thiruchandhur','thirunallvalli','thiruppathur','thirupu',
  'thiruthani','thiruvanandhapuram','thrichy','thricy','tirupattur','trichi','trivhy','ulunthurpettai',
  'vadachennai','vandhavasi','virudachalam','viruthachalam','vithunagar','pondicherry',
];
const LOCATIONS = Array.from(new Set(LOCATIONS_RAW.map(s => s.trim().toLowerCase())))
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

const FORM_WINDOW_SECS = 30;
const AGENT_RETRY_CAP  = 5;   // 5 SmartFlow miss-reason loops before auto-pause

export default function LeadCallNoteModal({ jwt, lead, onClose, onSaved }) {
  const [fullName, setFullName]                   = useState(lead.full_name || '');
  const [confirmedRange, setConfirmedRange]       = useState('');
  const [rangeFor, setRangeFor]                   = useState('personal');
  const [patientAge, setPatientAge]               = useState('');
  const [dietStatus, setDietStatus]               = useState('');
  const [takesMedicine, setTakesMedicine]         = useState('');
  const [note, setNote]                           = useState('');
  const [hba1c, setHba1c]                             = useState('');
  const [otherLanguages, setOtherLanguages]           = useState('');
  const [workingProfessional, setWorkingProfessional] = useState('');
  const [location, setLocation]                       = useState('');
  const [alreadyPaid, setAlreadyPaid]                 = useState('');
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
  // Initial phase decided by whether the parent already kicked off a call:
  //   – No last_call_id → fresh start. Land directly on ext_check overlay
  //     ("Is your SmartFlow extension turned on?"). The legacy idle banner
  //     with its own Start Auto Call button is never shown.
  //   – last_call_id present → auto-advance flow (post-DNP/Complete). Skip
  //     ext_check entirely and reflect the in-flight call as agent_ringing_1.
  const [callPhase, setCallPhase] = useState(() =>
    lead?.last_call_id ? 'agent_ringing_1' : 'ext_check'
  );
  // Sticky flag: true once the customer has answered AT LEAST ONCE during
  // this lead's modal session. Used to gate the Complete Call button — the
  // caller can't submit until the customer actually attends the call.
  // Survives recall flows (resetCallSignalForNewAttempt does NOT clear it),
  // resets only when the modal remounts (i.e. a new lead).
  const [customerAnsweredOnce, setCustomerAnsweredOnce] = useState(false);
  const [agentAttempts, setAgentAttempts]     = useState(0);   // SmartFlow misses this session (0..5)
  const [customerAttempt, setCustomerAttempt] = useState(1);   // 1 or 2 (whole-call retry)
  const [agentReasons, setAgentReasons]       = useState([]);  // appended every reason submit
  const [agentReason, setAgentReason]         = useState('');
  const [delayReasons, setDelayReasons]       = useState([]);
  const [delayReason, setDelayReason]         = useState('');
  const [formTimerSecs, setFormTimerSecs]     = useState(0);
  const [activeCallId, setActiveCallId]       = useState(lead?.last_call_id || null);

  // Refs mirror state for closures inside SSE/poll callbacks
  const callPhaseRef       = useRef(callPhase);
  const agentAttemptsRef   = useRef(0);
  const customerAttemptRef = useRef(1);
  const wasAgentAnsweredRef = useRef(false);
  const wasCustomerAnsweredRef = useRef(false);
  const lastSeenSigsRef    = useRef(new Set());
  const customerMissedTimerRef = useRef(null);
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

    const phase = callPhaseRef.current;
    const agentAnswered    = wasAgentAnsweredRef.current    || !!call?.agent_answered_at;
    const customerAnswered = wasCustomerAnsweredRef.current || !!call?.customer_answered_at;

    if (eventType === 'agent.answered') {
      wasAgentAnsweredRef.current = true;
      // Recall path / form-window: agent picking up means customer was already
      // on the call before the recall flow → jump straight to customer_on_call.
      if (phase === 'recall_ringing' || phase === 'form_window' || phase === 'form_reason_card') {
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
        // Need BOTH timestamps to compute the elapsed gap reliably. Falling
        // back to Date.now() for a missing miss-timestamp would inflate the
        // gap and falsely fire form_window for stale events. If the gap
        // can't be computed, treat as spurious post-answer and ignore.
        const ans  = call?.customer_answered_at ? new Date(call.customer_answered_at).getTime() : null;
        const miss = call?.customer_missed_at   ? new Date(call.customer_missed_at).getTime()   : null;
        const elapsed = (ans != null && miss != null) ? (miss - ans) : 0;
        if (elapsed >= 8000) {
          if (phase !== 'form_window' && phase !== 'form_reason_card') {
            setCallPhase('form_window');
            setFormTimerSecs(prev => (prev > 0 ? prev : FORM_WINDOW_SECS));
          }
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
      if (customerMissedTimerRef.current) clearTimeout(customerMissedTimerRef.current);
      customerMissedTimerRef.current = setTimeout(() => {
        customerMissedTimerRef.current = null;
        if (wasCustomerAnsweredRef.current) return;
        const p = callPhaseRef.current;
        if (PRE_CUSTOMER.includes(p) || POST_DECISION.includes(p)) return;
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
        if (phase !== 'form_window' && phase !== 'form_reason_card') {
          setCallPhase('form_window');
          setFormTimerSecs(prev => (prev > 0 ? prev : FORM_WINDOW_SECS));
        }
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
        const calls = (since
          ? all.filter(c =>
              fresh(c.started_at) || fresh(c.agent_answered_at) ||
              fresh(c.customer_answered_at) || fresh(c.customer_missed_at) ||
              fresh(c.ended_at)
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
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, lead?.id, callPhase]);

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
    if (!ms) return;
    phaseTimeoutRef.current = setTimeout(() => {
      phaseTimeoutRef.current = null;
      const p = callPhaseRef.current;
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
    }, ms);
    return () => {
      if (phaseTimeoutRef.current) {
        clearTimeout(phaseTimeoutRef.current);
        phaseTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callPhase]);

  /* 30-s form-fill countdown. */
  useEffect(() => {
    if (formTimerSecs <= 0) return;
    const id = setInterval(() => {
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
  }, [formTimerSecs > 0]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /* Caller clicked "Yes & Proceed" on the SmartFlow extension prompt. */
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
    } catch (e) {
      setCallPhase('ext_check');
      setRecallToast(e.message || 'Call failed — Smartflo extension off?');
      setTimeout(() => setRecallToast(''), 3500);
    } finally {
      setRecalling(false);
    }
  }

/* Agent missed the SmartFlow ring. attempt 1 → silent auto-redial,
     attempt ≥ 2 → reason card (after 5 reason loops, auto-pause and advance). */
  async function handleAgentMissed() {
    const attempts = agentAttemptsRef.current + 1;
    agentAttemptsRef.current = attempts;
    setAgentAttempts(attempts);

    if (attempts >= AGENT_RETRY_CAP) {
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

  function submitDelayReason() {
    const reason = delayReason.trim();
    if (!reason) return;
    setDelayReasons(prev => [...prev, reason]);
    setDelayReason('');
    setFormTimerSecs(FORM_WINDOW_SECS);
    setCallPhase('form_window');
  }

  /* Manual Recall — caller chose to redial from inside the form window. */
  async function handleRecall() {
    if (recalling) return;
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
      setTimeout(() => setRecallToast(''), 2500);
    } catch (e) {
      setRecallToast(e.message || 'Recall failed');
      setTimeout(() => setRecallToast(''), 3500);
    } finally {
      setRecalling(false);
    }
  }

  /* Single-shot wrapper for onSaved. The dnp_alert / auto_paused setTimeout
     paths can race with a manual DNP click; this guard ensures the parent
     advances exactly once. */
  function callOnSaved(outcome, opts) {
    if (savedRef.current) return;
    savedRef.current = true;
    onSaved?.(outcome, opts);
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
    setTimeout(() => callOnSaved('not_picked', { autoAdvance: true }), 1500);
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
            'Auto-paused after 5 SmartFlow misses by caller.',
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
    setTimeout(() => callOnSaved('auto_paused', { autoAdvance: true }), 1800);
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
  const detailsMandatory  = !noOverride && !wantsFollowUp;

  function validate() {
    if (!fullName.trim()) return 'Name cannot be empty.';
    if (interested !== 'yes' && interested !== 'no') {
      return 'Pick Interested — Yes or No.';
    }
    if (noOverride) {
      if (!note.trim())  return 'Add a brief note about the not-interested reason.';
      return null;
    }
    if (followUpOnly) {
      if (!note.trim())                   return 'Please add a note about the follow-up.';
      if (!followUpAtLocal)               return 'Pick a follow-up date and time.';
      return null;
    }
    if (!confirmedRange) return 'Pick the patient’s confirmed sugar range.';
    if (!rangeFor)       return 'Pick whether the value is for personal or family use.';
    if (!patientAge)     return 'Pick the patient age range.';
    if (!dietStatus)     return 'Select diet preference.';
    if (!takesMedicine)  return 'Pick whether the patient takes medicine.';
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
          diet_status:           dietStatus,
          takes_medicine:        takesMedicine || null,
          hba1c:                 hba1c || null,
          other_languages:       otherLanguages || null,
          working_professional:  workingProfessional || null,
          location:              location || null,
          already_paid:          alreadyPaid || null,
          webinar_attended:      webinarAttended || null,
          available_for_webinar: availableForWebinar || null,
          next_batch_joining:    nextBatchJoining || null,
          note:                  buildNoteWithDelays(note, delayReasons, agentReasons),
          outcome:               derivedOutcome,
          follow_up_at:          followUpAt,
          call_id:               activeCallIdRef.current || lead.last_call_id || null,
          interested:            interested || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save.');

      fetch(`/api/caller/leads/${lead.id}/hangup`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}` },
      }).catch(() => {});

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
      onClick={e => e.target === e.currentTarget && onClose()}
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
        borderRadius: 22,
        border: '1px solid rgba(147,51,234,0.18)',
        boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
        padding: '24px 22px 18px',
        fontFamily: 'Outfit, sans-serif',
        animation: 'scaleIn 200ms ease',
        overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10 }}>
          <div>
            <h2 style={{ fontWeight: 700, fontSize: '1.05rem', color: '#3B0764', margin: 0 }}>Fill up call details</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={handleRecall} disabled={recalling} aria-label="Recall lead"
              title={recalling ? 'Calling…' : 'Call this lead again'}
              style={{
                height: 30, padding: '0 12px', borderRadius: 8, border: 'none',
                background: recalling ? 'rgba(22,163,74,0.50)' : 'linear-gradient(135deg,#16A34A,#15803D)',
                color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.78rem',
                cursor: recalling ? 'wait' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 5,
                boxShadow: recalling ? 'none' : '0 2px 8px rgba(22,163,74,0.35)',
                whiteSpace: 'nowrap',
              }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
              {recalling ? 'Calling…' : 'Recall'}
            </button>
            <button onClick={onClose} aria-label="Close"
              style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'rgba(91,33,182,0.08)', color: '#5B21B6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        {recallToast && (
          <div style={{
            margin: '-6px 0 12px', padding: '8px 12px', borderRadius: 8,
            background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)',
            color: '#15803D', fontSize: '0.80rem', fontWeight: 600,
          }}>{recallToast}</div>
        )}

        <BannerStatus
          phase={callPhase}
          formTimerSecs={formTimerSecs}
          totalWindow={FORM_WINDOW_SECS}
          customerAttempt={customerAttempt}
        />

        <div className="lcn-form-grid">
          <FieldRow label="1. Name" mandatory wide>
            <input type="text" value={fullName} onChange={e => setFullName(e.target.value)}
              placeholder="Patient name" style={inputStyle} maxLength={120} />
          </FieldRow>

          <FieldRow
            label={
              <>
                2. Confirm Range{' '}
                <span style={{ fontWeight: 500, color: 'rgba(91,33,182,0.65)', fontStyle: 'italic' }}>
                  (registered as <span style={{ fontWeight: 700, color: '#3B0764' }}>{lead.sugar_level || '—'}</span>)
                </span>
              </>
            }
            mandatory={detailsMandatory}
          >
            <RadioRow options={RANGES} value={confirmedRange} onChange={setConfirmedRange} wrap />
          </FieldRow>

          <FieldRow label="3. This value is for" mandatory={detailsMandatory}>
            <RadioRow options={RANGE_FOR} value={rangeFor} onChange={setRangeFor} />
          </FieldRow>

          <FieldRow label="4. Patient Age" mandatory={detailsMandatory}>
            <RadioRow options={AGE_BUCKETS} value={patientAge} onChange={setPatientAge} wrap />
          </FieldRow>

          <FieldRow label="5. Diet" mandatory={detailsMandatory}>
            <RadioRow options={DIET} value={dietStatus} onChange={setDietStatus} />
          </FieldRow>

          <FieldRow label="6. Medicine" mandatory={detailsMandatory} hint={detailsMandatory ? null : '(optional)'}>
            <RadioRow options={MEDICINE} value={takesMedicine} onChange={setTakesMedicine} />
          </FieldRow>

          <FieldRow label="7. HbA1c" hint="(optional)">
            <RadioRow options={HBA1C} value={hba1c} onChange={setHba1c} wrap />
          </FieldRow>

          <FieldRow label="8. Other Languages" hint="(optional)">
            <RadioRow options={YES_NO} value={otherLanguages} onChange={setOtherLanguages} />
          </FieldRow>

          <FieldRow label="9. Working Professional" hint="(optional)">
            <SelectField value={workingProfessional} onChange={setWorkingProfessional}
              options={WORKING_PROFESSIONAL} placeholder="Select occupation…" />
          </FieldRow>

          <FieldRow label="10. Location" hint="(optional)">
            <SelectField value={location} onChange={setLocation} options={LOCATIONS} placeholder="Select location…" />
          </FieldRow>

          <FieldRow label="11. Already Paid" hint="(optional)">
            <RadioRow options={YES_NO} value={alreadyPaid} onChange={setAlreadyPaid} />
          </FieldRow>

          <FieldRow label="12. Webinar Attended" hint="(optional)">
            <RadioRow options={YES_NO} value={webinarAttended} onChange={setWebinarAttended} />
          </FieldRow>

          <FieldRow label="13. Available for Webinar" hint="(optional)">
            <RadioRow options={YES_NO} value={availableForWebinar} onChange={setAvailableForWebinar} />
          </FieldRow>

          <FieldRow label="14. Next Batch Joining" hint="(optional)">
            <RadioRow options={YES_NO} value={nextBatchJoining} onChange={setNextBatchJoining} />
          </FieldRow>

          <FieldRow label="15. Note" mandatory={followUpOnly || noOverride} hint={(followUpOnly || noOverride) ? null : '(optional)'} wide>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder="Anything noteworthy from the conversation…" rows={3}
              style={{
                width: '100%', padding: '10px 12px',
                borderRadius: 10, border: '1px solid rgba(209,196,240,0.7)',
                background: 'rgba(237,234,248,0.30)',
                fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764',
                outline: 'none', resize: 'vertical', boxSizing: 'border-box',
              }} />
          </FieldRow>

          {wantsFollowUp && (
            <FieldRow label="16. Follow-up schedule" mandatory wide>
              <DateTimePicker value={followUpAtLocal} onChange={setFollowUpAtLocal}
                placeholder="Pick the callback date & time" />
            </FieldRow>
          )}

          {error && (
            <div className="lcn-wide" style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 10, padding: '8px 12px', marginTop: 6 }}>
              <p style={{ fontSize: '0.80rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
            </div>
          )}

          <div className="lcn-wide" style={{ marginTop: 18, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.74rem', color: '#3B0764', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Interested <span style={{ color: '#DC2626', marginLeft: 2 }}>*</span>
              </span>
              <div style={{ display: 'flex', background: 'rgba(237,234,248,0.50)', border: '1px solid rgba(209,196,240,0.7)', borderRadius: 14, padding: 4, gap: 4 }}>
                <button type="button"
                  onClick={() => setInterested(interested === 'yes' ? '' : 'yes')}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: 10, border: 'none',
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
                    flex: 1, padding: '10px 14px', borderRadius: 10, border: 'none',
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
                setWantsFollowUp(v => {
                  const next = !v;
                  if (next && interested !== 'yes') setInterested('yes');
                  return next;
                });
              }}
              style={{
                flex: '1 1 200px', alignSelf: 'flex-end', height: '2.85rem',
                padding: '0 18px', borderRadius: 14, border: 'none',
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
        </div>

        {/* Submit */}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.40)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" onClick={submitDnp} disabled={saving}
            title="Lead didn't pick up — move to Not Picked"
            style={{ width: '100%', height: '2.5rem', borderRadius: 50,
                     border: '1.5px solid #B45309',
                     background: saving ? 'rgba(245,158,11,0.20)' : 'rgba(245,158,11,0.10)',
                     color: '#B45309', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.86rem',
                     cursor: saving ? 'not-allowed' : 'pointer',
                     letterSpacing: '0.04em' }}>
            DNP — Did Not Pick
          </button>
          {/* Complete Call is gated on customer having actually answered.
              Until the customer attends the call, this button stays
              disabled even if every form field is filled. DNP above is the
              correct path when the customer never picks up. */}
          {(() => {
            const interestedSet = interested === 'yes' || interested === 'no';
            const canComplete   = !saving && interestedSet && customerAnsweredOnce;
            return (
              <>
                <button type="button" onClick={submit}
                  disabled={!canComplete}
                  title={!customerAnsweredOnce ? 'Waiting for the customer to attend the call…' : undefined}
                  style={{ width: '100%', height: '2.8rem', borderRadius: 50, border: 'none',
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
          onCancelExt={onClose}
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
          retryCap={AGENT_RETRY_CAP}
        />
      )}
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
    <div style={{ display: 'flex', flexWrap: wrap ? 'wrap' : 'nowrap', gap: 6 }}>
      {options.map(opt => {
        const selected = value === opt.value;
        return (
          <button key={opt.value} type="button" onClick={() => onChange(opt.value)}
            style={{
              padding: '7px 14px', borderRadius: 10,
              border: selected ? 'none' : '1px solid rgba(91,33,182,0.20)',
              background: selected ? '#5B21B6' : '#fff',
              color: selected ? '#fff' : 'rgba(91,33,182,0.75)',
              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.78rem',
              cursor: 'pointer', whiteSpace: 'nowrap',
              boxShadow: selected ? '0 2px 8px rgba(91,33,182,0.25)' : 'none',
            }}>{opt.label}</button>
        );
      })}
    </div>
  );
}

/* Yellow status banner — the in-flight call message at the top of the modal.
   Action prompts (extension check, reason cards, DNP alert) live in the
   centered overlay rendered separately. */
function BannerStatus({ phase, formTimerSecs, totalWindow, customerAttempt }) {
  const cardBase = {
    marginBottom: 16, padding: '14px 18px',
    borderRadius: 12, border: '1.5px dashed #F59E0B',
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
    return <div style={cardBase}><Row>{dot}<span>Recall is triggered. Please pick the call.</span></Row></div>;
  }
  if (phase === 'form_window') {
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
}) {
  const cardStyle = {
    width: '100%', maxWidth: 440,
    background: '#fff', borderRadius: 18,
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
        <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.05rem', color: '#3B0764', textAlign: 'center' }}>
          Is your SmartFlow extension turned on?
        </h3>
        <p style={{ margin: '10px 0 22px', fontSize: '0.86rem', color: 'rgba(91,33,182,0.65)', textAlign: 'center' }}>
          We'll dial the SmartFlow extension first. If it's off, the call won't connect.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={onCancelExt}
            style={{
              flex: 1, height: '2.6rem', borderRadius: 50,
              border: '1px solid rgba(91,33,182,0.25)', background: 'rgba(237,234,248,0.50)',
              color: '#5B21B6', fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer',
            }}>
            Cancel
          </button>
          <button type="button" onClick={onConfirmExt} disabled={starting}
            style={{
              flex: 1.2, height: '2.6rem', borderRadius: 50, border: 'none',
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
      <div style={cardStyle}>
        <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.05rem', color: '#991B1B', textAlign: 'center' }}>
          Why didn't you pick the call?
        </h3>
        <p style={{ margin: '10px 0 14px', fontSize: '0.82rem', color: 'rgba(91,33,182,0.65)', textAlign: 'center' }}>
          Submitting will retrigger the call. Attempt {agentAttempts + 1} of {retryCap}.
        </p>
        <textarea
          value={agentReason}
          onChange={e => onAgentReasonChange(e.target.value)}
          placeholder="e.g. SmartFlow not ready, away from desk…"
          autoFocus rows={3}
          style={{
            width: '100%', padding: '10px 12px', borderRadius: 10,
            border: '1px solid rgba(220,38,38,0.30)', background: '#fff',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem', color: '#3B0764',
            outline: 'none', resize: 'vertical', boxSizing: 'border-box',
          }}
        />
        <button type="button" onClick={onAgentReasonSubmit} disabled={!agentReason.trim()}
          style={{
            width: '100%', marginTop: 14,
            height: '2.6rem', borderRadius: 50, border: 'none',
            background: agentReason.trim() ? '#B91C1C' : 'rgba(220,38,38,0.30)',
            color: '#fff', fontWeight: 800, fontSize: '0.88rem',
            cursor: agentReason.trim() ? 'pointer' : 'not-allowed',
          }}>
          Submit Reason & Retry
        </button>
      </div>
    );
  }

  if (phase === 'form_reason_card') {
    return wrap(
      <div style={cardStyle}>
        <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.05rem', color: '#991B1B', textAlign: 'center' }}>
          Please enter the reason for not completing the form.
        </h3>
        <p style={{ margin: '10px 0 14px', fontSize: '0.82rem', color: 'rgba(91,33,182,0.65)', textAlign: 'center' }}>
          Submitting restarts the {totalWindow}-second timer.
        </p>
        <textarea
          value={delayReason}
          onChange={e => onDelayReasonChange(e.target.value)}
          placeholder="e.g. Looking up patient history, asking supervisor…"
          autoFocus rows={3}
          style={{
            width: '100%', padding: '10px 12px', borderRadius: 10,
            border: '1px solid rgba(220,38,38,0.30)', background: '#fff',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem', color: '#3B0764',
            outline: 'none', resize: 'vertical', boxSizing: 'border-box',
          }}
        />
        <button type="button" onClick={onDelayReasonSubmit} disabled={!delayReason.trim()}
          style={{
            width: '100%', marginTop: 14,
            height: '2.6rem', borderRadius: 50, border: 'none',
            background: delayReason.trim() ? '#B91C1C' : 'rgba(220,38,38,0.30)',
            color: '#fff', fontWeight: 800, fontSize: '0.88rem',
            cursor: delayReason.trim() ? 'pointer' : 'not-allowed',
          }}>
          Submit Reason
        </button>
      </div>
    );
  }

  if (phase === 'dnp_alert') {
    return wrap(
      <div style={{ ...cardStyle, textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: '50%', background: 'rgba(245,158,11,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#B45309" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/>
          </svg>
        </div>
        <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.05rem', color: '#3B0764' }}>
          The lead has been moved to the 'Did Not Pick' list.
        </h3>
        <p style={{ margin: '10px 0 0', fontSize: '0.86rem', color: 'rgba(91,33,182,0.65)' }}>
          Loading the next lead…
        </p>
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
          Caller couldn't be reached after {retryCap} attempts.
        </h3>
        <p style={{ margin: '10px 0 0', fontSize: '0.86rem', color: 'rgba(91,33,182,0.65)' }}>
          Lead parked. Loading the next lead…
        </p>
      </div>
    );
  }

  return null;
}

function SelectField({ value, onChange, options, placeholder }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', height: '2.6rem', padding: '0 12px',
        borderRadius: 10,
        border: '1px solid rgba(209,196,240,0.8)',
        background: 'rgba(237,234,248,0.30)',
        fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem',
        color: value ? '#3B0764' : 'rgba(91,33,182,0.50)',
        outline: 'none', boxSizing: 'border-box', cursor: 'pointer',
      }}>
      <option value="">{placeholder || 'Select…'}</option>
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

const fieldLabelStyle = {
  fontSize: '0.80rem',
  fontWeight: 700,
  color: '#3B0764',
};

const inputStyle = {
  width: '100%', height: '2.6rem', padding: '0 12px',
  borderRadius: 10,
  border: '1px solid rgba(209,196,240,0.8)',
  background: 'rgba(237,234,248,0.30)',
  fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem',
  color: '#3B0764', outline: 'none', boxSizing: 'border-box',
};
