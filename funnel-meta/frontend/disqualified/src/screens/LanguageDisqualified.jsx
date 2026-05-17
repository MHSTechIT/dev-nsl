import { m } from 'framer-motion';
import { trackEvent } from '../utils/trackEvent';

const slideIn = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18, ease: 'easeIn' } },
};

const YOUTUBE_URL = 'https://www.youtube.com/@DoctorFarmer';

export default function LanguageDisqualified() {
  return (
    <m.div
      variants={slideIn} initial="initial" animate="animate" exit="exit"
      style={{
        minHeight: '100vh',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '40px 16px',
      }}
    >
      {/* Main card */}
      <m.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 280, damping: 24, delay: 0.1 }}
        style={{
          width: '100%', maxWidth: 420,
          background: 'rgba(255,255,255,0.60)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          border: '1px solid rgba(139,92,246,0.18)',
          borderRadius: 24,
          padding: '36px 28px 40px',
          boxShadow: '0 8px 40px rgba(91,33,182,0.12), inset 0 1px 0 rgba(255,255,255,0.85)',
          textAlign: 'center',
        }}
      >
        {/* YouTube play icon */}
        <m.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 320, damping: 20, delay: 0.2 }}
          style={{
            width: 80, height: 80, borderRadius: '50%',
            background: 'linear-gradient(135deg, #FF0000, #CC0000)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 24px',
            boxShadow: '0 6px 28px rgba(255,0,0,0.30)',
          }}
        >
          <svg width="38" height="38" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
          </svg>
        </m.div>

        {/* Heading */}
        <h2 style={{
          fontFamily: '"Montserrat", Outfit, sans-serif',
          fontWeight: 900, fontSize: '1.45rem',
          color: '#2d0a6e', lineHeight: 1.2, marginBottom: 14,
        }}>
          This Session is in{' '}
          <span style={{
            background: 'linear-gradient(90deg, #7C3AED, #a78bfa)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          }}>
            Tamil
          </span>
        </h2>

        {/* Divider */}
        <div style={{ width: 48, height: 3, borderRadius: 2, background: 'linear-gradient(90deg,#7C3AED,#a78bfa)', margin: '0 auto 18px' }} />

        {/* Body text */}
        <p style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '0.90rem',
          color: '#5b3fa0', lineHeight: 1.65, marginBottom: 10,
        }}>
          This webinar is conducted in Tamil language. Follow our YouTube channel for English diabetes content.
        </p>

        {/* Content pills */}
        {['🥗 Diet & Nutrition Tips', '🧘 Lifestyle Reversal', '💊 Reduce Medication Naturally'].map((tip, i) => (
          <m.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 + i * 0.08 }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(139,92,246,0.07)', borderRadius: 10,
              padding: '8px 12px', marginBottom: 8, textAlign: 'left',
            }}
          >
            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#4c1d95', fontWeight: 500 }}>{tip}</span>
          </m.div>
        ))}

        {/* YouTube button */}
        <m.a
          href={YOUTUBE_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackEvent('youtube_clicked')}
          whileTap={{ scale: 0.97 }}
          animate={{
            boxShadow: [
              '0 4px 18px rgba(255,0,0,0.25)',
              '0 6px 30px rgba(255,0,0,0.50)',
              '0 4px 18px rgba(255,0,0,0.25)',
            ],
          }}
          transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            width: '100%', height: '3.4rem', borderRadius: 50, marginTop: 22,
            background: 'linear-gradient(135deg, #FF0000, #CC0000)',
            color: '#ffffff', fontFamily: 'Outfit, sans-serif',
            fontWeight: 700, fontSize: '1.05rem',
            textDecoration: 'none',
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
          </svg>
          Follow on YouTube
        </m.a>

        {/* Channel name */}
        <p style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem',
          color: 'rgba(91,33,182,0.45)', marginTop: 10,
        }}>
          @DoctorFarmer
        </p>
      </m.div>
    </m.div>
  );
}
