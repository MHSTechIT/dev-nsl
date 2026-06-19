import { useState, useEffect, useCallback } from 'react';

/* ──────────────────────────────────────────────────────────────────────
   Sales → Tata Tele tab.

   Shows each caller's Tata Tele number (the outbound DID customers see) and a
   SPAM-RISK signal. Tata exposes no spam flag, so we infer it from the pickup
   (answer) rate over a window: a flagged DID makes customers stop answering,
   so its rate collapses. Low rate ⇒ likely flagged as spam.
   ────────────────────────────────────────────────────────────────────── */

const FONT      = 'Outfit, sans-serif';
const PURPLE_DK = '#3B0764';
const PURPLE    = '#5B21B6';
const PURPLE_BR = 'rgba(139,92,246,0.20)';

const RISK = {
  healthy:     { label: 'Healthy',        color: '#15803D', bg: 'rgba(22,163,74,0.12)',  dot: '#16A34A' },
  at_risk:     { label: 'At risk',        color: '#B45309', bg: 'rgba(245,158,11,0.14)', dot: '#F59E0B' },
  likely_spam: { label: 'Likely spam',    color: '#B91C1C', bg: 'rgba(220,38,38,0.12)',  dot: '#DC2626' },
  no_data:     { label: 'Not enough data',color: '#6B7280', bg: 'rgba(107,114,128,0.12)',dot: '#9CA3AF' },
};

const WINDOWS = [7, 14, 30];

function fmtDID(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (!d) return '—';
  // 91XXXXXXXXXX → +91 XXXXX XXXXX
  const ten = d.length > 10 ? d.slice(-10) : d;
  const cc  = d.length > 10 ? d.slice(0, d.length - 10) : '';
  return `${cc ? '+' + cc + ' ' : ''}${ten.slice(0, 5)} ${ten.slice(5)}`.trim();
}

export default function TataTeleView({ token }) {
  const [days, setDays]       = useState(7);
  const [numbers, setNumbers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/tata-numbers?days=${days}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load Tata numbers.');
      const data = await res.json();
      setNumbers(data.numbers || []);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, days]);

  useEffect(() => { load(); }, [load]);

  const flagged = numbers.filter(n => n.risk === 'likely_spam').length;
  const atRisk  = numbers.filter(n => n.risk === 'at_risk').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONT }}>
      {/* Header bar — window selector + at-a-glance counts + refresh */}
      <div className="bg-white rounded-card" style={{
        padding: '14px 18px', borderRadius: 14, boxShadow: '0 2px 12px rgba(91,33,182,0.08)',
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto' }}>
          <span style={{ fontWeight: 800, color: PURPLE_DK, fontSize: '1rem' }}>Caller Tata numbers</span>
          <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.6)' }}>
            Spam risk inferred from pickup rate over the last {days} days.
            {flagged > 0 && <strong style={{ color: '#B91C1C' }}> · {flagged} likely flagged</strong>}
            {atRisk > 0 && <strong style={{ color: '#B45309' }}> · {atRisk} at risk</strong>}
          </span>
        </div>

        <div style={{ display: 'inline-flex', borderRadius: 50, background: 'rgba(91,33,182,0.07)', padding: 3 }}>
          {WINDOWS.map(w => (
            <button key={w} onClick={() => setDays(w)} style={{
              padding: '6px 14px', borderRadius: 50, border: 'none', cursor: 'pointer',
              fontFamily: FONT, fontWeight: 700, fontSize: '0.78rem',
              background: days === w ? PURPLE : 'transparent',
              color: days === w ? '#fff' : PURPLE,
            }}>{w}d</button>
          ))}
        </div>

        <button onClick={load} disabled={loading} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', borderRadius: 50, border: `1.5px solid ${PURPLE}`,
          background: '#fff', color: PURPLE, fontFamily: FONT, fontWeight: 700,
          fontSize: '0.78rem', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/>
          </svg>
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontSize: '0.82rem', color: '#DC2626', margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="bg-white rounded-card" style={{ borderRadius: 14, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', overflow: 'hidden' }}>
        {/* Column header */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 0.9fr 1.1fr 1.2fr', gap: 10,
          padding: '11px 18px', borderBottom: `1px solid ${PURPLE_BR}`,
          fontSize: '0.68rem', fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
          color: 'rgba(91,33,182,0.55)',
        }}>
          <span>Caller</span><span>Number (DID)</span><span>Calls</span><span>Pickup rate</span><span>Status</span>
        </div>

        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.86rem' }}>Loading…</div>
        ) : numbers.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.86rem' }}>
            No callers have a Tata number configured yet.
          </div>
        ) : numbers.map(n => {
          const meta = RISK[n.risk] || RISK.no_data;
          return (
            <div key={n.caller_id} style={{
              display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 0.9fr 1.1fr 1.2fr', gap: 10,
              padding: '13px 18px', borderBottom: `1px solid rgba(209,196,240,0.4)`, alignItems: 'center',
            }}>
              {/* Caller */}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: PURPLE_DK, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</div>
                <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{(n.role || '').replace('_', ' ')}</div>
              </div>
              {/* DID */}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: PURPLE_DK, fontSize: '0.88rem', fontVariantNumeric: 'tabular-nums' }}>{fmtDID(n.did)}</div>
                {n.extension && <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.5)' }}>ext {n.extension}</div>}
              </div>
              {/* Calls */}
              <div style={{ fontSize: '0.82rem', color: PURPLE_DK }}>
                <span style={{ fontWeight: 700 }}>{n.answered}</span>
                <span style={{ color: 'rgba(91,33,182,0.5)' }}> / {n.dialed}</span>
              </div>
              {/* Pickup rate bar */}
              <div>
                {n.answer_rate == null ? (
                  <span style={{ fontSize: '0.8rem', color: 'rgba(91,33,182,0.45)' }}>—</span>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 800, color: meta.color, fontSize: '0.86rem', minWidth: 36 }}>{n.answer_rate}%</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 4, background: 'rgba(91,33,182,0.10)', overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(100, n.answer_rate)}%`, height: '100%', background: meta.dot, borderRadius: 4 }} />
                    </div>
                  </div>
                )}
              </div>
              {/* Status pill */}
              <div>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 11px', borderRadius: 50, background: meta.bg, color: meta.color,
                  fontWeight: 800, fontSize: '0.74rem',
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.dot }} />
                  {meta.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.5)', margin: '0 4px', lineHeight: 1.5 }}>
        ⓘ Tata provides no direct spam flag. This estimates risk from how often customers answer the DID —
        a flagged number's pickup rate drops sharply. A low rate can also mean a poor lead batch, so treat it
        as a strong hint, not proof. (Needs at least 10 calls in the window to judge.)
      </p>
    </div>
  );
}
