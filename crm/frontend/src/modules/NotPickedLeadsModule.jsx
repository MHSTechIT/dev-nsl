import { useState, useEffect, useCallback, useRef } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
   Not Picked Leads — leads the caller dialed but couldn't reach. Marked via
   the DNP button in the call notes modal. Read-only list (for now).
   ────────────────────────────────────────────────────────────────────────── */

const SUGAR_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}

function fmtPhone(num) {
  if (!num) return '—';
  return `+91 ${num}`;
}

export default function NotPickedLeadsModule({ jwt }) {
  const [leads, setLeads]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const sseRef = useRef(null);

  const fetchLeads = useCallback(async () => {
    if (!jwt) {
      setLeads([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/caller/leads/not-picked', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) throw new Error('Failed to load not-picked leads.');
      const data = await res.json();
      setLeads(data.leads || []);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  /* SSE — refresh when this caller saves a new note */
  useEffect(() => {
    if (!jwt) return;
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwt)}`;
    const es  = new EventSource(url);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'lead.note_saved') fetchLeads();
      } catch (_) {}
    };
    return () => { es.close(); sseRef.current = null; };
  }, [jwt, fetchLeads]);

  const filtered = leads;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
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
            <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 16, background: 'rgba(245,158,11,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#B45309" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                <line x1="22" y1="2" x2="2" y2="22"/>
              </svg>
            </div>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>
              No not-picked leads yet
            </div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem', maxWidth: 360, margin: '0 auto' }}>
              When you press <strong>DNP</strong> on the call notes modal, the lead lands here.
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <Th>Name</Th>
                  <Th>Phone</Th>
                  <Th>Sugar</Th>
                  <Th>Webinar</Th>
                  <Th>Marked at</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(l => {
                  const sugar = SUGAR_BADGE[l.sugar_level] || { bg: '#F3F4F6', fg: '#4B5563' };
                  return (
                    <tr key={l.id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
                      <Td>
                        <div style={{ fontWeight: 600, color: '#3B0764' }}>{l.full_name || '—'}</div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{l.email || '—'}</div>
                      </Td>
                      <Td mono>{fmtPhone(l.whatsapp_number)}</Td>
                      <Td>
                        <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 50, fontSize: '0.72rem', fontWeight: 700, background: sugar.bg, color: sugar.fg }}>
                          {l.sugar_level || '—'}
                        </span>
                      </Td>
                      <Td bold>{l.webinar_name || '—'}</Td>
                      <Td muted>{fmtDate(l.last_note_at)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ children }) {
  return (
    <th style={{
      padding: '12px 16px', fontSize: '0.72rem', fontWeight: 700,
      letterSpacing: '0.04em', textTransform: 'uppercase',
      color: 'rgba(91,33,182,0.55)',
    }}>{children}</th>
  );
}
function Td({ children, mono, bold, muted }) {
  return (
    <td style={{
      padding: '12px 16px',
      fontSize: mono ? '0.80rem' : muted ? '0.78rem' : '0.86rem',
      fontFamily: mono ? 'ui-monospace, monospace' : 'Outfit,sans-serif',
      color: muted ? 'rgba(91,33,182,0.65)' : '#3B0764',
      fontWeight: bold ? 600 : 'inherit',
    }}>{children}</td>
  );
}
