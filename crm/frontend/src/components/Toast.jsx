import { useEffect, useState } from 'react';

/**
 * Lightweight toast — call <Toast message="..." kind="success" onDone={...} />
 * Auto-hides after `duration` ms (default 2800).
 */
export default function Toast({ message, kind = 'success', duration = 2800, onDone }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDone?.(), 250);
    }, duration);
    return () => clearTimeout(t);
  }, [message, duration, onDone]);

  if (!message) return null;

  const palette = {
    success: { bg: 'linear-gradient(135deg,#059669,#10B981)', icon: 'M5 13l4 4L19 7' },
    error:   { bg: 'linear-gradient(135deg,#DC2626,#F87171)', icon: 'M6 18L18 6M6 6l12 12' },
    info:    { bg: 'linear-gradient(135deg,#5B21B6,#8B6FEA)', icon: 'M12 9v4M12 17h.01' },
  }[kind] || palette?.success;

  return (
    <div
      style={{
        position: 'fixed', bottom: 24, left: '50%',
        transform: `translateX(-50%) translateY(${visible ? 0 : 20}px)`,
        opacity: visible ? 1 : 0,
        transition: 'opacity 200ms ease, transform 200ms ease',
        zIndex: 10000,
        background: palette.bg,
        color: '#fff',
        padding: '12px 18px',
        borderRadius: 50,
        fontFamily: 'Outfit, sans-serif',
        fontWeight: 600,
        fontSize: '0.86rem',
        boxShadow: '0 12px 40px rgba(15,0,40,0.30)',
        display: 'inline-flex', alignItems: 'center', gap: 10,
        maxWidth: '90vw',
      }}
      role="status"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={palette.icon}/>
      </svg>
      {message}
    </div>
  );
}
