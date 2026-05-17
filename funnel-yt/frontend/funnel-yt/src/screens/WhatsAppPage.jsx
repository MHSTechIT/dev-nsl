import { useEffect, useState } from 'react';
import { m } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import { trackEvent } from '../utils/trackEvent';

/* ── Link expiry countdown ── */
function LinkExpiryTimer() {
  const [secs, setSecs] = useState(179);
  useEffect(() => {
    const id = setInterval(() => setSecs(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  const fmt = (n) => String(n).padStart(2, '0');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      background: '#DC2626', border: '1px solid rgba(239,68,68,0.70)',
      borderRadius: 10, padding: '8px 16px', marginBottom: 12,
    }}>
      <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', fontWeight: 600, color: '#ffffff', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        Link Expires In
      </span>
      <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '1.15rem', fontWeight: 800, color: '#ffffff', letterSpacing: '0.06em' }}>
        {fmt(mins)}:{fmt(s)}
      </span>
    </div>
  );
}

export default function WhatsAppPage() {
  const { state } = useFunnel();
  // Live link — comes from FunnelContext which already has SSE + initial fetch
  const waLink = state.webinarConfig?.tuesday_whatsapp_link || '';

  function handleJoinClick() {
    trackEvent('wa_join_clicked', state.webinarConfig?.next_webinar_at);
    const leadId = localStorage.getItem('mhs_lead_id');
    if (leadId) {
      fetch(`/api/leads/${leadId}/wa-click`, { method: 'PATCH' }).catch(() => {});
    }
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: 0, left: 0, right: 0,
      maxWidth: 480,
      margin: '0 auto',
    }}>
      <m.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        style={{
          width: '100%',
          background: 'rgba(255,255,255,0.55)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          border: '1px solid rgba(139,92,246,0.18)',
          borderBottom: 'none',
          borderRadius: '24px 24px 0 0',
          padding: '12px 24px 44px',
          boxShadow: '0 -4px 24px rgba(91,33,182,0.10), inset 0 1px 0 rgba(255,255,255,0.80)',
        }}
      >
        {/* Drag handle style top bar */}
        <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(91,33,182,0.25)', margin: '0 auto 24px' }} />

        {/* Confirm label */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, marginBottom: 24 }}>
          <m.div
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ repeat: Infinity, duration: 1.1 }}
            style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981' }}
          />
          <span style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '0.70rem', fontWeight: 700,
            color: '#2d0a6e', letterSpacing: '0.10em', textTransform: 'uppercase',
          }}>
            Confirm Your Registration
          </span>
        </div>

        {/* WhatsApp icon */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
          <m.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 320, damping: 20, delay: 0.15 }}
            style={{
              width: 80, height: 80, borderRadius: '50%',
              background: 'linear-gradient(135deg, #25D366, #128C7E)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 6px 24px rgba(37,211,102,0.30)',
            }}
          >
            <svg width="42" height="42" viewBox="0 0 24 24" fill="#ffffff">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
          </m.div>
        </div>

        {/* Heading */}
        <h2 style={{
          fontFamily: '"Montserrat", Outfit, sans-serif', fontWeight: 900,
          fontSize: '1.25rem', color: '#2d0a6e',
          textAlign: 'center', marginBottom: 10, lineHeight: 1.2,
        }}>
          Join the <span style={{ color: '#15803d' }}>WhatsApp Group</span>
        </h2>
        <p style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#5b3fa0',
          textAlign: 'center', marginBottom: 24, lineHeight: 1.55,
        }}>
          All workshop <strong style={{ color: '#2d0a6e' }}>bonuses</strong> and the{' '}
          <strong style={{ color: '#2d0a6e' }}>joining link</strong> will be sent inside the WhatsApp group
        </p>

        {/* Expiry timer */}
        <LinkExpiryTimer />

        {/* Join button */}
        <m.a
          href={waLink || '#'}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleJoinClick}
          whileTap={{ scale: 0.97 }}
          animate={{
            boxShadow: [
              '0 4px 16px rgba(37,211,102,0.30)',
              '0 6px 28px rgba(37,211,102,0.55)',
              '0 4px 16px rgba(37,211,102,0.30)',
            ],
          }}
          transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            width: '100%', height: '3.5rem', borderRadius: 50,
            background: 'linear-gradient(135deg, #25D366, #128C7E)',
            color: '#ffffff', fontFamily: 'Outfit, sans-serif',
            fontWeight: 700, fontSize: '1.05rem',
            textDecoration: 'none',
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          Join WhatsApp Group
        </m.a>
      </m.div>
    </div>
  );
}
