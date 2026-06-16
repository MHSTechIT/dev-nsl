import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { funnelMetrics, num } from './callerReportCategories';
import Loading from '../components/Loading';
import DateTimePicker from '../admin/DateTimePicker';
import CallerLeadsMoveDrawer from '../admin/CallerLeadsMoveDrawer';
import CallerActivityDrawer from '../admin/CallerActivityDrawer';
import CallLogDrawer from '../admin/CallLogDrawer';

/* ── "Caller 360" combined report ────────────────────────────────────────────
   One row per caller merging telephony activity (the Intern Hourly Report) with
   the lead-disposition breakdown (the Lead Outcome Report). Headline metrics are
   inline; the 14 disposition categories open in an expandable detail row.
   Scope: a date range (drives call activity) + an optional Webinar/Batch. */

/* ── tiny local helpers (kept self-contained on purpose) ─────────────────── */
const VIOLET = '#5B21B6';
const INK    = '#3B0764';
const NAME_W   = 140;   // px — fixed width of the sticky caller-name column
const STATUS_W = 132;   // px — fixed width of the sticky status column
const WORKSPACE_W = 110; // px — width of the workspace column
const todayIstYmd = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const pad2 = (n) => String(n).padStart(2, '0');
/* seconds → "HH.MM.SS" (zero-padded) for a single combined talk-time column */
const secToHms = (s) => {
  const t = Math.max(0, Math.round(num(s)));
  return `${pad2(Math.floor(t / 3600))}.${pad2(Math.floor((t % 3600) / 60))}.${pad2(t % 60)}`;
};
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

/* ── Live caller-status badge — same rules as the Performance page ──
   Green = working · Orange = on break · Red = idle/overrun/offline.
   Tracking window 9 AM–6 PM IST; outside it shows "Off hours". Needs `nowTick`
   (a periodically-updated timestamp) so the rest/offline timers stay live. */
