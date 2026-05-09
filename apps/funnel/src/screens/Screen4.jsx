import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import { t } from '../translations';
import { trackEvent } from '../utils/trackEvent';

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

/* ── 5-minute urgency countdown ─────────────────────────────────────── */
function UrgencyTimer() {
  const [secs, setSecs] = useState(179); // 2:59 minutes
  useEffect(() => {
    const id = setInterval(() => setSecs(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  const fmt = (n) => String(n).padStart(2, '0');
  const pulse = secs <= 60; // pulse when under 1 min

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {/* Glow layer — blurred red div that pulses, never touches text */}
      <m.div
        animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.06, 1] }}
        transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
        style={{
          position: 'absolute', inset: -6,
          borderRadius: 16,
          background: '#EF4444',
          filter: 'blur(10px)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      {/* Static text container — no animation, text always crisp */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        background: '#DC2626',
        border: '1px solid rgba(239,68,68,0.70)',
        borderRadius: 12, padding: '8px 20px',
        width: '100%',
      }}>
        <m.div
          animate={{ opacity: [1, 0.2, 1], scale: [1, 1.4, 1] }}
          transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
          style={{ width: 7, height: 7, borderRadius: '50%', background: '#ffffff', flexShrink: 0 }}
        />
        <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', fontWeight: 600, color: '#ffffff', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Complete in
        </span>
        <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '1.15rem', fontWeight: 800, letterSpacing: '0.06em', color: '#ffffff' }}>
          {fmt(mins)}:{fmt(s)}
        </span>
        <span style={{ fontSize: '0.9rem' }}>⚠️</span>
      </div>
    </div>
  );
}

