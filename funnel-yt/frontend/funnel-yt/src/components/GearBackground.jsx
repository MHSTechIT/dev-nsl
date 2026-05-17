import { m } from 'framer-motion';

function GearIcon({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.34.07-.69.07-1.08s-.03-.73-.07-1.08l2.32-1.81c.21-.16.27-.46.13-.7l-2.2-3.81c-.13-.24-.42-.32-.65-.24l-2.74 1.1c-.57-.44-1.18-.81-1.86-1.08L14 2.42c-.05-.26-.27-.42-.54-.42h-4.4c-.27 0-.49.16-.53.42L8.21 5.37c-.68.27-1.29.64-1.86 1.08L3.61 5.35c-.23-.08-.52 0-.65.24L.76 9.4c-.14.24-.08.54.13.7l2.32 1.81C3.17 12.27 3.14 12.63 3.14 13s.03.73.07 1.08L.89 15.89c-.21.16-.27.46-.13.7l2.2 3.81c.13.24.42.32.65.24l2.74-1.1c.57.44 1.18.81 1.86 1.08l.32 2.95c.04.26.26.42.53.42h4.4c.27 0 .49-.16.54-.42l.32-2.95c.68-.27 1.29-.64 1.86-1.08l2.74 1.1c.23.08.52 0 .65-.24l2.2-3.81c.14-.24.08-.54-.13-.7l-2.32-1.81z"/>
    </svg>
  );
}

const gears = [
  { size: 200, top: -60,   right: -60,  bottom: 'auto', left: 'auto', rotate: 1,  duration: 22, opacity: 0.07 },
  { size: 160, top: 'auto',right: 'auto',bottom: -50,   left: -50,   rotate: -1, duration: 16, opacity: 0.06 },
  { size: 90,  top: '38%', right: 'auto',bottom: 'auto',left: -30,   rotate: 1,  duration: 10, opacity: 0.05 },
  { size: 70,  top: 'auto',right: -20,  bottom: '30%', left: 'auto', rotate: -1, duration: 14, opacity: 0.05 },
  { size: 50,  top: '60%', right: -10,  bottom: 'auto',left: 'auto', rotate: 1,  duration: 8,  opacity: 0.04 },
];

export default function GearBackground() {
  // Disable on mobile — rotating SVGs are expensive on low-end devices
  if (window.innerWidth < 768) return null;

  return (
    <>
      {gears.map((g, i) => (
        <m.div
          key={i}
          animate={{ rotate: g.rotate * 360 }}
          transition={{ duration: g.duration, repeat: Infinity, ease: 'linear' }}
          style={{
            position: 'fixed',
            top:    g.top,
            right:  g.right,
            bottom: g.bottom,
            left:   g.left,
            color: '#5B21B6',
            opacity: g.opacity,
            pointerEvents: 'none',
            zIndex: 0,
          }}
        >
          <GearIcon size={g.size} />
        </m.div>
      ))}
    </>
  );
}
