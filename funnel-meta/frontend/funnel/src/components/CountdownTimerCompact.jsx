import { useState, useEffect } from 'react';
import { useFunnel } from '../context/FunnelContext';
import { getCountdownParts } from '../utils/time';
import { FlipUnit } from './FlipCard';

export default function CountdownTimerCompact() {
  const { state } = useFunnel();
  const [parts, setParts] = useState(getCountdownParts(state.webinarConfig.next_webinar_at));

  useEffect(() => {
    const id = setInterval(() => {
      setParts(getCountdownParts(state.webinarConfig.next_webinar_at));
    }, 1000);
    return () => clearInterval(id);
  }, [state.webinarConfig.next_webinar_at]);

  if (parts.isDuringSession) return null;

  const isUrgent = parts.isUrgent;
  const units = [
    { val: parts.hrs,  label: 'h' },
    { val: parts.min,  label: 'm' },
    { val: parts.sec,  label: 's' },
  ];

  return (
    <div className="inline-flex items-end gap-2 rounded-pill px-4 py-2" style={{ background: isUrgent ? 'rgba(254,242,242,0.90)' : 'rgba(255,255,255,0.82)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: isUrgent ? '1px solid rgba(239,68,68,0.35)' : '1px solid rgba(255,255,255,0.6)', boxShadow: isUrgent ? '0 4px 16px rgba(239,68,68,0.12)' : '0 4px 16px rgba(91,33,182,0.07)', transition: 'all 0.5s' }}>
      <span className="text-purple-400 text-xs mb-0.5">⏱</span>
      <div className="flex items-end gap-1.5">
        {units.map(({ val, label }, i) => (
          <div key={i} className="flex items-end gap-1.5">
            <FlipUnit value={val} label={label} size="sm" />
            {i < units.length - 1 && (
              <span className="font-heading font-bold text-sm mb-5 leading-none select-none" style={{color:'rgba(91,33,182,0.4)'}}>:</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
