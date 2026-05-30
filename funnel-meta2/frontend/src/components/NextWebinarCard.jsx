import { useFunnel } from '../context/FunnelContext';

/**
 * Single-line strip below the registration countdown.
 * Shows "workshop at : <date> · <time> IST" — no card chrome.
 * Hidden when no upcoming date is configured.
 */
export default function NextWebinarCard() {
  const { state } = useFunnel();
  const iso = state.webinarConfig?.current_webinar_date
           || state.webinarConfig?.next_webinar_date
           || state.webinarConfig?.backup_webinar_at;
  if (!iso) return null;

  let dateLabel = '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const date = d.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day:      'numeric',
      month:    'short',
      year:     'numeric',
    });
    const time = d.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour:     'numeric',
      minute:   '2-digit',
      hour12:   true,
    }).replace(/\s/g, ''); // "6:00pm"
    dateLabel = `${date}, ${time} IST`;
  } catch { return null; }

  return (
    <p
      style={{
        margin: 0,
        padding: '0 4px',
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontFamily: '"Outfit", sans-serif',
        fontWeight: 600,
        fontSize: 'clamp(0.72rem, 3vw, 0.95rem)',
        color: '#3B0764',
        letterSpacing: '0.01em',
      }}
    >
      <span style={{ color: '#5b3fa0', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.88em' }}>
        Workshop at :
      </span>{' '}
      {dateLabel}
    </p>
  );
}