export default function Screen4() {
  const { state, dispatch } = useFunnel();
  const lang = state.lang;
  const navigate = useNavigate();

  const [fullName, setFullName] = useState(state.fullName);
  const [whatsappNumber, setWhatsappNumber] = useState(state.whatsappNumber);
  const [email, setEmail] = useState(state.email);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  useEffect(() => {
    if (!state.sugarLevel) { navigate('/', { replace: true }); return; }
    // Pre-warm Render backend so it's ready when user submits
    fetch('/api/health').catch(() => {});
  }, []);

  function handlePhoneInput(e) {
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
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

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
          language_pref: state.lang,
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
      setSubmitting(false);
      if (data.lead_id) localStorage.setItem('mhs_lead_id', data.lead_id);
      const waBase = import.meta.env.VITE_WHATSAPP_URL || '/whatsapp';
      window.location.href = `${waBase}?lead_id=${data.lead_id}`;
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

  /* ── Shared glass input style ── */
  const inputStyle = (hasError) => ({
    width: '100%', height: '3.2rem',
    paddingLeft: '1rem', paddingRight: '1rem',
    borderRadius: 14,
    border: hasError ? '1px solid rgba(248,113,113,0.60)' : '1px solid rgba(139,92,246,0.22)',
    background: hasError ? 'rgba(254,100,100,0.10)' : 'rgba(255,255,255,0.60)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,0.80), 0 2px 8px rgba(91,33,182,0.08)',
    fontSize: '1rem',
    fontFamily: 'Outfit, sans-serif',
    color: '#2d0a6e',
    outline: 'none',
    transition: 'all 200ms',
  });

  const labelStyle = {
    display: 'block',
    fontFamily: 'Outfit, sans-serif',
    fontSize: '0.8rem',
    fontWeight: 600,
    color: '#5b3fa0',
    marginBottom: '0.35rem',
  };

  return (
    <>
      {/* ── Fixed top: urgency countdown — outside animated wrapper ── */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        maxWidth: 480, margin: '0 auto',
        padding: '10px 16px',
        background: 'transparent',
        zIndex: 50,
      }}>
        <UrgencyTimer />
      </div>

    <m.div variants={slideIn} initial="initial" animate="animate" exit="exit"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      {/* ── Scrollable body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '80px 16px 120px' }}>

      {/* ── Headline ── */}
      <m.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
        <h1 style={{
          fontFamily: '"Montserrat", Outfit, sans-serif', fontWeight: 900,
          fontSize: 'clamp(1.5rem, 7vw, 2rem)', lineHeight: 1.15,
          color: '#2d0a6e', marginBottom: 4,
        }}>
          Reserve Your{' '}
          <span style={{
            background: 'linear-gradient(90deg, #16a34a, #22c55e)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          }}>FREE</span>{' '}Seat
        </h1>
        <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#7c5cbf', marginBottom: 14 }}>
          Fill in your details below to confirm your spot
        </p>
      </m.div>

      {/* ── Webinar details pills ── */}
      <m.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
        style={{
          display: 'flex', flexWrap: 'nowrap', gap: 6, marginBottom: 14,
          background: 'rgba(255,255,255,0.55)', borderRadius: 12, padding: '10px 12px',
          border: '1px solid rgba(139,92,246,0.18)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        }}>
        {(() => {
          const webinarDateISO = state.webinarConfig?.current_webinar_date || state.webinarConfig?.next_webinar_at;
          return [
          {
            text: webinarDateISO
              ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(webinarDateISO))
              : 'Every Sat & Tue',
            icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(167,139,250,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            ),
          },
          {
            text: webinarDateISO
              ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(webinarDateISO)) + ' IST'
              : '7:00 PM IST',
            icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(167,139,250,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            ),
          },
          {
            text: 'Zoom Live',
            icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(167,139,250,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
              </svg>
            ),
          },
        ].map((item, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 5,
            background: 'rgba(255,255,255,0.60)', border: '1px solid rgba(139,92,246,0.18)',
            borderRadius: 20, padding: '5px 11px',
          }}>
            {item.icon}
            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.68rem', fontWeight: 600, color: '#2d0a6e', whiteSpace: 'nowrap' }}>{item.text}</span>
          </div>
        ));
        })()}
      </m.div>

      {/* ── Based on your answers ── */}
      <m.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
        style={{
          background: '#FFFDE7', borderRadius: 12, padding: '12px 14px', marginBottom: 16,
          border: '1px solid #F0D080',
        }}>
        {/* Header row with clipboard icon */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c5c00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
            <rect x="9" y="3" width="6" height="4" rx="1"/>
            <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
          </svg>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.68rem', fontWeight: 700, color: '#7c5c00', letterSpacing: '0.08em', textTransform: 'uppercase', margin: 0 }}>
            Based on your answers:
          </p>
        </div>

        {/* Checklist items */}
        {[
          <span>You have diabetes (<strong style={{ color: '#5b21b6' }}>{state.sugarLevel === '250+' ? '250+ sugar level' : '150–250 mg/dL sugar level'}</strong>)</span>,
          <span><strong style={{ color: '#5b21b6' }}>Tamil</strong> is comfortable for you</span>,
        ].map((line, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
            <span style={{ color: '#22c55e', fontWeight: 700, flexShrink: 0, marginTop: 1 }}>✓</span>
            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#3b1f00', fontWeight: 500 }}>{line}</span>
          </div>
        ))}

        {/* Dashed divider */}
        <div style={{ borderTop: '1.5px dashed #D4B800', margin: '10px 0' }} />

        {/* Final line */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#5b21b6', fontWeight: 700, fontSize: '0.9rem' }}>→</span>
          <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', color: '#3b1f00', fontWeight: 700, fontStyle: 'italic' }}>
            This session is built for <em style={{ fontStyle: 'italic', color: '#5b21b6' }}>YOU.</em>
          </span>
        </div>
      </m.div>

      {/* ── Social proof ── */}
      <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 18 }}>
        <m.div
          animate={{ opacity: [1, 0.3, 1] }} transition={{ repeat: Infinity, duration: 1.2 }}
          style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', flexShrink: 0 }}
        />
        <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.75rem', color: '#5b3fa0', fontWeight: 500 }}>
          <span style={{ color: '#2d0a6e', fontWeight: 700 }}>347 people</span> have registered in the last 24 hours
        </span>
      </m.div>

      {/* ── Form ── */}
      <form id="reg-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Full Name */}
        <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }}>
          <label style={labelStyle}>Full Name</label>
          <input
            type="text"
            value={fullName}
            onChange={e => { setFullName(e.target.value); }}
            placeholder="Ramaswamy"
            autoCapitalize="words"
            style={inputStyle(errors.fullName)}
            onFocus={e => { e.target.style.borderColor = 'rgba(139,92,246,0.55)'; e.target.style.boxShadow = '0 0 0 3px rgba(91,33,182,0.15), inset 0 1.5px 0 rgba(255,255,255,0.12)'; }}
            onBlur={e => { e.target.style.borderColor = errors.fullName ? 'rgba(248,113,113,0.60)' : 'rgba(255,255,255,0.18)'; e.target.style.boxShadow = 'inset 0 1.5px 0 rgba(255,255,255,0.12), 0 2px 8px rgba(0,0,0,0.20)'; }}
          />
          {errors.fullName && (
            <p style={{ fontFamily: 'Outfit, sans-serif', color: '#F87171', fontSize: '0.75rem', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              ⚠ {t.screen4.errorName[lang]}
            </p>
          )}
        </m.div>

        {/* WhatsApp */}
        <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.36 }}>
          <label style={labelStyle}>WhatsApp Number</label>
          <div style={{
            display: 'flex', alignItems: 'center', borderRadius: 14, height: '3.2rem', overflow: 'hidden',
            border: errors.whatsappNumber ? '1px solid rgba(248,113,113,0.60)' : '1px solid rgba(139,92,246,0.22)',
            background: errors.whatsappNumber ? 'rgba(254,100,100,0.10)' : 'rgba(255,255,255,0.60)',
            backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,0.80), 0 2px 8px rgba(91,33,182,0.08)',
            transition: 'all 200ms',
          }}>
            <span style={{
              padding: '0 12px', fontFamily: 'Outfit, sans-serif', fontWeight: 700,
              color: '#5b3fa0', fontSize: '0.9rem',
              borderRight: '1px solid rgba(139,92,246,0.18)',
              height: '100%', display: 'flex', alignItems: 'center',
              background: 'rgba(255,255,255,0.20)', flexShrink: 0,
            }}>+91</span>
            <input
              type="tel" inputMode="numeric"
              value={whatsappNumber} onChange={handlePhoneInput}
              placeholder="98XXX XXXXX"
              style={{
                flex: 1, padding: '0 12px', background: 'transparent', border: 'none', outline: 'none',
                fontFamily: 'Outfit, sans-serif', fontSize: '1rem', color: '#2d0a6e',
              }}
            />
            {isPhoneValid && (
              <span style={{ paddingRight: 12, color: '#34D399', fontWeight: 800, fontSize: '1.1rem' }}>✓</span>
            )}
          </div>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', color: '#7c5cbf', marginTop: 4 }}>
            🔒 All Workshop bonuses and Diabetic guides will be shared to your WhatsApp
          </p>
          {errors.whatsappNumber && (
            <p style={{ fontFamily: 'Outfit, sans-serif', color: '#F87171', fontSize: '0.75rem', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              ⚠ {t.screen4.errorPhone[lang]}
            </p>
          )}
        </m.div>

        {/* Email */}
        <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.40 }}>
          <label style={labelStyle}>Email Address</label>
          <input
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); }}
            placeholder="yourname@gmail.com"
            style={inputStyle(errors.email)}
            onFocus={e => { e.target.style.borderColor = 'rgba(139,92,246,0.55)'; e.target.style.boxShadow = '0 0 0 3px rgba(91,33,182,0.15), inset 0 1.5px 0 rgba(255,255,255,0.12)'; }}
            onBlur={e => { e.target.style.borderColor = errors.email ? 'rgba(248,113,113,0.60)' : 'rgba(255,255,255,0.18)'; e.target.style.boxShadow = 'inset 0 1.5px 0 rgba(255,255,255,0.12), 0 2px 8px rgba(0,0,0,0.20)'; }}
          />
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', color: '#7c5cbf', marginTop: 4 }}>
            ✉ Workshop Free Joining link will be sent to your email
          </p>
          {errors.email && (
            <p style={{ fontFamily: 'Outfit, sans-serif', color: '#F87171', fontSize: '0.75rem', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              ⚠ {t.screen4.errorEmail[lang]}
            </p>
          )}
        </m.div>

        {serverError && (
          <div style={{
            background: 'rgba(220,38,38,0.15)', border: '1px solid rgba(248,113,113,0.35)',
            borderRadius: 12, padding: '10px 14px',
            fontFamily: 'Outfit, sans-serif', color: '#FCA5A5', fontSize: '0.85rem',
          }}>
            {serverError}
          </div>
        )}

      </form>
      </div>{/* end scrollable body */}
    </m.div>

      {/* ── Fixed bottom: submit button — outside animated wrapper ── */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        maxWidth: 480, margin: '0 auto',
        padding: '12px 16px 20px',
        background: 'transparent',
        zIndex: 50,
      }}>
        <div style={{ position: 'relative' }}>
          <m.div
            animate={{ scale: [1, 1.12, 1], opacity: [0.7, 0.2, 0.7] }}
            transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
            style={{ position: 'absolute', inset: -10, borderRadius: 50, background: 'rgba(139,92,246,0.70)', filter: 'blur(18px)', zIndex: 0 }}
          />
          <m.button
            type="submit"
            form="reg-form"
            disabled={submitting}
            animate={submitting ? {} : {
              scale: [1, 1.03, 1],
              boxShadow: ['0 4px 20px rgba(91,33,182,0.45)', '0 6px 36px rgba(139,92,246,0.85)', '0 4px 20px rgba(91,33,182,0.45)'],
            }}
            transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
            style={{
              position: 'relative', zIndex: 1,
              width: '100%', height: '3.5rem',
              background: submitting ? 'rgba(91,33,182,0.60)' : 'linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)',
              border: 'none', borderRadius: 50,
              color: '#fff', fontFamily: 'Outfit, sans-serif',
              fontWeight: 700, fontSize: '1.05rem',
              cursor: submitting ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              opacity: submitting ? 0.75 : 1,
            }}
          >
            {submitting ? (
              <>
                <svg style={{ animation: 'spin 1s linear infinite', width: 18, height: 18 }} viewBox="0 0 24 24" fill="none">
                  <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Reserving your seat...
              </>
            ) : 'COMPLETE REGISTRATION →'}
          </m.button>
        </div>
        <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.68rem', color: '#7c5cbf', textAlign: 'center', marginTop: 6 }}>
          By joining, you agree to our{' '}
          <span style={{ color: '#5b21b6', textDecoration: 'underline', cursor: 'pointer' }}>Privacy Policy</span>
          {' & '}
          <span style={{ color: '#5b21b6', textDecoration: 'underline', cursor: 'pointer' }}>Terms</span>
        </p>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        input::placeholder { color: rgba(91,33,182,0.35) !important; }
      `}</style>
    </>
  );
}
