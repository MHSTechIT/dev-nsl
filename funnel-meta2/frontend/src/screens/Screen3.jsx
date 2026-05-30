import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import { t } from '../translations';
import { computeLeadScore } from '../utils/scoring';
import TopBar from '../components/TopBar';
import Confetti from '../components/Confetti';
import { FlipUnit } from '../components/FlipCard';
import { trackEvent, getVisitorId } from '../utils/trackEvent';
import {
  trackScreenView, trackFieldSelect, trackFieldFocus, trackFieldBlur,
  trackInitiateCheckout, trackAddPaymentInfo, trackAddToCart,
  trackLead, trackContact, trackViewContent, trackButtonClick,
} from '../utils/metaPixel';

const durationOptions = ['new', 'mid', 'long'];
const HALF = 280; // ms per half-flip

/* ─────────────────────────────────────────────────────── styles ── */
const pillStyle = {
  width: '100%', padding: '14px 18px', borderRadius: 50,
  background: 'rgba(237,234,248,0.85)',
  border: '1px solid rgba(255,255,255,0.85)', color: '#3B0764',
  fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.95rem',
  cursor: 'pointer', textAlign: 'center',
  boxShadow: '0 2px 8px rgba(91,33,182,0.10)',
};
const inputStyle = {
  width: '100%', height: '3rem', padding: '0 14px', borderRadius: 12,
  border: '1px solid rgba(209,196,240,0.7)', background: '#fff',
  fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764',
  outline: 'none', transition: 'border-color 200ms',
};
const labelStyle = {
  fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600,
  color: '#4A1A94', display: 'block', marginBottom: 5,
};

/* ─────────────────────────── Birthday confetti: burst + slow fall ── */

/* ─────────────────────────────────────── Webinar countdown ── */
function UrgencyTimer() {
  const [total, setTotal] = useState(300);
  const urgent = total <= 60;
  const mins   = Math.floor(total / 60);
  const secs   = total % 60;

  useEffect(() => {
    if (total <= 0) return;
    const id = setTimeout(() => setTotal(t => t - 1), 1000);
    return () => clearTimeout(id);
  }, [total]);

  const { state } = useFunnel();
  const lang = state.lang;

  return (
    <div style={{ background: urgent ? 'rgba(254,242,242,0.7)' : 'rgba(255,255,255,0.82)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: urgent ? '1px solid rgba(239,68,68,0.25)' : '1px solid rgba(255,255,255,0.6)', boxShadow: '0 4px 24px rgba(91,33,182,0.07)', borderRadius: 18, padding: '16px 20px', transition: 'background 0.4s, border-color 0.4s' }}>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', gap: 3 }}>
        <FlipUnit value={mins} label={lang === 'tamil' ? 'நிமி' : 'Min'} size="lg" />
        <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.4rem', color: urgent ? 'rgba(220,38,38,0.5)' : 'rgba(91,33,182,0.5)', lineHeight: 1, marginTop: 6, userSelect: 'none', transition: 'color 0.4s' }}>:</span>
        <FlipUnit value={secs} label={lang === 'tamil' ? 'வி' : 'Sec'} size="lg" />
      </div>
      {total <= 0 && (
        <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.74rem', color: '#DC2626', fontWeight: 700, textAlign: 'center', marginTop: 10 }}>
          ⚠ {lang === 'tamil' ? 'உடனே சேரவும்!' : 'Offer expired — join immediately!'}
        </p>
      )}
    </div>
  );
}

