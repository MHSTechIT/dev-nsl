import { useState } from 'react';
import { m } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import { t } from '../translations';

const slideIn = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18, ease: 'easeIn' } },
};

const SHARE_URL = window.location.origin;

export default function LanguageDisqualified() {
  const { state } = useFunnel();
  const lang = state.lang;
  const [copied, setCopied] = useState(false);

  function shareWA() {
    window.open('https://wa.me/?text=' + encodeURIComponent('Check out this diabetes reversal webinar: ' + SHARE_URL), '_blank');
  }
  function copyLink() {
    navigator.clipboard.writeText(SHARE_URL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <m.div variants={slideIn} initial="initial" animate="animate" exit="exit"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', padding: '48px 16px 40px' }}>

      {/* Card */}
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        style={{
          background: 'rgba(255,255,255,0.08)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 20,
          padding: '24px 20px',
          textAlign: 'center',
          boxShadow: '0 4px 24px rgba(91,33,182,0.20), inset 0 1px 0 rgba(255,255,255,0.12)',
          marginBottom: 28,
        }}
      >
        <h2 style={{
          fontFamily: '"Montserrat", Outfit, sans-serif',
          fontWeight: 900, fontSize: '1.4rem',
          color: '#ffffff', marginBottom: 10, lineHeight: 1.2,
        }}>
          {t.languageDisqualified.headline[lang]}
        </h2>
        <p style={{
          fontFamily: 'Outfit, sans-serif',
          fontSize: '0.88rem',
          color: 'rgba(220,210,255,0.80)',
          lineHeight: 1.6,
        }}>
          {t.languageDisqualified.subheadline[lang]}
        </p>
      </m.div>

      {/* Buttons */}
      <m.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {/* WhatsApp */}
        <m.button
          onClick={shareWA}
          whileTap={{ scale: 0.97 }}
          style={{
            width: '100%', height: '3.3rem', borderRadius: 50,
            background: 'linear-gradient(135deg, #25D366, #128C7E)',
            border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1rem',
            color: '#ffffff',
            boxShadow: '0 6px 24px rgba(37,211,102,0.35)',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          {t.languageDisqualified.shareWA[lang]}
        </m.button>

        {/* Copy link */}
        <m.button
          onClick={copyLink}
          whileTap={{ scale: 0.97 }}
          style={{
            width: '100%', height: '3.3rem', borderRadius: 50,
            background: 'rgba(255,255,255,0.10)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.22)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1rem',
            color: copied ? '#4ADE80' : '#ffffff',
            boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,0.35), 0 4px 16px rgba(0,0,0,0.20)',
            transition: 'color 300ms',
          }}
        >
          {copied ? (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              {t.languageDisqualified.copied[lang]}
            </>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(167,139,250,0.90)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              {t.languageDisqualified.copyLink[lang]}
            </>
          )}
        </m.button>
      </m.div>

    </m.div>
  );
}
