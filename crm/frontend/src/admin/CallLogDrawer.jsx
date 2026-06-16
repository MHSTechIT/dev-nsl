import { useEffect, useRef, useState } from 'react';

/* Call-log drawer — opens from the New Page → per-caller ⋮ → "View call log".
   Read-only list of every call this caller has made/received, newest first,
   each with an inline recording player when a recording exists.

   Data:  GET  /api/admin/caller-calls/:callerId   (Bearer ADMIN_PASSWORD)
   Audio: GET  /api/caller/recordings/:id?token=<ADMIN_PASSWORD>
          (the recordings proxy accepts the admin token directly). */

const VIOLET = '#7C3AED';
const INK    = '#312E81';

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function fmtDuration(sec) {
  if (sec == null || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* Status → small colored chip. */
const STATUS_META = {
  answered:  { label: 'Answered',  color: '#15803D', bg: 'rgba(22,163,74,0.12)' },
  ended:     { label: 'Completed', color: '#15803D', bg: 'rgba(22,163,74,0.12)' },
  missed:    { label: 'Missed',    color: '#B91C1C', bg: 'rgba(185,28,28,0.12)' },
  failed:    { label: 'Failed',    color: '#B91C1C', bg: 'rgba(185,28,28,0.12)' },
  ringing:   { label: 'Ringing',   color: '#D97706', bg: 'rgba(217,119,6,0.14)' },
};

// Module-level "currently playing" tracker — starting one recording pauses
// any other that was playing (the browser-native control did this implicitly).
let _callLogCurrentAudio = null;

function RecordingPlayer({ src }) {
  const audioRef = useRef(null);
  const [playing, setPlaying]   = useState(false);
  const [errored, setErrored]   = useState(false);

  function togglePlay() {
    const a = audioRef.current;
    if (!a || errored) return;
    if (a.paused) {
      try {
        if (_callLogCurrentAudio && _callLogCurrentAudio !== a) _callLogCurrentAudio.pause();
        _callLogCurrentAudio = a;
      } catch { /* ignore */ }
      a.play().catch(() => setErrored(true));
    } else {
      a.pause();
    }
  }

  useEffect(() => () => {
    if (_callLogCurrentAudio === audioRef.current) _callLogCurrentAudio = null;
  }, []);

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={togglePlay}
        disabled={errored}
        title={errored ? 'Recording unavailable' : (playing ? 'Pause' : 'Play recording')}
        style={{
          width: 30, height: 30, borderRadius: '50%', border: 'none',
          background: errored ? 'rgba(220,38,38,0.30)' : (playing ? 'linear-gradient(135deg,#7C3AED,#5B21B6)' : '#5B21B6'),
          color: '#fff', cursor: errored ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}
      >
        {playing
          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          : <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>}
      </button>
      <audio
        ref={audioRef}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); if (_callLogCurrentAudio === audioRef.current) _callLogCurrentAudio = null; }}
        onError={() => setErrored(true)}
        style={{ height: 32 }}
        controls
      />
    </div>
  );
}

