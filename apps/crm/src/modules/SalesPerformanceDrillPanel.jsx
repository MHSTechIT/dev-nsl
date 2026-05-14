import { useState, useEffect, useMemo } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
   Sales Performance per-caller drill panel.

   Opens as a right-side sheet when a numeric cell in the Sales Performance
   table is clicked. The clicked column maps to `initialFilter`, which selects
   which subset of leads or calls to show. The user can switch tabs/pills
   inside the panel to look at adjacent slices without closing it.
   ────────────────────────────────────────────────────────────────────────── */

const FILTERS = [
  { id: 'assigned',  label: 'Assigned',    kind: 'leads' },
  { id: 'hot',       label: 'Hot',         kind: 'leads' },
  { id: 'warm',      label: 'Warm',        kind: 'leads' },
  { id: 'touched',   label: 'Touched',     kind: 'leads' },
  { id: 'untouched', label: 'Untouched',   kind: 'leads' },
  { id: 'stale_24h', label: '>24h Stale',  kind: 'leads' },
  { id: 'follow_up', label: 'Follow-ups',  kind: 'leads' },
  { id: 'calls',     label: 'Total Calls', kind: 'calls' },
  { id: 'in',        label: 'Incoming',    kind: 'calls' },
  { id: 'out',       label: 'Outgoing',    kind: 'calls' },
  { id: 'connected', label: 'Connected',   kind: 'calls' },
];

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

export default function SalesPerformanceDrillPanel({ token, caller, onClose, initialFilter = 'assigned' }) {
  const [filter,  setFilter]  = useState(initialFilter);
  const [leads,   setLeads]   = useState([]);
  const [calls,   setCalls]   = useState([]);
  const [loading, setLoading] = useState(true);

  // Sync filter when the parent opens the panel with a different cell click
  useEffect(() => { setFilter(initialFilter); }, [initialFilter]);

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
      fetch(`/api/admin/calls?caller_id=${caller.caller_id}&limit=200`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([leadsRes, callsRes]) => {
      const filtered = (leadsRes.leads || []).filter(l => l.assigned_user_id === caller.caller_id);
      setLeads(filtered);
      setCalls(callsRes.calls || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [caller, token]);

  const filterDef = FILTERS.find(f => f.id === filter) || FILTERS[0];

  const visibleLeads = useMemo(() => {
    if (filterDef.kind !== 'leads') return [];
    const now = Date.now();
    return leads.filter(l => {
      switch (filter) {
        case 'assigned':  return true;
        case 'hot':       return Number(l.lead_score) >= 4;
        case 'warm':      return [2, 3].includes(Number(l.lead_score));
        case 'touched':   return !!l.last_note_at;
        case 'untouched': return !l.last_note_at;
        case 'stale_24h':
          if (l.last_note_at) return false;
          if (!l.assigned_at) return false;
          return (now - new Date(l.assigned_at).getTime()) >= 24 * 3600 * 1000;
        case 'follow_up': return l.last_note_outcome === 'follow_up';
        default: return true;
      }
    });
  }, [leads, filter, filterDef.kind]);

  const visibleCalls = useMemo(() => {
    if (filterDef.kind !== 'calls') return [];
    return calls.filter(c => {
      switch (filter) {
        case 'calls':     return true;
        case 'in':        return c.direction === 'inbound';
        case 'out':       return c.direction === 'outbound';
        case 'connected': return Number(c.duration_sec) > 0;
        default: return true;
      }
    });
  }, [calls, filter, filterDef.kind]);

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
          <div style={{ minWidth: 0 }}>
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

        {/* Filter pills */}
        <div style={{
          padding: '12px 20px', borderBottom: '1px solid rgba(209,196,240,0.30)',
          display: 'flex', flexWrap: 'wrap', gap: 6,
        }}>
          {FILTERS.map(f => {
            const active = f.id === filter;
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                style={{
                  padding: '5px 11px', borderRadius: 50,
                  border: active ? 'none' : '1px solid rgba(91,33,182,0.20)',
                  background: active ? '#5B21B6' : 'transparent',
                  color: active ? '#fff' : 'rgba(91,33,182,0.75)',
                  fontFamily: 'Outfit,sans-serif', fontWeight: 600, fontSize: '0.74rem',
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>
          {filterDef.kind === 'leads' ? (
            <section>
              <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', fontWeight: 700, color: 'rgba(91,33,182,0.65)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {filterDef.label} leads {visibleLeads.length > 0 && `(${visibleLeads.length})`}
              </h4>
              {loading ? (
                <p style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>Loading…</p>
              ) : visibleLeads.length === 0 ? (
                <p style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>
                  No {filterDef.label.toLowerCase()} leads.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {visibleLeads.map(l => <LeadCard key={l.id} l={l} />)}
                </div>
              )}
            </section>
          ) : (
            <section>
              <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', fontWeight: 700, color: 'rgba(91,33,182,0.65)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {filterDef.label} {visibleCalls.length > 0 && `(${visibleCalls.length})`}
              </h4>
              {loading ? (
                <p style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>Loading…</p>
              ) : visibleCalls.length === 0 ? (
                <p style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>
                  No {filterDef.label.toLowerCase()} calls.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {visibleCalls.map(c => <CallCard key={c.id} c={c} />)}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function LeadCard({ l }) {
  return (
    <div style={{
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
  );
}

function CallCard({ c }) {
  return (
    <div style={{
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
  );
}
