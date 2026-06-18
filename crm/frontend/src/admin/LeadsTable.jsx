import { useEffect, useState, useCallback, useRef } from 'react';
import DateTimePicker from './DateTimePicker';
import SourceBadge from '../components/SourceBadge';
import AddLeadsModal from './AddLeadsModal';
import Loading from '../components/Loading';
import { isMetaTempLike } from '../utils/workspaceFlags';

const DURATION_LABELS = { new: '< 1 yr', mid: '1–5 yrs', long: '5+ yrs', pre: 'Pre-diabetic' };
const SUGAR_LABELS    = { '150-250': '150–250', '250+': '250+' };
const LANG_LABELS     = { tamil: 'Tamil', english: 'English' };
const MEDICATION_LABELS = { insulin: 'Insulin', tablets: 'Tablets', none: 'None' };
const OCCUPATION_LABELS = { working: 'Working', housewife: 'Housewife', retired: 'Retired' };
// age_group column holds two different shapes: the old age-bucket
// ('35-45' / '45-55' / '55+') from the YT funnel, and the new Tamil
// yes/no answer ('yes' / 'no') from the Meta funnel. The header column
// is now labelled "Do you know Tamil?" so we render the answer plainly
// ("Yes" / "No") and fall back to the raw age-bucket value for legacy
// YT rows so no data is lost in the migration.
function fmtAgeOrTamil(v) {
  if (!v) return '';
  if (v === 'yes') return 'Yes';
  if (v === 'no')  return 'No';
  return v;
}

