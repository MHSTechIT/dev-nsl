import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { funnelMetrics, num } from './callerReportCategories';
import CallerLeadsMoveDrawer from '../admin/CallerLeadsMoveDrawer';

/* ── "Caller 360" combined report ────────────────────────────────────────────
   One row per caller merging telephony activity (the Intern Hourly Report) with
   the lead-disposition breakdown (the Lead Outcome Report). Headline metrics are
   inline; the 14 disposition categories open in an expandable detail row.
   Scope: a date range (drives call activity) + an optional Batch. */

/* ── tiny local helpers (kept self-contained on purpose) ─────────────────── */
const VIOLET = '#5B21B6';
const INK    = '#3B0764';
const todayIstYmd = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const secToMin = (s) => Math.round(num(s) / 60);
const secToHr  = (s) => (num(s) / 3600).toFixed(2);
function toCsvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function convColor(p) {
  if (p == null) return 'rgba(91,33,182,0.45)';
  if (p >= 90) return '#047857';
  if (p >= 75) return '#B45309';
  return '#B91C1C';
}

/* ── Column groups (exact 30-column spec). Each col's `get(row)` works on both
   a caller row and the totals row (same atom shape). Collapsible groups can be
   folded to a single placeholder column. ──────────────────────────────────── */
const GROUPS = [
  { id: 'leads', label: 'LEADS', color: '#6D28D9', cols: [
    { id: 'assigned', label: 'Assigned', get: (r) => num(r.assigned) },
    { id: 'touched',  label: 'Touched',  get: (r) => num(r.touched) },
  ]},
  { id: 'answered', label: 'ANSWERED', color: '#7C3AED', collapsible: true, cols: [
    { id: 'answered', label: 'Answered',     get: (r) => num(r.answered) },
    { id: 'ansdur',   label: 'Ans Dur (s)',  get: (r) => num(r.answered_dur_sec) },
    { id: 'ansmin',   label: 'Ans Talk (m)', get: (r) => secToMin(r.answered_dur_sec) },
    { id: 'anshr',    label: 'Ans Talk (h)', get: (r) => secToHr(r.answered_dur_sec) },
  ]},
  { id: 'interested', label: 'INTERESTED', color: '#8B5CF6', cols: [
    { id: 'interested', label: 'Interested', get: (r) => num(r.interested) },
    { id: 'hot',  label: 'Hot',  get: (r) => num(r.hot) },
    { id: 'warm', label: 'Warm', get: (r) => num(r.warm) },
    { id: 'cold', label: 'Cold', get: (r) => num(r.cold) },
  ]},
  { id: 'junk', label: 'JUNK', color: '#6D28D9', collapsible: true, cols: [
    { id: 'junk',   label: 'Junk',                      get: (r) => num(r.junk) },
    { id: 'nsni',   label: 'No Sugar Not Interested',   get: (r) => num(r.st_no_sugar_not_interested) },
    { id: 'nafw',   label: 'Not Available For Webinar', get: (r) => num(r.st_not_available_for_webinar) },
    { id: 'notreg', label: 'Not Registered',            get: (r) => num(r.st_not_register) },
    { id: 'jfk',    label: 'Just For Knowledge',        get: (r) => num(r.st_just_for_knowledge) },
    { id: 'paid',   label: 'Already Paid',              get: (r) => num(r.st_already_paid) },
    { id: 'wrong',  label: 'Wrong Number',              get: (r) => num(r.st_wrong_number) },
    { id: 'disc',   label: 'Call Disconnected',         get: (r) => num(r.st_call_disconnected) },
    { id: 'lang',   label: 'Other Languages',           get: (r) => num(r.st_other_languages) },
    { id: 'nodia',  label: 'No Diabetes',               get: (r) => num(r.st_no_diabetes) },
  ]},
  { id: 'dnp', label: 'DNP', color: '#7C3AED', collapsible: true, cols: [
    { id: 'dnp',     label: 'DNP',            get: (r) => num(r.o_not_picked) },
    { id: 'missdur', label: 'Missed Dur (s)', get: (r) => num(r.missed_dur_sec) },
    { id: 'missmin', label: 'Miss Talk (m)',  get: (r) => secToMin(r.missed_dur_sec) },
    { id: 'misshr',  label: 'Miss Talk (h)',  get: (r) => secToHr(r.missed_dur_sec) },
  ]},
  { id: 'outcome', label: 'OUTCOME', color: '#5B21B6', cols: [
    { id: 'nextbatch', label: 'Next Batch',   get: (r) => num(r.next_batch) },
    { id: 'untouched', label: 'Untouched',    get: (r) => num(r.untouched) },
    { id: 'followup',  label: 'Follow Up',    get: (r) => num(r.o_follow_up) },
    { id: 'lc',        label: 'L→C %',        pct: true,  get: (r) => funnelMetrics(r).connPct },
    { id: 'actual',    label: 'Actual Leads', bold: true, get: (r) => funnelMetrics(r).actualLeads },
  ]},
];