export default function CallLogDrawer({ token, caller, onClose }) {
  const callerId   = caller?.caller_id;
  const callerName = caller?.name;
  const [calls, setCalls]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [active, setActive]   = useState(null);   // current in-progress call (polled)
  const [nowMs, setNowMs]     = useState(() => Date.now()); // ticks the live timer

  useEffect(() => {
    let cancelled = false;
    if (!callerId) return;
    setLoading(true);
    setError('');
    fetch(`/api/admin/caller-calls/${callerId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (!cancelled) setCalls(Array.isArray(d.calls) ? d.calls : []); })
      .catch(() => { if (!cancelled) setError('Failed to load call log.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [callerId, token]);

  // Poll for the caller's current in-progress call every 3s while the drawer
  // is open, so the live monitor reflects ring → connected → hang-up promptly.
  useEffect(() => {
    if (!callerId) return;
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch(`/api/admin/caller-active-call/${callerId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error();
        const d = await r.json();
        if (!cancelled) setActive(d.active || null);
      } catch { if (!cancelled) setActive(null); }
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [callerId, token]);

  // Tick the live-call timer once a second (only matters while a call is active).
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function liveElapsed() {
    if (!active?.since) return '0:00';
    const s = Math.max(0, Math.floor((nowMs - new Date(active.since).getTime()) / 1000));
    return fmtDuration(s);
  }

  const withRecording = calls.filter(c => c.has_recording).length;

  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 9000, backdropFilter: 'blur(2px)' }}
      />
      {/* Panel */}
      <div
        role="dialog" aria-modal="true"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(620px, 100vw)', background: '#fff',
          zIndex: 9001, boxShadow: '-12px 0 40px rgba(15,23,42,0.20)',
          display: 'flex', flexDirection: 'column', fontFamily: 'Outfit, sans-serif',
          animation: 'cld-slide-in 220ms ease-out',
        }}
      >
        <style>{`
          @keyframes cld-slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
          .cld-row:hover { background: rgba(124,58,237,0.04); }
        `}</style>

        {/* Header */}
        <div style={{ padding: '18px 22px 16px', background: 'linear-gradient(180deg,#7C3AED,#5B21B6)', color: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.10em' }}>
                Call log
              </div>
              <div style={{ fontSize: '1.20rem', fontWeight: 800, marginTop: 2 }}>
                {callerName || `Caller #${callerId}`}
              </div>
            </div>
            <button
              type="button" onClick={onClose} aria-label="Close"
              style={{ width: 34, height: 34, borderRadius: 10, border: 'none', background: 'rgba(255,255,255,0.18)', color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.10rem', fontWeight: 800 }}
            >×</button>
          </div>
          {!loading && !error && (
            <div style={{ marginTop: 10, fontSize: '0.80rem', opacity: 0.9, fontWeight: 600 }}>
              {calls.length} call{calls.length === 1 ? '' : 's'} · {withRecording} with recording{withRecording === 1 ? '' : 's'}
            </div>
          )}
        </div>

        {/* Live monitor — only shown while a call is in progress. */}
        {active && (
          <div style={{
            padding: '12px 22px', background: active.connected ? 'rgba(22,163,74,0.07)' : 'rgba(217,119,6,0.07)',
            borderBottom: '1px solid rgba(209,196,240,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          }}>
            <style>{`@keyframes cld-pulse { 0%,100% { opacity:1; transform:scale(1);} 50% { opacity:.45; transform:scale(.8);} }`}</style>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                background: active.connected ? '#16A34A' : '#D97706',
                animation: 'cld-pulse 1.2s ease-in-out infinite',
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: active.connected ? '#15803D' : '#B45309' }}>
                  {active.connected ? 'On call — live' : (active.status === 'ringing' ? 'Ringing…' : 'Connecting…')}
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {active.direction === 'inbound' ? '↘ ' : '↗ '}{active.full_name}{active.phone ? ` · +91 ${active.phone}` : ''}
                </div>
              </div>
            </div>
            <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: '1.05rem', color: active.connected ? '#15803D' : '#B45309', flexShrink: 0 }}>
              {liveElapsed()}
            </div>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
          {loading && (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(49,46,129,0.6)', fontSize: '0.9rem' }}>Loading…</div>
          )}
          {error && (
            <div style={{ padding: 40, textAlign: 'center', color: '#B91C1C', fontSize: '0.9rem' }}>{error}</div>
          )}
          {!loading && !error && calls.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(49,46,129,0.6)', fontSize: '0.9rem' }}>
              No calls recorded for this caller yet.
            </div>
          )}

          {!loading && !error && calls.map((c) => {
            const sm = STATUS_META[c.status] || { label: c.status || '—', color: '#6B7280', bg: 'rgba(107,114,128,0.12)' };
            const inbound = c.direction === 'inbound';
            return (
              <div
                key={c.id}
                className="cld-row"
                style={{ padding: '12px 22px', borderBottom: '1px solid rgba(209,196,240,0.4)', display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* direction arrow */}
                    <span title={inbound ? 'Inbound' : 'Outbound'} style={{ color: inbound ? '#0891B2' : VIOLET, display: 'inline-flex', flexShrink: 0 }}>
                      {inbound
                        ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="7 17 17 7"/><polyline points="7 7 7 17 17 17" transform="rotate(180 12 12)"/></svg>
                        : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="9 7 17 7 17 15"/></svg>}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.92rem', color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.full_name}
                      </div>
                      <div style={{ fontSize: '0.78rem', color: 'rgba(49,46,129,0.6)' }}>
                        {c.phone ? `+91 ${c.phone}` : '—'}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: sm.color, background: sm.bg, padding: '3px 9px', borderRadius: 20, whiteSpace: 'nowrap' }}>
                      {sm.label}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '0.76rem', color: 'rgba(49,46,129,0.65)', fontWeight: 600 }}>
                    {fmtTime(c.started_at)} · {fmtDuration(c.duration_sec)}
                  </div>
                  {c.has_recording ? (
                    <RecordingPlayer src={`/api/caller/recordings/${c.id}?token=${encodeURIComponent(token)}`} />
                  ) : (
                    <span style={{ fontSize: '0.74rem', color: 'rgba(49,46,129,0.45)', fontStyle: 'italic' }}>No recording</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
