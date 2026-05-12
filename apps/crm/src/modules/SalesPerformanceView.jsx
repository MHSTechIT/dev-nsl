import { useState, useEffect, useCallback, useRef } from 'react';
import SalesPerformanceDrillPanel from './SalesPerformanceDrillPanel';

/* ── small formatters ── */
function fmtDuration(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtHMS(sec) {
  if (!sec || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function minutesSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

/* ── date range helpers ── */
function rangeForPreset(preset) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const today = ymd(ist);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'week') {
    const start = new Date(ist); start.setUTCDate(start.getUTCDate() - 6);
    return { from: ymd(start), to: today };
  }
  if (preset === 'month') {
    const start = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1));
    return { from: ymd(start), to: today };
  }
  return { from: today, to: today };
}

/* ── filter pill ── */
function Pill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px', borderRadius: 50, border: 'none',
        fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600,
        cursor: 'pointer', transition: 'all 150ms',
        background: active ? '#5B21B6' : 'rgba(91,33,182,0.08)',
        color: active ? '#fff' : 'rgba(91,33,182,0.70)',
        boxShadow: active ? '0 2px 8px rgba(91,33,182,0.30)' : 'none',
      }}
    >
      {label}
    </button>
  );
}

/* ── trend arrow ── */
function TrendArrow({ now, prev }) {
  if (prev == null || (now === 0 && prev === 0)) return null;
  if (now > prev) return <span title={`Prev: ${prev}`} style={{ color: '#059669', marginLeft: 4, fontSize: '0.72rem' }}>▲</span>;
  if (now < prev) return <span title={`Prev: ${prev}`} style={{ color: '#DC2626', marginLeft: 4, fontSize: '0.72rem' }}>▼</span>;
  return <span title={`Prev: ${prev}`} style={{ color: 'rgba(91,33,182,0.40)', marginLeft: 4, fontSize: '0.72rem' }}>–</span>;
}