/* Per-caller ⋮ menu actions. Handlers are wired in the component (stubs for now). */
const MENU_ITEMS = [
  { id: 'move', label: 'Move leads', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/>
      <line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>
    </svg>) },
  { id: 'calllog', label: 'View call log', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>) },
  { id: 'callerpage', label: 'Caller page', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>) },
  { id: 'pause', label: 'Pause caller', danger: true, icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>
    </svg>) },
];

export default function NsmSalesNewPageView({ token }) {
  const [preset, setPreset]       = useState('today');     // 'today' | 'custom'
  const [customFrom, setCustomFrom] = useState(todayIstYmd());
  const [customTo, setCustomTo]     = useState(todayIstYmd());
  const [webinars, setWebinars]   = useState([]);
  const [webinarId, setWebinarId] = useState('');
  const [wbOpen, setWbOpen]       = useState(false);
  const [search, setSearch]       = useState('');
  const [data, setData]           = useState({ rows: [], totals: {}, window: null });
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set()); // collapsed group ids
  const isOpen = (g) => !collapsed.has(g.id);
  const toggleGroup = (id) => setCollapsed((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [selectedId, setSelectedId] = useState(null);      // clicked → highlighted caller row
  const [menu, setMenu]           = useState(null);        // per-caller ⋮ menu { callerId, name, x, y }
  const [callerPageRow, setCallerPageRow] = useState(null); // "Caller page" drawer target
  const [isFs, setIsFs]           = useState(false);       // laptop full-screen view
  const rootRef                   = useRef(null);
  const scrollRef                 = useRef(null);
  const [scrollH, setScrollH]     = useState(null);        // fill viewport → scrollbar at page bottom

  const range = useMemo(() => {
    if (preset === 'all')   return { from: '2020-01-01', to: todayIstYmd() }; // from the beginning
    if (preset === 'today') return { from: todayIstYmd(), to: todayIstYmd() };
    return { from: customFrom || todayIstYmd(), to: customTo || customFrom || todayIstYmd() };
  }, [preset, customFrom, customTo]);

  /* Batches list for the dropdown (once). */
  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/nsm/batches', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => setWebinars((d.batches || []).map((b) => ({ id: b.id, name: b.batch_name, is_active: b.is_active }))))
      .catch(() => {});
  }, [token]);

  const fetchReport = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to });
      if (webinarId) qs.set('webinar_id', webinarId);
      const res = await fetch(`/api/admin/nsm/caller-report?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load report.');
      const d = await res.json();
      setData({ rows: d.rows || [], totals: d.totals || {}, window: d.window || null });
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e.message || 'Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [token, range.from, range.to, webinarId]);

  useEffect(() => { fetchReport(); }, [fetchReport]);
  useEffect(() => {
    const id = setInterval(fetchReport, 30_000);
    return () => clearInterval(id);
  }, [fetchReport]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? data.rows.filter((r) => (r.name || '').toLowerCase().includes(q)) : data.rows;
  }, [data.rows, search]);

  /* Real OS/laptop full screen via the Fullscreen API (NOT a CSS-only expand) —
     fills the whole laptop display and hides the browser chrome. Esc or the
     button exits; the fullscreenchange listener keeps `isFs` in sync. */
  function toggleFullscreen() {
    const el = rootRef.current;
    if (!el) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      req && req.call(el);
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      exit && exit.call(document);
    }
  }
  useEffect(() => {
    const onFs = () => setIsFs(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
    };
  }, []);

  /* Stretch the scrollable table area down to the bottom of the viewport so the
     horizontal scrollbar sits at the bottom of the page (instead of floating
     under a short table). Re-measure on resize + full-screen toggle. */
  useEffect(() => {
    function measure() {
      const el = scrollRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setScrollH(Math.max(240, Math.round(window.innerHeight - top - 16)));
    }
    measure();
    const t = setTimeout(measure, 60); // after layout/HMR settles
    window.addEventListener('resize', measure);
    return () => { clearTimeout(t); window.removeEventListener('resize', measure); };
  }, [isFs, loading]);

  /* total inline column count for loading/empty colSpan (collapsed group = 1 col) */
  const inlineCols = 1 + GROUPS.reduce((s, g) => s + (isOpen(g) ? g.cols.length : 1), 0);
  const ALL_COLS = GROUPS.flatMap((g) => g.cols); // CSV always exports every column

  function exportCsv() {
    const header = ['Caller', 'Extension', 'Batch', ...ALL_COLS.map((c) => c.label)];
    const body = visibleRows.map((r) => [
      r.name, r.tata_extension || '', r.batch || '',
      ...ALL_COLS.map((c) => { const v = c.get(r); return v == null ? '' : v; }),
    ]);
    const csv = [header, ...body].map((row) => row.map(toCsvCell).join(',')).join('\n');
    downloadCsv(csv, `caller-report_${range.from}_to_${range.to}.csv`);
  }

  /* ── shared cell styles ─────────────────────────────────────────────────── */
  const thBase = { padding: '7px 10px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.72rem', color: 'rgba(255,255,255,0.95)', whiteSpace: 'nowrap', textAlign: 'center' };
  const tdBase = { padding: '8px 10px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK, textAlign: 'center', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(209,196,240,0.4)' };
  const stickyLeft = { position: 'sticky', left: 0, zIndex: 2, textAlign: 'left', background: '#fff', boxShadow: '2px 0 4px rgba(91,33,182,0.06)' };
  const groupTh = (bg) => ({ ...thBase, background: bg, position: 'sticky', top: 0, zIndex: 3 });

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex', flexDirection: 'column', gap: 14,
        ...(isFs ? { background: '#EDEAF8', padding: 14, height: '100vh', overflowY: 'auto', boxSizing: 'border-box' } : {}),
      }}
    >
      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, background: '#fff', borderRadius: 14, padding: 12, boxShadow: '0 2px 12px rgba(91,33,182,0.08)' }}>
        {/* Line 1 — date presets + custom range + batch */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* date preset */}
          <div style={{ display: 'inline-flex', background: '#F3F0FD', borderRadius: 10, padding: 3 }}>
            {['today', 'all', 'custom'].map((p) => (
              <button key={p} onClick={() => setPreset(p)} style={{
                border: 'none', cursor: 'pointer', borderRadius: 8, padding: '6px 14px',
                fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.8rem',
                textTransform: 'capitalize',
                background: preset === p ? VIOLET : 'transparent',
                color: preset === p ? '#fff' : 'rgba(91,33,182,0.6)',
              }}>{p}</button>
            ))}
          </div>
          {preset === 'custom' && (
            <>
              <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} style={dateInput} />
              <span style={{ color: 'rgba(91,33,182,0.5)' }}>→</span>
              <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} style={dateInput} />
            </>
          )}

          {/* batch dropdown */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setWbOpen((o) => !o)} style={dropdownBtn}>
              {webinarId ? (webinars.find((w) => String(w.id) === webinarId)?.name || 'Batch') : 'All batches'}
              <span style={{ marginLeft: 6, fontSize: '0.6rem' }}>▼</span>
            </button>
            {wbOpen && (
              <div style={dropdownPanel} onMouseLeave={() => setWbOpen(false)}>
                <button onClick={() => { setWebinarId(''); setWbOpen(false); }} style={dropdownItem(!webinarId)}>All batches</button>
                {webinars.map((w) => (
                  <button key={w.id} onClick={() => { setWebinarId(String(w.id)); setWbOpen(false); }} style={dropdownItem(String(w.id) === webinarId)}>
                    {w.name}{w.is_active ? '' : ' (inactive)'}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Line 2 — search + Refresh / Export / Full screen */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search caller…" style={{ ...dateInput, minWidth: 200, flex: '1 1 200px' }} />
          <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', color: 'rgba(91,33,182,0.5)' }}>
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : ''}
          </span>
          <button onClick={fetchReport} style={ghostBtn}>↻ Refresh</button>
          <button onClick={exportCsv} style={ghostBtn}>↧ Export CSV</button>
          <button onClick={toggleFullscreen} style={ghostBtn} title="View the report full screen on your laptop">
            {isFs ? '⤢ Exit full screen' : '⛶ Full screen'}
          </button>
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderRadius: isFs ? 0 : 14, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: isFs ? 1 : 'none', minHeight: 0 }}>
        {error ? (
          <div style={{ padding: 24, color: '#B91C1C', fontFamily: 'Outfit, sans-serif' }}>{error}</div>
        ) : (
          <div ref={scrollRef} style={{ overflow: 'auto', height: scrollH ? `${scrollH}px` : (isFs ? 'calc(100vh - 150px)' : '72vh') }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 760 }}>
              <thead>
                {/* group header row */}
                <tr>
                  <th style={{ ...groupTh(VIOLET), ...stickyLeft, background: VIOLET, color: '#fff', zIndex: 4, textAlign: 'left' }}>Caller</th>
                  {GROUPS.map((g) => isOpen(g) ? (
                    <th key={g.id} colSpan={g.cols.length} style={groupTh(g.color)}>
                      {g.label}{g.collapsible && <button onClick={() => toggleGroup(g.id)} style={collapseBtn}>–</button>}
                    </th>
                  ) : (
                    <th key={g.id} style={groupTh(g.color)}><button onClick={() => toggleGroup(g.id)} style={collapseBtn}>＋ {g.label}</button></th>
                  ))}
                </tr>
                {/* column label row */}
                <tr>
                  <th style={{ ...thBase, ...stickyLeft, position: 'sticky', top: 28, zIndex: 4, background: '#F3F0FD', color: INK, textAlign: 'left' }}>Name</th>
                  {GROUPS.map((g) => isOpen(g)
                    ? g.cols.map((c) => <th key={c.id} style={labelTh}>{c.label}</th>)
                    : <th key={g.id} style={labelTh}>—</th>
                  )}
                </tr>
              </thead>

              <tbody>
                {loading && !data.rows.length ? (
                  <tr><td colSpan={inlineCols} style={{ ...tdBase, padding: 28, color: 'rgba(91,33,182,0.5)' }}>Loading…</td></tr>
                ) : !visibleRows.length ? (
                  <tr><td colSpan={inlineCols} style={{ ...tdBase, padding: 28, color: 'rgba(91,33,182,0.5)' }}>No callers.</td></tr>
                ) : visibleRows.map((r) => {
                  const isSel = selectedId === r.caller_id;
                  const rowBg = isSel ? '#EAE3FB' : '#fff';
                  return (
                    <tr
                      key={r.caller_id}
                      onClick={() => setSelectedId(isSel ? null : r.caller_id)}
                      style={{ background: rowBg, cursor: 'pointer' }}
                    >
                      <td style={{ ...tdBase, ...stickyLeft, background: rowBg, boxShadow: isSel ? 'inset 3px 0 0 #5B21B6, 2px 0 4px rgba(91,33,182,0.08)' : '2px 0 4px rgba(91,33,182,0.06)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <span style={{ fontWeight: 700, color: isSel ? VIOLET : INK }}>{r.name}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const b = e.currentTarget.getBoundingClientRect();
                              setMenu({ callerId: r.caller_id, name: r.name, x: Math.min(b.left, window.innerWidth - 230), y: b.bottom + 4 });
                            }}
                            title="Actions"
                            style={kebabBtn}
                          >⋮</button>
                        </span>
                      </td>
                      {GROUPS.map((g) => isOpen(g)
                        ? g.cols.map((c) => {
                            if (c.pct) { const p = c.get(r); return <td key={c.id} style={{ ...tdBase, fontWeight: 800, color: convColor(p) }}>{p == null ? '—' : `${p}%`}</td>; }
                            return <td key={c.id} style={{ ...tdBase, ...(c.bold ? { fontWeight: 700 } : {}) }}>{c.get(r)}</td>;
                          })
                        : <td key={g.id} style={tdBase}>—</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>

              {/* totals footer — uses the same get() on the totals atom object */}
              {!!visibleRows.length && (
                <tfoot>
                  <tr>
                    <td style={{ ...tdBase, ...stickyLeft, position: 'sticky', bottom: 0, zIndex: 3, background: '#EDEAF8', fontWeight: 800, borderTop: '2px solid rgba(124,58,237,0.3)' }}>TOTAL</td>
                    {GROUPS.map((g) => isOpen(g)
                      ? g.cols.map((c) => {
                          if (c.pct) { const p = c.get(data.totals); return <td key={c.id} style={{ ...footTd, color: convColor(p) }}>{p == null ? '—' : `${p}%`}</td>; }
                          return <td key={c.id} style={footTd}>{c.get(data.totals)}</td>;
                        })
                      : <td key={g.id} style={footTd}>—</td>
                    )}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {/* ── Per-caller ⋮ actions menu ─────────────────────────────────────── */}
      {menu && (
        <>
          <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div style={{ position: 'fixed', top: menu.y, left: menu.x, zIndex: 61, minWidth: 210, background: '#fff', border: '1px solid rgba(124,58,237,0.15)', borderRadius: 12, boxShadow: '0 12px 32px rgba(91,33,182,0.22)', padding: 6 }}>
            {MENU_ITEMS.map((it) => (
              <button
                key={it.id}
                onClick={() => {
                  const cid = menu.callerId, cname = menu.name;
                  setMenu(null);
                  if (it.id === 'callerpage') setCallerPageRow({ caller_id: cid, name: cname });
                  // TODO: wire 'move' / 'calllog' / 'pause' actions
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 8, padding: '9px 12px', fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.86rem', color: it.danger ? '#DC2626' : INK }}
                onMouseEnter={(e) => { e.currentTarget.style.background = it.danger ? 'rgba(220,38,38,0.08)' : 'rgba(124,58,237,0.08)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ display: 'inline-flex', color: it.danger ? '#DC2626' : VIOLET }}>{it.icon}</span>
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* ── "Caller page" drawer — admin view of what this caller sees ────── */}
      {callerPageRow && (
        <CallerLeadsMoveDrawer
          token={token}
          caller={callerPageRow}
          callers={data.rows}
          onClose={() => setCallerPageRow(null)}
          onAfterMove={fetchReport}
        />
      )}
    </div>
  );
}

/* ── style atoms ─────────────────────────────────────────────────────────── */
const dateInput  = { border: '1px solid rgba(124,58,237,0.25)', borderRadius: 9, padding: '6px 10px', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: INK };
const dropdownBtn = { border: '1px solid rgba(124,58,237,0.25)', borderRadius: 9, padding: '7px 12px', background: '#fff', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: INK, whiteSpace: 'nowrap' };
const dropdownPanel = { position: 'absolute', top: '110%', left: 0, zIndex: 20, background: '#fff', border: '1px solid rgba(124,58,237,0.2)', borderRadius: 10, boxShadow: '0 8px 24px rgba(91,33,182,0.18)', minWidth: 200, maxHeight: 300, overflowY: 'auto', padding: 4 };
const dropdownItem = (active) => ({ display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', borderRadius: 7, padding: '7px 10px', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', background: active ? 'rgba(124,58,237,0.1)' : 'transparent', color: INK });
const ghostBtn   = { border: `1px solid ${VIOLET}`, borderRadius: 9, padding: '7px 13px', background: '#fff', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.78rem', color: VIOLET, whiteSpace: 'nowrap' };
const labelTh    = { padding: '6px 10px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.68rem', color: 'rgba(91,33,182,0.7)', whiteSpace: 'nowrap', textAlign: 'center', background: '#F3F0FD', position: 'sticky', top: 28, zIndex: 2 };
const footTd     = { padding: '9px 10px', fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '0.82rem', color: INK, textAlign: 'center', background: '#EDEAF8', position: 'sticky', bottom: 0, zIndex: 1, borderTop: '2px solid rgba(124,58,237,0.3)', whiteSpace: 'nowrap' };
const collapseBtn = { marginLeft: 6, border: 'none', background: 'rgba(255,255,255,0.25)', color: '#fff', borderRadius: 5, cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 800, padding: '0 6px' };
const kebabBtn    = { border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(91,33,182,0.55)', fontSize: '1.1rem', fontWeight: 800, lineHeight: 1, padding: '2px 7px', borderRadius: 6, flexShrink: 0 };
