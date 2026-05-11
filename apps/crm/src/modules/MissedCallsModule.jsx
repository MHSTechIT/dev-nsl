import { useState, useEffect, useCallback, useRef } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
   Missed Calls — inbound calls (customer dialed the Tata DID) that didn't
   connect to a caller. Includes:
     – calls linked to a lead assigned to this caller
     – calls from unknown numbers (caller_id NULL on the row) so the whole
       team sees them and any agent can claim & convert to a lead.

   Auto-refreshes every 30 s and on SSE 'call.update' / 'call.incoming'.
   ────────────────────────────────────────────────────────────────────────── */

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}

function fmtPhone(num) {
  if (!num) return 'Unknown';
  return `+91 ${num}`;
}

const STATUS_BADGE = {
  missed:  { bg: 'rgba(220,38,38,0.12)',  fg: '#B91C1C', label: 'Missed' },
  failed:  { bg: 'rgba(220,38,38,0.10)',  fg: '#991B1B', label: 'Failed' },
  ringing: { bg: 'rgba(245,158,11,0.15)', fg: '#B45309', label: 'Rang, no answer' },
  ended:   { bg: 'rgba(91,33,182,0.10)',  fg: '#5B21B6', label: 'Ended (not answered)' },
};

export default function MissedCallsModule({ jwt }) {
  const [calls, setCalls]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const sseRef = useRef(null);

  const fetchCalls = useCallback(async () => {
    if (!jwt) {
      setCalls([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/caller/calls/missed-inbound', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) throw new Error('Failed to load missed calls.');
      const data = await res.json();
      setCalls(data.calls || []);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { fetchCalls(); }, [fetchCalls]);

  // Auto-refresh every 30 s — Tata's missed/hangup webhook can lag, so a
  // periodic poll catches calls that have just transitioned to 'missed'.
  useEffect(() => {
    if (!jwt) return;
    const t = setInterval(fetchCalls, 30000);
    return () => clearInterval(t);
  }, [jwt, fetchCalls]);

  // SSE refresh on incoming/updated call events
  useEffect(() => {
    if (!jwt) return;
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwt)}`;
    const es  = new EventSource(url);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'call.incoming' || msg?.type === 'call.update' || msg?.type === 'call.hangup') {
          fetchCalls();
        }
      } catch (_) {}
    };
    return () => { es.close(); sseRef.current = null; };
  }, [jwt, fetchCalls]);

  const filtered = calls.filter(c => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    const blob = `${c.full_name || ''} ${c.phone || ''} ${c.email || ''}`.toLowerCase();
    return blob.includes(q);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Search */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 16 }}>
        <div style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search missed calls by name or phone…"
            style={{ width: '100%', height: '2.4rem', padding: '0 12px 0 34px', borderRadius: 6, border: '1px solid rgba(209,196,240,0.7)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 6, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* List */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', fontFamily: 'Outfit,sans-serif', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
            <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 12, background: 'rgba(220,38,38,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#B91C1C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                <line x1="22" y1="2" x2="2" y2="22"/>
              </svg>
            </div>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>
              {calls.length === 0 ? 'No missed calls yet' : 'No matches'}
            </div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem', maxWidth: 360, margin: '0 auto' }}>
              {calls.length === 0
                ? <>When a customer calls in and isn't picked up, the call will appear here.</>
                : 'Try clearing the search.'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {filtered.map(c => {
              const badge = STATUS_BADGE[c.status] || { bg: 'rgba(91,33,182,0.08)', fg: '#5B21B6', label: c.status || '—' };
              return (
                <div key={c.id} style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(180px,1.4fr) minmax(140px,1fr) minmax(150px,auto) minmax(140px,auto)',
                  alignItems: 'center', gap: 14,
                  padding: '14px 18px',
                  borderTop: '1px solid rgba(209,196,240,0.30)',
                  fontFamily: 'Outfit, sans-serif',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.92rem' }}>
                        {c.full_name || 'Unknown caller'}
                      </span>
                      {!c.is_known && (
                        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700, background: 'rgba(91,33,182,0.08)', color: '#5B21B6' }}>
                          NEW
                        </span>
                      )}
                    </div>
                    {c.email && (
                      <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{c.email}</div>
                    )}
                  </div>
                  <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.80rem', color: '#3B0764' }}>
                    {fmtPhone(c.phone)}
                  </div>
                  <div>
                    <span style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, background: badge.bg, color: badge.fg, whiteSpace: 'nowrap' }}>
                      {badge.label}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)', textAlign: 'right' }}>
                    {fmtDate(c.started_at)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