/* ─────────────────────────────────────── Sand clock icon ── */
function SandClockIcon() {
  return (
    <div style={{ width: 100, height: 100, background: 'rgba(237,234,248,0.70)', borderRadius: 24, border: '1px solid rgba(255,255,255,0.90)', boxShadow: 'inset 0 2px 10px rgba(91,33,182,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <m.div animate={{ rotateZ: [0, 0, 180, 180] }} transition={{ duration: 6, times: [0, 0.75, 0.85, 1], repeat: Infinity, ease: 'easeInOut' }}>
        <svg width="50" height="62" viewBox="0 0 54 66">
          <defs>
            <clipPath id="sc-top"><polygon points="6,6 48,6 48,12 30,32 24,32 6,12" /></clipPath>
            <clipPath id="sc-bot"><polygon points="6,60 48,60 48,54 30,34 24,34 6,54" /></clipPath>
          </defs>
          <polygon points="6,6 48,6 48,12 30,32 30,34 48,54 48,60 6,60 6,54 24,34 24,32 6,12" fill="rgba(237,234,248,0.5)" stroke="rgba(91,33,182,0.55)" strokeWidth="2.2" strokeLinejoin="round" />
          <line x1="4" y1="6" x2="50" y2="6" stroke="rgba(91,33,182,0.65)" strokeWidth="3" strokeLinecap="round" />
          <line x1="4" y1="60" x2="50" y2="60" stroke="rgba(91,33,182,0.65)" strokeWidth="3" strokeLinecap="round" />
          <m.rect x="0" width="54" animate={{ y: [6, 34], height: [28, 0] }} transition={{ duration: 2.6, repeat: Infinity, repeatDelay: 0.8, ease: 'linear' }} clipPath="url(#sc-top)" fill="rgba(91,33,182,0.28)" />
          <m.rect x="0" width="54" animate={{ y: [60, 34], height: [0, 26] }} transition={{ duration: 2.6, repeat: Infinity, repeatDelay: 0.8, ease: 'linear' }} clipPath="url(#sc-bot)" fill="rgba(91,33,182,0.28)" />
          {[0, 1, 2].map(i => (
            <m.circle key={i} cx="27" r="1.3" fill="rgba(91,33,182,0.55)" animate={{ cy: [32, 34], opacity: [0, 1, 0] }} transition={{ duration: 0.45, repeat: Infinity, delay: i * 0.15 }} />
          ))}
        </svg>
      </m.div>
    </div>
  );
}

/* ─────────────────────────────────────── Staggered field ── */
function Field({ index, children }) {
  return (
    <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 + index * 0.065, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </m.div>
  );
}

function validate(fullName, phone, email) {
  const e = {};
  if (!/^[a-zA-Z\s\u0B80-\u0BFF]{2,}$/.test(fullName.trim())) e.fullName = true;
  if (!/^\d{10}$/.test(phone)) e.phone = true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) e.email = true;
  return e;
}

function formatIST(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/* ═══════════════════════════════════════════════ Screen3 ═══ */
export default function Screen3() {
  const { state, dispatch } = useFunnel();
  const lang = state.lang;
  const navigate = useNavigate();

  // phases: teaser | question | form | success | webinar
  const [phase, setPhase] = useState('teaser');
  const [cardRotY, setCardRotY] = useState(0);
  const [cardHeight, setCardHeight] = useState(230);
  const [slideDown, setSlideDown] = useState(false);
  const [wLink, setWLink] = useState('');
  const [showOverlay, setShowOverlay] = useState(false);

  // form
  const [fullName, setFullName] = useState(state.fullName || '');
  const [phone, setPhone] = useState(state.whatsappNumber || '');
  const [email, setEmail] = useState(state.email || '');
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const hasStartedRef = useRef(false);
  const abandonRef = useRef(null);

  useEffect(() => {
    if (!state.sugarLevel) navigate('/', { replace: true });
    // Meta: Screen3 = qualification (diabetes duration) → checkout start.
    // ViewContent narrates the funnel step; InitiateCheckout signals
    // commit intent. Both ride the dedup-event-id so server CAPI can
    // mirror.
    trackScreenView('screen3_duration', {
      sugar_level: state.sugarLevel,
      lang:        state.lang,
    });
    trackViewContent('Diabetes Duration Question', {
      step: 3,
      sugar_level: state.sugarLevel,
    });
    trackInitiateCheckout({
      step: 3,
      sugar_level: state.sugarLevel,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* flip helper: fold to 90°, swap content, unfold back to 0° */
  function doFlip(newPhase, newHeight) {
    setCardRotY(90);
    setTimeout(() => {
      setPhase(newPhase);
      if (newHeight != null) setCardHeight(newHeight);
      setCardRotY(0);
    }, HALF);
  }

  /* auto-flip teaser → question after 800ms */
  useEffect(() => {
    const id = setTimeout(() => doFlip('question', 270), 800);
    return () => clearTimeout(id);
  }, []);

  function handleFirstInput() {
    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      // Meta: AddToCart = user has begun the form (first keystroke).
      // Earlier signal than Lead — Smart Bidding can use it to find
      // buyers who don't necessarily finish in this session.
      trackAddToCart({
        sugar_level:       state.sugarLevel,
        diabetes_duration: state.diabetesDuration,
        content_name:      'Webinar Registration Form',
        content_category:  'form_started',
      });
    }
  }

  function handleSelect(durKey) {
    const durationEventMap = { new: 'duration_new', mid: 'duration_mid', long: 'duration_long' };
    if (durationEventMap[durKey]) trackEvent(durationEventMap[durKey], state.webinarConfig?.next_webinar_at);
    // Meta: stamp the picked value so Smart Bidding sees the granular
    // qualification answer. AddPaymentInfo signals BOTH qualification
    // questions are now answered (sugar + duration) — that's our
    // strongest "commit" intent before name/phone capture.
    trackFieldSelect('diabetes_duration', durKey, {
      sugar_level: state.sugarLevel,
      lang:        state.lang,
    });
    trackAddPaymentInfo({
      sugar_level:       state.sugarLevel,
      diabetes_duration: durKey,
      content_category:  'qualified_lead',
    });
    dispatch({ type: 'SET_DURATION', payload: durKey });
    dispatch({ type: 'SET_NAV_DIRECTION', payload: 'forward' });
    /* grow card first, then flip into form */
    setCardHeight(580);
    setTimeout(() => doFlip('form'), 220);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate(fullName, phone, email);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSubmitting(true); setServerError('');
    clearTimeout(abandonRef.current);

    try {
      const res = await fetch('/api/leads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullName.trim(), whatsapp_number: phone, email: email.trim().toLowerCase(), sugar_level: state.sugarLevel, diabetes_duration: state.diabetesDuration, language_pref: state.lang, visitor_id: getVisitorId(), ...state.utm }),
      });
      const data = await res.json();
      if (res.status === 409) { setServerError(t.screen4.paused[lang]); setSubmitting(false); return; }
      if (!res.ok || !data.success) { setServerError('Something went wrong. Please try again.'); setSubmitting(false); return; }

      dispatch({ type: 'SET_FORM_FIELD', field: 'fullName', value: fullName });
      dispatch({ type: 'SET_FORM_FIELD', field: 'whatsappNumber', value: phone });
      dispatch({ type: 'SET_FORM_FIELD', field: 'email', value: email });
      dispatch({ type: 'SET_SUBMITTED', payload: { leadId: data.lead_id, leadScore: data.lead_score, whatsappGroupLink: data.whatsapp_link } });
      trackEvent('registration_submitted', state.webinarConfig?.next_webinar_at);
      // Meta: Lead — the main conversion event. Carries hashed
      // email + phone via mpTrack opts.user_data (server-side
      // CAPI hashes; client-side fbq sees only custom_data here).
      trackLead({
        leadId:   data.lead_id,
        score:    data.lead_score,
        sugar:    state.sugarLevel,
        duration: state.diabetesDuration,
        lang:     state.lang,
        email:    email.trim().toLowerCase(),
        phone:    phone,
      });
      setWLink(data.whatsapp_link || '');

      /* show overlay immediately; confetti plays on top (z-index 9999) */
      setPhase('success');
      setCardHeight(200);
      setShowOverlay(true);

    } catch {
      setServerError('Network error. Please try again.');
      setSubmitting(false);
    }
  }

  function handleJoinWA() {
    trackEvent('wa_join_clicked', state.webinarConfig?.next_webinar_at);
    // Meta: Contact = downstream channel engagement. Combined with
    // Lead this gives Meta a two-step conversion ladder for Smart
    // Bidding to optimise toward (people who CLICK WA vs. just
    // submit the form).
    trackContact({
      channel:   'whatsapp',
      lead_id:   state.submittedLeadId,
      score:     state.leadScore,
      sugar:     state.sugarLevel,
      duration:  state.diabetesDuration,
    });
    trackButtonClick('join_whatsapp', { screen: 'screen3' });
    stopUrgencyTick();
    /* fire-and-forget: record that this lead clicked the WA button */
    const leadId = state.submittedLeadId;
    if (leadId) {
      fetch(`/api/leads/${leadId}/wa-click`, { method: 'PATCH' }).catch(() => {});
    }
    if (wLink) window.open(wLink, '_blank');
    setSlideDown(true);
    setTimeout(() => navigate('/'), 430);
  }

  const firstName = fullName.trim().split(' ')[0];
  const webinarISO = state.webinarConfig?.next_webinar_at;

  /* card visual style changes per phase */
  const isSolid = phase === 'form' || phase === 'success' || phase === 'webinar';

  return (
    <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="flex flex-col min-h-screen">
      {/* Full-screen confetti — rendered outside the card so it's not clipped */}
      <Confetti
        active={phase === 'success'}
        count={175}
        duration={2200}
        onDone={() => {
          setTimeout(() => {
            setShowOverlay(false);
            doFlip('webinar', 460);
          }, 2400);
        }}
      />

      {/* ── SUCCESS OVERLAY — fixed, appears after confetti ends ── */}
      <AnimatePresence>
        {showOverlay && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{
              position: 'fixed', inset: 0, zIndex: 200,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 20px',
              background: 'rgba(15,0,40,0.48)',
              backdropFilter: 'blur(5px)',
              WebkitBackdropFilter: 'blur(5px)',
            }}
          >
            <m.div
              className="success-card-glow"
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.82, ease: [0.16, 1, 0.3, 1] }}
              style={{
                width: '100%', maxWidth: 420,
                background: 'rgba(255,255,255,0.97)',
                borderRadius: 22,
                border: '1.5px solid rgba(147,51,234,0.30)',
                padding: '42px 28px 38px',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                textAlign: 'center',
              }}
            >
              {/* Check icon — pops in then draws the tick */}
              <m.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.12, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  width: 68, height: 68, borderRadius: '50%',
                  background: 'linear-gradient(135deg,#5B21B6,#9333EA)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 6px 28px rgba(91,33,182,0.40)',
                  marginBottom: 22,
                }}
              >
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                  <m.path
                    d="M5 13l4 4L19 7"
                    stroke="#fff"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ delay: 0.46, duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                  />
                </svg>
              </m.div>

              {/* Title */}
              <m.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.42, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.52rem', color: '#3B0764', lineHeight: 1.2, marginBottom: 10 }}
              >
                {lang === 'tamil' ? `${firstName}, பதிவு வெற்றி!` : `${firstName}, Registration Successful!`}
              </m.p>

              {/* Supporting text */}
              <m.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.58, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', color: 'rgba(91,33,182,0.60)', marginBottom: 18 }}
              >
                {lang === 'tamil' ? 'உங்கள் இலவச இடம் உறுதிப்படுத்தப்பட்டது 🎉' : 'Your free seat has been confirmed 🎉'}
              </m.p>

              {/* Loading hint */}
              <m.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.74, duration: 0.4 }}
                style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.74rem', color: 'rgba(91,33,182,0.38)' }}
              >
                {lang === 'tamil' ? 'வெபினார் விவரங்கள் வருகின்றன...' : 'Webinar details loading...'}
              </m.p>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

      <TopBar
        showBack={phase === 'question' || phase === 'form'}
        step={phase === 'webinar' ? 4 : isSolid ? 3 : 2}
        onBack={() => {
          stopUrgencyTick();
          if (phase === 'form') doFlip('question', 270);
          else navigate('/');
        }}
      />

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '0 16px 28px' }}>

        {/* ── single card that flips in-place ── */}
        <m.div
          animate={{ rotateY: cardRotY, minHeight: cardHeight, y: slideDown ? '110vh' : 0 }}
          transition={{
            rotateY: { duration: HALF / 1000, ease: 'easeInOut' },
            minHeight: { duration: 0.55, ease: [0.34, 1.4, 0.64, 1] },
            y: { duration: 0.42, ease: [0.32, 0, 0.67, 0] },
          }}
          style={{
            width: '100%',
            background: isSolid ? 'rgba(255,255,255,0.97)' : 'rgba(255,255,255,0.82)',
            backdropFilter: isSolid ? 'none' : 'blur(20px)',
            WebkitBackdropFilter: isSolid ? 'none' : 'blur(20px)',
            borderRadius: 22,
            border: '1px solid rgba(255,255,255,0.75)',
            boxShadow: '0 8px 32px rgba(91,33,182,0.14)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >

          {/* ── TEASER ── */}
          {phase === 'teaser' && (
            <div style={{ padding: '36px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 12 }}>
              <SandClockIcon />
              <p style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.4rem', color: '#3B0764', lineHeight: 1.2 }}>
                {lang === 'tamil' ? 'ஒரு கேள்வி மட்டும்...' : 'One last question...'}
              </p>
              <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: 'rgba(91,33,182,0.55)' }}>
                {lang === 'tamil' ? 'உங்கள் இலவச இடம் காத்திருக்கிறது' : 'Your free seat is waiting'}
              </p>
            </div>
          )}

          {/* ── QUESTION ── */}
          {phase === 'question' && (
            <div style={{ padding: '28px 18px 22px' }}>
              <h2 style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.45rem', color: '#3B0764', marginBottom: 20, lineHeight: 1.2 }}>
                {t.screen3.question[lang]}
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {durationOptions.map((key, i) => (
                  <m.button key={key} onClick={() => handleSelect(key)}
                    initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.06 + i * 0.07, duration: 0.28 }}
                    whileTap={{ scale: 0.97 }} style={pillStyle}>
                    {lang === 'tamil' ? t.screen3[`opt${i + 1}Title`].tamil : t.screen3[`opt${i + 1}Title`].english}
                  </m.button>
                ))}
              </div>
              <p style={{ textAlign: 'center', marginTop: 16, fontFamily: 'Outfit, sans-serif', fontSize: '0.68rem', color: 'rgba(91,33,182,0.38)' }}>
                🔒 {lang === 'tamil' ? '100% தனிப்பட்டது & பாதுகாப்பானது' : '100% Private & Secure'}
              </p>
            </div>
          )}

          {/* ── FORM ── */}
          {phase === 'form' && (
            <form onSubmit={handleSubmit} style={{ padding: '22px 18px 24px', display: 'flex', flexDirection: 'column', gap: 13 }}>
              <Field index={0}>
                <h2 style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.45rem', color: '#3B0764', lineHeight: 1.2, marginBottom: 2 }}>
                  {t.screen4.headline[lang]}
                </h2>
              </Field>
              <Field index={1}>
                <label style={labelStyle}>{t.screen4.nameLabel[lang]}</label>
                <input type="text" value={fullName} placeholder={t.screen4.namePlaceholder[lang]} autoCapitalize="words"
                  onChange={e => { setFullName(e.target.value); handleFirstInput(); }}
                  onFocus={() => trackFieldFocus('full_name')}
                  onBlur={() => trackFieldBlur('full_name', fullName)}
                  style={{ ...inputStyle, borderColor: errors.fullName ? 'rgba(248,113,113,0.6)' : undefined }} />
                {errors.fullName && <p style={{ color: '#EF4444', fontSize: '0.72rem', marginTop: 4, fontFamily: 'Outfit,sans-serif' }}>⚠ {t.screen4.errorName[lang]}</p>}
              </Field>
              <Field index={2}>
                <label style={labelStyle}>{t.screen4.phoneLabel[lang]}</label>
                <div style={{ display: 'flex', alignItems: 'center', borderRadius: 12, height: '3rem', overflow: 'hidden', border: errors.phone ? '1px solid rgba(248,113,113,0.6)' : '1px solid rgba(209,196,240,0.7)', background: '#fff' }}>
                  <span style={{ padding: '0 10px', fontFamily: 'Outfit,sans-serif', fontWeight: 600, color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem', borderRight: '1px solid rgba(91,33,182,0.12)', height: '100%', display: 'flex', alignItems: 'center', background: 'rgba(237,234,248,0.5)', flexShrink: 0 }}>+91</span>
                  <input type="tel" inputMode="numeric" value={phone} placeholder="98XXX XXXXX"
                    onChange={e => { setPhone(e.target.value.replace(/\D/g, '').slice(0, 10)); handleFirstInput(); }}
                    onFocus={() => trackFieldFocus('whatsapp_number')}
                    onBlur={() => trackFieldBlur('whatsapp_number', phone)}
                    style={{ flex: 1, padding: '0 10px', fontFamily: 'Outfit,sans-serif', fontSize: '0.9rem', color: '#3B0764', background: 'transparent', border: 'none', outline: 'none' }} />
                  {/^\d{10}$/.test(phone) && <span style={{ paddingRight: 10, color: '#22C55E', fontWeight: 700 }}>✓</span>}
                </div>
                {errors.phone && <p style={{ color: '#EF4444', fontSize: '0.72rem', marginTop: 4, fontFamily: 'Outfit,sans-serif' }}>⚠ {t.screen4.errorPhone[lang]}</p>}
              </Field>
              <Field index={3}>
                <label style={labelStyle}>{t.screen4.emailLabel[lang]}</label>
                <input type="email" value={email} placeholder={t.screen4.emailPlaceholder[lang]}
                  onChange={e => { setEmail(e.target.value); handleFirstInput(); }}
                  onFocus={() => trackFieldFocus('email')}
                  onBlur={() => trackFieldBlur('email', email)}
                  style={{ ...inputStyle, borderColor: errors.email ? 'rgba(248,113,113,0.6)' : undefined }} />
                {errors.email && <p style={{ color: '#EF4444', fontSize: '0.72rem', marginTop: 4, fontFamily: 'Outfit,sans-serif' }}>⚠ {t.screen4.errorEmail[lang]}</p>}
              </Field>
              <Field index={4}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <input type="checkbox" defaultChecked id="consent3" style={{ marginTop: 2, accentColor: '#5B21B6', width: 14, height: 14, flexShrink: 0 }} />
                  <label htmlFor="consent3" style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.7rem', color: 'rgba(91,33,182,0.50)', lineHeight: 1.4 }}>{t.screen4.consent[lang]}</label>
                </div>
              </Field>
              {serverError && <p style={{ color: '#EF4444', fontSize: '0.78rem', fontFamily: 'Outfit,sans-serif', textAlign: 'center' }}>{serverError}</p>}
              <Field index={5}>
                <m.button type="submit" disabled={submitting}
                  animate={submitting ? {} : { scale: [1, 1.02, 1] }}
                  transition={{ repeat: Infinity, repeatDelay: 3, duration: 0.4 }}
                  style={{ width: '100%', height: '3.4rem', background: submitting ? 'rgba(91,33,182,0.55)' : '#5B21B6', border: 'none', borderRadius: 50, color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '1.05rem', cursor: submitting ? 'not-allowed' : 'pointer', boxShadow: '0 4px 22px rgba(91,33,182,0.38)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  {submitting
                    ? <><svg style={{ animation: 'spin 1s linear infinite', width: 18, height: 18 }} viewBox="0 0 24 24" fill="none"><circle opacity="0.25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path opacity="0.75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" /></svg>{t.screen4.submitting[lang]}</>
                    : t.screen4.cta[lang]}
                </m.button>
              </Field>
              <Field index={6}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[{ icon: '🔒', text: t.screen4.trustPrivate[lang] }, { icon: '🚫', text: t.screen4.trustNoSpam[lang] }].map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, borderRadius: 10, padding: '7px 10px', background: 'rgba(237,234,248,0.60)', border: '1px solid rgba(209,196,240,0.5)' }}>
                      <span style={{ fontSize: '0.8rem', flexShrink: 0 }}>{item.icon}</span>
                      <span style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.68rem', color: '#5B21B6', lineHeight: 1.35 }}>{item.text}</span>
                    </div>
                  ))}
                </div>
              </Field>
            </form>
          )}

          {/* ── SUCCESS ── (content handled by overlay; card stays as backdrop) */}
          {phase === 'success' && <div style={{ minHeight: 200 }} />}

          {/* ── WEBINAR ── */}
          {phase === 'webinar' && (
            <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.28 }}
              style={{ padding: '24px 18px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(91,33,182,0.07)', borderRadius: 50, padding: '4px 14px', marginBottom: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22C55E', boxShadow: '0 0 6px #22C55E', display: 'inline-block' }} />
                  <span style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.72rem', fontWeight: 600, color: '#5B21B6' }}>
                    {lang === 'tamil' ? 'நேரடி வெபினார்' : 'LIVE WEBINAR'}
                  </span>
                </div>
                <h2 style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.35rem', color: '#3B0764', lineHeight: 1.25, marginBottom: 6 }}>
                  {lang === 'tamil' ? 'நீரிழிவு மாற்றம் மாஸ்டர்கிளாஸ்' : 'Diabetes Reversal Masterclass'}
                </h2>
                {webinarISO && (
                  <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.8rem', color: 'rgba(91,33,182,0.58)' }}>
                    📅 {formatIST(webinarISO)} IST
                  </p>
                )}
              </div>
              <div style={{ height: 1, background: 'rgba(91,33,182,0.08)' }} />
              <div>
                <p style={{ textAlign: 'center', fontFamily: 'Outfit,sans-serif', fontSize: '0.7rem', fontWeight: 600, color: 'rgba(91,33,182,0.42)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {lang === 'tamil' ? 'உங்கள் இடம் வேறொருவருக்கு போகலாம். இப்போதே சேரவும்!' : 'Your seat may be given to someone else. Join now!'}
                </p>
                <UrgencyTimer />
              </div>
              <div style={{ height: 1, background: 'rgba(91,33,182,0.08)' }} />
              <m.button onClick={handleJoinWA} whileTap={{ scale: 0.97 }}
                animate={{ scale: [1, 1.02, 1] }} transition={{ repeat: Infinity, repeatDelay: 2.5, duration: 0.4 }}
                style={{ width: '100%', height: '3.4rem', background: '#25D366', border: 'none', borderRadius: 50, color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', boxShadow: '0 4px 20px rgba(37,211,102,0.40)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" /></svg>
                {lang === 'tamil' ? 'WhatsApp குழுவில் சேரவும்' : 'Join WhatsApp Group'}
              </m.button>
              <p style={{ textAlign: 'center', fontFamily: 'Outfit,sans-serif', fontSize: '0.7rem', color: 'rgba(91,33,182,0.32)' }}>
                🔒 {lang === 'tamil' ? 'இணைப்பு உங்களுக்காக மட்டுமே' : 'This link is exclusively for you'}
              </p>
            </m.div>
          )}

        </m.div>
      </div>
    </m.div>
  );
}