function fmtWebinar(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function WebinarSelect({ value, onChange, webinars }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const options = [
    { value: '', label: 'All Webinars' },
    ...webinars
      .filter(w => w.is_active || (w.webinar_at && new Date(w.webinar_at) <= new Date()))
      .map(w => ({
        value: String(w.id),
        label: w.name ? w.name.replace(/^AWS-/, 'AWS - ') : fmtWebinar(w.webinar_at),
      })),
  ];
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
        {selected ? selected.label : 'All Webinars'}
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
          padding: '4px 0', maxHeight: 200, overflowY: 'auto',
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
                transition: 'background 100ms',
              }}
              onMouseEnter={e => { if (value !== opt.value) e.target.style.background = 'rgba(91,33,182,0.05)'; }}
              onMouseLeave={e => { if (value !== opt.value) e.target.style.background = 'transparent'; }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* Generic styled dropdown (same look as WebinarSelect) — used for the Form
   filter. `options` is [{ value, label }] including the "all" entry. */
function OptionDropdown({ value, onChange, options, placeholder = 'All', minWidth = 180 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);
  const selected = options.find(o => o.value === value);
  return (
    <div ref={ref} style={{ position: 'relative', minWidth }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', height: '2.1rem', borderRadius: 10,
          border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
          padding: '0 32px 0 12px', fontFamily: 'Outfit, sans-serif',
          fontSize: '0.82rem', fontWeight: 600, color: '#3B0764',
          cursor: 'pointer', outline: 'none', textAlign: 'left', position: 'relative',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {selected ? selected.label : placeholder}
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
                cursor: 'pointer', textAlign: 'left', transition: 'background 100ms',
                whiteSpace: 'normal',
              }}
              onMouseEnter={e => { if (value !== opt.value) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
              onMouseLeave={e => { if (value !== opt.value) e.currentTarget.style.background = 'transparent'; }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LeadsTable({ token, source = 'meta' }) {
  const [leads, setLeads]           = useState([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [sortKey, setSortKey]       = useState('created_at');
  const [sortAsc, setSortAsc]       = useState(false);
  const [activeFilter, setActiveFilter] = useState('all');
  const [dateFrom, setDateFrom]     = useState('');
  const [dateTo, setDateTo]         = useState('');
  const [syncToast, setSyncToast]   = useState(null);
  const [webinars, setWebinars]     = useState([]);
  const [webinarFilter, setWebinarFilter] = useState('');
  const [formFilter, setFormFilter]       = useState('');   // filter leads by meta_form_id

  // Pagination
  const [page, setPage] = useState(1);
  const perPage = 10;

  // Add Leads (bulk upload) modal
  const [addOpen, setAddOpen] = useState(false);

  // Delete mode state
  const [deleteMode, setDeleteMode]     = useState(false);
  const [selected, setSelected]         = useState(new Set());
  const [deleting, setDeleting]         = useState(false);
  const [confirmOpen, setConfirmOpen]   = useState(false);

  function loadLeads() {
    setLoading(true);
    fetch(`/api/admin/leads?source=${source}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { setLeads(d.leads || []); setTotal(d.total || 0); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadLeads(); }, [token, source]);

  // Fetch webinar sessions for filter dropdown
  useEffect(() => {
    fetch(`/api/admin/webinars?source=${source}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setWebinars(d.webinars || []))
      .catch(() => {});
  }, [token, source]);

  // Map Meta lead-form id → human name, so the "Form" column can show which
  // form each lead came from instead of the raw numeric form id.
  const [formNameById, setFormNameById] = useState({});
  useEffect(() => {
    fetch('/api/admin/meta-leadgen-forms', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        const map = {};
        for (const f of (d.forms || [])) if (f && f.id) map[String(f.id)] = f.name || String(f.id);
        setFormNameById(map);
      })
      .catch(() => {});
  }, [token]);

  function handleSort(key) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
    setPage(1);
  }

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [activeFilter, dateFrom, dateTo, webinarFilter, formFilter]);

  // Form-filter options — the distinct Meta forms actually present in the loaded
  // leads, labelled by name (falling back to the id), plus the "All Forms" entry.
  const formOptions = (() => {
    const present = new Map();
    for (const l of leads) {
      const fid = l.meta_form_id ? String(l.meta_form_id) : '';
      if (fid && !present.has(fid)) present.set(fid, formNameById[fid] || fid);
    }
    const opts = [...present.entries()].map(([value, label]) => ({ value, label }));
    opts.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return [{ value: '', label: 'All Forms' }, ...opts];
  })();

  // ── Duplicate detection ──
  // Group by phone number, keep oldest (first registered) as original, rest are
  // duplicates. A lead with NO valid phone is never a duplicate — otherwise every
  // empty/missing number collides into one bucket and inflates the count (e.g.
  // leads whose Meta "phone number" field failed to map). Normalise to the last
  // 10 digits so "+91 98…" and "98…" match the same person.
  const duplicateIds = (() => {
    const phoneMap = {};
    // Sort by created_at ascending so oldest comes first
    const byDate = [...leads].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    for (const l of byDate) {
      const phone = String(l.whatsapp_number || '').replace(/\D/g, '').slice(-10);
      if (phone.length < 10) continue;   // no real phone → not a duplicate
      if (!phoneMap[phone]) phoneMap[phone] = [];
      phoneMap[phone].push(l.id);
    }
    const dupes = new Set();
    for (const ids of Object.values(phoneMap)) {
      if (ids.length > 1) {
        // skip first (original), mark rest as duplicates
        for (let i = 1; i < ids.length; i++) dupes.add(ids[i]);
      }
    }
    return dupes;
  })();

  const duplicateCount = duplicateIds.size;

  /* Meta-Temp / TagMango: build the table columns from the actual Meta lead
     fields (leads.field_data) so each lead form's questions become their own
     columns — "columns created dynamically according to the leads generated".
     Falls back to the static columns when no field_data is present yet (e.g.
     only legacy CSV-imported leads exist). */
  const prettyLabel = (k) => String(k).replace(/[_-]+/g, ' ').replace(/\?+$/, '').trim().replace(/\b\w/g, c => c.toUpperCase());
  const fieldKeys = (() => {
    if (!isMetaTempLike(source)) return [];
    const keys = []; const seen = new Set();
    for (const l of leads) {
      const fd = l.field_data;
      if (fd && typeof fd === 'object') {
        for (const k of Object.keys(fd)) { if (!seen.has(k)) { seen.add(k); keys.push(k); } }
      }
    }
    return keys;
  })();
  const dynamicMode = isMetaTempLike(source) && fieldKeys.length > 0;
  const cellValue = (l, key) =>
    (key && key.startsWith('fd:')) ? (l.field_data?.[key.slice(3)] ?? '') : (l[key] ?? '');

  const filtered = leads.filter(l => {
    // Webinar filter — match by webinar_id
    if (webinarFilter && String(l.webinar_id) !== String(webinarFilter)) return false;
    if (formFilter && String(l.meta_form_id) !== String(formFilter)) return false;
    if (dateFrom || dateTo) {
      const created = new Date(l.created_at);
      // DateTimePicker emits "YYYY-MM-DDTHH:mm:ss" (exact moment); the
      // legacy "Today" button still sets a date-only "YYYY-MM-DD" string.
      // Treat date-only values as start-of-day (from) / end-of-day (to) in IST.
      if (dateFrom) {
        const from = dateFrom.includes('T') ? new Date(dateFrom) : new Date(dateFrom + 'T00:00:00+05:30');
        if (created < from) return false;
      }
      if (dateTo) {
        const to = dateTo.includes('T') ? new Date(dateTo) : new Date(dateTo + 'T23:59:59+05:30');
        if (created > to) return false;
      }
    }
    if (activeFilter === 'all')        return true;
    if (activeFilter === 'high_sugar') return l.sugar_level === '250+';
    if (activeFilter === 'wa_clicked') return l.wa_clicked === true;
    if (activeFilter === 'wa_not')     return !l.wa_clicked;
    if (activeFilter === 'duplicates') return duplicateIds.has(l.id);
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const va = cellValue(a, sortKey);
    const vb = cellValue(b, sortKey);
    return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const paginated = sorted.slice((page - 1) * perPage, page * perPage);

  function exportCSV() {
    // Meta-Temp/TagMango dynamic mode: export exactly the dynamic columns shown.
    if (dynamicMode) {
      const headers = cols.map(c => c.label);
      const rows = sorted.map(l => cols.map(c => {
        if (c.key === 'created_at') return l.created_at ? new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
        if (c.key === 'wa_clicked') return l.wa_clicked ? 'Yes' : 'No';
        return cellValue(l, c.key);
      }));
      const csv = [headers, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'mhs_leads.csv'; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    // CSV headers + row mapper kept in lockstep with the on-screen `cols`
    // array above. Adding a new column here should always be paired with
    // both an entry in `cols` and a `<td>` in the body so admins can
    // verify what they see in the table matches what they download.
    // CSV column set mirrors the on-screen `cols` array so YT exports
    // skip the Meta-only fields and Meta exports include them. Keep the
    // two lists in lockstep when adding new columns.
    const isMetaExport = source === 'meta';
    const headers = [
      'Name', 'Phone', 'Email', 'Sugar Level', 'Duration',
      ...(isMetaExport ? ['Medication', 'Do you know Tamil?', 'Occupation'] : []),
      'Ad Source', 'Registered At', 'WA Clicked',
    ];
    const rows = sorted.map(l => [
      l.full_name,
      '+91' + l.whatsapp_number,
      l.email || '',
      SUGAR_LABELS[l.sugar_level] || l.sugar_level,
      DURATION_LABELS[l.diabetes_duration] || l.diabetes_duration || '',
      ...(isMetaExport ? [
        MEDICATION_LABELS[l.on_medication] || l.on_medication || '',
        fmtAgeOrTamil(l.age_group),
        OCCUPATION_LABELS[l.occupation] || l.occupation || '',
      ] : []),
      l.utm_content || '',
      new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      l.wa_clicked ? 'Yes' : 'No',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'mhs_leads.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Delete helpers ──
  function toggleDeleteMode() {
    setDeleteMode(v => !v);
    setSelected(new Set());
    setConfirmOpen(false);
    if (activeFilter === 'duplicates') setActiveFilter('all');
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (activeFilter === 'duplicates') {
      // Only select duplicate leads (not originals)
      const dupesInView = sorted.filter(l => duplicateIds.has(l.id));
      if (selected.size === dupesInView.length) {
        setSelected(new Set());
      } else {
        setSelected(new Set(dupesInView.map(l => l.id)));
      }
    } else {
      if (selected.size === sorted.length) {
        setSelected(new Set());
      } else {
        setSelected(new Set(sorted.map(l => l.id)));
      }
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch('/api/admin/leads/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], source }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (res.ok) {
        setSyncToast({ ok: true, msg: `✓ ${data.deleted} lead${data.deleted !== 1 ? 's' : ''} permanently deleted.` });
        setDeleteMode(false);
        setSelected(new Set());
        setConfirmOpen(false);
        loadLeads();
      } else {
        setSyncToast({ ok: false, msg: data.error || `Delete failed (${res.status}).` });
      }
    } catch (e) {
      setSyncToast({ ok: false, msg: e?.message || 'Network error. Try again.' });
    } finally {
      setDeleting(false);
      setTimeout(() => setSyncToast(null), 4000);
    }
  }

  const dateFiltered = leads.filter(l => {
    if (webinarFilter && String(l.webinar_id) !== String(webinarFilter)) return false;
    if (formFilter && String(l.meta_form_id) !== String(formFilter)) return false;
    if (dateFrom) {
      const from = dateFrom.includes('T') ? new Date(dateFrom) : new Date(dateFrom + 'T00:00:00+05:30');
      if (new Date(l.created_at) < from) return false;
    }
    if (dateTo) {
      const to = dateTo.includes('T') ? new Date(dateTo) : new Date(dateTo + 'T23:59:59+05:30');
      if (new Date(l.created_at) > to) return false;
    }
    return true;
  });

  // Columns mirror the funnel form fields the admin actually cares about.
  // Meta-funnel-only columns (Medication / Do you know Tamil? / Occupation)
  // are conditionally added so the YT workspace doesn't show empty columns
  // for fields its funnel never collects. The `source` prop drives the
  // conditional — 'meta' shows everything, 'yt' shows only the fields the
  // YT funnel actually captures.
  const isMeta = source === 'meta';
  const cols = dynamicMode
    ? [
        ...fieldKeys.map(k => ({ key: `fd:${k}`, label: prettyLabel(k) })),
        { key: 'meta_form_id', label: 'Form' },
        { key: 'created_at', label: 'Registered' },
        { key: 'wa_clicked', label: 'WhatsApp' },
      ]
    : [
        { key: 'full_name',         label: 'Name' },
        { key: 'whatsapp_number',   label: 'Phone' },
        { key: 'email',             label: 'Email' },
        { key: 'sugar_level',       label: 'Sugar Level' },
        { key: 'diabetes_duration', label: 'Duration' },
        ...(isMeta ? [
          { key: 'on_medication', label: 'Medication' },
          { key: 'age_group',     label: 'Do you know Tamil?' },
          { key: 'occupation',    label: 'Occupation' },
        ] : []),
        { key: 'utm_content',       label: 'Ad Source' },
        { key: 'created_at',        label: 'Registered' },
        { key: 'wa_clicked',        label: 'WhatsApp' },
      ];

  /* Generic cell renderer for the dynamic (Meta-Temp/TagMango) table. The
     first field column also carries the source badge. */
  const renderDynCell = (c, l, isFirst) => {
    if (c.key === 'created_at') {
      return <span className="text-gray-400">{l.created_at ? new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</span>;
    }
    if (c.key === 'wa_clicked') {
      return l.wa_clicked
        ? <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-semibold bg-green-100 text-green-700">Clicked</span>
        : <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium bg-gray-100 text-gray-400">Not yet</span>;
    }
    if (c.key === 'meta_form_id') {
      const fid = l.meta_form_id ? String(l.meta_form_id) : '';
      if (!fid) return <span className="text-gray-300">—</span>;
      const fname = formNameById[fid] || fid;   // fall back to id until the catalog loads
      return <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-semibold bg-purple-100 text-purple-700" title={fname}>{fname}</span>;
    }
    const v = cellValue(l, c.key);
    const shown = (v !== '' && v != null) ? String(v) : null;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {shown !== null ? shown : <span className="text-gray-300">—</span>}
        {isFirst && <SourceBadge source={l.source} />}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="py-16 text-center">
        <Loading label="Loading leads…" />
      </div>
    );
  }

  return (
    <div>
      <style>{`
        @media (max-width: 640px) {
          .leads-header { flex-direction: column !important; align-items: flex-start !important; gap: 12px !important; }
          .leads-actions { width: 100% !important; justify-content: flex-start !important; flex-wrap: nowrap !important; }
          .leads-action-btn { padding: 0 10px !important; font-size: 0.70rem !important; height: 2rem !important; gap: 4px !important; }
          .leads-stat-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
      {/* Header row */}
      <div className="flex items-center justify-between mb-5 leads-header" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 className="font-sans text-xl font-bold text-purple-900">Lead Registry</h3>
          <p className="font-sans text-sm text-purple-400 mt-0.5">
            {activeFilter === 'all'
              ? <><span className="font-semibold text-purple-700">{total}</span> total registrations</>
              : <><span className="font-semibold text-purple-700">{sorted.length}</span> of {total} shown &mdash; <button onClick={() => setActiveFilter('all')} className="text-purple-500 underline font-semibold">Clear filter</button></>
            }
          </p>
        </div>
        <div className="leads-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>

          {/* Add Leads (bulk CSV/Excel upload) — Meta Temp only */}
          {isMetaTempLike(source) && (
            <button
              onClick={() => setAddOpen(true)}
              className="leads-action-btn"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: '2.4rem', padding: '0 16px', borderRadius: 50,
                border: '1.5px solid rgba(5,150,105,0.40)',
                background: 'rgba(236,253,245,0.85)',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
                color: '#059669', cursor: 'pointer', transition: 'all 180ms',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Leads
            </button>
          )}

          {/* Duplicates filter */}
          <button
            onClick={() => {
              if (activeFilter === 'duplicates') {
                setActiveFilter('all');
                setDeleteMode(false);
                setSelected(new Set());
              } else {
                setActiveFilter('duplicates');
                setDeleteMode(true);
                setSelected(new Set());
              }
            }}
            className="leads-action-btn"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: '2.4rem', padding: '0 16px', borderRadius: 50,
              border: activeFilter === 'duplicates' ? '1.5px solid rgba(217,119,6,0.50)' : '1.5px solid rgba(217,119,6,0.35)',
              background: activeFilter === 'duplicates' ? 'rgba(255,237,213,0.90)' : 'rgba(255,247,237,0.80)',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
              color: '#D97706', cursor: 'pointer', transition: 'all 180ms',
              boxShadow: activeFilter === 'duplicates' ? '0 0 0 3px rgba(217,119,6,0.12)' : 'none',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="8" y="2" width="13" height="13" rx="2"/><path d="M3 9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2"/>
            </svg>
            Duplicates{duplicateCount > 0 ? ` (${duplicateCount})` : ''}
          </button>

          {/* Delete mode toggle */}
          {!deleteMode ? (
            <button
              onClick={toggleDeleteMode}
              className="leads-action-btn"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: '2.4rem', padding: '0 16px', borderRadius: 50,
                border: '1.5px solid rgba(220,38,38,0.35)',
                background: 'rgba(254,242,242,0.80)',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
                color: '#DC2626', cursor: 'pointer', transition: 'all 180ms',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
              Delete
            </button>
          ) : (
            <button
              onClick={toggleDeleteMode}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: '2.4rem', padding: '0 16px', borderRadius: 50,
                border: '1.5px solid rgba(139,92,246,0.30)',
                background: 'rgba(237,234,248,0.80)',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
                color: '#5B21B6', cursor: 'pointer',
              }}
            >
              ✕ Cancel
            </button>
          )}

          {/* Export CSV */}
          <button
            onClick={exportCSV}
            className="leads-action-btn inline-flex items-center gap-2 bg-purple text-white font-sans font-semibold text-sm px-4 py-2.5 rounded-pill hover:bg-purple-700 transition-colors shadow-[0_2px_12px_rgba(91,33,182,0.25)]"
          >
            ↓ Export CSV
          </button>
        </div>
      </div>

      {/* Delete action bar — shown when in delete mode */}
      {deleteMode && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(254,242,242,0.90)', borderRadius: 12,
          border: '1.5px solid rgba(220,38,38,0.25)',
          padding: '10px 16px', marginBottom: 14,
          flexWrap: 'wrap', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              checked={activeFilter === 'duplicates'
                ? duplicateIds.size > 0 && selected.size === sorted.filter(l => duplicateIds.has(l.id)).length
                : sorted.length > 0 && selected.size === sorted.length}
              onChange={toggleSelectAll}
              style={{ width: 16, height: 16, accentColor: '#DC2626', cursor: 'pointer' }}
            />
            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.83rem', fontWeight: 600, color: '#DC2626' }}>
              {selected.size === 0
                ? (activeFilter === 'duplicates' ? 'Select all duplicates' : 'Select leads to delete')
                : `${selected.size} duplicate${selected.size !== 1 ? 's' : ''} selected`}
            </span>
          </div>
          {selected.size > 0 && (
            <button
              onClick={() => setConfirmOpen(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                height: '2.2rem', padding: '0 18px', borderRadius: 50,
                border: 'none', background: '#DC2626',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.83rem',
                color: '#fff', cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(220,38,38,0.30)',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                <path d="M9 6V4h6v2"/>
              </svg>
              Delete {selected.size} Selected
            </button>
          )}
        </div>
      )}

      {/* Toast */}
      {syncToast && (
        <div style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 10,
          background: syncToast.ok ? 'rgba(220,252,231,0.80)' : 'rgba(254,226,226,0.80)',
          border: syncToast.ok ? '1px solid rgba(34,197,94,0.35)' : '1px solid rgba(239,68,68,0.35)',
          fontFamily: 'Outfit, sans-serif', fontSize: '0.83rem', fontWeight: 600,
          color: syncToast.ok ? '#15803d' : '#DC2626',
        }}>
          {syncToast.msg}
        </div>
      )}

      {/* Date range filter */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: 'rgba(237,234,248,0.50)', borderRadius: 14,
        border: '1px solid rgba(139,92,246,0.15)',
        padding: '10px 14px', marginBottom: 14,
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.55)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', whiteSpace: 'nowrap' }}>Date Range</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <DateTimePicker value={dateFrom} onChange={setDateFrom} placeholder="From date" />
          <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.45)', fontWeight: 600 }}>to</span>
          <DateTimePicker value={dateTo} onChange={setDateTo} placeholder="To date" />
        </div>
        {(() => {
          const istToday = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const isTodayActive = dateFrom === istToday && dateTo === istToday;
          return (
            <button
              onClick={() => {
                if (isTodayActive) { setDateFrom(''); setDateTo(''); }
                else { setDateFrom(istToday); setDateTo(istToday); }
              }}
              style={{
                height: '2.1rem', padding: '0 14px', borderRadius: 10,
                border: isTodayActive ? '1.5px solid rgba(91,33,182,0.55)' : '1px solid rgba(139,92,246,0.30)',
                background: isTodayActive ? 'rgba(91,33,182,0.12)' : 'rgba(255,255,255,0.80)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700,
                color: '#5B21B6', cursor: 'pointer', whiteSpace: 'nowrap',
                boxShadow: isTodayActive ? '0 0 0 3px rgba(91,33,182,0.10)' : 'none',
                transition: 'all 150ms',
              }}
              title="Show only leads registered today (IST)"
            >
              Today
            </button>
          );
        })()}
        {(dateFrom || dateTo) && (
          <button onClick={() => { setDateFrom(''); setDateTo(''); }}
            style={{ height: '2.1rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(239,68,68,0.30)', background: 'rgba(254,242,242,0.80)', fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: '#DC2626', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            ✕ Clear
          </button>
        )}
      </div>

      {/* Webinar session + Form filters */}
      {(webinars.length > 0 || formOptions.length > 1) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: 'rgba(237,234,248,0.50)', borderRadius: 14,
          border: '1px solid rgba(139,92,246,0.15)',
          padding: '10px 14px', marginBottom: 14,
        }}>
          {webinars.length > 0 && (
            <>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.55)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>
              </svg>
              <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', whiteSpace: 'nowrap' }}>Webinar</span>
              <WebinarSelect value={webinarFilter} onChange={setWebinarFilter} webinars={webinars} />
              {webinarFilter && (
                <button onClick={() => setWebinarFilter('')}
                  style={{ height: '2.1rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(239,68,68,0.30)', background: 'rgba(254,242,242,0.80)', fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: '#DC2626', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  ✕ Clear
                </button>
              )}
            </>
          )}

          {/* Form filter — only when the loaded leads come from ≥1 known form */}
          {formOptions.length > 1 && (
            <>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.55)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>
              </svg>
              <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', whiteSpace: 'nowrap' }}>Form</span>
              <OptionDropdown value={formFilter} onChange={setFormFilter} options={formOptions} placeholder="All Forms" minWidth={200} />
              {formFilter && (
                <button onClick={() => setFormFilter('')}
                  style={{ height: '2.1rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(239,68,68,0.30)', background: 'rgba(254,242,242,0.80)', fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: '#DC2626', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  ✕ Clear
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-card border border-purple-100">
        <table className="w-full text-sm font-sans">
          <thead>
            <tr className="border-b border-purple-100 bg-purple-50/60">
              {/* Checkbox column header */}
              {deleteMode && (
                <th className="px-3 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={sorted.length > 0 && selected.size === sorted.length}
                    onChange={toggleSelectAll}
                    style={{ width: 15, height: 15, accentColor: '#DC2626', cursor: 'pointer' }}
                  />
                </th>
              )}
              {cols.map(c => (
                <th key={c.key} onClick={() => handleSort(c.key)}
                  className="px-3 py-3 text-left text-xs font-semibold text-purple-500 cursor-pointer hover:text-purple whitespace-nowrap select-none transition-colors">
                  {c.label} {sortKey === c.key ? (sortAsc ? '↑' : '↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginated.map((l, idx) => (
              <tr
                key={l.id}
                onClick={() => deleteMode && toggleSelect(l.id)}
                className={`border-b border-purple-50 transition-colors ${idx % 2 === 0 ? '' : 'bg-purple-50/20'}
                  ${deleteMode ? 'cursor-pointer' : ''}
                  ${deleteMode && selected.has(l.id) ? 'bg-red-50/60' : 'hover:bg-lavender/40'}
                `}
              >
                {/* Checkbox cell */}
                {deleteMode && (
                  <td className="px-3 py-3" onClick={e => { e.stopPropagation(); toggleSelect(l.id); }}>
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => toggleSelect(l.id)}
                      style={{ width: 15, height: 15, accentColor: '#DC2626', cursor: 'pointer' }}
                    />
                  </td>
                )}
                {dynamicMode ? cols.map((c, ci) => (
                  <td key={c.key} className="px-3 py-3 whitespace-nowrap text-xs text-gray-700" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} title={typeof cellValue(l, c.key) === 'string' ? cellValue(l, c.key) : ''}>
                    {renderDynCell(c, l, ci === 0)}
                  </td>
                )) : (<>
                <td className="px-3 py-3 font-semibold text-gray-900 whitespace-nowrap">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {l.full_name}
                    <SourceBadge source={l.source} />
                  </span>
                </td>
                <td className="px-3 py-3 text-gray-600 whitespace-nowrap font-mono text-xs">+91 {l.whatsapp_number}</td>
                {/* Email — truncated with full value on hover via title */}
                <td className="px-3 py-3 text-gray-600 whitespace-nowrap text-xs" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={l.email || ''}>
                  {l.email || <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-semibold ${l.sugar_level === '250+' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                    {SUGAR_LABELS[l.sugar_level] || l.sugar_level}
                  </span>
                </td>
                {/* Diabetes duration — soft yellow pill */}
                <td className="px-3 py-3 whitespace-nowrap text-xs">
                  {l.diabetes_duration
                    ? <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-semibold bg-yellow-50 text-yellow-800">{DURATION_LABELS[l.diabetes_duration] || l.diabetes_duration}</span>
                    : <span className="text-gray-300">—</span>}
                </td>
                {/* Meta-only columns — On medication / Tamil yes-no /
                    Occupation. The YT funnel doesn't capture these so we
                    hide the cells entirely on the YT workspace to keep
                    the row width tight. */}
                {isMeta && (
                  <>
                    {/* On medication — soft indigo pill */}
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {l.on_medication
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-semibold bg-indigo-50 text-indigo-700">{MEDICATION_LABELS[l.on_medication] || l.on_medication}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {/* Age bucket OR Tamil yes/no — same DB column, format depends on the value */}
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {l.age_group
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-semibold bg-purple-50 text-purple-700">{fmtAgeOrTamil(l.age_group)}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {/* Occupation — soft teal pill */}
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {l.occupation
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-semibold bg-teal-50 text-teal-700">{OCCUPATION_LABELS[l.occupation] || l.occupation}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                  </>
                )}
                <td className="px-3 py-3 whitespace-nowrap text-xs">
                  {l.utm_content ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-xs font-semibold bg-blue-50 text-blue-700" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }} title={l.utm_content}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                      {l.utm_content}
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-gray-400 whitespace-nowrap text-xs">
                  {new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {l.wa_clicked
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-xs font-semibold bg-green-100 text-green-700">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                        Clicked
                      </span>
                    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-xs font-medium bg-gray-100 text-gray-400">
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#D1D5DB', display: 'inline-block' }} />
                        Not yet
                      </span>
                  }
                </td>
                </>)}
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                {/* Total cells = visible cols (8 on YT / 11 on Meta), +1
                    when delete-mode adds the leading checkbox column. */}
                <td colSpan={cols.length + (deleteMode ? 1 : 0)} className="px-3 py-16 text-center">
                  <div className="flex flex-col items-center gap-2 text-purple-300">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
                    <p className="font-sans text-sm">No leads yet.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {sorted.length > perPage && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 14, padding: '0 4px', flexWrap: 'wrap', gap: 10,
        }}>
          <span style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 500,
            color: 'rgba(91,33,182,0.50)',
          }}>
            Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, sorted.length)} of {sorted.length}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {/* Prev */}
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              style={{
                width: 32, height: 32, borderRadius: 8,
                border: '1px solid rgba(139,92,246,0.20)',
                background: page === 1 ? 'rgba(237,234,248,0.30)' : 'rgba(237,234,248,0.60)',
                color: page === 1 ? 'rgba(91,33,182,0.25)' : '#5B21B6',
                cursor: page === 1 ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>

            {/* Page numbers */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
              .reduce((acc, p, idx, arr) => {
                if (idx > 0 && p - arr[idx - 1] > 1) acc.push('...');
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) =>
                p === '...' ? (
                  <span key={`dot${i}`} style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.35)', padding: '0 4px' }}>…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    style={{
                      minWidth: 32, height: 32, borderRadius: 8, border: 'none',
                      fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem', fontWeight: p === page ? 700 : 500,
                      background: p === page ? '#5B21B6' : 'transparent',
                      color: p === page ? '#fff' : '#5B21B6',
                      cursor: 'pointer', transition: 'all 150ms',
                      boxShadow: p === page ? '0 2px 8px rgba(91,33,182,0.30)' : 'none',
                    }}
                  >
                    {p}
                  </button>
                )
              )
            }

            {/* Next */}
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              style={{
                width: 32, height: 32, borderRadius: 8,
                border: '1px solid rgba(139,92,246,0.20)',
                background: page === totalPages ? 'rgba(237,234,248,0.30)' : 'rgba(237,234,248,0.60)',
                color: page === totalPages ? 'rgba(91,33,182,0.25)' : '#5B21B6',
                cursor: page === totalPages ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* Confirm Delete Modal */}
      {confirmOpen && (
        <div
          onClick={e => e.target === e.currentTarget && setConfirmOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9000,
            background: 'rgba(15,0,40,0.50)',
            backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 16px',
          }}
        >
          <div style={{
            width: '100%', maxWidth: 380,
            background: '#fff', borderRadius: 20,
            border: '1px solid rgba(220,38,38,0.20)',
            boxShadow: '0 24px 64px rgba(220,38,38,0.18)',
            padding: '32px 28px 28px',
            fontFamily: 'Outfit, sans-serif',
            textAlign: 'center',
          }}>
            {/* Icon */}
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(254,226,226,0.80)', border: '1.5px solid rgba(220,38,38,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M9 6V4h6v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
              </svg>
            </div>
            <h3 style={{ fontWeight: 800, fontSize: '1.1rem', color: '#3B0764', margin: '0 0 8px' }}>
              Delete {selected.size} Lead{selected.size !== 1 ? 's' : ''}?
            </h3>
            <p style={{ fontSize: '0.85rem', color: '#6B7280', margin: '0 0 24px', lineHeight: 1.6 }}>
              This action is <strong style={{ color: '#DC2626' }}>permanent</strong> and cannot be undone. The selected leads will be removed from the database forever.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setConfirmOpen(false)}
                style={{ flex: 1, height: '2.7rem', borderRadius: 50, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.50)', fontFamily: 'Outfit,sans-serif', fontWeight: 600, fontSize: '0.88rem', color: '#5B21B6', cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{ flex: 1, height: '2.7rem', borderRadius: 50, border: 'none', background: deleting ? 'rgba(220,38,38,0.55)' : '#DC2626', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.88rem', color: '#fff', cursor: deleting ? 'not-allowed' : 'pointer', boxShadow: '0 4px 16px rgba(220,38,38,0.30)' }}>
                {deleting ? 'Deleting…' : 'Yes, Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Leads (bulk upload) modal */}
      {addOpen && (
        <AddLeadsModal
          token={token}
          source={source}
          existingPhones={new Set(leads.map(l => String(l.whatsapp_number || '').trim()))}
          onClose={() => setAddOpen(false)}
          onImported={(data) => {
            const n = data?.inserted ?? 0;
            setSyncToast({ ok: true, msg: `${n} lead${n === 1 ? '' : 's'} added${data?.skipped_duplicates ? ` · ${data.skipped_duplicates} duplicate(s) skipped` : ''}.` });
            loadLeads();
          }}
        />
      )}
    </div>
  );
}
