import { useState, useEffect } from 'react';

function fmt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}
function fmtPhone(p) {
  if (!p) return '—';
  const d = String(p).replace(/\D/g, '');
  return d.startsWith('91') ? '+' + d : '+91 ' + d;
}
function fmtDur(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SalesPerformanceDrillPanel({ token, caller, onClose }) {
  const [leads, setLeads] = useState([]);
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function onEsc(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  useEffect(() => {
    if (!caller) return;
    setLoading(true);
    Promise.all([
      fetch('/api/admin/leads', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`/api/admin/calls?caller_id=${caller.caller_id}&limit=50`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([leadsRes, callsRes]) => {
      const filtered = (leadsRes.leads || []).filter(l => l.assigned_user_id === caller.caller_id).slice(0, 50);
      setLeads(filtered);
      setCalls(callsRes.calls || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [caller, token]);

  if (!caller) return null;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,0,40,0.45)', backdropFilter: 'blur(4px)',
      zIndex: 100, display: 'flex', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(560px, 100%)', height: '100%', background: '#fff',
        boxShadow: '-8px 0 24px rgba(91,33,182,0.18)',
        display: 'flex', flexDirection: 'column', fontFamily: 'Outfit, sans-serif',
      }}>
        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: '1px solid rgba(209,196,240,0.40)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: '#3B0764' }}>{caller.name}</h3>
            <p style={{ margin: '2px 0 0', fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)', textTransform: 'capitalize' }}>
              {caller.role.replace('_', ' ')} · {caller.assigned} assigned · {caller.enrolled} enrolled · {caller.conversion_pct}% conv
            </p>
          </div>
          <button onClick={onClose} style={{
            width: 32, height: 32, borderRadius: 8, border: 'none',
            background: 'rgba(91,33,182,0.08)', color: '#5B21B6',
            cursor: 'pointer', fontSize: '1.1rem',
          }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Open leads */}
          <section>
            <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', fontWeight: 700, color: 'rgba(91,33,182,0.65)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Assigned leads {leads.length > 0 && `(${leads.length})`}
            </h4>
            {loading ? (
              <p style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>Loading…</p>
            ) : leads.length === 0 ? (
              <p style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>No leads currently assigned.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {leads.map(l => (
                  <div key={l.id} style={{
                    padding: '8px 12px', borderRadius: 8,
                    border: '1px solid rgba(209,196,240,0.40)',
                    fontSize: '0.80rem', display: 'flex', justifyContent: 'space-between', gap: 8,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: '#3B0764', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.full_name || '—'}
                      </div>
                      <div style={{ fontSize: '0.70rem', color: 'rgba(91,33,182,0.55)' }}>
                        {fmtPhone(l.whatsapp_number)} · {l.sugar_level || '—'} · {l.last_note_outcome || 'open'}
                      </div>
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.50)', whiteSpace: 'nowrap' }}>
                      {fmt(l.assigned_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Recent calls */}
          <section>
            <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', fontWeight: 700, color: 'rgba(91,33,182,0.65)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Recent calls {calls.length > 0 && `(${calls.length})`}
            </h4>
            {loading ? (
              <p style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>Loading…</p>
            ) : calls.length === 0 ? (
              <p style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>No call history.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {calls.map(c => (
                  <div key={c.id} style={{
                    padding: '6px 12px', borderRadius: 6,
                    background: 'rgba(237,234,248,0.30)',
                    fontSize: '0.78rem',
                    display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10, alignItems: 'center',
                  }}>
                    <span style={{
                      background: c.direction === 'inbound' ? 'rgba(34,197,94,0.15)' : 'rgba(91,33,182,0.12)',
                      color: c.direction === 'inbound' ? '#15803D' : '#5B21B6',
                      padding: '1px 7px', borderRadius: 50, fontSize: '0.62rem', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                    }}>
                      {c.direction === 'inbound' ? 'In' : 'Out'}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#3B0764', fontWeight: 600 }}>
                      {c.lead_name || fmtPhone(c.lead_phone) || '—'}
                    </span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', color: 'rgba(91,33,182,0.65)' }}>
                      {fmtDur(c.duration_sec)}
                    </span>
                    <span style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.50)' }}>
                      {fmt(c.started_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
