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
  const [callPhase, setCallPhase] = useState('idle');
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
  const activeCallIdRef    = useRef(lead?.last_call_id || null);
  useEffect(() => { callPhaseRef.current = callPhase; },             [callPhase]);
  useEffect(() => { agentAttemptsRef.current = agentAttempts; },     [agentAttempts]);
  useEffect(() => { customerAttemptRef.current = customerAttempt; }, [customerAttempt]);
  useEffect(() => { activeCallIdRef.current = activeCallId; },       [activeCallId]);

  /* If the modal opened mid-call (parent already kicked off the dial), skip
     the extension prompt and reflect ringing immediately. */
  useEffect(() => {
    if (lead?.last_call_id && callPhase === 'idle') setCallPhase('agent_ringing_1');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.last_call_id]);

  /* Reduce a typed call event into a phase transition. Read from refs so the
     callback (registered once at mount) sees fresh values.

     Tata occasionally fires "Call missed by Customer" even when the customer
     DID answer (likely fired on any premature hangup of the customer leg).
     We treat the per-leg timestamp columns + ref flags as ground truth and
     ignore *.missed events whenever the corresponding *.answered already
     happened on the same call. */
  function handleCallEvent(eventType, call) {
    if (call && call.lead_id && call.lead_id !== lead.id) return;

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
      if (phase === 'recall_ringing' || phase === 'form_window' || phase === 'form_reason_card') {
        setCallPhase('customer_on_call');
      } else {
        setCallPhase('customer_ringing');
      }
      return;
    }

    if (eventType === 'customer.answered') {
      wasCustomerAnsweredRef.current = true;
      setCallPhase('customer_on_call');
      return;
    }

    if (eventType === 'customer.missed') {
      // Tata fires "Call missed by Customer" right after customer.answered
      // (within ~1 s) on every click-to-call, even when the customer picked
      // up. We can't trust this event as a hangup signal at low elapsed
      // times. If the customer DID answer:
      //   – elapsed < 8 s  → spurious post-answer fire, IGNORE
      //   – elapsed ≥ 8 s  → likely the customer hung up after a real call,
      //                       move into form_window (used as a fallback when
      //                       the dedicated /hangup webhook isn't firing).
      if (customerAnswered) {
        const ans = call?.customer_answered_at ? new Date(call.customer_answered_at).getTime() : null;
        const miss = call?.customer_missed_at ? new Date(call.customer_missed_at).getTime() : Date.now();
        const elapsed = ans ? (miss - ans) : 0;
        if (elapsed >= 8000) {
          if (phase !== 'form_window' && phase !== 'form_reason_card') {
            setCallPhase('form_window');
            setFormTimerSecs(prev => (prev > 0 ? prev : FORM_WINDOW_SECS));
          }
        }
        return;
      }
      // Past the decision point already — don't retry from form / DNP / etc.
      if (['form_window','form_reason_card','dnp_alert','auto_paused','recall_ringing'].includes(phase)) return;
      if (customerAttemptRef.current < 2) {
        retryCallToCustomer();
      } else {
        triggerDnp();
      }
      return;
    }

    if (eventType === 'agent.missed') {
      // Agent already picked SmartFlow → not actually a miss; ignore.
      if (agentAnswered) return;
      if (['form_window','form_reason_card','dnp_alert','auto_paused','customer_on_call'].includes(phase)) return;
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

  /* Polling fallback — derive typed events from the latest call row. */
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
        const c = data.calls?.[0];
        if (cancelled || !c) return;
        // Derive missing events from timestamp columns. Always process answered
        // events first so the *.missed guards can short-circuit cleanly.
        if (c.agent_answered_at && !wasAgentAnsweredRef.current) {
          handleCallEvent('agent.answered', { ...c, lead_id: lead.id });
        }
        if (c.customer_answered_at && !wasCustomerAnsweredRef.current) {
          handleCallEvent('customer.answered', { ...c, lead_id: lead.id });
        }
        if (c.customer_missed_at) {
          // After-answer customer_missed_at means Tata fired the trigger on
          // the customer hangup. Use the typed event — the handler routes it
          // to form_window in that case.
          handleCallEvent('customer.missed', { ...c, lead_id: lead.id });
        }
        if (c.ended_at) {
          // Only fire agent.missed if the agent never actually answered.
          if (!c.agent_answered_at) handleCallEvent('agent.missed', { ...c, lead_id: lead.id });
          handleCallEvent('call.hangup', { ...c, lead_id: lead.id });
        }
      } catch (_) {}
    };
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, lead?.id, callPhase]);

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
    lastSeenSigsRef.current = new Set();
  }

  async function postStartCall() {
    const res = await fetch('/api/caller/calls/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ lead_id: lead.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to start call');
    if (data?.call?.id) {
      setActiveCallId(data.call.id);
      activeCallIdRef.current = data.call.id;
    }
    return data;
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

  /* "Start Auto Call" button on the idle banner. */
  function startAutoCall() {
    setCallPhase('ext_check');
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

  /* ── DNP / auto-paused auto-saves ─────────────────────────────────── */
  async function triggerDnp() {
    setCallPhase('dnp_alert');
    try {
      await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name: (fullName || lead.full_name || '').trim() || null,
          outcome:   'not_picked',
          note:      'Auto-marked: customer did not pick after 2 attempts.',
          call_id:   activeCallIdRef.current || lead.last_call_id || null,
        }),
      });
    } catch (_) {}
    fetch(`/api/caller/leads/${lead.id}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
    }).catch(() => {});
    // Brief moment to let the user see the alert before advancing
    setTimeout(() => onSaved?.('not_picked', { autoAdvance: true }), 1500);
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
    setTimeout(() => onSaved?.('auto_paused', { autoAdvance: true }), 1800);
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
          call_id:   activeCallIdRef.current || lead.last_call_id || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save.');
      fetch(`/api/caller/leads/${lead.id}/hangup`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}` },
      }).catch(() => {});
      onSaved?.('not_picked', { autoAdvance: true });
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

      onSaved?.(derivedOutcome, { autoAdvance: true });
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
          starting={recalling}
          onStart={startAutoCall}
          customerAttempt={customerAttempt}
          onEndCall={() => {
            // Manual safety net: caller knows the call ended even if Tata's
            // hangup webhook didn't reach us. Move straight into form_window.
            setCallPhase('form_window');
            setFormTimerSecs(FORM_WINDOW_SECS);
          }}
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
          <button type="button" onClick={submit}
            disabled={saving || !(interested === 'yes' || interested === 'no')}
            style={{ width: '100%', height: '2.8rem', borderRadius: 50, border: 'none',
                     background: saving ? 'rgba(5,150,105,0.55)' : '#059669',
                     color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.92rem',
                     cursor: saving ? 'not-allowed' : 'pointer',
                     boxShadow: '0 4px 16px rgba(5,150,105,0.35)',
                     opacity: (interested === 'yes' || interested === 'no') ? 1 : 0.6 }}>
            {saving ? 'Saving…' : 'Complete Call'}
          </button>
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
function BannerStatus({ phase, formTimerSecs, totalWindow, starting, onStart, customerAttempt, onEndCall }) {
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

  if (phase === 'idle') {
    return (
      <div style={cardBase}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span>Ready to start auto call.</span>
          <button type="button" onClick={onStart} disabled={starting}
            style={{
              padding: '8px 18px', borderRadius: 50, border: 'none',
              background: starting ? 'rgba(245,158,11,0.55)' : '#F59E0B',
              color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '0.84rem',
              cursor: starting ? 'wait' : 'pointer', whiteSpace: 'nowrap',
              boxShadow: starting ? 'none' : '0 4px 12px rgba(245,158,11,0.35)',
            }}>
            {starting ? 'Calling…' : '▶ Start Auto Call'}
          </button>
        </div>
      </div>
    );
  }
  if (phase === 'agent_ringing_1') {
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <Row><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10B981', animation: 'pulseDot 1s ease-in-out infinite', flexShrink: 0 }} /><span>Customer is on the call.</span></Row>
          {onEndCall && (
            <button type="button" onClick={onEndCall}
              title="Click after the customer disconnects, in case the auto-detect misses it"
              style={{
                padding: '6px 14px', borderRadius: 50, border: 'none',
                background: '#059669', color: '#fff',
                fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '0.78rem',
                cursor: 'pointer', whiteSpace: 'nowrap',
                boxShadow: '0 2px 8px rgba(5,150,105,0.35)',
              }}>
              ✓ Call ended → start form timer
            </button>
          )}
        </div>
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
