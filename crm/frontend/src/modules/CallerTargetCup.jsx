import { useState, useEffect, useRef } from 'react';
import Lottie from 'lottie-react';
import trophyAnim from '../assets/trophy.json';

/* CallerTargetCup — the caller's "Targeted Calls" progress cup.
   Polls GET /api/caller/daily-target ({ target, attempts_today, done }) and
   renders a mug that fills with violet liquid as the caller dials leads. When
   today's attempts reach the global daily target, the trophy animation plays.
   Renders nothing when no target is set (target === 0). */

const VIOLET = '#5B21B6';

export default function CallerTargetCup({ jwt }) {
  const [data, setData]         = useState(null);   // { target, attempts_today, done }
  const [celebrate, setCelebrate] = useState(false);
  const prevDone = useRef(false);

  useEffect(() => {
    if (!jwt) return;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/caller/daily-target', { headers: { Authorization: `Bearer ${jwt}` } });
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        setData(d);
        // Fire the celebration the moment we cross from not-done → done.
        if (d.done && !prevDone.current) {
          setCelebrate(true);
          setTimeout(() => setCelebrate(false), 6000);
        }
        prevDone.current = d.done;
      } catch { /* keep last value */ }
    }
    load();
    const id = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [jwt]);

  // No target configured → don't show the cup at all.
  if (!data || !data.target) return null;

  const target   = data.target;
  const attempts = data.attempts_today || 0;
  const done     = !!data.done;
  const pct      = Math.max(0, Math.min(1, target > 0 ? attempts / target : 0));
  const fillPct  = Math.round(pct * 100);

  // Mug geometry (viewBox 0 0 120 150). Interior rounded-rect 24..96 × 14..126.
  const topY = 14, botY = 126, height = botY - topY;   // 112
  const liquidH = height * pct;
  const liquidY = botY - liquidH;

  return (
    <div style={{
      width: 196, background: '#fff', borderRadius: 18,
      border: '1px solid rgba(139,92,246,0.18)',
      boxShadow: '0 8px 28px rgba(91,33,182,0.14)',
      padding: '14px 14px 16px', fontFamily: 'Outfit, sans-serif',
      position: 'relative', overflow: 'hidden', textAlign: 'center',
    }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(91,33,182,0.7)', marginBottom: 8 }}>
        Targeted Calls
      </div>

      <style>{`
        @keyframes cup-trophy-rise {
          0%   { transform: translateY(46px) scale(0.35); opacity: 0; }
          60%  { transform: translateY(-6px) scale(1.08); opacity: 1; }
          100% { transform: translateY(0)    scale(1);    opacity: 1; }
        }
      `}</style>

      <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', minHeight: 150 }}>
        {done ? (
          /* 100% reached → the trophy RISES UP and celebrates (replaces the cup). */
          <div style={{ animation: 'cup-trophy-rise 800ms cubic-bezier(.2,.8,.3,1.2) both' }}>
            <Lottie animationData={trophyAnim} loop autoplay style={{ width: 150, height: 150 }} />
          </div>
        ) : (
          /* In progress → the cup fills (liquid rises) with the live %. */
          <svg viewBox="0 0 120 150" width="120" height="150" role="img" aria-label={`${attempts} of ${target}`}>
            <defs>
              <clipPath id="cupClip"><rect x="24" y={topY} width="72" height={height} rx="14" /></clipPath>
              <linearGradient id="cupLiquid" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#8B5CF6" />
                <stop offset="1" stopColor="#5B21B6" />
              </linearGradient>
            </defs>

            {/* glass background */}
            <rect x="24" y={topY} width="72" height={height} rx="14" fill="rgba(237,234,248,0.75)" />

            {/* liquid (animated rise) */}
            <g clipPath="url(#cupClip)">
              <rect
                x="24" width="72"
                y={liquidY} height={liquidH}
                fill="url(#cupLiquid)"
                style={{ transition: 'y 0.8s ease, height 0.8s ease' }}
              />
              {pct > 0 && (
                <ellipse cx="60" cy={liquidY} rx="36" ry="3.5" fill="rgba(255,255,255,0.35)"
                  style={{ transition: 'cy 0.8s ease' }} />
              )}
            </g>

            {/* handle */}
            <path d="M96 42 q24 4 24 28 q0 24 -24 28" fill="none" stroke={VIOLET} strokeWidth="4" strokeLinecap="round" />
            {/* glass outline */}
            <rect x="24" y={topY} width="72" height={height} rx="14" fill="none" stroke={VIOLET} strokeWidth="3.5" />

            {/* percent in the middle, color flips for contrast as liquid rises */}
            <text x="60" y="76" textAnchor="middle" fontSize="22" fontWeight="800"
              fill={pct > 0.45 ? '#fff' : VIOLET} fontFamily="Outfit, sans-serif">
              {fillPct}%
            </text>
          </svg>
        )}
      </div>

      <div style={{ marginTop: 8, fontSize: '1.05rem', fontWeight: 800, color: '#3B0764', fontVariantNumeric: 'tabular-nums' }}>
        {attempts} <span style={{ color: 'rgba(91,33,182,0.45)', fontWeight: 700 }}>/ {target}</span>
      </div>
      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: done ? '#059669' : 'rgba(91,33,182,0.55)' }}>
        {done ? '🎉 Target reached!' : `${Math.max(0, target - attempts)} to go`}
      </div>
    </div>
  );
}
