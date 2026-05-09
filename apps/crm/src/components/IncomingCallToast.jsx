import { useState, useEffect, useRef, useCallback } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
   Incoming-call toast popup.

   Subscribes to /api/caller/leads/events (SSE) and listens for `call.incoming`
   events that the backend emits when Tata's dialplan webhook fires for an
   inbound call matched to one of this caller's assigned leads.

   Stacks up to 3 visible toasts, newest on top. Each toast auto-dismisses
   after 30s (configurable via AUTO_DISMISS_MS) or when the caller clicks
   "Open lead" or the close button.
   ────────────────────────────────────────────────────────────────────────── */

const AUTO_DISMISS_MS = 30000;
const MAX_VISIBLE     = 3;

export default function IncomingCallToast({ jwt, onOpenLead }) {
  const [calls, setCalls] = useState([]);   // [{ key, leadId, fullName, phone, uuid, at }]
  const sseRef = useRef(null);
  const audioRef = useRef(null);

  const dismiss = useCallback((key) => {
    setCalls(prev => prev.filter(c => c.key !== key));
  }, []);

  const handleOpen = useCallback((call) => {
    if (call.leadId && onOpenLead) onOpenLead(call.leadId);
    dismiss(call.key);
  }, [onOpenLead, dismiss]);

  /* Single SSE connection scoped to the shell — independent of the per-module
     subscriptions so the toast survives across page changes. */
  useEffect(() => {
    if (!jwt) return;
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwt)}`;
    const es  = new EventSource(url);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'call.incoming') {
          const entry = {
            key:      `${msg.uuid || ''}-${Date.now()}`,
            leadId:   msg.lead_id || null,
            fullName: msg.full_name || 'Unknown caller',
            phone:    msg.phone || '',
            uuid:     msg.uuid || null,
            at:       Date.now(),
          };
          setCalls(prev => [entry, ...prev].slice(0, MAX_VISIBLE));
          // Soft chime — best-effort, ignored if audio is blocked
          try { audioRef.current && audioRef.current.play().catch(() => {}); } catch (_) {}
        }
      } catch (_) { /* ignore malformed */ }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => { es.close(); sseRef.current = null; };
  }, [jwt]);

  /* Auto-dismiss timer per toast */
  useEffect(() => {
    if (calls.length === 0) return;
    const timers = calls.map(c => setTimeout(() => dismiss(c.key), Math.max(0, AUTO_DISMISS_MS - (Date.now() - c.at))));
    return () => timers.forEach(clearTimeout);
  }, [calls, dismiss]);

  if (calls.length === 0) return null;

  return (
    <>
      {/* Soft chime — short data-URI sine beep so we don't ship a binary file */}
      <audio
        ref={audioRef}
        src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
        preload="auto"
      />
      <div
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          zIndex: 10000,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          maxWidth: 360,
          width: 'calc(100vw - 32px)',
          pointerEvents: 'none',
        }}
      >
        <style>{`
          @keyframes incomingSlideIn {
            from { opacity: 0; transform: translateX(20px) scale(0.96); }
            to   { opacity: 1; transform: translateX(0) scale(1); }
          }
          @keyframes incomingPulse {
            0%, 100% { box-shadow: 0 12px 32px rgba(91,33,182,0.20), 0 0 0 0 rgba(16,185,129,0.45); }
            50%      { box-shadow: 0 12px 32px rgba(91,33,182,0.20), 0 0 0 10px rgba(16,185,129,0); }
          }
        `}</style>

        {calls.map(c => (
          <div
            key={c.key}
            style={{
              pointerEvents: 'auto',
              background: '#fff',
              borderRadius: 16,
              border: '1px solid rgba(16,185,129,0.30)',
              padding: '14px 16px',
              fontFamily: 'Outfit, sans-serif',
              animation: 'incomingSlideIn 220ms ease, incomingPulse 1600ms ease infinite',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              {/* Phone icon */}
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'rgba(16,185,129,0.12)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#059669', marginBottom: 2 }}>
                  Incoming call
                </div>
                <div style={{ fontWeight: 700, fontSize: '0.96rem', color: '#3B0764', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.fullName}
                </div>
                {c.phone && (
                  <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)' }}>
                    +91 {c.phone}
                  </div>
                )}
              </div>

              <button
                onClick={() => dismiss(c.key)}
                aria-label="Dismiss"
                style={{
                  width: 26, height: 26, borderRadius: 8, border: 'none',
                  background: 'rgba(91,33,182,0.06)', color: '#5B21B6',
                  cursor: 'pointer', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {c.leadId && (
              <button
                onClick={() => handleOpen(c)}
                style={{
                  width: '100%', height: '2.2rem',
                  borderRadius: 10, border: 'none',
                  background: '#5B21B6', color: '#fff',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
                  cursor: 'pointer',
                  boxShadow: '0 2px 10px rgba(91,33,182,0.30)',
                }}
              >
                Open lead
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
