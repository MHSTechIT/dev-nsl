import { useEffect, useState, useMemo } from 'react';
import DatePicker from './DatePicker';

/* Caller activity drawer — opens from the Performance grid's Status pill.
   Shows the chronological audit log of every state transition for one
   caller on one IST day. Each row carries a color-coded tag, start →
   end timestamps, duration, and optional context (lead name on ON_CALL,
   over-by-sec on BREAK_OVER). */

const TAG_META = {
  LOGGED_IN:          { label: 'Logged in',       color: '#059669', bg: 'rgba(5,150,105,0.10)' },
  LOGGED_OUT:         { label: 'Logged out',      color: '#374151', bg: 'rgba(55,65,81,0.10)'  },
  ACTIVE:             { label: 'Active',          color: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
  ON_CALL:            { label: 'On call',         color: '#2563EB', bg: 'rgba(37,99,235,0.10)' },
  VIEWING_LEAD:       { label: 'Viewing lead',    color: '#0EA5E9', bg: 'rgba(14,165,233,0.10)' },
  AFTER_CALL_FORM:    { label: 'Filling form',    color: '#7C3AED', bg: 'rgba(124,58,237,0.10)' },
  ON_REASON_FORM:     { label: 'Reason picker',   color: '#D97706', bg: 'rgba(217,119,6,0.12)'  },
  BREAK_PICKER:       { label: 'Break picker',    color: '#EAB308', bg: 'rgba(234,179,8,0.12)'  },
  BREAK_OTHER_PICKER: { label: 'Break: other reason', color: '#CA8A04', bg: 'rgba(202,138,4,0.12)' },
  BREAK:              { label: 'Break',           color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' },
  BREAK_OVER:         { label: 'Break over',      color: '#DC2626', bg: 'rgba(220,38,38,0.12)'  },
  RESUMED:            { label: 'Resumed',         color: '#0891B2', bg: 'rgba(8,145,178,0.10)'  },
  IDLE:               { label: 'Idle',            color: '#6B7280', bg: 'rgba(107,114,128,0.12)' },
  PAUSED_BY_ADMIN:    { label: 'Paused by admin', color: '#B91C1C', bg: 'rgba(185,28,28,0.12)'  },
  UNPAUSED_BY_ADMIN:  { label: 'Unpaused by admin', color: '#15803D', bg: 'rgba(21,128,61,0.12)' },
  OFFLINE:            { label: 'Offline',         color: '#6B7280', bg: 'rgba(107,114,128,0.18)' },
  // Page-level — which workspace tab the caller is sitting on. Soft purples
  // so they read as "background context" vs. the brighter modal/call tags.
  ON_PAGE_CALL:         { label: 'Page: Call',            color: '#6D28D9', bg: 'rgba(109,40,217,0.08)' },
  ON_PAGE_ASSIGNED:     { label: 'Page: Assigned',        color: '#6D28D9', bg: 'rgba(109,40,217,0.08)' },
  ON_PAGE_COMPLETED:    { label: 'Page: Completed',       color: '#6D28D9', bg: 'rgba(109,40,217,0.08)' },
  ON_PAGE_NOT_PICKED:   { label: 'Page: Not Picked',      color: '#6D28D9', bg: 'rgba(109,40,217,0.08)' },
  ON_PAGE_MISSED_CALLS: { label: 'Page: Missed Calls',    color: '#6D28D9', bg: 'rgba(109,40,217,0.08)' },
  ON_PAGE_UNTOUCHED:    { label: 'Page: Untouched',       color: '#6D28D9', bg: 'rgba(109,40,217,0.08)' },
  ON_PAGE_NEXT_BATCH:   { label: 'Page: Next Batch',      color: '#6D28D9', bg: 'rgba(109,40,217,0.08)' },
};

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

function fmtDuration(sec) {
  if (sec == null || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function todayIstYmd() {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  return istNow.toISOString().slice(0, 10);
}

export default function CallerActivityDrawer({
  token, callerId, callerName, onClose,
  // Pause/Resume support. `isActive` is the current paused state of the
  // caller; `onTogglePause` is async and the parent updates its row data.
  // When `onTogglePause` is omitted, the button is hidden entirely so the
  // drawer can still be used by any view that doesn't grant pause rights.
  isActive,
  onTogglePause,
}) {
  // Local "busy" flag so the button shows a loading state while the
  // parent's PATCH is in flight. Cleared as soon as onTogglePause resolves.
  const [togglingPause, setTogglingPause] = useState(false);
  async function handleTogglePause() {
    if (typeof onTogglePause !== 'function' || togglingPause) return;
    setTogglingPause(true);
    try { await onTogglePause(); }
    finally { setTogglingPause(false); }
  }
  // Hide the pause button entirely if the parent didn't wire up a handler.
  const canTogglePause = typeof onTogglePause === 'function' && typeof isActive === 'boolean';
  const [date,    setDate]    = useState(() => todayIstYmd());
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  /* nowTick — re-renders every second so ongoing entries (ended_at IS NULL)
     show a live-ticking duration without re-fetching. */
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    if (!callerId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/admin/caller-activity/${callerId}?date=${date}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.error) { setError(d.error); setEvents([]); }
        else { setEvents(d.events || []); }
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, callerId, date]);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /* Esc closes the drawer */
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* Newest first, but keep open (ongoing) rows pinned to the top. */
  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => {
      const aOpen = a.ended_at == null ? 1 : 0;
      const bOpen = b.ended_at == null ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      return new Date(b.started_at) - new Date(a.started_at);
    });
  }, [events]);

  /* Per-tag totals for the summary header — only count closed events
     plus the live duration of open ones. */
  const summary = useMemo(() => {
    const totals = {};
    for (const ev of events) {
      const dur = ev.ended_at
        ? ev.duration_sec || 0
        : Math.max(0, Math.floor((nowTick - new Date(ev.started_at).getTime()) / 1000));
      totals[ev.tag] = (totals[ev.tag] || 0) + dur;
    }
    return totals;
  }, [events, nowTick]);

  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
          zIndex: 9000, backdropFilter: 'blur(2px)',
        }}
      />
      {/* Drawer panel */}
      <div
        role="dialog" aria-modal="true"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(560px, 100vw)', background: '#fff',
          zIndex: 9001, boxShadow: '-12px 0 40px rgba(15,23,42,0.20)',
          display: 'flex', flexDirection: 'column',
          fontFamily: 'Outfit, sans-serif',
          animation: 'cad-slide-in 220ms ease-out',
        }}
      >
        <style>{`
          @keyframes cad-slide-in {
            from { transform: translateX(20px); opacity: 0; }
            to   { transform: translateX(0);    opacity: 1; }
          }
          .cad-row:hover { background: rgba(91,33,182,0.04); }
        `}</style>

        {/* Header */}
        <div style={{
          padding: '18px 22px 14px', borderBottom: '1px solid rgba(209,196,240,0.45)',
          background: 'linear-gradient(180deg,#7C3AED,#5B21B6)', color: '#fff',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.10em' }}>
                Activity log
              </div>
              <div style={{ fontSize: '1.20rem', fontWeight: 800, marginTop: 2 }}>
                {callerName || `Caller #${callerId}`}
              </div>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {/* Pause / Resume button — only rendered when the parent
                  passes onTogglePause + isActive. Single button that
                  toggles between "Pause caller" (when active, red tint)
                  and "Resume caller" (when paused, green tint). */}
              {canTogglePause && (
                <button
                  type="button"
                  onClick={handleTogglePause}
                  disabled={togglingPause}
                  aria-label={isActive ? 'Pause caller' : 'Resume caller'}
                  title={isActive ? 'Pause this caller (block new auto-assigned leads)' : 'Resume this caller'}
                  style={{
                    height: 34, padding: '0 14px', borderRadius: 10, border: 'none',
                    background: togglingPause
                      ? 'rgba(255,255,255,0.20)'
                      : (isActive ? 'rgba(220,38,38,0.85)' : 'rgba(22,163,74,0.90)'),
                    color: '#fff', fontFamily: 'Outfit, sans-serif',
                    fontWeight: 700, fontSize: '0.80rem',
                    cursor: togglingPause ? 'wait' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    boxShadow: togglingPause ? 'none' : '0 2px 8px rgba(0,0,0,0.20)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isActive ? (
                    /* Pause icon — two vertical bars */
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                  ) : (
                    /* Play icon — right-pointing triangle */
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                  )}
                  {togglingPause ? '…' : (isActive ? 'Pause' : 'Resume')}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  width: 34, height: 34, borderRadius: 10, border: 'none',
                  background: 'rgba(255,255,255,0.18)', color: '#fff',
                  cursor: 'pointer', display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.10rem', fontWeight: 800,
                }}
              >×</button>
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: '0.78rem', opacity: 0.85, fontWeight: 600 }}>Date</label>
            {/* Custom DatePicker — same component used across the admin
                UI (Sales Performance, Funnel Overview). Matches the
                violet/Outfit aesthetic so it doesn't clash with the
                browser-native dark date dropdown that was here before.
                We also guard against future-day picks by clamping any
                onChange value that exceeds today (IST) back to today —
                the activity log has no rows beyond today anyway. */}
            <DatePicker
              value={date}
              onChange={v => {
                const max = todayIstYmd();
                if (!v) return;            // ignore Clear (keep current)
                setDate(v > max ? max : v);
              }}
              placeholder="Select date"
            />
          </div>
        </div>

        {/* Summary chips */}
        {!loading && events.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 6,
            padding: '12px 22px', borderBottom: '1px solid rgba(209,196,240,0.45)',
            background: '#FAF7FF',
          }}>
            {Object.entries(summary)
              .sort((a, b) => b[1] - a[1])
              .map(([tag, sec]) => {
                const meta = TAG_META[tag] || { label: tag, color: '#374151', bg: 'rgba(55,65,81,0.10)' };
                return (
                  <span key={tag} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 999,
                    background: meta.bg, color: meta.color,
                    fontSize: '0.74rem', fontWeight: 700,
                  }}>
                    <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{meta.label}</span>
                    <span style={{ opacity: 0.75 }}>{fmtDuration(sec)}</span>
                  </span>
                );
              })}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.88rem' }}>
              Loading activity…
            </div>
          ) : error ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#DC2626', fontSize: '0.88rem' }}>
              {error}
            </div>
          ) : sortedEvents.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.88rem' }}>
              No activity recorded for this day.
            </div>
          ) : sortedEvents.map(ev => {
            const meta = TAG_META[ev.tag] || { label: ev.tag, color: '#374151', bg: 'rgba(55,65,81,0.10)' };
            const ongoing = ev.ended_at == null;
            const liveDur = ongoing
              ? Math.max(0, Math.floor((nowTick - new Date(ev.started_at).getTime()) / 1000))
              : (ev.duration_sec || 0);
            const ctx = ev.context || {};
            return (
              <div
                key={ev.id}
                className="cad-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr auto',
                  alignItems: 'center', gap: 10,
                  padding: '12px 22px',
                  borderBottom: '1px solid rgba(209,196,240,0.30)',
                  transition: 'background 120ms',
                }}
              >
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  padding: '5px 8px', borderRadius: 999,
                  background: meta.bg, color: meta.color,
                  fontSize: '0.66rem', fontWeight: 800,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  {ongoing && (
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: meta.color, marginRight: 6,
                      animation: 'pulse 1.4s infinite',
                    }} />
                  )}
                  {meta.label}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#3B0764', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {fmtTime(ev.started_at)} <span style={{ opacity: 0.55, fontWeight: 600 }}>→</span> {ongoing ? <span style={{ color: meta.color }}>ongoing</span> : fmtTime(ev.ended_at)}
                  </div>
                  {(ctx.lead_name || ctx.over_by_sec || ctx.reason || ctx.minutes || ctx.kind || ctx.attempt) && (
                    <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.65)', fontWeight: 600, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {ctx.kind === 'agent_dnp' && <span>Why didn't customer pick? </span>}
                      {ctx.kind === 'form_skip' && <span>Why didn't form get filled? </span>}
                      {ctx.lead_name && <span>Lead: {ctx.lead_name}</span>}
                      {ctx.attempt && <span>{ctx.lead_name ? ' · ' : ''}Try {ctx.attempt}</span>}
                      {ctx.reason && <span>{(ctx.lead_name || ctx.attempt) ? ' · ' : ''}Reason: {ctx.reason}</span>}
                      {ctx.minutes && <span>{(ctx.lead_name || ctx.reason || ctx.attempt) ? ' · ' : ''}Allotted: {ctx.minutes}m</span>}
                      {ctx.over_by_sec > 0 && <span style={{ color: '#DC2626' }}>{(ctx.lead_name || ctx.reason || ctx.minutes || ctx.attempt) ? ' · ' : ''}Over by {fmtDuration(ctx.over_by_sec)}</span>}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: '0.84rem', fontWeight: 800, color: meta.color, textAlign: 'right', minWidth: 70 }}>
                  {fmtDuration(liveDur)}
                </div>
              </div>
            );
          })}
        </div>

        <style>{`
          @keyframes pulse {
            0%   { opacity: 0.4; }
            50%  { opacity: 1; }
            100% { opacity: 0.4; }
          }
        `}</style>
      </div>
    </>
  );
}