function fmtRest(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function badgeStyleByColor(c) {
  const palettes = {
    green:  { bg: 'rgba(5,150,105,0.15)',  fg: '#047857' },
    orange: { bg: 'rgba(245,158,11,0.18)', fg: '#B45309' },
    red:    { bg: 'rgba(220,38,38,0.14)',  fg: '#B91C1C' },
  };
  const p = palettes[c] || palettes.red;
  return {
    display: 'inline-block', padding: '2px 9px', borderRadius: 50,
    fontSize: '0.66rem', fontWeight: 700, background: p.bg, color: p.fg,
    whiteSpace: 'nowrap', fontFamily: 'Outfit, sans-serif',
  };
}
function StatusBadge({ row, nowTick }) {
  const now = nowTick;
  const istHr = new Date(now + 5.5 * 3600 * 1000).getUTCHours();
  if (!(istHr >= 9 && istHr < 18)) {
    return <span title="Tracking window is 9 AM – 6 PM IST" style={{ ...badgeStyleByColor('red'), background: 'rgba(107,114,128,0.12)', color: '#6B7280' }}>Off hours</span>;
  }
  const hbAge = row.last_heartbeat_at ? now - new Date(row.last_heartbeat_at).getTime() : Infinity;
  if (hbAge > 90_000) {
    const restMs = row.rest_started_at ? Math.max(0, now - new Date(row.rest_started_at).getTime()) : null;
    return <span title={`No heartbeat in ${Math.floor(hbAge / 1000)}s`} style={badgeStyleByColor('red')}>Offline{restMs != null && ` · ${fmtRest(restMs)}`}</span>;
  }
  if (row.activity_status === 'working') return <span style={badgeStyleByColor('green')}>Working</span>;
  if (row.activity_status === 'on_break') {
    const b = row.activity_break || {};
    const endsAtMs = b.endsAt ? new Date(b.endsAt).getTime() : (typeof b.endsAt === 'number' ? b.endsAt : null);
    if (endsAtMs && now > endsAtMs) {
      const restMs = row.rest_started_at ? Math.max(0, now - new Date(row.rest_started_at).getTime()) : 0;
      return <span title={`Break overrun — was ${b.reason || 'on break'}`} style={badgeStyleByColor('red')}>Overrun · {fmtRest(restMs)}</span>;
    }
    return <span title={b.reason || 'On break'} style={badgeStyleByColor('orange')}>{b.reason || 'Break'}</span>;
  }
  const restMs = row.rest_started_at ? Math.max(0, now - new Date(row.rest_started_at).getTime()) : 0;
  return <span style={badgeStyleByColor('red')}>Resting · {fmtRest(restMs)}</span>;
}

/* ── Column groups (exact 30-column spec). Each col's `get(row)` works on both
   a caller row and the totals row (same atom shape). Collapsible groups can be
   folded to a single placeholder column. ──────────────────────────────────── */
const GROUPS = [
  { id: 'activity', label: 'ACTIVITY', color: '#B45309', cols: [
    // Break / not-making-auto-call time, office hours (9-18 IST) only.
    { id: 'break', label: 'Break (h.m.s)', get: (r) => secToHms(r.break_sec) },
  ]},
  { id: 'leads', label: 'LEADS', color: '#6D28D9', cols: [
    { id: 'assigned', label: 'Assigned', get: (r) => num(r.assigned) },
    { id: 'touched',  label: 'Touched',  get: (r) => num(r.touched) },
  ]},
  { id: 'answered', label: 'ANSWERED', color: '#7C3AED', collapsible: true, cols: [
    { id: 'answered', label: 'Answered',         get: (r) => num(r.answered) },
    { id: 'anstalk',  label: 'Ans Talk (h.m.s)', get: (r) => secToHms(r.answered_dur_sec) },
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
    { id: 'dnp',      label: 'DNP',               get: (r) => num(r.o_not_picked) },
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

export default function SalesNewPageView({ token, source = 'all' }) {
  const [preset, setPreset]       = useState('today');     // 'today' | 'custom'
  const [customFrom, setCustomFrom] = useState(todayIstYmd());
  const [customTo, setCustomTo]     = useState(todayIstYmd());
  const [fromTime, setFromTime]     = useState('00:00');   // time-of-day filter (custom range)
  const [toTime, setToTime]         = useState('23:59');
  const [webinars, setWebinars]   = useState([]);
  const [webinarId, setWebinarId] = useState('');
  const [wbOpen, setWbOpen]       = useState(false);
  const [search, setSearch]       = useState('');

  /* ── Filter dropdowns ported from the Performance page ──────────────────── */
  /* Salespeople multi-select. Empty set = all. */
  const [salespeopleSel, setSalespeopleSel] = useState(() => new Set());
  const [salespeopleOpen, setSalespeopleOpen] = useState(false);
  const [salespeopleQuery, setSalespeopleQuery] = useState('');
  const salespeopleRef = useRef(null);
  /* Categories multi-select (status + role). Empty set = no filtering. */
  const [categoriesSel, setCategoriesSel] = useState(() => new Set());
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const categoriesRef = useRef(null);
  /* Team-leader single-select. '' = no filter. */
  const [tlFilter, setTlFilter] = useState('');
  const [tlOpen, setTlOpen]     = useState(false);
  const tlRef = useRef(null);
  /* crm_users list — backs the TL dropdown options + the team_leader_id map
     used by the TL filter. Fetched once (like webinars). If the endpoint is
     unavailable the TL dropdown gracefully hides. */
  const [crmUsers, setCrmUsers] = useState([]);
  const [crmUsersLoaded, setCrmUsersLoaded] = useState(false);

  const CATEGORY_GROUPS = [
    {
      title: 'Status',
      items: [
        { value: 'status:active', label: 'Active', dot: '#059669' },
        { value: 'status:paused', label: 'Paused', dot: '#DC2626' },
      ],
    },
    {
      title: 'Role',
      items: [
        { value: 'role:junior_caller', label: 'Junior' },
        { value: 'role:senior_caller', label: 'Senior' },
      ],
    },
  ];
  function toggleCategory(value) {
    setCategoriesSel(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }
  const [data, setData]           = useState({ rows: [], totals: {}, window: null });
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [refreshToast, setRefreshToast] = useState(false);  // brief "Refreshed" toast
  const [collapsed, setCollapsed] = useState(() => new Set()); // collapsed group ids
  const isOpen = (g) => !collapsed.has(g.id);
  const toggleGroup = (id) => setCollapsed((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [selectedId, setSelectedId] = useState(null);      // clicked → highlighted caller row
  const [menu, setMenu]           = useState(null);        // per-caller ⋮ menu { callerId, name, x, y }
  const [callerPageRow, setCallerPageRow] = useState(null); // "Caller page" drawer target
  const [callLogRow, setCallLogRow]       = useState(null); // "View call log" drawer target
  const [activityRow, setActivityRow]     = useState(null); // status-pill → activity timeline drawer
  const [isFs, setIsFs]           = useState(false);       // laptop full-screen view
  const rootRef                   = useRef(null);
  const scrollRef                 = useRef(null);
  const [scrollH, setScrollH]     = useState(null);        // fill viewport → scrollbar at page bottom
  const [nowTick, setNowTick]     = useState(() => Date.now()); // live clock for the status badge
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 10_000); return () => clearInterval(t); }, []);

  const range = useMemo(() => {
    if (preset === 'all')   return { from: '2020-01-01', to: todayIstYmd() }; // from the beginning
    if (preset === 'today') return { from: todayIstYmd(), to: todayIstYmd() };
    return { from: customFrom || todayIstYmd(), to: customTo || customFrom || todayIstYmd() };
  }, [preset, customFrom, customTo]);

  /* Webinars list for the dropdown (once). */
  useEffect(() => {
    if (!token) return;
    fetch(`/api/admin/webinars?source=${encodeURIComponent(source)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => setWebinars(d.webinars || []))
      .catch(() => {});
  }, [token, source]);

  /* crm_users list for the TL dropdown options + team_leader_id lookups.
     Same endpoint the Performance tab uses. Failure leaves crmUsers empty so
     the TL dropdown hides itself rather than breaking the page. */
  useEffect(() => {
    if (!token) return;
    fetch(`/api/admin/crm-users?workspace=${encodeURIComponent(source)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setCrmUsers(d.users || []); setCrmUsersLoaded(true); })
      .catch(() => { setCrmUsers([]); setCrmUsersLoaded(false); });
  }, [token, source]);

  /* Outside-click closers for the three new dropdowns. */
  useEffect(() => {
    if (!salespeopleOpen) return undefined;
    function onDoc(e) { if (salespeopleRef.current && !salespeopleRef.current.contains(e.target)) setSalespeopleOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [salespeopleOpen]);
  useEffect(() => {
    if (!categoriesOpen) return undefined;
    function onDoc(e) { if (categoriesRef.current && !categoriesRef.current.contains(e.target)) setCategoriesOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [categoriesOpen]);
  useEffect(() => {
    if (!tlOpen) return undefined;
    function onDoc(e) { if (tlRef.current && !tlRef.current.contains(e.target)) setTlOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [tlOpen]);

  /* Team-leader dropdown options — always all TLs (sorted), regardless of
     other active filters. Sourced from crm_users, not the report rows. */
  const teamLeaderOptions = useMemo(
    () => crmUsers
      .filter(u => u.role === 'team_leader')
      .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || ''))),
    [crmUsers]
  );

  /* caller_id → team_leader_id lookup so the TL filter can match report rows
     even when their own row doesn't carry team_leader_id (it now does, but we
     keep the crm_users map as a fallback + to know the TL's own id). */
  const tlChildIds = useMemo(() => {
    if (!tlFilter) return null;
    const ids = new Set([tlFilter]);
    for (const u of crmUsers) if (u.team_leader_id === tlFilter) ids.add(u.id);
    return ids;
  }, [tlFilter, crmUsers]);

  const fetchReport = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to, source });
      if (webinarId) qs.set('webinar_id', webinarId);
      // Time-of-day filter — only in Custom mode (Today/All stay full-day).
      if (preset === 'custom' && (fromTime !== '00:00' || toTime !== '23:59')) {
        qs.set('from_time', fromTime);
        qs.set('to_time', toTime);
      }
      const res = await fetch(`/api/admin/caller-report?${qs.toString()}`, {
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
  }, [token, range.from, range.to, webinarId, source, preset, fromTime, toTime]);

  useEffect(() => { fetchReport(); }, [fetchReport]);
  useEffect(() => {
    const id = setInterval(fetchReport, 30_000);
    return () => clearInterval(id);
  }, [fetchReport]);

  /* visibleRows = report rows after applying ALL filters together:
       search  AND  salespeople  AND  categories(status/role)  AND  TL.
     Categories semantics mirror the Performance page exactly: status entries
     OR within the Status group, role entries OR within the Role group, and the
     two groups AND. Empty selections mean "no filtering" for that control. */
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const catStatuses = Array.from(categoriesSel).filter(v => v.startsWith('status:')).map(v => v.slice(7));
    const catRoles    = Array.from(categoriesSel).filter(v => v.startsWith('role:')).map(v => v.slice(5));
    return data.rows.filter((r) => {
      if (q && !(r.name || '').toLowerCase().includes(q)) return false;
      if (salespeopleSel.size > 0 && !salespeopleSel.has(r.caller_id)) return false;
      if (catStatuses.length > 0) {
        const rowStatus = r.is_active === false ? 'paused' : 'active';
        if (!catStatuses.includes(rowStatus)) return false;
      }
      if (catRoles.length > 0 && !catRoles.includes(r.role)) return false;
      if (tlChildIds) {
        // Prefer the row's own team_leader_id (now returned by the backend);
        // fall back to the crm_users-derived child set.
        const matchesTl = r.team_leader_id === tlFilter || tlChildIds.has(r.caller_id);
        if (!matchesTl) return false;
      }
      return true;
    });
  }, [data.rows, search, salespeopleSel, categoriesSel, tlChildIds, tlFilter]);

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
  // caller_id → workspace tag, from the crm_users list (callers carry a workspace).
  const workspaceById = useMemo(() => {
    const m = {};
    for (const u of crmUsers) m[u.id] = u.workspace || null;
    return m;
  }, [crmUsers]);
  const inlineCols = 3 + GROUPS.reduce((s, g) => s + (isOpen(g) ? g.cols.length : 1), 0);
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
  const stickyLeft = { position: 'sticky', left: 0, zIndex: 2, textAlign: 'left', background: '#fff', boxShadow: 'none' };
  const stickyStatus = { position: 'sticky', left: NAME_W, zIndex: 2, textAlign: 'left', background: '#fff', boxShadow: '2px 0 4px rgba(91,33,182,0.06)' };
  const groupTh = (bg) => ({ ...thBase, background: bg, position: 'sticky', top: 0, zIndex: 3 });

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex', flexDirection: 'column', gap: 14,
        ...(isFs ? { background: '#EDEAF8', padding: 14, height: '100vh', overflowY: 'auto', boxSizing: 'border-box' } : {}),
      }}
    >
      {/* Custom violet checkbox style for the filter dropdowns (same as the
          Performance page's .sp-check). */}
      <style>{`
        .sp-check {
          -webkit-appearance: none; -moz-appearance: none; appearance: none;
          width: 18px; height: 18px; margin: 0;
          border: 1.5px solid rgba(91,33,182,0.40);
          border-radius: 5px; background: #fff; cursor: pointer;
          position: relative; transition: background 120ms, border-color 120ms, box-shadow 120ms;
          vertical-align: middle; flex-shrink: 0;
        }
        .sp-check:hover  { border-color: #5B21B6; box-shadow: 0 0 0 3px rgba(91,33,182,0.10); }
        .sp-check:focus  { outline: none; border-color: #5B21B6; box-shadow: 0 0 0 3px rgba(91,33,182,0.18); }
        .sp-check:checked { background: #5B21B6; border-color: #5B21B6; }
        .sp-check:checked::after {
          content: ''; position: absolute; left: 5px; top: 1px;
          width: 5px; height: 10px; border: solid #fff; border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }
      `}</style>
      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, background: '#fff', borderRadius: 14, padding: 12, boxShadow: '0 2px 12px rgba(91,33,182,0.08)' }}>
        {/* Second line — date presets + custom range (order:2 → below the dropdowns row) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', order: 2 }}>
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
              <div style={{ width: 250 }}>
                <DateTimePicker
                  allowPast
                  placeholder="From date & time"
                  value={`${customFrom}T${fromTime}:00`}
                  onChange={(local) => { const [d, t] = local.split('T'); setCustomFrom(d); setFromTime((t || '00:00').slice(0, 5)); }}
                />
              </div>
              <span style={{ color: 'rgba(91,33,182,0.5)' }}>→</span>
              <div style={{ width: 250 }}>
                <DateTimePicker
                  allowPast
                  placeholder="To date & time"
                  value={`${customTo}T${toTime}:00`}
                  onChange={(local) => { const [d, t] = local.split('T'); setCustomTo(d); setToTime((t || '23:59').slice(0, 5)); }}
                />
              </div>
            </>
          )}
        </div>

        {/* First line — all dropdowns + actions (order:1 → above the presets row). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', order: 1 }}>
          {/* webinar dropdown */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setWbOpen((o) => !o)} style={dropdownBtn}>
              {webinarId ? (webinars.find((w) => String(w.id) === webinarId)?.name || 'Webinar') : 'All webinars'}
              <span style={{ marginLeft: 6, fontSize: '0.6rem' }}>▼</span>
            </button>
            {wbOpen && (
              <div style={dropdownPanel} onMouseLeave={() => setWbOpen(false)}>
                <button onClick={() => { setWebinarId(''); setWbOpen(false); }} style={dropdownItem(!webinarId)}>All webinars</button>
                {webinars.map((w) => (
                  <button key={w.id} onClick={() => { setWebinarId(String(w.id)); setWbOpen(false); }} style={dropdownItem(String(w.id) === webinarId)}>
                    {w.name}{w.is_active ? '' : ' (inactive)'}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Categories — unified multi-select with Status + Role checkboxes. */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <div ref={categoriesRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setCategoriesOpen(o => !o)}
                style={{
                  height: '2.1rem', padding: '0 32px 0 12px', borderRadius: 10,
                  border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK,
                  cursor: 'pointer', minWidth: 140, textAlign: 'left', position: 'relative',
                }}
              >
                {categoriesSel.size === 0 ? 'All categories' : `${categoriesSel.size} selected`}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) rotate(${categoriesOpen ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              {categoriesOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                  minWidth: 220, maxHeight: 360, overflowY: 'auto',
                  background: '#fff', borderRadius: 10,
                  border: '1px solid rgba(209,196,240,0.60)',
                  boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
                  padding: 6, zIndex: 50, fontFamily: 'Outfit, sans-serif',
                }}>
                  <button
                    type="button"
                    onClick={() => setCategoriesSel(new Set())}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6, border: 'none',
                      background: categoriesSel.size === 0 ? 'rgba(91,33,182,0.10)' : 'transparent',
                      color: categoriesSel.size === 0 ? '#5B21B6' : 'rgba(59,7,100,0.85)',
                      fontWeight: categoriesSel.size === 0 ? 700 : 600, fontSize: '0.82rem', cursor: 'pointer',
                      borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4,
                    }}
                    onMouseEnter={e => { if (categoriesSel.size > 0) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
                    onMouseLeave={e => { if (categoriesSel.size > 0) e.currentTarget.style.background = 'transparent'; }}
                  >
                    All categories
                  </button>
                  {CATEGORY_GROUPS.map(group => (
                    <div key={group.title} style={{ marginTop: 4, marginBottom: 4 }}>
                      <div style={{ padding: '6px 10px 4px', fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.10em', color: 'rgba(91,33,182,0.55)' }}>{group.title}</div>
                      {group.items.map(item => {
                        const checked = categoriesSel.has(item.value);
                        return (
                          <label
                            key={item.value}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                              background: checked ? 'rgba(91,33,182,0.06)' : 'transparent', transition: 'background 120ms',
                            }}
                            onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'rgba(91,33,182,0.04)'; }}
                            onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                          >
                            <input type="checkbox" className="sp-check" checked={checked} onChange={() => toggleCategory(item.value)} />
                            {item.dot && (<span style={{ width: 7, height: 7, borderRadius: '50%', background: item.dot, flexShrink: 0 }} />)}
                            <span style={{ flex: 1, fontFamily: 'Outfit, sans-serif', fontWeight: checked ? 700 : 600, fontSize: '0.84rem', color: checked ? '#5B21B6' : INK }}>{item.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* TL filter — single-select team leaders. Hidden when no TLs exist
              (or crm_users couldn't be loaded). */}
          {crmUsersLoaded && teamLeaderOptions.length > 0 && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <div ref={tlRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setTlOpen(o => !o)}
                  style={{
                    height: '2.1rem', padding: '0 32px 0 12px', borderRadius: 10,
                    border: '1px solid rgba(139,92,246,0.25)',
                    background: tlFilter ? 'rgba(91,33,182,0.08)' : '#fff',
                    fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK,
                    cursor: 'pointer', minWidth: 140, textAlign: 'left', position: 'relative',
                  }}
                >
                  {tlFilter ? (teamLeaderOptions.find(t => t.id === tlFilter)?.full_name || 'Team Leader') : 'All TLs'}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) rotate(${tlOpen ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {tlOpen && (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                    minWidth: 220, maxHeight: 320, overflowY: 'auto',
                    background: '#fff', borderRadius: 10,
                    border: '1px solid rgba(209,196,240,0.60)',
                    boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
                    padding: 4, zIndex: 50, fontFamily: 'Outfit, sans-serif',
                  }}>
                    <button
                      type="button"
                      onClick={() => { setTlFilter(''); setTlOpen(false); }}
                      style={{
                        width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6, border: 'none',
                        background: !tlFilter ? 'rgba(91,33,182,0.10)' : 'transparent',
                        color: !tlFilter ? '#5B21B6' : 'rgba(59,7,100,0.85)',
                        fontWeight: !tlFilter ? 700 : 600, fontSize: '0.82rem', cursor: 'pointer',
                        borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4,
                      }}
                      onMouseEnter={e => { if (tlFilter) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
                      onMouseLeave={e => { if (tlFilter) e.currentTarget.style.background = 'transparent'; }}
                    >
                      All TLs
                    </button>
                    {teamLeaderOptions.map(tl => {
                      const active = tlFilter === tl.id;
                      const teamSize = crmUsers.filter(c => c.team_leader_id === tl.id).length;
                      return (
                        <button
                          key={tl.id}
                          type="button"
                          onClick={() => { setTlFilter(tl.id); setTlOpen(false); }}
                          style={{
                            width: '100%', textAlign: 'left',
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                            padding: '8px 10px', borderRadius: 6, border: 'none',
                            background: active ? 'rgba(91,33,182,0.10)' : 'transparent',
                            color: active ? '#5B21B6' : 'rgba(59,7,100,0.85)',
                            fontWeight: active ? 700 : 600, fontSize: '0.82rem', cursor: 'pointer',
                          }}
                          onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(91,33,182,0.04)'; }}
                          onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tl.full_name}{tl.department ? ` · ${tl.department}` : ''}
                          </span>
                          <span style={{ flexShrink: 0, fontSize: '0.66rem', fontWeight: 800, background: 'rgba(91,33,182,0.10)', color: '#5B21B6', padding: '2px 7px', borderRadius: 50 }}>
                            {teamSize}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Salesperson multi-select — options are the report rows (callers). */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <div ref={salespeopleRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setSalespeopleOpen(o => !o)}
                style={{
                  height: '2.1rem', padding: '0 32px 0 12px', borderRadius: 10,
                  border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK,
                  cursor: 'pointer', minWidth: 140, textAlign: 'left', position: 'relative',
                }}
              >
                {salespeopleSel.size === 0
                  ? 'All salespeople'
                  : salespeopleSel.size === 1
                    ? (data.rows.find(c => salespeopleSel.has(c.caller_id))?.name || '1 selected')
                    : `${salespeopleSel.size} selected`}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) rotate(${salespeopleOpen ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              {salespeopleOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                  minWidth: 240, maxHeight: 320, overflowY: 'auto',
                  background: '#fff', borderRadius: 10,
                  border: '1px solid rgba(209,196,240,0.60)',
                  boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
                  padding: 4, zIndex: 50, fontFamily: 'Outfit, sans-serif',
                }}>
                  <div style={{ position: 'sticky', top: 0, background: '#fff', padding: '4px 4px 6px', zIndex: 1, borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4 }}>
                    <input
                      type="text"
                      autoFocus
                      value={salespeopleQuery}
                      onChange={e => setSalespeopleQuery(e.target.value)}
                      placeholder="Search salespeople…"
                      style={{ width: '100%', height: '2.1rem', padding: '0 10px', borderRadius: 8, border: '1px solid rgba(139,92,246,0.30)', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK, outline: 'none' }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setSalespeopleSel(new Set())}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6, border: 'none',
                      background: salespeopleSel.size === 0 ? 'rgba(91,33,182,0.10)' : 'transparent',
                      color: salespeopleSel.size === 0 ? '#5B21B6' : 'rgba(59,7,100,0.85)',
                      fontWeight: salespeopleSel.size === 0 ? 700 : 600, fontSize: '0.82rem', cursor: 'pointer',
                      borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4,
                    }}
                    onMouseEnter={e => { if (salespeopleSel.size > 0) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
                    onMouseLeave={e => { if (salespeopleSel.size > 0) e.currentTarget.style.background = 'transparent'; }}
                  >
                    All salespeople
                  </button>
                  {(() => {
                    const q = salespeopleQuery.trim().toLowerCase();
                    const filtered = q ? data.rows.filter(c => (c.name || '').toLowerCase().includes(q)) : data.rows;
                    if (filtered.length === 0) {
                      return (<div style={{ padding: '12px 10px', fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)', textAlign: 'center' }}>No salespeople match "{salespeopleQuery}"</div>);
                    }
                    return filtered.map(c => {
                      const checked = salespeopleSel.has(c.caller_id);
                      return (
                        <label
                          key={c.caller_id}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                            background: checked ? 'rgba(91,33,182,0.06)' : 'transparent', transition: 'background 120ms',
                          }}
                          onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'rgba(91,33,182,0.04)'; }}
                          onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <input
                            type="checkbox"
                            className="sp-check"
                            checked={checked}
                            onChange={() => setSalespeopleSel(prev => {
                              const next = new Set(prev);
                              if (next.has(c.caller_id)) next.delete(c.caller_id); else next.add(c.caller_id);
                              return next;
                            })}
                          />
                          <span style={{ flex: 1, fontFamily: 'Outfit, sans-serif', fontWeight: checked ? 700 : 600, fontSize: '0.84rem', color: checked ? '#5B21B6' : INK }}>{c.name}</span>
                          {c.is_active === false && (
                            <span style={{ fontSize: '0.60rem', fontWeight: 700, textTransform: 'uppercase', padding: '1px 6px', borderRadius: 50, background: 'rgba(107,114,128,0.18)', color: '#374151' }}>Paused</span>
                          )}
                        </label>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          </div>

          {/* actions — refresh / export / full screen, pushed to the right of the same line */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => { fetchReport(); setRefreshToast(true); setTimeout(() => setRefreshToast(false), 2000); }}
              style={{ ...ghostBtn, padding: '7px 11px' }}
              title="Refresh" aria-label="Refresh"
            >↻</button>
            <button onClick={exportCsv} style={ghostBtn}>↧ Export CSV</button>
            <button onClick={toggleFullscreen} style={{ ...ghostBtn, padding: '7px 11px' }} title={isFs ? 'Exit full screen' : 'Full screen'} aria-label={isFs ? 'Exit full screen' : 'Full screen'}>
              {isFs ? '⤢' : '⛶'}
            </button>
          </div>
        </div>
      </div>

      {/* Refresh toast — bottom-right, auto-hides */}
      {refreshToast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '12px 18px', borderRadius: 50,
          background: 'linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)', color: '#fff',
          fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.85rem',
          boxShadow: '0 10px 30px rgba(91,33,182,0.35)',
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Report refreshed
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderRadius: isFs ? 0 : 14, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: isFs ? 1 : 'none', minHeight: 0 }}>
        {error ? (
          <div style={{ padding: 24, color: '#B91C1C', fontFamily: 'Outfit, sans-serif' }}>{error}</div>
        ) : (
          <div ref={scrollRef} style={{ overflow: 'auto', maxHeight: scrollH ? `${scrollH}px` : (isFs ? 'calc(100vh - 150px)' : '72vh') }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 760 }}>
              <thead>
                {/* group header row */}
                <tr>
                  <th colSpan={1} style={{ ...groupTh(VIOLET), ...stickyLeft, background: VIOLET, color: '#fff', zIndex: 4, textAlign: 'left', minWidth: NAME_W, width: NAME_W }}>Caller</th>
                  {/* Status + Workspace group-header cell — scrolls with the data (not pinned). */}
                  <th colSpan={2} style={{ ...groupTh(VIOLET), background: VIOLET, color: '#fff', zIndex: 3, textAlign: 'left', minWidth: STATUS_W + WORKSPACE_W }}>&nbsp;</th>
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
                  <th style={{ ...thBase, ...stickyLeft, position: 'sticky', top: 28, zIndex: 4, background: '#F3F0FD', color: INK, textAlign: 'left', minWidth: NAME_W, width: NAME_W }}>Name</th>
                  <th style={{ ...thBase, position: 'sticky', top: 28, zIndex: 3, background: '#F3F0FD', color: INK, textAlign: 'left', minWidth: STATUS_W, width: STATUS_W }}>Status</th>
                  <th style={{ ...thBase, position: 'sticky', top: 28, zIndex: 3, background: '#F3F0FD', color: INK, textAlign: 'left', minWidth: WORKSPACE_W, width: WORKSPACE_W }}>Workspace</th>
                  {GROUPS.map((g) => isOpen(g)
                    ? g.cols.map((c) => <th key={c.id} style={labelTh}>{c.label}</th>)
                    : <th key={g.id} style={labelTh}>—</th>
                  )}
                </tr>
              </thead>

              <tbody>
                {loading && !data.rows.length ? (
                  <tr><td colSpan={inlineCols} style={{ ...tdBase, padding: 16 }}><Loading /></td></tr>
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
                      <td style={{ ...tdBase, ...stickyLeft, width: NAME_W, minWidth: NAME_W, background: rowBg, boxShadow: isSel ? 'inset 3px 0 0 #5B21B6' : 'none' }}>
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontWeight: 700, color: isSel ? VIOLET : INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
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
                      <td style={{ ...tdBase, width: STATUS_W, minWidth: STATUS_W, background: rowBg, textAlign: 'left' }}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setActivityRow(r); }}
                          title="View this caller's activity timeline"
                          style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}
                        >
                          <StatusBadge row={r} nowTick={nowTick} />
                        </button>
                      </td>
                      <td style={{ ...tdBase, width: WORKSPACE_W, minWidth: WORKSPACE_W, textAlign: 'left' }}>
                        {(() => {
                          const ws = workspaceById[r.caller_id];
                          const label = !ws ? 'All' : ({ meta: 'Meta', yt: 'YT', meta2: 'Meta 2.0', metatemp: 'Meta Temp', tagmango: 'TagMango' }[ws] || ws);
                          return (
                            <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 50, fontSize: '0.7rem', fontWeight: 700, background: 'rgba(124,58,237,0.10)', color: '#5B21B6', whiteSpace: 'nowrap' }}>{label}</span>
                          );
                        })()}
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
                    <td style={{ ...tdBase, ...stickyLeft, position: 'sticky', bottom: 0, zIndex: 3, width: NAME_W, minWidth: NAME_W, background: '#EDEAF8', fontWeight: 800, borderTop: '2px solid rgba(124,58,237,0.3)' }}>TOTAL</td>
                    <td style={{ ...tdBase, position: 'sticky', bottom: 0, zIndex: 1, width: STATUS_W, minWidth: STATUS_W, background: '#EDEAF8', borderTop: '2px solid rgba(124,58,237,0.3)' }}></td>
                    <td style={{ ...footTd, width: WORKSPACE_W, minWidth: WORKSPACE_W, textAlign: 'left' }}></td>
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
                  if (it.id === 'calllog')    setCallLogRow({ caller_id: cid, name: cname });
                  // TODO: wire 'pause' action
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

      {/* ── "View call log" drawer — caller's call history + recordings ────── */}
      {callLogRow && (
        <CallLogDrawer
          token={token}
          caller={callLogRow}
          onClose={() => setCallLogRow(null)}
        />
      )}

      {/* Status pill → full activity timeline for that caller (same drawer as the
          Performance page). */}
      {activityRow && (
        <CallerActivityDrawer
          token={token}
          callerId={activityRow.caller_id}
          callerName={activityRow.name}
          onClose={() => setActivityRow(null)}
          isActive={activityRow.is_active !== false}
        />
      )}
    </div>
  );
}

/* ── style atoms ─────────────────────────────────────────────────────────── */
const dateInput  = { border: '1px solid rgba(124,58,237,0.25)', borderRadius: 9, padding: '6px 10px', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: INK };
const timeInput  = { height: '2.1rem', border: '1px solid rgba(124,58,237,0.25)', borderRadius: 9, padding: '0 8px', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: INK, background: '#fff', outline: 'none' };
const dropdownBtn = { border: '1px solid rgba(124,58,237,0.25)', borderRadius: 9, padding: '7px 12px', background: '#fff', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: INK, whiteSpace: 'nowrap' };
const dropdownPanel = { position: 'absolute', top: '110%', left: 0, zIndex: 20, background: '#fff', border: '1px solid rgba(124,58,237,0.2)', borderRadius: 10, boxShadow: '0 8px 24px rgba(91,33,182,0.18)', minWidth: 200, maxHeight: 300, overflowY: 'auto', padding: 4 };
const dropdownItem = (active) => ({ display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', borderRadius: 7, padding: '7px 10px', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', background: active ? 'rgba(124,58,237,0.1)' : 'transparent', color: INK });
const ghostBtn   = { border: `1px solid ${VIOLET}`, borderRadius: 9, padding: '7px 13px', background: '#fff', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.78rem', color: VIOLET, whiteSpace: 'nowrap' };
const labelTh    = { padding: '6px 10px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.68rem', color: 'rgba(91,33,182,0.7)', whiteSpace: 'nowrap', textAlign: 'center', background: '#F3F0FD', position: 'sticky', top: 28, zIndex: 2 };
const footTd     = { padding: '9px 10px', fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '0.82rem', color: INK, textAlign: 'center', background: '#EDEAF8', position: 'sticky', bottom: 0, zIndex: 1, borderTop: '2px solid rgba(124,58,237,0.3)', whiteSpace: 'nowrap' };
const collapseBtn = { marginLeft: 6, border: 'none', background: 'rgba(255,255,255,0.25)', color: '#fff', borderRadius: 5, cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 800, padding: '0 6px' };
const kebabBtn    = { border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(91,33,182,0.55)', fontSize: '1.1rem', fontWeight: 800, lineHeight: 1, padding: '2px 7px', borderRadius: 6, flexShrink: 0 };
