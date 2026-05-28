import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

/* ──────────────────────────────────────────────────────────────────────
   Sales → Completed Calls.

   Wide read-only table — one row per completed lead, one column per
   form question the caller filled in, plus a final Recording column
   with an inline <audio> player.

   Powered by:
     GET /api/admin/completed-calls   (auth: ADMIN_PASSWORD bearer)
     GET /api/caller/recordings/:id   (auth: ?token=<ADMIN_PASSWORD> —
        the recordings proxy now accepts the admin token directly so a
        manager can stream any caller's recording without re-signing).
   ────────────────────────────────────────────────────────────────────── */

const OUTCOME_LABEL = {
  completed:      'Completed',
  not_interested: 'Not Interested',
  incomplete:     'Incomplete',
};

const TAG_STYLE = {
  HOT:  { bg: 'rgba(220,38,38,0.12)',  fg: '#B91C1C' },
  WARM: { bg: 'rgba(245,158,11,0.15)', fg: '#B45309' },
  COLD: { bg: 'rgba(30,64,175,0.12)',  fg: '#1E40AF' },
  JUNK: { bg: 'rgba(107,114,128,0.18)', fg: '#374151' },
  // Synthetic tag used for rows whose last_note_outcome = 'incomplete'.
  // Not a real lead_tag value in the DB — rendered in the Tag column
  // when the lead never reached the classifier (caller was paused /
  // disconnected before saving the form). Distinct amber styling so
  // managers can spot abandoned leads at a glance.
  INCOMPLETE: { bg: 'rgba(245,158,11,0.18)', fg: '#92400E' },
};

/* Subtag value → human label — kept in sync with the dropdown options
   in LeadCallNoteModal.jsx + the second-DNP choice card. */
const SUBTAG_LABEL = {
  wrong_number:              'Wrong Number',
  call_disconnected:         'Call Disconnected',
  other_languages:           'Other Languages',
  no_diabetes:               'No Diabetes',
  no_sugar_interested:       'No Sugar — Interested',
  no_sugar_not_interested:   'No Sugar — Not Interested',
  already_paid:              'Already Paid',
  already_attended:          'Already Attended',
  not_available_for_webinar: 'Not Available for Webinar',
  not_register:              'Not Registered',
  just_for_knowledge:        'Just for Knowledge',
  switch_off:                'Switch Off',
  out_of_service:            'Out of Service',
  no_ring:                   'No Ring',
};

/* Friendly labels for the radio-value-style fields */
const YESNO_LABEL = { yes: 'Yes', no: 'No' };
const RANGE_LABEL = {
  '250+':         '250+',
  '200-250':      '200–250',
  '100-200':      '100–200',
  'no_diabetes':  'No Diabetes',
};
const HBA1C_LABEL = {
  gt_7_5:    '> 7.5',
  '6_5_to_7_5': '6.5 – 7.5',
  '5_7_to_6_5': '5.7 – 6.5',
};
const RANGE_FOR_LABEL = { personal: 'Personal', family: 'Family' };

function titleCase(s) {
  if (!s) return '';
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function fmt(v, map) {
  if (v == null || v === '') return '—';
  return map?.[v] || titleCase(v);
}
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return '—'; }
}

/* Same category groups as the Performance filter for visual + behavioural
   parity. Values are namespaced strings ("status:active", "role:junior")
   so a single Set holds the union of both group selections. */
const CATEGORY_GROUPS = [
  {
    title: 'Status',
    items: [
      { value: 'status:active', label: 'Active' },
      { value: 'status:paused', label: 'Paused' },
    ],
  },
  {
    title: 'Role',
    items: [
      { value: 'role:junior_caller', label: 'Junior' },
      { value: 'role:senior_caller', label: 'Senior' },
      { value: 'role:team_leader',   label: 'Team Lead' },
      { value: 'role:manager',       label: 'Manager' },
      { value: 'role:trainer',       label: 'Trainer' },
      { value: 'role:admin',         label: 'Admin' },
    ],
  },
];

/* Per-column filter definitions — keyed by the row field name so the
   filter logic and the header rendering can share one source of truth.
   Each entry:
     type      'select' (multi-select from unique values found in rows)
               OR 'text' (case-insensitive substring match)
     label     header text shown in the popover
     labelMap  optional value→display map for select rows (e.g. yes → Yes)
   Columns without an entry (#, Recording, Completed at) are unfiltered
   at the column level — Completed at is already handled by the top
   toolbar's Today / Custom date pills. */
const COLUMN_FILTERS = {
  caller_name:                     { type: 'select', label: 'Caller' },
  // Lead + Phone column filters removed per request — those columns
  // render as plain <th> cells now. Use the top toolbar's search box
  // to search by lead name / phone instead.
  last_note_outcome:               { type: 'select', label: 'Outcome' },        // mapped via OUTCOME_LABEL
  lead_tag:                        { type: 'select', label: 'Tag' },
  last_note_outcome_subtag:        { type: 'select', label: 'Subtag' },         // mapped via SUBTAG_LABEL
  last_note_interested:            { type: 'select', label: 'Interested' },     // mapped via YESNO_LABEL
  last_note_confirmed_range:       { type: 'select', label: 'Confirm Range' }, // mapped via RANGE_LABEL
  last_note_range_for:             { type: 'select', label: 'For' },           // mapped via RANGE_FOR_LABEL
  last_note_patient_age:           { type: 'select', label: 'Age' },
  last_note_hba1c:                 { type: 'select', label: 'HbA1c' },         // mapped via HBA1C_LABEL
  last_note_takes_medicine:        { type: 'select', label: 'Medicine' },      // mapped via YESNO_LABEL
  last_note_working_professional:  { type: 'select', label: 'Working Pro.' },
  last_note_location:              { type: 'select', label: 'Location' },
  last_note_webinar_attended:      { type: 'select', label: 'Webinar Attended' },
  last_note_available_for_webinar: { type: 'select', label: 'Available for Webinar' },
  last_note_next_batch_joining:    { type: 'select', label: 'Next Batch Joining' },
  last_note_text:                  { type: 'text',   label: 'Note' },
  webinar_name:                    { type: 'select', label: 'Webinar' },
};

/* Resolve a raw column value to its display string — uses the per-column
   label map when one is defined, otherwise falls back to titlecasing the
   snake_case value. Empty / null becomes the explicit "(blank)" bucket
   so callers can filter on rows with missing data. */
function labelForColumnValue(key, value) {
  if (value == null || value === '') return '(blank)';
  switch (key) {
    case 'last_note_outcome':        return OUTCOME_LABEL[value] || titleCase(value);
    case 'last_note_outcome_subtag': return SUBTAG_LABEL[value] || titleCase(value);
    case 'last_note_interested':
    case 'last_note_takes_medicine':
    case 'last_note_webinar_attended':
    case 'last_note_available_for_webinar':
    case 'last_note_next_batch_joining':
      return YESNO_LABEL[value] || titleCase(value);
    case 'last_note_confirmed_range': return RANGE_LABEL[value] || value;
    case 'last_note_range_for':       return RANGE_FOR_LABEL[value] || titleCase(value);
    case 'last_note_hba1c':           return HBA1C_LABEL[value] || value;
    case 'last_note_working_professional':
    case 'last_note_location':
      return titleCase(value);
    default: return String(value);
  }
}