/* ── salesperson dropdown ── */
function SalespersonSelect({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 180 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', height: '2.1rem', borderRadius: 10,
          border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
          padding: '0 32px 0 12px', fontFamily: 'Outfit, sans-serif',
          fontSize: '0.82rem', fontWeight: 600, color: '#3B0764',
          cursor: 'pointer', outline: 'none', textAlign: 'left',
          position: 'relative',
        }}
      >
        {selected ? selected.label : 'All salespeople'}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: '#fff', borderRadius: 12, border: '1px solid rgba(139,92,246,0.20)',
          boxShadow: '0 8px 24px rgba(91,33,182,0.15)', zIndex: 50,
          padding: '4px 0', maxHeight: 240, overflowY: 'auto',
        }}>
          {options.map(opt => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={{
                width: '100%', border: 'none', background: value === opt.value ? 'rgba(91,33,182,0.08)' : 'transparent',
                padding: '8px 14px', fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem',
                fontWeight: value === opt.value ? 700 : 500,
                color: value === opt.value ? '#5B21B6' : '#3B0764',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── row tint logic ── */
function rowBg(row, isTopPerformer) {
  // No-activity flag wins
  if (row.assigned > 0 && row.touched === 0) return 'rgba(254,215,170,0.30)';
  if (isTopPerformer) return 'rgba(254,243,199,0.45)';
  const c = row.conversion_pct || 0;
  if (c >= 5) return 'rgba(220,252,231,0.40)';
  if (c >= 1) return 'rgba(254,249,195,0.30)';
  if (row.assigned > 0) return 'rgba(254,226,226,0.35)';
  return 'transparent';
}

/* ── CSV export ── */
function exportCsv(rows, ratio, from, to) {
  const header = [
    'Salesperson','Role','Assigned','Hot','Warm','Touched','Untouched','Untouched_24h',
    'Total_Calls','Incoming','Outgoing','Connected','Connection_%','Avg_Duration',
    'Total_Duration_sec','Enrolled','Predicted','Conversion_%',
  ];
  const body = rows.map(r => [
    r.name, r.role, r.assigned, r.hot, r.warm, r.touched, r.untouched, r.untouched_aged,
    r.total_calls, r.incoming, r.outgoing, r.connected, r.connection_rate_pct,
    fmtDuration(r.avg_duration_sec), r.total_duration_sec, r.enrolled,
    (r.hot * ratio).toFixed(1), r.conversion_pct,
  ]);
  const csv = [header, ...body].map(row => row.map(v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sales-performance-${from}_to_${to}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ══════════════════ Main component ══════════════════ */
export default function SalesPerformanceView({ token }) {
  const [data, setData]         = useState({ rows: [], team_totals: null, hot_to_enroll_ratio: 0, window: null });
  const [callers, setCallers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [lastUpdated, setLastUpdated] = useState('');

  const [preset, setPreset]     = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [salesperson, setSalesperson] = useState('');
  const [drillId, setDrillId]   = useState(null);

  const range = preset === 'custom' && customFrom
    ? { from: customFrom, to: customTo || customFrom }
    : rangeForPreset(preset);

  /* Salesperson list for dropdown */
  useEffect(() => {
    fetch('/api/admin/crm-users', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        const filtered = (d.users || []).filter(u =>
          u.is_active && ['junior_caller','senior_caller','team_leader','manager'].includes(u.role)
        );
        setCallers(filtered);
      })
      .catch(() => {});
  }, [token]);

  const fetchData = useCallback(async () => {
    setError('');
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (salesperson) params.set('salesperson_id', salesperson);
    try {
      const res = await fetch(`/api/admin/sales-performance?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load sales performance');
      const json = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [token, range.from, range.to, salesperson]);

  useEffect(() => { fetchData(); }, [fetchData]);

  /* Auto refresh every 30 s */
  useEffect(() => {
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  /* Top performer — highest conversion among rows with at least 1 enrollment */
  const topRowId = (() => {
    const candidates = data.rows.filter(r => r.enrolled > 0);
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.conversion_pct > a.conversion_pct ? b : a)).caller_id;
  })();

  const tt = data.team_totals;
  const ratio = data.hot_to_enroll_ratio || 0;

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <style>{`
        .sp-table { width: 100%; border-collapse: collapse; min-width: 1100px; font-size: 0.82rem; }
        .sp-table th, .sp-table td { padding: 10px 8px; text-align: right; white-space: nowrap; }
        .sp-table th { background: rgba(237,234,248,0.65); color: rgba(91,33,182,0.65); font-weight: 700; font-size: 0.70rem; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; z-index: 1; }
        .sp-table th:first-child, .sp-table td:first-child { text-align: left; }
        .sp-table tbody tr { border-top: 1px solid rgba(209,196,240,0.30); transition: background 150ms; }
        .sp-table tbody tr:hover { box-shadow: inset 0 0 0 2px rgba(91,33,182,0.20); cursor: pointer; }
        .sp-table tfoot td { background: rgba(91,33,182,0.06); font-weight: 800; color: #3B0764; border-top: 2px solid rgba(91,33,182,0.20); }
        @media (max-width: 640px) {
          .sp-filter-bar { padding: 8px 10px !important; gap: 6px !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 800, color: '#3B0764' }}>Sales Performance</h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.72rem', color: 'rgba(91,33,182,0.50)' }}>
            Per-salesperson stats — auto-refreshes every 30 s
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {lastUpdated && (
            <span style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.45)' }}>Last updated: {lastUpdated}</span>
          )}
          <button onClick={fetchData} style={{
            height: '2rem', padding: '0 12px', borderRadius: 8, border: 'none',
            background: 'rgba(91,33,182,0.08)', color: '#5B21B6',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
          }}>↻ Refresh</button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="sp-filter-bar" style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: 'rgba(237,234,248,0.50)', borderRadius: 14,
        border: '1px solid rgba(139,92,246,0.15)',
        padding: '10px 14px', marginBottom: 16,
      }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)' }}>Period</span>
        {[
          { id: 'today', label: 'Today' },
          { id: 'week',  label: 'This Week' },
          { id: 'month', label: 'This Month' },
          { id: 'custom', label: 'Custom' },
        ].map(p => <Pill key={p.id} label={p.label} active={preset === p.id} onClick={() => setPreset(p.id)} />)}

        {preset === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ height: '2.1rem', borderRadius: 10, border: '1px solid rgba(139,92,246,0.25)', padding: '0 10px', fontSize: '0.82rem', color: '#3B0764' }} />
            <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.45)', fontWeight: 600 }}>to</span>
            <input type="date" value={customTo}   onChange={e => setCustomTo(e.target.value)}   style={{ height: '2.1rem', borderRadius: 10, border: '1px solid rgba(139,92,246,0.25)', padding: '0 10px', fontSize: '0.82rem', color: '#3B0764' }} />
          </>
        )}

        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', marginLeft: 8 }}>Salesperson</span>
        <SalespersonSelect
          value={salesperson}
          onChange={setSalesperson}
          options={[{ value: '', label: 'All salespeople' }, ...callers.map(c => ({ value: c.id, label: c.full_name }))]}
        />

        <div style={{ flex: 1 }} />

        <button
          onClick={() => exportCsv(data.rows, ratio, range.from, range.to)}
          disabled={data.rows.length === 0}
          style={{
            height: '2.1rem', padding: '0 14px', borderRadius: 10, border: '1px solid rgba(91,33,182,0.25)',
            background: '#fff', color: '#5B21B6', fontWeight: 700, fontSize: '0.80rem',
            cursor: data.rows.length === 0 ? 'not-allowed' : 'pointer',
            opacity: data.rows.length === 0 ? 0.5 : 1,
          }}
        >
          ⤓ Export CSV
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.80)', border: '1px solid rgba(239,68,68,0.30)', borderRadius: 12, padding: '12px 16px', marginBottom: 16, color: '#DC2626', fontSize: '0.82rem', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ background: '#fff', borderRadius: 14, boxShadow: '0 2px 12px rgba(91,33,182,0.07)', overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto', maxHeight: '70vh' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>Loading performance data…</div>
          ) : data.rows.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>
              No salespeople found for this period.
            </div>
          ) : (
            <table className="sp-table">
              <thead>
                <tr>
                  <th>Salesperson</th>
                  <th>Assigned</th>
                  <th>Hot</th>
                  <th>Warm</th>
                  <th>Touched</th>
                  <th>Untouched</th>
                  <th title="Assigned > 24h ago, never touched">&gt;24h Stale</th>
                  <th>Total Calls</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Connected</th>
                  <th>Conn %</th>
                  <th>Avg Dur</th>
                  <th>Total Dur</th>
                  <th>Enrolled</th>
                  <th title="Hot × historical hot-to-enrolled ratio">Predicted</th>
                  <th>Conv %</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => {
                  const isTop = r.caller_id === topRowId;
                  const idleMin = minutesSince(r.last_call_at);
                  const idle = (r.total_calls > 0 && idleMin != null && idleMin > 30) ? idleMin : null;
                  const noActivity = r.assigned > 0 && r.touched === 0;
                  const predicted = (r.hot * ratio).toFixed(1);
                  return (
                    <tr key={r.caller_id}
                        onClick={() => setDrillId(r.caller_id)}
                        style={{ background: rowBg(r, isTop) }}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {isTop && <span title="Top performer" style={{ fontSize: '0.95rem' }}>🏆</span>}
                          <span style={{ fontWeight: 700, color: '#3B0764' }}>{r.name}</span>
                          {noActivity && (
                            <span style={{ background: 'rgba(249,115,22,0.15)', color: '#C2410C', padding: '1px 7px', borderRadius: 50, fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>⚠ Idle</span>
                          )}
                          {idle != null && (
                            <span title={`No call in ${idle} min`} style={{ background: 'rgba(91,33,182,0.10)', color: '#5B21B6', padding: '1px 7px', borderRadius: 50, fontSize: '0.62rem', fontWeight: 700 }}>
                              Idle {idle}m
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.65rem', color: 'rgba(91,33,182,0.45)', textTransform: 'capitalize' }}>
                          {r.role.replace('_', ' ')}
                        </div>
                      </td>
                      <td>{r.assigned}</td>
                      <td style={{ color: r.hot > 0 ? '#DC2626' : 'rgba(91,33,182,0.55)', fontWeight: 700 }}>{r.hot}</td>
                      <td>{r.warm}</td>
                      <td>{r.touched}</td>
                      <td>{r.untouched}</td>
                      <td style={{ color: r.untouched_aged > 5 ? '#DC2626' : 'rgba(91,33,182,0.65)', fontWeight: r.untouched_aged > 5 ? 700 : 500 }}>
                        {r.untouched_aged}
                      </td>
                      <td>
                        {r.total_calls}
                        <TrendArrow now={r.total_calls} prev={r.total_calls_prev} />
                      </td>
                      <td>{r.incoming}</td>
                      <td>{r.outgoing}</td>
                      <td>{r.connected}</td>
                      <td>
                        {r.connection_rate_pct}%
                      </td>
                      <td>{fmtDuration(r.avg_duration_sec)}</td>
                      <td>{fmtHMS(r.total_duration_sec)}</td>
                      <td style={{ fontWeight: 700, color: '#059669' }}>
                        {r.enrolled}
                        <TrendArrow now={r.enrolled} prev={r.enrolled_prev} />
                      </td>
                      <td title={`Hot × ${ratio.toFixed(3)}`} style={{ color: 'rgba(91,33,182,0.70)' }}>{predicted}</td>
                      <td style={{ fontWeight: 800, color: '#3B0764' }}>
                        {r.conversion_pct}%
                        <TrendArrow now={r.conversion_pct} prev={r.conversion_pct_prev} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {tt && (
                <tfoot>
                  <tr>
                    <td>Team Total</td>
                    <td>{tt.assigned}</td>
                    <td>{tt.hot}</td>
                    <td>{tt.warm}</td>
                    <td>{tt.touched}</td>
                    <td>{tt.untouched}</td>
                    <td>{tt.untouched_aged}</td>
                    <td>{tt.total_calls}</td>
                    <td>{tt.incoming}</td>
                    <td>{tt.outgoing}</td>
                    <td>{tt.connected}</td>
                    <td>{tt.connection_rate_pct}%</td>
                    <td>{fmtDuration(tt.avg_duration_sec)}</td>
                    <td>{fmtHMS(tt.total_duration_sec)}</td>
                    <td>{tt.enrolled}</td>
                    <td>—</td>
                    <td>{tt.conversion_pct}%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>

      {/* Drill-down panel */}
      {drillId && (
        <SalesPerformanceDrillPanel
          token={token}
          caller={data.rows.find(r => r.caller_id === drillId)}
          onClose={() => setDrillId(null)}
        />
      )}
    </div>
  );
}
