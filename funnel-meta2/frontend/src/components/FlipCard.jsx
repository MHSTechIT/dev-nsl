import { AnimatePresence, m } from 'framer-motion';

/* ─── Single morphing digit ─── */
function MorphDigit({ value, size = 'lg', urgent = false }) {
  const isLg = size === 'lg';
  const W  = isLg ? 34 : 28;
  const H  = isLg ? 46 : 36;
  const fs = isLg ? '1.45rem' : '1.05rem';
  const r  = isLg ? 9 : 7;

  return (
    <div style={{
      width: W, height: H,
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      background: urgent ? 'rgba(254,202,202,0.80)' : 'rgba(255,255,255,0.70)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderRadius: r,
      border: urgent ? '1px solid rgba(239,68,68,0.45)' : '1px solid rgba(139,92,246,0.20)',
      boxShadow: urgent
        ? 'inset 0 1.5px 0 rgba(255,255,255,0.80), 0 0 12px rgba(239,68,68,0.25)'
        : 'inset 0 1.5px 0 rgba(255,255,255,0.80), 0 0 12px rgba(139,92,246,0.12)',
      overflow: 'hidden',
      transition: 'all 0.5s',
    }}>
      <AnimatePresence mode="popLayout">
        <m.span
          key={value}
          initial={{ opacity: 0, filter: 'blur(10px)', scale: 1.45, y: -6 }}
          animate={{ opacity: 1, filter: 'blur(0px)',  scale: 1,    y:  0 }}
          exit={{    opacity: 0, filter: 'blur(10px)', scale: 0.60, y:  6 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          style={{
            fontFamily: '"Outfit", "Noto Sans Tamil", sans-serif',
            fontWeight: 800,
            fontSize: fs,
            color: urgent ? '#DC2626' : '#2d0a6e',
            lineHeight: 1,
            userSelect: 'none',
            letterSpacing: '-0.02em',
            position: 'absolute',
            zIndex: 1,
          }}
        >
          {value}
        </m.span>
      </AnimatePresence>
    </div>
  );
}

/* ─── Two-or-more-digit unit with label ─── */
export function FlipUnit({ value, label, size = 'lg', urgent = false }) {
  // Always show at least 2 digits; show 3 if the value needs it (e.g. 100+ hrs)
  const digits = Math.max(2, String(Math.abs(value)).length);
  const str = String(value).padStart(digits, '0');
  const gap = size === 'lg' ? 2 : 2;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
      <div style={{ display: 'flex', gap }}>
        {str.split('').map((d, i) => (
          <MorphDigit key={i} value={d} size={size} urgent={urgent} />
        ))}
      </div>

      {label && (
        <span style={{
          fontFamily: 'Outfit, "Noto Sans Tamil", sans-serif',
          fontSize: 9, fontWeight: 600,
          color: '#7c5cbf',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
      )}
    </div>
  );
}

/* Alias so existing imports still work */
export { MorphDigit as FlipDigit };