function startOfTodayISO() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function endOfTodayISO() {
  const d = new Date(); d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/* Pagination — client-side, 10 rows per page. The `filtered` array is
   what we slice; `page` is 0-indexed and gets clamped + reset whenever
   the filter inputs change so the user always lands on page 1 of the
   new result set. */
const PAGE_SIZE = 10;

export default function SalesCompletedCallsView({ token }) {
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [query, setQuery]       = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('all'); // all | completed | not_interested
  const [page, setPage]         = useState(0);

  /* ── Filter state — same vocabulary as Performance so the bar behaves
     identically. All filtering happens client-side over the 500-row
     completed-calls payload. */
  // 'today' | 'custom'. The legacy 'all' option was removed from the
  // UI — if any stored state still references it (older session), we
  // coerce to 'today' on mount via a one-shot effect below.
  const [preset,         setPreset]         = useState('today');
  const [customFrom,     setCustomFrom]     = useState('');
  const [customTo,       setCustomTo]       = useState('');
  // Styled date-range picker state (matches the Performance view's
  // CRM-themed calendar instead of the browser-native input). The
  // picker popup is anchored to the From/To buttons; click either
  // to open. customMonth tracks the calendar's currently-shown
  // month independently of from/to so users can paginate freely.
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const customRangeRef = useRef(null);
  const [customMonth,    setCustomMonth]    = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  // Time of day applied to each end of the range (IST). The dateRange
  // useMemo uses these instead of always taking 00:00:00–23:59:59 so
  // admins can scope to "this morning" / "this afternoon" / etc.
  const [customFromTime, setCustomFromTime] = useState({ hh: '12', mm: '00', ampm: 'AM' });
  const [customToTime,   setCustomToTime]   = useState({ hh: '11', mm: '59', ampm: 'PM' });
  const [categoriesSel,  setCategoriesSel]  = useState(() => new Set());
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const categoriesRef = useRef(null);
  const [webinarId,      setWebinarId]      = useState('');
  const [webinarOpen,    setWebinarOpen]    = useState(false);
  const webinarRef    = useRef(null);
  const [tlFilter,       setTlFilter]       = useState('');
  const [tlOpen,         setTlOpen]         = useState(false);
  const tlRef         = useRef(null);
  const [salespeopleSel, setSalespeopleSel] = useState(() => new Set());
  const [salespeopleOpen, setSalespeopleOpen] = useState(false);
  const salespeopleRef = useRef(null);

  /* Reference data needed to populate the dropdowns. */
  const [callers,  setCallers]  = useState([]);
  const [webinars, setWebinars] = useState([]);

  /* Per-column filter state.
     colSel  — Map<columnKey, Set<rawValue>>  (multi-select columns)
     colText — Map<columnKey, string>          (text columns)
     openCol — the columnKey whose popover is currently open (or null) */
  const [colSel,  setColSel]  = useState(() => new Map());
  const [colText, setColText] = useState(() => new Map());
  const [openCol, setOpenCol] = useState(null);
  const headerRef = useRef(null);

  // One outside-click guard for the column popovers (only one open at a time).
  useEffect(() => {
    if (!openCol) return undefined;
    function on(e) {
      if (headerRef.current && !headerRef.current.contains(e.target)) setOpenCol(null);
    }
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [openCol]);

  function toggleColSel(key, value) {
    setColSel(prev => {
      const next = new Map(prev);
      const cur  = new Set(next.get(key) || []);
      if (cur.has(value)) cur.delete(value); else cur.add(value);
      if (cur.size === 0) next.delete(key); else next.set(key, cur);
      return next;
    });
  }
  function clearCol(key) {
    setColSel(prev => { const n = new Map(prev); n.delete(key); return n; });
    setColText(prev => { const n = new Map(prev); n.delete(key); return n; });
  }
  function clearAllColFilters() {
    setColSel(new Map());
    setColText(new Map());
  }
  const colFiltersActive = colSel.size + colText.size;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/completed-calls', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load completed calls.');
      const data = await res.json();
      setRows(data.leads || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Fetch callers + webinars once for the dropdown options.
  useEffect(() => {
    fetch('/api/admin/crm-users', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setCallers((d.users || []).filter(u =>
        ['junior_caller','senior_caller','team_leader','manager'].includes(u.role)
      )))
      .catch(() => {});
    fetch('/api/admin/webinars', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setWebinars(d.webinars || []))
      .catch(() => {});
  }, [token]);

  // Outside-click guards for the four popovers.
  useEffect(() => {
    function on(e) {
      if (categoriesOpen  && categoriesRef.current  && !categoriesRef.current.contains(e.target))   setCategoriesOpen(false);
      if (webinarOpen     && webinarRef.current     && !webinarRef.current.contains(e.target))      setWebinarOpen(false);
      if (tlOpen          && tlRef.current          && !tlRef.current.contains(e.target))           setTlOpen(false);
      if (salespeopleOpen && salespeopleRef.current && !salespeopleRef.current.contains(e.target))  setSalespeopleOpen(false);
    }
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [categoriesOpen, webinarOpen, tlOpen, salespeopleOpen]);

  // Outside-click closes the custom date-range picker (separate from
  // the four-popover guard above because the picker is its own subtree).
  useEffect(() => {
    if (!customRangeOpen) return undefined;
    function onDocClick(e) {
      if (customRangeRef.current && !customRangeRef.current.contains(e.target)) setCustomRangeOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [customRangeOpen]);

  /* Helpers derived from the loaded reference data. */
  const teamLeaderOptions = useMemo(
    () => callers.filter(c => c.role === 'team_leader')
      .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || ''))),
    [callers]
  );
  const callersById = useMemo(() => {
    const m = new Map();
    for (const c of callers) m.set(c.id, c);
    return m;
  }, [callers]);
  const callersForView = useMemo(() => {
    if (!tlFilter) return callers;
    return callers.filter(c => c.team_leader_id === tlFilter || c.id === tlFilter);
  }, [callers, tlFilter]);
  const callersForViewIds = useMemo(
    () => new Set(callersForView.map(c => c.id)),
    [callersForView]
  );

  function toggleCategory(v) {
    setCategoriesSel(prev => {
      const n = new Set(prev);
      if (n.has(v)) n.delete(v); else n.add(v);
      return n;
    });
  }
  function toggleSalesperson(id) {
    setSalespeopleSel(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  /* Date range derived from the date preset. For 'custom', the
     customFromTime and customToTime states (hh / mm / am-pm in IST)
     are folded into the ISO timestamps so admins can scope to a
     specific hour-of-day, not just whole calendar days. */
  const dateRange = useMemo(() => {
    if (preset === 'today') return { from: startOfTodayISO(), to: endOfTodayISO() };
    if (preset === 'custom' && customFrom) {
      const apply = (ymd, t) => {
        const [y, m, d] = ymd.split('-').map(Number);
        let h = parseInt(t.hh, 10);
        const min = parseInt(t.mm, 10);
        if (!Number.isFinite(h))   h = 0;
        if (!Number.isFinite(min)) /* keep 0 */;
        // 12-hour clock → 24-hour
        if (t.ampm === 'PM' && h < 12) h += 12;
        if (t.ampm === 'AM' && h === 12) h = 0;
        const out = new Date(y, m - 1, d);
        out.setHours(h, Number.isFinite(min) ? min : 0, 0, 0);
        return out;
      };
      const fromD = apply(customFrom,                customFromTime);
      const toD   = apply(customTo || customFrom,    customToTime);
      return { from: fromD.toISOString(), to: toD.toISOString() };
    }
    return null;
  }, [preset, customFrom, customTo, customFromTime, customToTime]);

  const catStatuses = useMemo(
    () => Array.from(categoriesSel).filter(v => v.startsWith('status:')).map(v => v.slice(7)),
    [categoriesSel]
  );
  const catRoles = useMemo(
    () => Array.from(categoriesSel).filter(v => v.startsWith('role:')).map(v => v.slice(5)),
    [categoriesSel]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(r => {
      // Outcome (the existing All / Completed / Not interested pill).
      if (outcomeFilter !== 'all' && r.last_note_outcome !== outcomeFilter) return false;

      // Date range — apply to completed_at, falling back to last_note_at.
      if (dateRange) {
        const stamp = r.completed_at || r.last_note_at;
        if (!stamp) return false;
        const t = new Date(stamp).getTime();
        if (Number.isNaN(t)) return false;
        if (t < new Date(dateRange.from).getTime() || t > new Date(dateRange.to).getTime()) return false;
      }

      // Webinar.
      if (webinarId && String(r.webinar_id || '') !== String(webinarId) &&
          String(r.last_call_id ? '' : '') !== String(webinarId)) {
        // r doesn't carry webinar_id directly — derive from webinar_name lookup
        const w = webinars.find(x => String(x.id) === String(webinarId));
        if (!w || w.name !== r.webinar_name) return false;
      }

      // TL — only keep rows whose caller is under the selected TL.
      if (tlFilter && r.caller_id && !callersForViewIds.has(r.caller_id)) return false;

      // Salesperson multi-select.
      if (salespeopleSel.size > 0 && !salespeopleSel.has(r.caller_id)) return false;

      // Categories (status + role of the caller — AND across groups, OR within).
      if (catStatuses.length > 0 || catRoles.length > 0) {
        const c = callersById.get(r.caller_id);
        if (!c) return false;
        if (catStatuses.length > 0) {
          const s = c.is_active === false ? 'paused' : 'active';
          if (!catStatuses.includes(s)) return false;
        }
        if (catRoles.length > 0 && !catRoles.includes(c.role)) return false;
      }

      // Free-text search (kept from before).
      if (q) {
        const hay = `${r.full_name || ''} ${r.whatsapp_number || ''} ${r.caller_name || ''} ${r.email || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      // Per-column filters — select (multi-value) + text (substring).
      for (const [key, sel] of colSel) {
        const raw = r[key] == null || r[key] === '' ? '(blank)' : String(r[key]);
        if (sel.size > 0 && !sel.has(raw)) return false;
      }
      for (const [key, str] of colText) {
        const needle = String(str || '').trim().toLowerCase();
        if (!needle) continue;
        if (!String(r[key] || '').toLowerCase().includes(needle)) return false;
      }
      return true;
    });
  }, [rows, query, outcomeFilter, dateRange, webinarId, tlFilter, salespeopleSel, catStatuses, catRoles, callersById, callersForViewIds, webinars, colSel, colText]);

  /* Page slice — render only PAGE_SIZE rows at a time. Total page
     count + page indices are derived (not stored) so they always
     reflect the live filter state. */
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Whenever filters narrow `filtered` below the current page's start
  // index, snap back to page 0 so the user isn't staring at an empty
  // "page 5 of 2".
  useEffect(() => {
    if (page > 0 && page >= totalPages) setPage(0);
  }, [page, totalPages]);
  // Reset to page 1 whenever the filter inputs change — staying on
  // page 5 after typing a new search term is confusing.
  useEffect(() => {
    setPage(0);
  }, [query, outcomeFilter, dateRange, webinarId, tlFilter, salespeopleSel.size, categoriesSel.size, colSel, colText]);
  const pageStart  = page * PAGE_SIZE;
  const pageRows   = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  /* Unique values per filterable column — computed from the full rows
     list (NOT `filtered`) so the available options don't shrink as the
     user narrows other filters. Sorted by their display label. */
  const uniqueColValues = useMemo(() => {
    const map = {};
    for (const key of Object.keys(COLUMN_FILTERS)) {
      if (COLUMN_FILTERS[key].type !== 'select') continue;
      const seen = new Set();
      for (const r of rows) {
        const v = r[key] == null || r[key] === '' ? '(blank)' : String(r[key]);
        seen.add(v);
      }
      map[key] = Array.from(seen).sort((a, b) =>
        labelForColumnValue(key, a === '(blank)' ? '' : a)
          .localeCompare(labelForColumnValue(key, b === '(blank)' ? '' : b))
      );
    }
    return map;
  }, [rows]);

  /* CSV export — uses the currently-filtered rows. Columns mirror the
     table so what you see is what you download. */
  /* Bundle the column-filter props once so the JSX header row stays
     readable. Each <FilterableTh> needs the same handful of bits. */
  function filterProps() {
    return {
      openCol, setOpenCol,
      colSel, colText,
      onToggle: toggleColSel,
      onSetText: (k, v) => setColText(prev => {
        const n = new Map(prev);
        if (v) n.set(k, v); else n.delete(k);
        return n;
      }),
      onClear: clearCol,
      uniqueColValues,
    };
  }

  function exportCsv() {
    const cols = [
      ['Caller', r => r.caller_name || ''],
      ['Lead',   r => r.full_name || ''],
      ['Phone',  r => r.whatsapp_number ? `+91 ${r.whatsapp_number}` : ''],
      ['Outcome', r => OUTCOME_LABEL[r.last_note_outcome] || r.last_note_outcome || ''],
      ['Tag', r => r.lead_tag || ''],
      ['Subtag', r => SUBTAG_LABEL[r.last_note_outcome_subtag] || (r.last_note_outcome_subtag ? titleCase(r.last_note_outcome_subtag) : '')],
      ['Interested', r => fmt(r.last_note_interested, YESNO_LABEL) === '—' ? '' : fmt(r.last_note_interested, YESNO_LABEL)],
      ['Confirm Range', r => fmt(r.last_note_confirmed_range, RANGE_LABEL) === '—' ? '' : fmt(r.last_note_confirmed_range, RANGE_LABEL)],
      ['For', r => fmt(r.last_note_range_for, RANGE_FOR_LABEL) === '—' ? '' : fmt(r.last_note_range_for, RANGE_FOR_LABEL)],
      ['Age', r => r.last_note_patient_age || ''],
      ['HbA1c', r => fmt(r.last_note_hba1c, HBA1C_LABEL) === '—' ? '' : fmt(r.last_note_hba1c, HBA1C_LABEL)],
      ['Medicine', r => fmt(r.last_note_takes_medicine, YESNO_LABEL) === '—' ? '' : fmt(r.last_note_takes_medicine, YESNO_LABEL)],
      ['Working Professional', r => r.last_note_working_professional ? titleCase(r.last_note_working_professional) : ''],
      ['Location', r => r.last_note_location ? titleCase(r.last_note_location) : ''],
      ['Webinar Attended', r => fmt(r.last_note_webinar_attended, YESNO_LABEL) === '—' ? '' : fmt(r.last_note_webinar_attended, YESNO_LABEL)],
      ['Available for Webinar', r => fmt(r.last_note_available_for_webinar, YESNO_LABEL) === '—' ? '' : fmt(r.last_note_available_for_webinar, YESNO_LABEL)],
      ['Next Batch Joining', r => fmt(r.last_note_next_batch_joining, YESNO_LABEL) === '—' ? '' : fmt(r.last_note_next_batch_joining, YESNO_LABEL)],
      ['Note', r => r.last_note_text || ''],
      ['Webinar', r => r.webinar_name || ''],
      ['Completed at', r => fmtDate(r.completed_at || r.last_note_at)],
      ['Recording URL', r => r.last_call_recording_url || ''],
    ];
    const escape = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = cols.map(([h]) => escape(h)).join(',');
    const body = filtered.map(r => cols.map(([, fn]) => escape(fn(r))).join(','));
    const csv = [header, ...body].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url; a.download = `completed-calls-${stamp}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Filter bar — two rows per the latest UX pass:
            Row 1: date pills (Today / Custom) + outcome quick-pills
                   (All / Completed / Not interested / Incomplete).
            Row 2: search input + "{n} shown" + clear-column-filters
                   (conditional) + Refresh + Export CSV.
          The "All time" date pill was removed per product decision
          (admins should pick a window deliberately; Custom covers
          everything-since-X). */}
      <div style={{
        position: 'relative', zIndex: 60,
        display: 'flex', flexDirection: 'column', gap: 10,
        background: '#EFE9F7',
        borderRadius: 14,
        border: '1px solid rgba(139,92,246,0.15)',
        padding: '10px 14px',
        boxShadow: '0 8px 24px rgba(91,33,182,0.10)',
      }}>
        {/* Row 1 — date pills + outcome pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {[
            { id: 'today',  label: 'Today' },
            { id: 'custom', label: 'Custom' },
          ].map(p => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              style={pillBtn(preset === p.id)}
            >
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (() => {
            /* Styled CRM date-range picker — mirrors the one in
               SalesPerformanceView so both tabs feel identical. Two
               clickable From / To boxes that open a single calendar
               popup; range selection inside the popup behaves
               first-click=From, second-click=To with auto-swap if
               the user clicks an earlier day second. */
            const pad   = n => String(n).padStart(2, '0');
            const toYMD = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
            const parseYMD = s => {
              if (!s) return null;
              const [y, m, d] = s.split('-').map(Number);
              return new Date(y, m - 1, d);
            };
            const fromDate = parseYMD(customFrom);
            const toDate   = parseYMD(customTo);
            const MONTH_NAMES = ['January','February','March','April','May','June',
                                  'July','August','September','October','November','December'];
            const DOW = ['Mo','Tu','We','Th','Fr','Sa','Su'];
            const year  = customMonth.year;
            const month = customMonth.month;
            // 6×7 day grid, week starts Monday.
            const firstOfMonth = new Date(year, month, 1);
            const lastOfMonth  = new Date(year, month + 1, 0);
            const daysInMonth  = lastOfMonth.getDate();
            const firstWeekdayMon = (firstOfMonth.getDay() + 6) % 7;
            const prevMonthDays = new Date(year, month, 0).getDate();
            const cells = [];
            for (let i = 0; i < firstWeekdayMon; i++) {
              const d = prevMonthDays - firstWeekdayMon + 1 + i;
              cells.push({ day: d, inMonth: false, date: new Date(year, month - 1, d) });
            }
            for (let d = 1; d <= daysInMonth; d++) {
              cells.push({ day: d, inMonth: true, date: new Date(year, month, d) });
            }
            while (cells.length < 42) {
              const d = cells.length - (firstWeekdayMon + daysInMonth) + 1;
              cells.push({ day: d, inMonth: false, date: new Date(year, month + 1, d) });
            }
            const sameYMD = (a, b) => a && b
              && a.getFullYear() === b.getFullYear()
              && a.getMonth() === b.getMonth()
              && a.getDate() === b.getDate();
            const isInRange = d => fromDate && toDate && d > fromDate && d < toDate;

            function pickDay(d) {
              const ymd = toYMD(d);
              if (!customFrom || (customFrom && customTo)) {
                setCustomFrom(ymd);
                setCustomTo('');
                return;
              }
              if (ymd < customFrom) {
                setCustomTo(customFrom);
                setCustomFrom(ymd);
              } else {
                setCustomTo(ymd);
              }
            }

            const fromLabel = customFrom || 'From date';
            const toLabel   = customTo   || 'To date';
            const boxStyle = (active) => ({
              height: '2.1rem', padding: '0 12px',
              border: '1px solid ' + (active ? '#5B21B6' : 'rgba(139,92,246,0.25)'),
              borderRadius: 10, background: '#fff',
              fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
              color: active ? '#3B0764' : 'rgba(91,33,182,0.55)',
              cursor: 'pointer', fontWeight: 700,
              display: 'inline-flex', alignItems: 'center', gap: 8,
              minWidth: 140, whiteSpace: 'nowrap',
              boxShadow: active && customRangeOpen ? '0 0 0 2px rgba(91,33,182,0.18)' : 'none',
            });
            const calIcon = (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <rect x="3" y="4" width="18" height="18" rx="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            );

            // Reusable time input row (HH : MM AM/PM). `value` is the
            // {hh, mm, ampm} state, `onChange` receives the updated
            // shallow-merged object. Kept inline so the picker stays
            // self-contained in this branch.
            function TimeRow({ label, value, onChange }) {
              const inputStyle = {
                width: 32, height: 24, borderRadius: 6,
                border: '1px solid rgba(139,92,246,0.25)', textAlign: 'center',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.74rem', fontWeight: 700,
                color: '#3B0764', outline: 'none',
              };
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  <span style={{ fontSize: '0.66rem', fontWeight: 700, color: 'rgba(91,33,182,0.65)', minWidth: 36 }}>{label}</span>
                  <input type="text" inputMode="numeric" maxLength={2} value={value.hh}
                    onChange={e => onChange({ ...value, hh: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                    style={inputStyle}/>
                  <span style={{ fontWeight: 800, color: '#5B21B6', fontSize: '0.78rem' }}>:</span>
                  <input type="text" inputMode="numeric" maxLength={2} value={value.mm}
                    onChange={e => onChange({ ...value, mm: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                    style={inputStyle}/>
                  <div style={{
                    display: 'inline-flex', borderRadius: 6, overflow: 'hidden',
                    border: '1px solid rgba(139,92,246,0.25)',
                  }}>
                    {['AM','PM'].map(p => {
                      const active = value.ampm === p;
                      return (
                        <button key={p} type="button"
                          onClick={() => onChange({ ...value, ampm: p })}
                          style={{
                            height: 24, padding: '0 8px', border: 'none', cursor: 'pointer',
                            background: active ? '#5B21B6' : '#fff',
                            color: active ? '#fff' : 'rgba(91,33,182,0.65)',
                            fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.64rem',
                          }}>{p}</button>
                      );
                    })}
                  </div>
                  <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'rgba(91,33,182,0.45)' }}>IST</span>
                </div>
              );
            }

            return (
              <div ref={customRangeRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <button type="button" onClick={() => setCustomRangeOpen(o => !o)} style={boxStyle(!!customFrom)} title="Pick start date">
                  {calIcon}<span style={{ flex: 1 }}>{fromLabel}</span>
                </button>
                <span style={{ color: 'rgba(91,33,182,0.45)', fontWeight: 700, fontSize: '0.82rem' }}>→</span>
                <button type="button" onClick={() => setCustomRangeOpen(o => !o)} style={boxStyle(!!customTo)} title="Pick end date">
                  {calIcon}<span style={{ flex: 1 }}>{toLabel}</span>
                </button>

                {customRangeOpen && (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 6px)', left: 0,
                    width: 300, background: '#fff', borderRadius: 14,
                    boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
                    border: '1px solid rgba(209,196,240,0.55)',
                    padding: 12, zIndex: 80,
                    fontFamily: 'Outfit, sans-serif',
                  }}>
                    {/* Month header */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <button type="button"
                        onClick={() => setCustomMonth(({ year: y, month: m }) =>
                          m === 0 ? { year: y - 1, month: 11 } : { year: y, month: m - 1 })}
                        style={{
                          width: 26, height: 26, borderRadius: 8,
                          border: '1px solid rgba(139,92,246,0.20)',
                          background: 'rgba(91,33,182,0.04)', cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }} aria-label="Previous month">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="15 18 9 12 15 6"/>
                        </svg>
                      </button>
                      <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.82rem' }}>
                        {MONTH_NAMES[month]} {year}
                      </div>
                      <button type="button"
                        onClick={() => setCustomMonth(({ year: y, month: m }) =>
                          m === 11 ? { year: y + 1, month: 0 } : { year: y, month: m + 1 })}
                        style={{
                          width: 26, height: 26, borderRadius: 8,
                          border: '1px solid rgba(139,92,246,0.20)',
                          background: 'rgba(91,33,182,0.04)', cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }} aria-label="Next month">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                      </button>
                    </div>

                    {/* Day-of-week row */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 2 }}>
                      {DOW.map(d => (
                        <div key={d} style={{
                          textAlign: 'center', fontSize: '0.58rem', fontWeight: 700,
                          color: 'rgba(91,33,182,0.55)', padding: '2px 0',
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                        }}>{d}</div>
                      ))}
                    </div>

                    {/* Day grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
                      {cells.map((c, i) => {
                        const isFrom    = sameYMD(c.date, fromDate);
                        const isTo      = sameYMD(c.date, toDate);
                        const inBetween = isInRange(c.date);
                        const isEdge    = isFrom || isTo;
                        return (
                          <button key={i} type="button"
                            onClick={() => pickDay(c.date)}
                            style={{
                              height: 28, border: 'none', cursor: 'pointer',
                              borderRadius: 8,
                              background:
                                isTo ? '#5B21B6' :
                                isFrom ? 'rgba(91,33,182,0.08)' :
                                inBetween ? 'rgba(91,33,182,0.10)' : 'transparent',
                              color:
                                isTo ? '#fff' :
                                c.inMonth ? '#3B0764' : 'rgba(91,33,182,0.30)',
                              fontFamily: 'Outfit, sans-serif',
                              fontWeight: isEdge ? 700 : 600,
                              fontSize: '0.74rem',
                              textDecoration: !c.inMonth ? 'line-through' : 'none',
                              outline: isFrom && !isTo ? '2px solid #5B21B6' : 'none',
                              outlineOffset: '-2px',
                              transition: 'background 120ms',
                            }}
                            onMouseEnter={e => {
                              if (!isEdge && !inBetween) e.currentTarget.style.background = 'rgba(91,33,182,0.06)';
                            }}
                            onMouseLeave={e => {
                              if (!isEdge && !inBetween) e.currentTarget.style.background = 'transparent';
                            }}
                          >{c.day}</button>
                        );
                      })}
                    </div>

                    <div style={{ height: 1, background: 'rgba(209,196,240,0.55)', margin: '10px 0' }} />

                    {/* Time rows — FROM and TO independent */}
                    <TimeRow label="From"   value={customFromTime} onChange={setCustomFromTime} />
                    <div style={{ height: 6 }} />
                    <TimeRow label="To"     value={customToTime}   onChange={setCustomToTime} />

                    {/* Done button */}
                    <button type="button"
                      onClick={() => setCustomRangeOpen(false)}
                      style={{
                        marginTop: 12,
                        width: '100%', height: 32, borderRadius: 10,
                        background: '#5B21B6', color: '#fff', border: 'none',
                        fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.78rem',
                        cursor: 'pointer', letterSpacing: '0.02em',
                        boxShadow: '0 3px 10px rgba(91,33,182,0.25)',
                      }}>Done</button>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Outcome quick-pills (All / Completed / Not interested /
              Incomplete) removed per UX cleanup — the per-column Outcome
              header funnel covers the same multi-select use case with
              less duplicated control surface. The outcomeFilter state
              stays at its default 'all' so the filter useMemo
              short-circuits (no narrowing). */}
        </div>

        {/* Row 2 — search + counter + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Search input grows to fill row 2; actions sit on the right */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, phone, caller…"
            style={{
              flex: '1 1 260px',
              height: '2.1rem', padding: '0 14px', borderRadius: 50,
              border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
              fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem', color: '#3B0764',
              outline: 'none', minWidth: 200,
            }}
          />

          <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)', whiteSpace: 'nowrap' }}>
            {filtered.length} shown
          </span>

          {colFiltersActive > 0 && (
            <button
              onClick={clearAllColFilters}
              title="Clear every column-header filter"
              style={{
                height: '2.1rem', padding: '0 12px', borderRadius: 50,
                border: '1px solid rgba(220,38,38,0.30)',
                background: 'rgba(254,242,242,0.85)',
                color: '#B91C1C',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.76rem', fontWeight: 700,
                cursor: 'pointer', whiteSpace: 'nowrap',
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}
            >
              ✕ Clear {colFiltersActive} column filter{colFiltersActive === 1 ? '' : 's'}
            </button>
          )}

          <button onClick={load} style={actionBtn}>↻ Refresh</button>
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            style={{
              ...actionBtn,
              cursor: filtered.length === 0 ? 'not-allowed' : 'pointer',
              opacity: filtered.length === 0 ? 0.5 : 1,
            }}
          >⤓ Export CSV</button>
        </div>

        {/* Row 2 — Categories / Webinar / TL / Salesperson dropdowns
            were removed per product decision. Per-column funnels in the
            table header now own the multi-axis filtering UI (cleaner +
            less duplicated control surface). Backing state and the
            global-filter useMemo branches are intentionally left in
            place: they're harmless when their state stays at the
            initial empty values, and dropping them would invalidate
            the useMemo dep array. */}
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '10px 14px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#DC2626', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Table card — uses the same shell + styling vocabulary as
          UsersModule.jsx (the canonical CRM table) so this view feels
          native rather than bolted-on. Horizontally scrollable inner
          div handles the ~22 columns at narrow widths. */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem' }}>
            Loading completed calls…
          </div>
        ) : filtered.length === 0 ? (
          /* Two distinct empty-states so admins don't think the DB is empty
             when really the filter just hides historical notes:
               • rows.length === 0 → no completed leads exist at all yet.
               • rows.length  > 0 → leads exist, current filters hide them.
                                    Most common cause is the default "Today"
                                    date preset. */
          rows.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit, sans-serif' }}>
              <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>
                No completed calls
              </div>
              <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem' }}>
                When a caller saves a note with outcome <b>Completed</b> or <b>Not Interested</b>, it'll land here.
              </div>
            </div>
          ) : (
            <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit, sans-serif' }}>
              <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>
                No completed calls match the current filters
              </div>
              <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem', marginBottom: 14 }}>
                {preset === 'today'
                  ? <>Showing <b>today</b> only. Switch to <b>Custom</b> and widen the date range to see earlier completed calls.</>
                  : <>Try clearing search / column filters or widening the date range.</>}
                <br />
                <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.45)' }}>
                  {rows.length} completed call{rows.length === 1 ? '' : 's'} loaded from the backend in total.
                </span>
              </div>
              {preset === 'today' && (
                <button
                  type="button"
                  onClick={() => setPreset('custom')}
                  style={{
                    padding: '8px 18px', borderRadius: 10, border: 'none',
                    background: '#5B21B6', color: '#fff',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
                    cursor: 'pointer', boxShadow: '0 4px 14px rgba(91,33,182,0.32)',
                  }}
                >
                  Switch to Custom range
                </button>
              )}
            </div>
          )
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead ref={headerRef}>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <th style={thStyle}>#</th>
                  <FilterableTh label="Caller"               colKey="caller_name"                    {...filterProps()} />
                  <th style={thStyle}>Lead</th>
                  <th style={thStyle}>Phone</th>
                  <FilterableTh label="Outcome"              colKey="last_note_outcome"               {...filterProps()} />
                  <FilterableTh label="Tag"                  colKey="lead_tag"                        {...filterProps()} />
                  <FilterableTh label="Subtag"               colKey="last_note_outcome_subtag"        {...filterProps()} />
                  <FilterableTh label="Interested"           colKey="last_note_interested"            {...filterProps()} />
                  <FilterableTh label="Confirm Range"        colKey="last_note_confirmed_range"       {...filterProps()} />
                  <FilterableTh label="For"                  colKey="last_note_range_for"             {...filterProps()} />
                  <FilterableTh label="Age"                  colKey="last_note_patient_age"           {...filterProps()} />
                  <FilterableTh label="HbA1c"                colKey="last_note_hba1c"                 {...filterProps()} />
                  <FilterableTh label="Medicine"             colKey="last_note_takes_medicine"        {...filterProps()} />
                  <FilterableTh label="Working Pro."         colKey="last_note_working_professional"  {...filterProps()} />
                  <FilterableTh label="Location"             colKey="last_note_location"              {...filterProps()} />
                  <FilterableTh label="Webinar Attended"     colKey="last_note_webinar_attended"      {...filterProps()} />
                  <FilterableTh label="Available for Webinar"colKey="last_note_available_for_webinar" {...filterProps()} />
                  <FilterableTh label="Next Batch Joining"   colKey="last_note_next_batch_joining"    {...filterProps()} />
                  <FilterableTh label="Note"                 colKey="last_note_text"                  {...filterProps()} />
                  <FilterableTh label="Webinar"              colKey="webinar_name"                    {...filterProps()} />
                  <th style={thStyle}>Completed at</th>
                  <th style={thStyle}>Recording</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, _localIdx) => {
                  // i = absolute row index across the entire filtered set
                  // so the "#" column stays continuous across pages
                  // (page 2 starts at 11, not 1).
                  const i = pageStart + _localIdx;
                  // Incomplete outcome overrides the lead_tag display —
                  // the caller never reached the classifier, so any
                  // stored lead_tag (usually NULL) is meaningless; we
                  // surface the abandonment with an explicit INCOMPLETE
                  // pill instead.
                  const isIncomplete = r.last_note_outcome === 'incomplete';
                  const tagKey       = isIncomplete ? 'INCOMPLETE' : r.lead_tag;
                  const tag          = tagKey ? TAG_STYLE[tagKey] : null;
                  const tagLabel     = isIncomplete ? 'INCOMPLETE' : r.lead_tag;
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
                      <td style={{ ...tdStyle, color: 'rgba(91,33,182,0.50)' }}>{i + 1}</td>
                      <td style={tdStyle}>
                        {r.caller_name || <span style={mutedStyle}>unassigned</span>}
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 600, color: '#3B0764' }}>{r.full_name || '—'}</span>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace' }}>
                        {r.whatsapp_number ? `+91 ${r.whatsapp_number}` : '—'}
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          ...pillStyle,
                          background: r.last_note_outcome === 'completed'  ? 'rgba(22,163,74,0.12)'
                                    : r.last_note_outcome === 'incomplete' ? 'rgba(245,158,11,0.18)'
                                    : 'rgba(220,38,38,0.10)',
                          color:      r.last_note_outcome === 'completed'  ? '#15803D'
                                    : r.last_note_outcome === 'incomplete' ? '#92400E'
                                    : '#B91C1C',
                        }}>
                          {OUTCOME_LABEL[r.last_note_outcome] || r.last_note_outcome || '—'}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        {tag
                          ? <span style={{ ...pillStyle, background: tag.bg, color: tag.fg }}>{tagLabel}</span>
                          : <span style={mutedStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        {r.last_note_outcome_subtag
                          ? <span style={{
                              ...pillStyle,
                              background: 'rgba(91,33,182,0.08)', color: '#5B21B6',
                              border: '1px solid rgba(91,33,182,0.18)',
                            }}>{SUBTAG_LABEL[r.last_note_outcome_subtag] || titleCase(r.last_note_outcome_subtag)}</span>
                          : <span style={mutedStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>{fmt(r.last_note_interested, YESNO_LABEL)}</td>
                      <td style={tdStyle}>{fmt(r.last_note_confirmed_range, RANGE_LABEL)}</td>
                      <td style={tdStyle}>{fmt(r.last_note_range_for, RANGE_FOR_LABEL)}</td>
                      <td style={tdStyle}>{r.last_note_patient_age || <span style={mutedStyle}>—</span>}</td>
                      <td style={tdStyle}>{fmt(r.last_note_hba1c, HBA1C_LABEL)}</td>
                      <td style={tdStyle}>{fmt(r.last_note_takes_medicine, YESNO_LABEL)}</td>
                      <td style={tdStyle}>
                        {r.last_note_working_professional ? titleCase(r.last_note_working_professional) : <span style={mutedStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        {r.last_note_location ? titleCase(r.last_note_location) : <span style={mutedStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>{fmt(r.last_note_webinar_attended, YESNO_LABEL)}</td>
                      <td style={tdStyle}>{fmt(r.last_note_available_for_webinar, YESNO_LABEL)}</td>
                      <td style={tdStyle}>{fmt(r.last_note_next_batch_joining, YESNO_LABEL)}</td>
                      <td style={{
                        // Wide Note column — short notes stay on one line,
                        // long notes wrap up to ~480 px before line-breaking
                        // (instead of the previous 280 px which crammed any
                        // 5+ word note into a 6-line vertical sliver).
                        ...tdStyle,
                        whiteSpace: 'normal',
                        minWidth: 280,
                        maxWidth: 480,
                        color: 'rgba(59,7,100,0.85)',
                        fontSize: '0.80rem',
                        lineHeight: 1.4,
                      }}>
                        {r.last_note_text || <span style={mutedStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>{r.webinar_name || <span style={mutedStyle}>—</span>}</td>
                      <td style={{ ...tdStyle, fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)' }}>
                        {fmtDate(r.completed_at || r.last_note_at)}
                      </td>
                      <td style={tdStyle}>
                        {r.last_call_recording_url && r.last_call_id ? (
                          <RecordingPlayer
                            src={`/api/caller/recordings/${r.last_call_id}?token=${encodeURIComponent(token)}`}
                          />
                        ) : (
                          <span style={{ ...mutedStyle, fontStyle: 'italic' }}>No recording</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination footer — fixed 10 rows per page. Hidden if
                the entire filtered result fits on one page (≤10 rows). */}
            {totalPages > 1 && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, padding: '12px 16px',
                borderTop: '1px solid rgba(209,196,240,0.40)',
                background: 'rgba(237,234,248,0.30)',
                fontFamily: 'Outfit, sans-serif',
              }}>
                <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)', fontWeight: 600 }}>
                  Showing <b style={{ color: '#3B0764' }}>{pageStart + 1}</b>
                  {' – '}
                  <b style={{ color: '#3B0764' }}>{Math.min(pageStart + PAGE_SIZE, filtered.length)}</b>
                  {' of '}
                  <b style={{ color: '#3B0764' }}>{filtered.length}</b>
                </span>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    aria-label="Previous page"
                    title="Previous page"
                    style={{
                      width: 34, height: 34, borderRadius: 10,
                      background: page === 0 ? 'rgba(91,33,182,0.06)' : '#fff',
                      color: page === 0 ? 'rgba(91,33,182,0.30)' : '#5B21B6',
                      cursor: page === 0 ? 'not-allowed' : 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      border: '1px solid ' + (page === 0 ? 'rgba(139,92,246,0.10)' : 'rgba(139,92,246,0.25)'),
                      boxShadow: page === 0 ? 'none' : '0 1px 3px rgba(91,33,182,0.10)',
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 18 9 12 15 6"/>
                    </svg>
                  </button>

                  <span style={{
                    minWidth: 90, textAlign: 'center',
                    fontSize: '0.80rem', color: '#3B0764', fontWeight: 700,
                  }}>
                    Page {page + 1} of {totalPages}
                  </span>

                  <button
                    type="button"
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    aria-label="Next page"
                    title="Next page"
                    style={{
                      width: 34, height: 34, borderRadius: 10,
                      background: page >= totalPages - 1 ? 'rgba(91,33,182,0.06)' : '#5B21B6',
                      color: page >= totalPages - 1 ? 'rgba(91,33,182,0.30)' : '#fff',
                      cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      border: 'none',
                      boxShadow: page >= totalPages - 1 ? 'none' : '0 2px 6px rgba(91,33,182,0.30)',
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* Shared table styling — mirrors the constants in UsersModule.jsx so
   this table looks native alongside the rest of the CRM. Kept inline
   here (rather than imported) so the module stays self-contained. */
const thStyle = {
  padding: '12px 16px',
  fontSize: '0.74rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'rgba(91,33,182,0.60)',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '14px 16px',
  fontSize: '0.86rem',
  color: '#3B0764',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};

const pillStyle = {
  display: 'inline-block',
  padding: '3px 10px',
  borderRadius: 50,
  fontSize: '0.70rem',
  fontWeight: 700,
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
};

const mutedStyle = {
  color: 'rgba(91,33,182,0.45)',
  fontSize: '0.82rem',
};

/* ──────────────────────────────────────────────────────────────────────
   Filter bar primitives — small inline-styled helpers used by the
   Row-1 / Row-2 toolbar. Kept local to this file so the component is
   self-contained; mirrors the look used in SalesPerformanceView.
   ────────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────────────
   FilterableTh — header cell with an inline funnel-icon button that
   opens a popover with a multi-select (or text input) filter for that
   column. The configuration lives in COLUMN_FILTERS at module scope.
   Active filters tint the icon purple + show a tiny count badge so the
   admin can spot what's narrowing the table at a glance.
   ────────────────────────────────────────────────────────────────────── */
function FilterableTh({
  label, colKey,
  openCol, setOpenCol,
  colSel, colText,
  onToggle, onSetText, onClear,
  uniqueColValues,
}) {
  const cfg = COLUMN_FILTERS[colKey];
  if (!cfg) return <th style={thStyle}>{label}</th>;

  const isOpen   = openCol === colKey;
  const selected = colSel.get(colKey);
  const textVal  = colText.get(colKey) || '';
  const active   = (cfg.type === 'select' ? (selected && selected.size > 0) : !!textVal);

  return (
    <th style={{ ...thStyle, position: 'relative' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {label}
        <button
          type="button"
          onClick={() => setOpenCol(isOpen ? null : colKey)}
          title={active ? `${cfg.label} filter active — click to edit` : `Filter by ${cfg.label}`}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 6, border: 'none',
            background: active ? '#5B21B6' : 'rgba(91,33,182,0.10)',
            color: active ? '#fff' : 'rgba(91,33,182,0.65)',
            cursor: 'pointer', transition: 'background 120ms',
            position: 'relative',
          }}
        >
          {/* Funnel icon */}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
          {active && cfg.type === 'select' && selected.size > 0 && (
            <span style={{
              position: 'absolute', top: -4, right: -4,
              minWidth: 14, height: 14, padding: '0 3px', borderRadius: 50,
              background: '#DC2626', color: '#fff',
              fontSize: '0.56rem', fontWeight: 800, lineHeight: '14px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>{selected.size}</span>
          )}
        </button>
      </span>

      {isOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 8,
            minWidth: cfg.type === 'text' ? 220 : 240,
            maxHeight: 360, overflowY: 'auto',
            background: '#fff', borderRadius: 10,
            border: '1px solid rgba(209,196,240,0.60)',
            boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
            padding: 8, zIndex: 100,
            fontFamily: 'Outfit, sans-serif',
            textTransform: 'none', letterSpacing: 0,
            color: '#3B0764', fontWeight: 500,
          }}
        >
          <div style={{
            padding: '4px 6px 8px', fontSize: '0.66rem', fontWeight: 800,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'rgba(91,33,182,0.55)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Filter by {cfg.label}</span>
            {active && (
              <button
                onClick={() => onClear(colKey)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#DC2626', fontFamily: 'Outfit, sans-serif',
                  fontWeight: 800, fontSize: '0.62rem', letterSpacing: '0.06em',
                }}
              >Clear</button>
            )}
          </div>

          {cfg.type === 'text' ? (
            <input
              type="search"
              autoFocus
              value={textVal}
              onChange={(e) => onSetText(colKey, e.target.value)}
              placeholder={`Search ${cfg.label.toLowerCase()}…`}
              style={{
                width: '100%', height: '2.2rem', padding: '0 12px',
                borderRadius: 8, border: '1px solid rgba(209,196,240,0.6)',
                background: 'rgba(237,234,248,0.30)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
                color: '#3B0764', outline: 'none', boxSizing: 'border-box',
              }}
            />
          ) : (
            <div>
              {(uniqueColValues[colKey] || []).length === 0 ? (
                <div style={{
                  padding: '12px 6px', textAlign: 'center', fontSize: '0.78rem',
                  color: 'rgba(91,33,182,0.55)', fontStyle: 'italic',
                }}>
                  No values yet
                </div>
              ) : (uniqueColValues[colKey] || []).map(v => {
                const checked = selected ? selected.has(v) : false;
                const display = labelForColumnValue(colKey, v === '(blank)' ? '' : v);
                return (
                  <label
                    key={v}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                      background: checked ? 'rgba(91,33,182,0.10)' : 'transparent',
                      fontSize: '0.82rem', fontWeight: checked ? 700 : 500,
                      color: v === '(blank)' ? 'rgba(91,33,182,0.55)' : '#3B0764',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(colKey, v)}
                      style={{ accentColor: '#5B21B6' }}
                    />
                    {v === '(blank)' ? <i>(blank)</i> : display}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </th>
  );
}

function LabeledField({ label, children }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)' }}>{label}</span>
      {children}
    </div>
  );
}

function Chev({ open }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{
        position: 'absolute', right: 10, top: '50%',
        transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
        transition: 'transform 200ms',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function PanelHeaderClear({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left',
        padding: '8px 10px', borderRadius: 6, border: 'none',
        background: active ? 'rgba(91,33,182,0.10)' : 'transparent',
        color: active ? '#5B21B6' : 'rgba(59,7,100,0.85)',
        fontWeight: active ? 700 : 600, fontSize: '0.82rem',
        cursor: 'pointer',
        borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4,
      }}
    >
      {children}
    </button>
  );
}

function GroupTitle({ children }) {
  return (
    <div style={{
      padding: '6px 10px 4px', fontSize: '0.62rem', fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.10em',
      color: 'rgba(91,33,182,0.55)',
    }}>{children}</div>
  );
}

function CheckRow({ checked, onClick, label }) {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
        background: checked ? 'rgba(91,33,182,0.06)' : 'transparent',
        fontSize: '0.84rem', color: '#3B0764', fontWeight: checked ? 700 : 500,
      }}
    >
      <input type="checkbox" checked={checked} onChange={onClick} style={{ accentColor: '#5B21B6' }} />
      {label}
    </label>
  );
}

function SelectRow({ active, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left',
        padding: '8px 10px', borderRadius: 6, border: 'none',
        background: active ? 'rgba(91,33,182,0.10)' : 'transparent',
        color: active ? '#5B21B6' : 'rgba(59,7,100,0.85)',
        fontWeight: active ? 700 : 600, fontSize: '0.82rem',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function EmptyMsg({ children }) {
  return (
    <div style={{
      padding: '12px 10px', textAlign: 'center', fontSize: '0.78rem',
      color: 'rgba(91,33,182,0.55)', fontStyle: 'italic',
    }}>
      {children}
    </div>
  );
}

/* Inline-style helpers */
function pillBtn(active) {
  return {
    height: '2.1rem', padding: '0 18px', borderRadius: 50,
    border: 'none',
    background: active ? '#5B21B6' : 'rgba(255,255,255,0.65)',
    color: active ? '#fff' : 'rgba(91,33,182,0.65)',
    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.80rem',
    cursor: 'pointer',
    boxShadow: active ? '0 2px 10px rgba(91,33,182,0.25)' : 'none',
    transition: 'all 200ms',
  };
}
function triggerBtn(open, bgOverride) {
  return {
    height: '2.1rem', padding: '0 32px 0 12px', borderRadius: 10,
    border: '1px solid rgba(139,92,246,0.25)',
    background: bgOverride || '#fff',
    fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#3B0764',
    cursor: 'pointer', minWidth: 140, textAlign: 'left',
    position: 'relative',
    outline: open ? '2px solid rgba(91,33,182,0.15)' : 'none',
  };
}
function popoverPanel(minWidth) {
  return {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
    minWidth, maxHeight: 320, overflowY: 'auto',
    background: '#fff', borderRadius: 10,
    border: '1px solid rgba(209,196,240,0.60)',
    boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
    padding: 6, zIndex: 50,
    fontFamily: 'Outfit, sans-serif',
  };
}
const actionBtn = {
  height: '2.1rem', padding: '0 14px', borderRadius: 10,
  border: '1px solid rgba(91,33,182,0.25)', background: '#fff',
  color: '#5B21B6', fontFamily: 'Outfit, sans-serif',
  fontSize: '0.80rem', fontWeight: 700, cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const dateInput = {
  height: '2.1rem', padding: '0 10px', borderRadius: 8,
  border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
  fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem', color: '#3B0764',
  outline: 'none',
};

/* ── RecordingPlayer ─────────────────────────────────────────────────
   Custom CRM-themed audio player replacing the browser-native
   <audio controls> in the RECORDING column of Completed Calls.

   Design goals:
     • Match the rest of the CRM — purple (#5B21B6) primary, lavender
       (#EDE9FE) surface, Outfit font, rounded pill shape.
     • Compact enough to fit a table cell (~270px wide).
     • Lazy network: preload="none" so the proxy URL isn't hit until
       the user actually presses play.
     • Single-at-a-time playback — module-level ref pauses whatever
       was previously playing the moment a new player starts. The
       browser's native control did this implicitly; we replicate it.
     • Clickable scrubber for seeking, Mute toggle, mm:ss / mm:ss
       time read-out.

   Not implemented (intentional, keeps the cell compact):
     • Playback rate (0.5×/1×/2×) — admins rarely re-listen
     • Download button — admins can right-click → Save audio as…
     • Volume slider — single mute toggle covers 95% of needs
*/

// Module-level "currently playing" tracker. Set by every player on
// play; cleared on pause / end. When player A starts, it pauses
// whatever player B was playing first.
let _mhsCurrentlyPlayingAudio = null;

function RecordingPlayer({ src }) {
  const audioRef = useRef(null);
  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [muted,       setMuted]       = useState(false);
  const [loaded,      setLoaded]      = useState(false);
  const [errored,     setErrored]     = useState(false);

  function fmt(t) {
    if (!Number.isFinite(t) || t < 0) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a || errored) return;
    if (a.paused) {
      // Pause any other currently-playing recording first.
      try {
        if (_mhsCurrentlyPlayingAudio && _mhsCurrentlyPlayingAudio !== a) {
          _mhsCurrentlyPlayingAudio.pause();
        }
        _mhsCurrentlyPlayingAudio = a;
      } catch { /* ignore */ }
      a.play().catch(() => setErrored(true));
    } else {
      a.pause();
    }
  }

  function toggleMute() {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
    setMuted(a.muted);
  }

  function onScrubClick(e) {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = pct * duration;
    setCurrentTime(a.currentTime);
  }

  // Clean up the module-level ref if this player unmounts mid-playback
  // (e.g. user navigates away or the table re-renders).
  useEffect(() => () => {
    if (_mhsCurrentlyPlayingAudio === audioRef.current) {
      _mhsCurrentlyPlayingAudio = null;
    }
  }, []);

  const progressPct = (duration > 0 ? (currentTime / duration) : 0) * 100;

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      padding: '4px 10px 4px 4px',
      background: 'rgba(237,233,254,0.55)',
      border: '1px solid rgba(139,92,246,0.20)',
      borderRadius: 50,
      minWidth: 240, maxWidth: 280,
    }}>
      <audio
        ref={audioRef}
        src={src}
        preload="none"
        onLoadedMetadata={e => { setDuration(e.target.duration || 0); setLoaded(true); }}
        onTimeUpdate={e => setCurrentTime(e.target.currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
          if (_mhsCurrentlyPlayingAudio === audioRef.current) _mhsCurrentlyPlayingAudio = null;
        }}
        onError={() => setErrored(true)}
        style={{ display: 'none' }}
      />

      {/* Play / Pause */}
      <button
        type="button"
        onClick={togglePlay}
        disabled={errored}
        title={errored ? 'Recording unavailable' : (playing ? 'Pause' : 'Play')}
        style={{
          width: 28, height: 28, borderRadius: '50%',
          border: 'none',
          background: errored
            ? 'rgba(220,38,38,0.30)'
            : (playing ? 'linear-gradient(135deg,#7C3AED,#5B21B6)' : '#5B21B6'),
          color: '#fff',
          cursor: errored ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          boxShadow: errored ? 'none' : '0 2px 6px rgba(91,33,182,0.30)',
        }}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
      >
        {playing ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1"/>
            <rect x="14" y="5" width="4" height="14" rx="1"/>
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        )}
      </button>

      {/* Time read-out — mm:ss / mm:ss */}
      <span style={{
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: '0.72rem', fontWeight: 700,
        color: '#3B0764',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        minWidth: 64,
      }}>
        {errored
          ? <span style={{ color: '#B91C1C', fontWeight: 700 }}>Error</span>
          : (loaded || playing ? fmt(currentTime) + ' / ' + fmt(duration) : '--:--')
        }
      </span>

      {/* Scrubber / progress bar */}
      <div
        onClick={onScrubClick}
        style={{
          flex: 1, height: 6, borderRadius: 50,
          background: 'rgba(139,92,246,0.20)',
          position: 'relative',
          cursor: duration > 0 ? 'pointer' : 'default',
          minWidth: 50,
        }}
        title="Click to seek"
      >
        <div style={{
          width: progressPct + '%',
          height: '100%', borderRadius: 50,
          background: 'linear-gradient(90deg,#7C3AED,#5B21B6)',
          transition: 'width 80ms linear',
          pointerEvents: 'none',
        }} />
        {/* Thumb circle on the progress edge */}
        {progressPct > 0 && progressPct < 100 && (
          <div style={{
            position: 'absolute',
            left: 'calc(' + progressPct + '% - 5px)',
            top: -2,
            width: 10, height: 10, borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 0 0 2px #5B21B6',
            pointerEvents: 'none',
          }} />
        )}
      </div>

      {/* Mute toggle */}
      <button
        type="button"
        onClick={toggleMute}
        title={muted ? 'Unmute' : 'Mute'}
        style={{
          width: 22, height: 22, borderRadius: 6,
          border: 'none',
          background: 'transparent',
          color: '#5B21B6',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          padding: 0,
        }}
        aria-label={muted ? 'Unmute recording' : 'Mute recording'}
      >
        {muted ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <line x1="23" y1="9" x2="17" y2="15"/>
            <line x1="17" y1="9" x2="23" y2="15"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>
        )}
      </button>
    </div>
  );
}
