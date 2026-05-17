import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import { t } from '../translations';
import { trackEvent, getVisitorId } from '../utils/trackEvent';
import { pixelFormStarted, pixelLead, newEventID, getFbpFbc } from '../utils/pixel';

const slideIn = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18, ease: 'easeIn' } },
};

function validate(fullName, whatsappNumber, email) {
  const errs = {};
  if (!/^[a-zA-Z\s]{2,}$/.test(fullName.trim())) errs.fullName = true;
  if (!/^\d{10}$/.test(whatsappNumber)) errs.whatsappNumber = true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = true;
  return errs;
}

export default function Screen4({ onSubmitted, onClose }) {
  const { state, dispatch } = useFunnel();
  const lang = state.lang;
  const navigate = useNavigate();

  const [fullName, setFullName] = useState(state.fullName);
  const [whatsappNumber, setWhatsappNumber] = useState(state.whatsappNumber);
  const [email, setEmail] = useState(state.email);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 900);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    const handler = (e) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (!state.sugarLevel) { navigate('/', { replace: true }); return; }
    // Pre-warm Render backend so it's ready when user submits
    fetch('/api/health').catch(() => {});
  }, []);

  // Fires once on the first keystroke into any field — tells Meta the
  // user is engaging with the form, not just looking at it.
  const formStartedRef = useRef(false);
  function markFormStarted() {
    if (formStartedRef.current) return;
    formStartedRef.current = true;
    pixelFormStarted(state);
  }

  function handlePhoneInput(e) {
    markFormStarted();
    const val = e.target.value.replace(/\D/g, '').slice(0, 10);
    setWhatsappNumber(val);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate(fullName, whatsappNumber, email);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    setServerError('');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    // Mint Meta CAPI dedup IDs up-front so we send the SAME UUIDs to
    // the backend and to the browser pixel. Same event_id → Meta
    // counts it once across both transports.
    const leadEventID = newEventID();
    const crEventID   = newEventID();
    const { fbp, fbc } = getFbpFbc();

    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          full_name: fullName.trim(),
          whatsapp_number: whatsappNumber,
          email: email.trim().toLowerCase(),
          sugar_level: state.sugarLevel,
          diabetes_duration: state.diabetesDuration || 'mid',
          on_medication: state.onMedication || null,
          age_group: state.ageGroup || null,
          occupation: state.occupation || null,
          language_pref: state.lang,
          visitor_id: getVisitorId(),
          // Meta CAPI dedup keys
          meta_event_id: leadEventID,
          meta_event_id_cr: crEventID,
          fbp,
          fbc,
          event_source_url: window.location.href,
          ...state.utm,
        }),
      });
      clearTimeout(timeout);

      const data = await res.json();

      if (res.status === 409) {
        setServerError(t.screen4.paused[lang]);
        setSubmitting(false);
        return;
      }
      if (!res.ok || !data.success) {
        setServerError('Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }

      dispatch({ type: 'SET_FORM_FIELD', field: 'fullName', value: fullName });
      dispatch({ type: 'SET_FORM_FIELD', field: 'whatsappNumber', value: whatsappNumber });
      dispatch({ type: 'SET_FORM_FIELD', field: 'email', value: email });
      dispatch({
        type: 'SET_SUBMITTED',
        payload: { leadId: data.lead_id, leadScore: data.lead_score, whatsappGroupLink: data.whatsapp_link },
      });

      trackEvent('registration_submitted', state.webinarConfig?.next_webinar_at);
      // Meta Pixel (browser): Lead + CompleteRegistration with Advanced
      // Matching and the same event_ids the backend will use for CAPI
      // — that's what makes them dedupe in Events Manager.
      pixelLead(
        { fullName, email, whatsappNumber, leadScore: data.lead_score },
        state,
        { leadEventID, crEventID },
      );
      setSubmitting(false);
      if (data.lead_id) localStorage.setItem('mhs_lead_id', data.lead_id);
      if (onSubmitted) onSubmitted(data.lead_id);
      else navigate(`/whatsapp?lead_id=${data.lead_id}`);
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        setServerError('Server is taking too long. Please try again in a moment.');
      } else {
        setServerError('Network error. Please try again.');
      }
      setSubmitting(false);
    }
  }

  const isPhoneValid = /^\d{10}$/.test(whatsappNumber);

  const webinarISO = state.webinarConfig?.current_webinar_date || state.webinarConfig?.next_webinar_at;
  const seatDateLabel = (() => {
    if (!webinarISO) return '';
    const d = new Date(webinarISO);
    if (isNaN(d.getTime())) return '';
    const date = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
    const time = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
    return `${date} · ${time} IST`;
  })();

  const inputBase = (hasError) => ({
    width: '100%', height: '3.2rem',
    padding: '0 18px',
    borderRadius: 50,
    border: hasError ? '1px solid rgba(248,113,113,0.55)' : '1px solid rgba(139,92,246,0.22)',
    background: '#fff',
    fontSize: '0.95rem',
    fontFamily: 'Outfit, sans-serif',
    color: '#2d0a6e',
    outline: 'none',
    transition: 'border-color 180ms',
  });

  const cardInner = (
    <>
      {/* Close ✕ */}
        <button
          type="button"
          onClick={() => { if (onClose) onClose(); else navigate('/'); }}
          aria-label="Close"
          style={{
            position: 'absolute', top: 12, right: 12,
            width: 30, height: 30, borderRadius: '50%',
            background: 'transparent', border: 'none',
            color: '#7c5cbf', fontSize: '1.05rem', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1,
          }}
        >✕</button>

        {/* Headline */}
        <h1 style={{
          fontFamily: '"Montserrat", "Outfit", sans-serif', fontWeight: 800,
          fontSize: '1.55rem', color: '#2d0a6e',
          textAlign: 'center', margin: '6px 0 4px', lineHeight: 1.2,
        }}>
          You're almost in <span style={{ fontWeight: 600 }}>✨</span>
        </h1>
        <p style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem',
          color: 'rgba(91,33,182,0.65)', textAlign: 'center',
          margin: '0 0 16px',
        }}>
          Where should we send your Zoom link?
        </p>

        {/* YOUR SEAT block */}
        <div style={{
          background: '#FFEFE3',
          border: '1px solid rgba(247,164,109,0.45)',
          borderRadius: 12,
          padding: '12px 14px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}>
          <div style={{ minWidth: 0 }}>
            <p style={{
              fontFamily: 'Outfit, sans-serif', fontSize: '0.66rem', fontWeight: 700,
              color: 'rgba(91,33,182,0.65)', letterSpacing: '0.08em',
              margin: '0 0 3px',
            }}>YOUR SEAT</p>
            <p style={{
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.92rem',
              color: '#2d0a6e', margin: 0, lineHeight: 1.25,
            }}>
              {seatDateLabel || 'Next live workshop'}
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
            <span style={{
              fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem',
              color: 'rgba(91,33,182,0.55)', textDecoration: 'line-through',
              lineHeight: 1.1,
            }}>₹999</span>
            <span style={{
              fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '0.95rem',
              color: '#F97316', letterSpacing: '0.04em',
            }}>FREE</span>
          </div>
        </div>

        {/* Form */}
        <form id="reg-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Full name */}
          <div>
            <input
              type="text"
              value={fullName}
              onChange={e => { markFormStarted(); setFullName(e.target.value); }}
              placeholder="Full name"
              autoCapitalize="words"
              style={inputBase(errors.fullName)}
            />
            {errors.fullName && (
              <p style={{ fontFamily: 'Outfit, sans-serif', color: '#EF4444', fontSize: '0.72rem', marginTop: 4 }}>
                ⚠ {t.screen4.errorName[lang]}
              </p>
            )}
          </div>

          {/* Email */}
          <div>
            <input
              type="email"
              value={email}
              onChange={e => { markFormStarted(); setEmail(e.target.value); }}
              placeholder="Email address"
              style={inputBase(errors.email)}
            />
            {errors.email && (
              <p style={{ fontFamily: 'Outfit, sans-serif', color: '#EF4444', fontSize: '0.72rem', marginTop: 4 }}>
                ⚠ {t.screen4.errorEmail[lang]}
              </p>
            )}
          </div>

          {/* WhatsApp number with +91 prefix segment */}
          <div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              borderRadius: 50,
              height: '3.2rem',
              overflow: 'hidden',
              border: errors.whatsappNumber ? '1px solid rgba(248,113,113,0.55)' : '1px solid rgba(139,92,246,0.22)',
              background: '#fff',
            }}>
              <span style={{
                padding: '0 14px',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700,
                color: '#5b3fa0', fontSize: '0.92rem',
                background: 'rgba(237,234,248,0.65)',
                height: '100%', display: 'flex', alignItems: 'center',
                borderRight: '1px solid rgba(139,92,246,0.18)',
                flexShrink: 0,
              }}>+91</span>
              <input
                type="tel" inputMode="numeric"
                value={whatsappNumber} onChange={handlePhoneInput}
                placeholder="WhatsApp number"
                style={{
                  flex: 1, padding: '0 16px',
                  background: 'transparent', border: 'none', outline: 'none',
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.95rem', color: '#2d0a6e',
                }}
              />
              {isPhoneValid && (
                <span style={{ paddingRight: 14, color: '#22C55E', fontWeight: 800 }}>✓</span>
              )}
            </div>
            {errors.whatsappNumber && (
              <p style={{ fontFamily: 'Outfit, sans-serif', color: '#EF4444', fontSize: '0.72rem', marginTop: 4 }}>
                ⚠ {t.screen4.errorPhone[lang]}
              </p>
            )}
          </div>

          {serverError && (
            <div style={{
              background: 'rgba(220,38,38,0.10)', border: '1px solid rgba(248,113,113,0.30)',
              borderRadius: 12, padding: '10px 14px',
              fontFamily: 'Outfit, sans-serif', color: '#B91C1C', fontSize: '0.82rem',
            }}>
              {serverError}
            </div>
          )}

          {/* Submit */}
          <m.button
            type="submit"
            disabled={submitting}
            whileTap={submitting ? {} : { scale: 0.98 }}
            style={{
              marginTop: 6,
              width: '100%', height: '3.4rem',
              background: submitting
                ? 'rgba(124,58,237,0.55)'
                : 'linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%)',
              border: 'none', borderRadius: 50,
              color: '#fff', fontFamily: 'Outfit, sans-serif',
              fontWeight: 700, fontSize: '1rem',
              cursor: submitting ? 'not-allowed' : 'pointer',
              boxShadow: '0 6px 22px rgba(124,58,237,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {submitting ? (
              <>
                <svg style={{ animation: 'spin 1s linear infinite', width: 18, height: 18 }} viewBox="0 0 24 24" fill="none">
                  <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Reserving your seat…
              </>
            ) : 'Confirm my free seat →'}
          </m.button>

          <p style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem',
            color: 'rgba(91,33,182,0.55)', textAlign: 'center', margin: '6px 0 0',
          }}>
            Zoom link + reminders via email & WhatsApp.
          </p>
          <p style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '0.68rem',
            color: 'rgba(91,33,182,0.45)', textAlign: 'center', margin: '2px 0 0',
          }}>
            By joining, you agree to our{' '}
            <span style={{ color: '#5B21B6', textDecoration: 'underline', cursor: 'pointer' }}>Privacy Policy</span>
            {' & '}
            <span style={{ color: '#5B21B6', textDecoration: 'underline', cursor: 'pointer' }}>Terms</span>
          </p>
        </form>
    </>
  );

  return (
    <>
      {/* Blur backdrop matching Screen1A popup */}
      <m.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        style={{
          position: 'fixed', inset: 0, zIndex: 40,
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          background: 'rgba(167,139,250,0.35)',
        }}
      />

      {isDesktop ? (
        /* Desktop: centered modal */
        <m.div
          key="register-desktop"
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.22 } }}
          transition={{ type: 'spring', stiffness: 340, damping: 28 }}
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '24px',
            pointerEvents: 'none',
          }}
        >
          <div style={{
            width: '100%', maxWidth: 480,
            background: 'rgba(255,255,255,0.72)',
            backdropFilter: 'blur(28px) saturate(180%)',
            WebkitBackdropFilter: 'blur(28px) saturate(180%)',
            borderRadius: 22,
            border: '1px solid rgba(139,92,246,0.18)',
            boxShadow: '0 10px 50px rgba(45,10,110,0.22), inset 0 1px 0 rgba(255,255,255,0.80)',
            padding: '24px 22px 22px',
            position: 'relative',
            pointerEvents: 'auto',
          }}>
            {cardInner}
          </div>
        </m.div>
      ) : (
        /* Mobile: bottom sheet — slides up from bottom, attached to bottom edge */
        <m.div
          key="register-mobile"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%', transition: { duration: 0.42, ease: [0.32, 0, 0.67, 0] } }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          style={{
            position: 'fixed', bottom: 0, left: 0, right: 0,
            maxWidth: 480, marginLeft: 'auto', marginRight: 'auto',
            zIndex: 50,
            padding: '0 16px',
          }}
        >
          <div style={{
            background: 'rgba(255,255,255,0.72)',
            backdropFilter: 'blur(28px) saturate(180%)',
            WebkitBackdropFilter: 'blur(28px) saturate(180%)',
            borderRadius: '22px 22px 0 0',
            border: '1px solid rgba(139,92,246,0.18)',
            borderBottom: 'none',
            boxShadow: '0 -4px 24px rgba(91,33,182,0.10), inset 0 1px 0 rgba(255,255,255,0.80)',
            padding: '20px 18px 22px',
            position: 'relative',
          }}>
            {cardInner}
          </div>
        </m.div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        input::placeholder { color: rgba(91,33,182,0.40) !important; font-family: Outfit, sans-serif; }
      `}</style>
    </>
  );
}
