import { useFunnel } from '../context/FunnelContext';

/**
 * Next Webinar card — sits below the "Registration closes in" countdown.
 * Shows just the DATE of the upcoming (backup) webinar — no countdown timer.
 * Hidden if `backup_webinar_at` isn't configured.
 */
export default function NextWebinarCard() {
  const { state } = useFunnel();
  // Prefer the dedicated "actual webinar date" set in admin; fall back to the
  // upcoming-registration deadline (backup_webinar_at) so old configs keep working.
  const iso = state.webinarConfig?.current_webinar_date
           || state.webinarConfig?.next_webinar_date
           || state.webinarConfig?.backup_webinar_at;
  if (!iso) return null;

  let dateLabel = '';
  let timeLabel = '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    dateLabel = d.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday:  'short',
      day:      'numeric',
      month:    'short',
      year:     'numeric',
    });
    timeLabel = d.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour:     'numeric',
      minute:   '2-digit',
      hour12:   true,
    });
  } catch { return null; }

  return (
    <div
      className="rounded-card p-4"
      style={{
        background: 'rgba(255,255,255,0.55)',
        backdropFilter:        'blur(24px) saturate(180%)',
        WebkitBackdropFilter:  'blur(24px) saturate(180%)',
        border: '1px solid rgba(139,92,246,0.18)',
        boxShadow: '0 4px 24px rgba(91,33,182,0.10)',
      }}
    >
      <p
        className="font-sans text-center text-xs font-semibold mb-3 tracking-widest uppercase"
        style={{ color: '#5b3fa0' }}
      >
        Next Webinar
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'center',
          gap: 8,
          flexWrap: 'wrap',
          textAlign: 'center',
        }}
      >
        <span
          style={{
            fontFamily: '"Outfit", sans-serif',
            fontWeight: 700,
            fontSize: 'clamp(0.95rem, 2.5vw, 1.05rem)',
            color: '#3B0764',
            lineHeight: 1.2,
          }}
        >
          {dateLabel}
        </span>
        <span style={{ color: 'rgba(91,33,182,0.40)', fontSize: '0.85rem' }}>·</span>
        <span
          style={{
            fontFamily: '"Outfit", sans-serif',
            fontWeight: 600,
            fontSize: '0.92rem',
            color: '#5b3fa0',
          }}
        >
          {timeLabel} IST
        </span>
      </div>
    </div>
  );
}
