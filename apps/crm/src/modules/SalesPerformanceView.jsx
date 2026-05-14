import { useState, useEffect, useCallback, useRef } from 'react';
import SalesPerformanceDrillPanel from './SalesPerformanceDrillPanel';
import ReassignDistributionModal   from '../admin/ReassignDistributionModal';
import Toast                       from '../components/Toast';

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
/* Numeric cell that opens the drill panel pre-filtered to its column. The
   inner button stops click propagation so the row's onClick (which would
   open the panel with the default Assigned filter) doesn't double-fire. */
function DrillCell({ value, onOpen, title, style, children }) {
  const display = children !== undefined ? children : value;
  const muted = !children && (value === 0 || value === null || value === undefined);
  return (
    <td style={{ padding: '4px 8px' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen?.(); }}
        title={title}
        style={{
          width: '100%', minHeight: 26, padding: '4px 8px',
          border: 'none', background: 'transparent', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 'inherit', textAlign: 'right',
          color: muted ? 'rgba(91,33,182,0.55)' : '#3B0764',
          borderRadius: 6, transition: 'background 120ms',
          ...(style || {}),
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,33,182,0.08)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        {display}
      </button>
    </td>
  );
}

function TrendArrow({ now, prev }) {
  if (prev == null || (now === 0 && prev === 0)) return null;
  if (now > prev) return <span title={`Prev: ${prev}`} style={{ color: '#059669', marginLeft: 4, fontSize: '0.72rem' }}>▲</span>;
  if (now < prev) return <span title={`Prev: ${prev}`} style={{ color: '#DC2626', marginLeft: 4, fontSize: '0.72rem' }}>▼</span>;
  return <span title={`Prev: ${prev}`} style={{ color: 'rgba(91,33,182,0.40)', marginLeft: 4, fontSize: '0.72rem' }}>–</span>;
}

/* ── per-row kebab menu ──
   Three actions:
     1. Move leads      — opens scope picker (all_open vs followups_for_date),
                          then mounts ReassignDistributionModal in the parent.
     2. View call log   — re-uses the existing setDrillId hook to open
                          SalesPerformanceDrillPanel. Same as clicking the row.
     3. Pause / Resume  — toggles crm_users.is_active via the admin PATCH.
                          Disabled while a previous toggle is in flight.

   Stops click propagation so the row's drill-down click isn't triggered. */
function RowMenuButton({ row, busyPause, onMove, onView, onTogglePause }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isPaused = row.is_active === false;
  const itemStyle = (danger) => ({
    width: '100%', textAlign: 'left', padding: '8px 12px',
    borderRadius: 6, border: 'none', background: 'transparent',
    color: danger ? '#B91C1C' : '#3B0764',
    fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', fontWeight: 600,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 8,
  });

  function close() { setOpen(false); }
  function handleItem(fn) { return (e) => { e.stopPropagation(); close(); fn?.(row); }; }

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        aria-label={`Actions for ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: 28, height: 28, borderRadius: 6, border: 'none',
          background: open ? 'rgba(91,33,182,0.12)' : 'transparent',
          color: '#5B21B6', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 150ms',
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = 'rgba(91,33,182,0.08)'; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5"  r="1.7"/>
          <circle cx="12" cy="12" r="1.7"/>
          <circle cx="12" cy="19" r="1.7"/>
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0,
            minWidth: 200, background: '#fff', borderRadius: 10,
            border: '1px solid rgba(209,196,240,0.60)',
            boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
            padding: 6, zIndex: 50,
            fontFamily: 'Outfit, sans-serif',
          }}
        >
          <button role="menuitem" onClick={handleItem(onMove)} style={itemStyle(false)}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,33,182,0.08)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/>
              <polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/>
              <line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>
            </svg>
            Move leads
          </button>
          <button role="menuitem" onClick={handleItem(onView)} style={itemStyle(false)}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,33,182,0.08)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            View call log
          </button>
          <button
            role="menuitem"
            disabled={busyPause}
            onClick={handleItem(onTogglePause)}
            style={{
              ...itemStyle(!isPaused),
              opacity: busyPause ? 0.55 : 1,
              cursor: busyPause ? 'wait' : 'pointer',
            }}
            onMouseEnter={e => { if (!busyPause) e.currentTarget.style.background = isPaused ? 'rgba(5,150,105,0.08)' : 'rgba(220,38,38,0.08)'; }}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {isPaused ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
            )}
            {busyPause ? '…' : (isPaused ? 'Resume caller' : 'Pause caller')}
          </button>
        </div>
      )}
    </div>
  );
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
  // ratio is kept in the signature for future re-introduction of a Predicted
  // column; currently unused since Enrolled / Predicted / Conv% were removed
  // from the table view.
  void ratio;
  const header = [
    'Salesperson','Role','Assigned','Hot','Warm','Touched','Untouched','Untouched_24h',
    'Total_Calls','Incoming','Outgoing','Connected','Connection_%','Avg_Duration',
    'Total_Duration_sec',
  ];
  const body = rows.map(r => [
    r.name, r.role, r.assigned, r.hot, r.warm, r.touched, r.untouched, r.untouched_aged,
    r.total_calls, r.incoming, r.outgoing, r.connected, r.connection_rate_pct,
    fmtDuration(r.avg_duration_sec), r.total_duration_sec,
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
  const [drillId,     setDrillId]     = useState(null);
  const [drillFilter, setDrillFilter] = useState('assigned');  // which numeric column was clicked

  /* Open the per-caller drill panel pre-filtered to a specific cell. */
  function openDrill(callerId, filterId) {
    setDrillFilter(filterId || 'assigned');
    setDrillId(callerId);
  }

  /* Kebab-menu state */
  const [movePickerRow, setMovePickerRow] = useState(null);   // row → pick scope step
  const [moveCtx,       setMoveCtx]       = useState(null);   // { row, scope, date, total, workload }
  const [pauseBusyIds,  setPauseBusyIds]  = useState(() => new Set());
  const [toast,         setToast]         = useState('');
  const [toastKind,     setToastKind]     = useState('success');

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

  /* ── Kebab actions ───────────────────────────────────────────────────── */

  function showToast(msg, kind = 'success') {
    setToastKind(kind);
    setToast(msg);
  }

  /* Step 1 of Move — open scope picker for this row. */
  function openMovePicker(row) { setMovePickerRow(row); }
  function closeMovePicker()   { setMovePickerRow(null); }

  /* Step 2 of Move — caller picked scope + (maybe) date. Fetch the workload
     for the chosen date so the distribution modal can show "X currently open"
     per teammate, compute the total, then open the shared modal. */
  async function confirmMoveScope({ scope, date }) {
    const row = movePickerRow;
    if (!row) return;
    closeMovePicker();
    try {
      const url = `/api/admin/caller-workload?date=${encodeURIComponent(date)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load workload.');
      const data = await res.json();
      const workload = data.callers || [];
      const src = workload.find(c => c.id === row.caller_id);
      const total = src
        ? (scope === 'followups_for_date' ? src.followups_for_date : src.total_open)
        : 0;
      if (!total || total <= 0) {
        showToast(
          scope === 'followups_for_date'
            ? `${row.name} has no follow-ups for ${date}.`
            : `${row.name} has no open leads to move.`,
          'info'
        );
        return;
      }
      setMoveCtx({
        row,
        scope,
        date,
        total,
        workload,
        fromCaller: { id: row.caller_id, full_name: row.name },
      });
    } catch (e) {
      showToast(e.message || 'Move failed.', 'error');
    }
  }
  function closeMove() { setMoveCtx(null); }

  function handleMoved({ moved, remaining, breakdown, fromName }) {
    const stayed = remaining > 0 ? ` (${remaining} stay with ${fromName})` : '';
    showToast(`Moved ${moved} lead${moved === 1 ? '' : 's'} → ${breakdown}${stayed}`);
    closeMove();
    fetchData();
  }

  /* Pause / Resume — PATCH /api/admin/crm-users/:id { is_active }.
     Optimistic: keep the row in busy state until response, then refetch. */
  async function togglePause(row) {
    const id = row.caller_id;
    if (pauseBusyIds.has(id)) return;
    setPauseBusyIds(prev => new Set(prev).add(id));
    const targetActive = !(row.is_active !== false);   // flipping from current
    try {
      const res = await fetch(`/api/admin/crm-users/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ is_active: targetActive }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update caller.');
      showToast(targetActive ? `${row.name} resumed.` : `${row.name} paused.`);
      await fetchData();
    } catch (e) {
      showToast(e.message || 'Failed to toggle pause.', 'error');
    } finally {
      setPauseBusyIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

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
        .sp-table th, .sp-table td { padding: 10px 8px; text-align: right; white-space: nowrap; border-right: 1px solid rgba(209,196,240,0.35); }
        .sp-table th:last-child, .sp-table td:last-child { border-right: none; }
        .sp-table th { background: rgba(237,234,248,0.65); color: rgba(91,33,182,0.65); font-weight: 700; font-size: 0.70rem; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; z-index: 1; }
        .sp-table th:first-child, .sp-table td:first-child { text-align: left; }
        .sp-table tbody tr { border-top: 1px solid rgba(209,196,240,0.30); transition: background 150ms; }
        .sp-table tbody tr:hover { box-shadow: inset 0 0 0 2px rgba(91,33,182,0.20); cursor: pointer; }
        .sp-table tfoot td { background: rgba(91,33,182,0.06); font-weight: 800; color: #3B0764; border-top: 2px solid rgba(91,33,182,0.20); }
        @media (max-width: 640px) {
          .sp-filter-bar { padding: 8px 10px !important; gap: 6px !important; }
        }
      `}</style>

      {/* Single top toolbar — filters + Refresh + Export all in one row,
          sitting just under the workspace tab bar so the table starts higher
          up. Wraps gracefully on narrow viewports. */}
      <div className="sp-filter-bar" style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: 'rgba(237,234,248,0.50)', borderRadius: 14,
        border: '1px solid rgba(139,92,246,0.15)',
        padding: '10px 14px', marginBottom: 16,
      }}>
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

        {lastUpdated && (
          <span style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.45)' }}>
            Last updated: {lastUpdated}
          </span>
        )}
        <button onClick={fetchData} style={{
          height: '2.1rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(91,33,182,0.25)',
          background: '#fff', color: '#5B21B6',
          fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem', fontWeight: 700, cursor: 'pointer',
        }}>↻ Refresh</button>
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
                  <th title="Leads parked with outcome = follow_up">Follow-ups</th>
                  <th>Total Calls</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Connected</th>
                  <th>Conn %</th>
                  <th>Avg Dur</th>
                  <th>Total Dur</th>
                  <th aria-label="Actions" style={{ width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => {
                  const isTop = r.caller_id === topRowId;
                  const idleMin = minutesSince(r.last_call_at);
                  const idle = (r.total_calls > 0 && idleMin != null && idleMin > 30) ? idleMin : null;
                  const noActivity = r.assigned > 0 && r.touched === 0;
                  return (
                    <tr key={r.caller_id}
                        onClick={() => openDrill(r.caller_id, 'assigned')}
                        style={{ background: rowBg(r, isTop) }}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {isTop && <span title="Top performer" style={{ fontSize: '0.95rem' }}>🏆</span>}
                          <span style={{ fontWeight: 700, color: '#3B0764' }}>{r.name}</span>
                          {r.is_active === false && (
                            <span title="Paused by admin — cannot dial or receive new leads" style={{ background: 'rgba(107,114,128,0.18)', color: '#374151', padding: '1px 7px', borderRadius: 50, fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Paused</span>
                          )}
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
                      <DrillCell value={r.assigned}        onOpen={() => openDrill(r.caller_id, 'assigned')}  title="View assigned leads" />
                      <DrillCell value={r.hot}             onOpen={() => openDrill(r.caller_id, 'hot')}       title="View hot leads"
                                 style={{ color: r.hot > 0 ? '#DC2626' : 'rgba(91,33,182,0.55)', fontWeight: 700 }} />
                      <DrillCell value={r.warm}            onOpen={() => openDrill(r.caller_id, 'warm')}      title="View warm leads" />
                      <DrillCell value={r.touched}         onOpen={() => openDrill(r.caller_id, 'touched')}   title="View touched leads" />
                      <DrillCell value={r.untouched}       onOpen={() => openDrill(r.caller_id, 'untouched')} title="View untouched leads" />
                      <DrillCell value={r.untouched_aged}  onOpen={() => openDrill(r.caller_id, 'stale_24h')} title="View leads stale > 24h"
                                 style={{ color: r.untouched_aged > 5 ? '#DC2626' : 'rgba(91,33,182,0.65)', fontWeight: r.untouched_aged > 5 ? 700 : 500 }} />
                      <DrillCell value={r.followups} onOpen={() => openDrill(r.caller_id, 'follow_up')} title="View follow-up leads"
                                 style={{ color: r.followups > 0 ? '#5B21B6' : 'rgba(91,33,182,0.55)', fontWeight: r.followups > 0 ? 700 : 500 }} />
                      <DrillCell
                        onOpen={() => openDrill(r.caller_id, 'calls')}
                        title="View all calls"
                      >
                        {r.total_calls}
                        <TrendArrow now={r.total_calls} prev={r.total_calls_prev} />
                      </DrillCell>
                      <DrillCell value={r.incoming}  onOpen={() => openDrill(r.caller_id, 'in')}        title="View incoming calls" />
                      <DrillCell value={r.outgoing}  onOpen={() => openDrill(r.caller_id, 'out')}       title="View outgoing calls" />
                      <DrillCell value={r.connected} onOpen={() => openDrill(r.caller_id, 'connected')} title="View connected calls" />
                      <td>
                        {r.connection_rate_pct}%
                      </td>
                      <td>{fmtDuration(r.avg_duration_sec)}</td>
                      <td>{fmtHMS(r.total_duration_sec)}</td>
                      <td onClick={e => e.stopPropagation()} style={{ textAlign: 'center', padding: '6px 4px' }}>
                        <RowMenuButton
                          row={r}
                          busyPause={pauseBusyIds.has(r.caller_id)}
                          onMove={openMovePicker}
                          onView={(row) => openDrill(row.caller_id, 'assigned')}
                          onTogglePause={togglePause}
                        />
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
                    <td>{tt.followups}</td>
                    <td>{tt.total_calls}</td>
                    <td>{tt.incoming}</td>
                    <td>{tt.outgoing}</td>
                    <td>{tt.connected}</td>
                    <td>{tt.connection_rate_pct}%</td>
                    <td>{fmtDuration(tt.avg_duration_sec)}</td>
                    <td>{fmtHMS(tt.total_duration_sec)}</td>
                    <td></td>
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
          initialFilter={drillFilter}
          onClose={() => setDrillId(null)}
        />
      )}

      {/* Kebab > Move leads — step 1: scope picker */}
      {movePickerRow && (
        <MoveScopePicker
          row={movePickerRow}
          onClose={closeMovePicker}
          onConfirm={confirmMoveScope}
        />
      )}

      {/* Kebab > Move leads — step 2: distribution modal (shared component) */}
      {moveCtx && (
        <ReassignDistributionModal
          fromCaller={moveCtx.fromCaller}
          scope={moveCtx.scope}
          date={moveCtx.date}
          total={moveCtx.total}
          eligibleCallers={moveCtx.workload}
          token={token}
          onClose={closeMove}
          onMoved={handleMoved}
        />
      )}

      {/* Toast — used by Move, Pause, errors */}
      <Toast message={toast} kind={toastKind} onDone={() => setToast('')} />
    </div>
  );
}

/* ── Move scope picker — small modal asking "All open" vs "Follow-ups for date" ── */
function MoveScopePicker({ row, onClose, onConfirm }) {
  // Default date = today in IST (matches the existing CallerWorkload behavior).
  const todayIST = (() => {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  })();
  const [scope, setScope] = useState('all_open');
  const [date,  setDate]  = useState(todayIST);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,0,40,0.45)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 9500,
      fontFamily: 'Outfit, sans-serif',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 16, padding: 24, maxWidth: 420, width: '100%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <h3 style={{ margin: 0, fontSize: '1.02rem', fontWeight: 700, color: '#3B0764' }}>
          Move leads from {row.name}
        </h3>
        <p style={{ margin: '4px 0 16px', fontSize: '0.82rem', color: 'rgba(91,33,182,0.65)' }}>
          Which leads should be reassigned?
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <ScopeOption
            value="all_open" current={scope} onChange={setScope}
            label="All open leads"
            desc="Everything this caller hasn't completed yet (untouched + follow-ups)."
          />
          <ScopeOption
            value="followups_for_date" current={scope} onChange={setScope}
            label="Follow-up leads for a specific date"
            desc="Only follow-ups scheduled for the chosen date."
          />
        </div>

        {scope === 'followups_for_date' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'rgba(91,33,182,0.75)' }}>
              Follow-ups for:
            </label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              style={{
                height: '2.2rem', padding: '0 12px', borderRadius: 8,
                border: '1px solid rgba(209,196,240,0.7)', background: '#fff',
                fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764',
              }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(91,33,182,0.20)',
            background: '#fff', color: '#5B21B6', fontWeight: 600, fontSize: '0.84rem',
            cursor: 'pointer',
          }}>Cancel</button>
          <button
            onClick={() => onConfirm({ scope, date })}
            style={{
              padding: '8px 14px', borderRadius: 8, border: 'none',
              background: '#5B21B6', color: '#fff',
              fontWeight: 700, fontSize: '0.84rem', cursor: 'pointer',
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function ScopeOption({ value, current, onChange, label, desc }) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      style={{
        textAlign: 'left', padding: '10px 12px', borderRadius: 10,
        border: active ? '2px solid #5B21B6' : '1px solid rgba(209,196,240,0.7)',
        background: active ? 'rgba(91,33,182,0.06)' : '#fff',
        cursor: 'pointer',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        fontFamily: 'Outfit, sans-serif',
      }}
    >
      <span style={{
        width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
        border: active ? '5px solid #5B21B6' : '2px solid rgba(91,33,182,0.30)',
        marginTop: 2,
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.88rem' }}>{label}</div>
        <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.60)', marginTop: 2 }}>{desc}</div>
      </div>
    </button>
  );
}
