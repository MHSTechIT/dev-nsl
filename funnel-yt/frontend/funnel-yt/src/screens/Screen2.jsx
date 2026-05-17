import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import { t } from '../translations';
import TopBar from '../components/TopBar';
import CountdownTimerCompact from '../components/CountdownTimerCompact';
import { pixelLanguageQualified, pixelDisqualifiedLead, pixelLead } from '../utils/pixel';
import { trackEvent } from '../utils/trackEvent';

const slideIn = {
  initial: { x: '100%', opacity: 0 },
  animate: { x: 0, opacity: 1, transition: { duration: 0.3, ease: 'easeOut' } },
  exit: { x: '-100%', opacity: 0, transition: { duration: 0.25, ease: 'easeIn' } },
};

export default function Screen2() {
  const { state, dispatch } = useFunnel();
  const lang = state.lang;
  const navigate = useNavigate();

  useEffect(() => {
    if (!state.sugarLevel) navigate('/', { replace: true });
  }, []);

  function handleYes() {
    trackEvent('tamil_yes', state.webinarConfig?.next_webinar_at);
    dispatch({ type: 'SET_LANGUAGE_QUALIFIED', payload: true });
    dispatch({ type: 'SET_NAV_DIRECTION', payload: 'forward' });
    pixelLanguageQualified();
    pixelLead({ content_name: 'tamil_qualified', content_category: 'language_screen' });
    navigate('/duration');
  }

  function handleNo() {
    trackEvent('tamil_no', state.webinarConfig?.next_webinar_at);
    dispatch({ type: 'SET_NAV_DIRECTION', payload: 'forward' });
    pixelDisqualifiedLead('language_mismatch', state.utm);
    window.location.href = (import.meta.env.VITE_DISQUALIFIED_URL || '') + '/language';
  }

  return (
    <m.div
      variants={slideIn} initial="initial" animate="animate" exit="exit"
      className="flex flex-col min-h-screen"
    >
      <TopBar showBack backPath="/" step={1} />

      {/* Spacer pushes card to bottom — floating timer centered inside */}
      <div className="flex-1" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <CountdownTimerCompact />
      </div>

      {/* Bottom area: zoom image + card, same pattern as sugar level */}
      <div style={{ position: 'relative', padding: '0 16px 32px' }}>

        {/* Zoom image — center, sits behind card */}
        <m.img
          src="/zoom.webp"
          alt="Zoom"
          initial={{ opacity: 0, scale: 0.85, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
          style={{
            display: 'block',
            width: '46%',
            maxWidth: 180,
            margin: '0 auto',
            marginBottom: '-50px',
            filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.30))',
            position: 'relative',
            zIndex: 0,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />

        {/* Card — sits in front of image */}
        <m.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.08 }}
          style={{
            background: 'rgba(255,255,255,0.82)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            borderRadius: 22,
            border: '1px solid rgba(255,255,255,0.75)',
            boxShadow: '0 8px 32px rgba(91,33,182,0.14)',
            padding: '68px 18px 20px',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {/* Note */}
          <p style={{
            fontFamily: 'Outfit, sans-serif',
            fontSize: '0.78rem',
            color: 'rgba(91,33,182,0.55)',
            marginBottom: 10,
          }}>
            🎙️ {t.screen2.note[lang]}
          </p>

          {/* Question */}
          <h2 style={{
            fontFamily: 'Outfit, sans-serif',
            fontWeight: 700, fontSize: '1.45rem',
            color: '#3B0764',
            marginBottom: 18, lineHeight: 1.2,
          }}>
            {t.screen2.question[lang]}
          </h2>

          {/* Options */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { label: t.screen2.yes[lang], action: handleYes },
              { label: t.screen2.no[lang],  action: handleNo  },
            ].map(({ label, action }, i) => (
              <m.button
                key={i}
                onClick={action}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.18 + i * 0.08 }}
                whileTap={{ scale: 0.97 }}
                style={{
                  width: '100%', padding: '14px 18px',
                  borderRadius: 50,
                  background: 'rgba(237,234,248,0.85)',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  border: '1px solid rgba(255,255,255,0.85)',
                  color: '#3B0764',
                  fontFamily: 'Outfit, sans-serif',
                  fontWeight: 700, fontSize: '0.95rem',
                  cursor: 'pointer', textAlign: 'center',
                  boxShadow: '0 2px 8px rgba(91,33,182,0.10)',
                }}
              >
                {label}
              </m.button>
            ))}
          </div>

          <p style={{
            textAlign: 'center', marginTop: 14,
            fontFamily: 'Outfit, sans-serif',
            fontSize: '0.68rem', color: 'rgba(91,33,182,0.40)',
          }}>
            🔒 {lang === 'tamil' ? '100% தனிப்பட்டது & பாதுகாப்பானது' : '100% Private & Secure'}
          </p>
        </m.div>
      </div>
    </m.div>
  );
}
