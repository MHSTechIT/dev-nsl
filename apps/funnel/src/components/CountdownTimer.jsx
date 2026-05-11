import { useState, useEffect } from 'react';
import { useFunnel } from '../context/FunnelContext';
import { getCountdownParts } from '../utils/time';
import { t } from '../translations';
import { FlipUnit } from './FlipCard';

export function stopTick() {
  // no-op — tick sound removed
}

export default function CountdownTimer({ floating = false }) {
  const { state } = useFunnel();
  const lang = state.lang;
  const [parts, setParts] = useState(getCountdownParts(state.webinarConfig.next_webinar_at));

  useEffect(() => {
    const id = setInterval(() => {
      setParts(getCountdownParts(state.webinarConfig.next_webinar_at));
    }, 1000);
    return () => clearInterval(id);
  }, [state.webinarConfig.next_webinar_at]);

  if (parts.isDuringSession) {
    return (
      <div className="rounded-card px-4 py-3 text-center font-sans text-sm font-semibold text-purple bg-purple-50 border border-purple-100">
        {t.screen1A.duringSession[lang]}
      </div>
    );
  }

  const isNear = parts.isNearStart;
  const isUrgent = parts.isUrgent;
  const showDays = parts.days > 0;

  const units = showDays
    ? [
        { val: parts.days, label: t.screen1A.days[lang] },
        { val: parts.hrs,  label: t.screen1A.hrs[lang] },
        { val: parts.min,  label: t.screen1A.min[lang] },
        { val: parts.sec,  label: t.screen1A.sec[lang] },
      ]
    : [
        { val: parts.hrs,  label: t.screen1A.hrs[lang] },
        { val: parts.min,  label: t.screen1A.min[lang] },
        { val: parts.sec,  label: t.screen1A.sec[lang] },
      ];

  return (
    <div className={`rounded-card p-4 ${isNear ? 'animate-pulse' : ''}`} style={{ background: isUrgent ? 'rgba(254,242,242,0.75)' : 'rgba(255,255,255,0.55)', backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)', border: isUrgent ? '1px solid rgba(239,68,68,0.35)' : '1px solid rgba(139,92,246,0.18)', boxShadow: isUrgent ? '0 4px 24px rgba(239,68,68,0.15)' : '0 4px 24px rgba(91,33,182,0.10)', transition: 'all 0.5s' }}>
      <p className="font-sans text-center text-xs font-semibold mb-4 tracking-widest uppercase" style={{ color: '#5b3fa0' }}>
        {isNear ? t.screen1A.nearStart[lang] : t.screen1A.timerLabel[lang]}
      </p>

      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', gap: 2 }}>
        {units.map(({ val, label }, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <FlipUnit value={val} label={label} size="lg" urgent={isUrgent} />
            {i < units.length - 1 && (
              <span style={{
                fontFamily: 'Outfit, sans-serif',
                fontWeight: 700,
                fontSize: '1.2rem',
                color: '#5b3fa0',
                lineHeight: 1,
                marginTop: 12,
                userSelect: 'none',
              }}>:</span>
            )}
          </div>
        ))}
      </div>

      {/* Workshop date now lives in the bottom footer of Screen1A, not inside
          the countdown card. Keep the marker comment so future merges remind
          us where to find it. */}
    </div>
  );
}
