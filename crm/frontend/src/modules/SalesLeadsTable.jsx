import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import DateTimePicker from '../admin/DateTimePicker';
import Loading from '../components/Loading';
import ManualAssignModal from './ManualAssignModal';
import SourceBadge from '../components/SourceBadge';

const SUGAR_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
};

// Form-option label maps — kept in sync with the funnel form choices and
// with admin/LeadsTable.jsx so both views speak the same language.
const DURATION_LABELS   = { new: '< 1 yr', mid: '1–5 yrs', long: '5+ yrs', pre: 'Pre-diabetic' };
const LANG_LABELS       = { tamil: 'Tamil', english: 'English' };
const MEDICATION_LABELS = { insulin: 'Insulin', tablets: 'Tablets', none: 'None' };
const OCCUPATION_LABELS = { working: 'Working', housewife: 'Housewife', retired: 'Retired' };

// age_group column on Meta leads stores the "Do you know Tamil?" answer
// ('yes' / 'no'); on legacy YT leads it stores the old age bucket. Render
// the Tamil answer plainly and fall through to the raw value otherwise.
function fmtTamilOrAge(v) {
  if (!v) return '';
  if (v === 'yes') return 'Yes';
  if (v === 'no')  return 'No';
  return v;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}

function fmtPhone(p) {
  if (!p) return '—';
  const digits = String(p).replace(/\D/g, '');
  return digits.startsWith('91') ? '+' + digits : '+91 ' + digits;
}

/* IST helpers — date filters operate on IST calendar days. */
function todayISTYmd() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/* Return [startISO, endISO] for a YYYY-MM-DD date string in IST (00:00:00 to
   23:59:59.999 IST), or null inputs map to null bounds (no filter on that side). */
/* Accepts either a date-only ("YYYY-MM-DD") OR a datetime ("YYYY-MM-DDTHH:mm:ss")
   string. Date-only values get padded to start-of-day (from) / end-of-day (to)
   in IST. Datetime values are interpreted as exact IST moments and used as-is. */
function istDayBounds(fromStr, toStr) {
  const fromISO = fromStr
    ? new Date(fromStr.includes('T') ? `${fromStr}+05:30` : `${fromStr}T00:00:00+05:30`).toISOString()
    : null;
  const toISO = toStr
    ? new Date(toStr.includes('T') ? `${toStr}+05:30` : `${toStr}T23:59:59.999+05:30`).toISOString()
    : null;
  return [fromISO, toISO];
}

function toCsvCell(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

const PAGE_SIZE = 10;

export default function SalesLeadsTable({ token, source = 'all' }) {
  const [leads, setLeads]       = useState([]);
  const [webinars, setWebinars] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [page, setPage]         = useState(1);

  /* Filter state */
  const [dateMode, setDateMode]   = useState('all');   // 'all' | 'today' | 'custom'
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo]     = useState('');
  // Multi-select set of webinar ids (as strings). Empty set = no filter
  // (i.e. "All webinars").
  const [webinarIds, setWebinarIds] = useState(() => new Set());
  // Manual lead-assignment modal visibility.
  const [manualAssignOpen, setManualAssignOpen] = useState(false);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [leadsRes, webinarsRes] = await Promise.all([
        fetch(`/api/admin/leads?source=${encodeURIComponent(source)}`,    { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/webinars?source=${encodeURIComponent(source)}`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (!leadsRes.ok) throw new Error('Failed to load leads.');
      const leadsData = await leadsRes.json();
      setLeads(leadsData.leads || []);
      if (webinarsRes.ok) {
        const w = await webinarsRes.json();
        setWebinars(w.webinars || []);
      }
    } catch (e) {
      setError(e.message || 'Failed to load leads.');
    } finally {
      setLoading(false);
    }
  }, [token, source]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  /* Date range derived from dateMode + custom inputs. Two ISO strings or null. */
  const [fromISO, toISO] = useMemo(() => {
    if (dateMode === 'today') {
      const t = todayISTYmd();
      return istDayBounds(t, t);
    }
    if (dateMode === 'custom') {
      if (!customFrom && !customTo) return [null, null];
      return istDayBounds(customFrom, customTo || customFrom);
    }
    return [null, null];
  }, [dateMode, customFrom, customTo]);

  /* Webinar id → name lookup for table display + CSV export. */
  const webinarNameById = useMemo(() => {
    const m = {};
    for (const w of webinars) m[String(w.id)] = w.name;
    return m;
  }, [webinars]);

  const filtered = useMemo(() => leads.filter(l => {
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const blob = `${l.full_name || ''} ${l.email || ''} ${l.whatsapp_number || ''}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    if (webinarIds.size > 0 && !webinarIds.has(String(l.webinar_id))) return false;
    if (fromISO && l.created_at < fromISO) return false;
    if (toISO   && l.created_at > toISO)   return false;
    return true;
  }), [leads, search, webinarIds, fromISO, toISO]);

  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart   = (currentPage - 1) * PAGE_SIZE;
  const pageRows    = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => { setPage(1); }, [search, dateMode, customFrom, customTo, webinarIds]);

  function exportCsv() {
    const header = [
      'Name', 'Email', 'Phone',
      'Sugar', 'Duration', 'Language', 'Medication', 'Knows Tamil', 'Occupation',
      'Ad Source', 'Webinar', 'Registered (IST)', 'Assigned To',
    ];
    const body = filtered.map(l => [
      l.full_name || '',
      l.email || '',
      fmtPhone(l.whatsapp_number),
      l.sugar_level || '',
      DURATION_LABELS[l.diabetes_duration] || l.diabetes_duration || '',
      LANG_LABELS[l.language_pref] || l.language_pref || '',
      MEDICATION_LABELS[l.on_medication] || l.on_medication || '',
      fmtTamilOrAge(l.age_group),
      OCCUPATION_LABELS[l.occupation] || l.occupation || '',
      l.utm_content || '',
      webinarNameById[String(l.webinar_id)] || '',
      fmtDate(l.created_at),
      l.assigned_to_name || 'Unassigned',
    ]);
    const csv = [header, ...body]
      .map(row => row.map(toCsvCell).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `web-reminder-leads-${stamp}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  const activeFilterCount =
    (dateMode !== 'all' ? 1 : 0) +
    (webinarIds.size > 0 ? 1 : 0);

  function clearAllFilters() {
    setDateMode('all');
    setCustomFrom('');
    setCustomTo('');
    setWebinarIds(new Set());
  }

  // Webinars filtered to only current + previous (no future schedules).
  // A webinar is "available" when its webinar_at is now or earlier.
  const availableWebinars = useMemo(() => {
    const now = Date.now();
    return webinars.filter(w => !w.webinar_at || new Date(w.webinar_at).getTime() <= now);
  }, [webinars]);

  /* Dynamic form-field columns — same idea as the Marketing leads page. Builds
     the union of every lead's field_data keys (across ALL sources) so Meta-Temp
     / form leads show their actual answers instead of blank standard columns.
     When any lead carries field_data we switch to this dynamic layout; the
     Assigned To column is appended at the end. */
  const prettyLabel = (k) => String(k).replace(/[_-]+/g, ' ').replace(/\?+$/, '').trim().replace(/\b\w/g, c => c.toUpperCase());
  // Name/phone keys ("full name", "phone number", etc.) are already covered by
  // the fixed NAME column (name + phone stacked), so skip them in the dynamic
  // columns — otherwise every spelling variant shows as a duplicate FULL NAME /
  // PHONE NUMBER column.
  const isNameOrPhone = (k) => { const s = String(k).toLowerCase(); return /phone|mobile|name|பெயர/.test(s); };
  const fieldKeys = useMemo(() => {
    const keys = []; const seen = new Set();
    for (const l of leads) {
      const fd = l.field_data;
      if (fd && typeof fd === 'object') for (const k of Object.keys(fd)) if (!seen.has(k) && !isNameOrPhone(k)) { seen.add(k); keys.push(k); }
    }
    return keys;
  }, [leads]);
  const dynamicMode = fieldKeys.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Filter toolbar — single row with date pills, custom inputs, webinar dropdown, Export CSV */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: 'rgba(237,234,248,0.50)', borderRadius: 14,
        border: '1px solid rgba(139,92,246,0.15)',
        padding: '10px 14px',
      }}>
        <Pill label="All time" active={dateMode === 'all'}    onClick={() => setDateMode('all')} />
        <Pill label="Today"    active={dateMode === 'today'}  onClick={() => setDateMode('today')} />
        <Pill label="Custom"   active={dateMode === 'custom'} onClick={() => setDateMode('custom')} />

        {dateMode === 'custom' && (
          <>
            <DateTimePicker value={customFrom} onChange={setCustomFrom} placeholder="From date" />
            <span style={{ fontSize: '0.76rem', color: 'rgba(91,33,182,0.45)', fontWeight: 600 }}>to</span>
            <DateTimePicker value={customTo}   onChange={setCustomTo}   placeholder="To date" />
          </>
        )}

        <span style={{ width: 1, height: 24, background: 'rgba(91,33,182,0.20)', margin: '0 4px' }} />

        <span style={{ fontSize: '0.76rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)' }}>Webinar</span>
        <MultiWebinarSelect
          webinars={availableWebinars}
          selected={webinarIds}
          onChange={setWebinarIds}
        />

        {activeFilterCount > 0 && (
          <button
            onClick={clearAllFilters}
            style={{
              padding: '5px 11px', borderRadius: 50, border: 'none',
              background: 'rgba(220,38,38,0.10)', color: '#B91C1C',
              fontFamily: 'Outfit,sans-serif', fontSize: '0.74rem', fontWeight: 700,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            Clear filters
          </button>
        )}

        <div style={{ flex: 1 }} />

        <button
          onClick={() => setManualAssignOpen(true)}
          title="Manually assign unassigned leads to callers"
          style={{
            height: '2.1rem', padding: '0 14px', borderRadius: 10, border: 'none',
            background: 'linear-gradient(135deg, #5B21B6, #7C3AED)',
            color: '#fff',
            fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.80rem',
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
            boxShadow: '0 2px 8px rgba(91,33,182,0.30)',
          }}
        >
          ⇄ Manual Assign
        </button>

        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          title={filtered.length === 0 ? 'No rows to export' : `Export ${filtered.length} lead${filtered.length === 1 ? '' : 's'} to CSV`}
          style={{
            height: '2.1rem', padding: '0 14px', borderRadius: 10,
            border: '1px solid rgba(91,33,182,0.25)',
            background: '#fff', color: '#5B21B6',
            fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.80rem',
            cursor: filtered.length === 0 ? 'not-allowed' : 'pointer',
            opacity: filtered.length === 0 ? 0.5 : 1,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          ⤓ Export CSV
        </button>
      </div>

      {manualAssignOpen && (
        <ManualAssignModal
          token={token}
          source={source}
          onClose={() => setManualAssignOpen(false)}
          onAssigned={() => fetchLeads()}
        />
      )}

      {/* Search toolbar */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 16 }}>
        <div style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search the pipeline by name, email, or phone…"
            style={{ width: '100%', height: '2.4rem', padding: '0 12px 0 34px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.7)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* Pipeline table */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Loading label="Loading pipeline…" />
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>
              {leads.length === 0 ? 'No leads in pipeline yet' : 'No matches'}
            </div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem' }}>
              {leads.length === 0
                ? 'Once people register, they will land here.'
                : 'Try clearing the search, date range, or webinar filter.'}
            </div>
          </div>
        ) : dynamicMode ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Phone</th>
                  {fieldKeys.map(k => <th key={k} style={thStyle}>{prettyLabel(k)}</th>)}
                  <th style={thStyle}>Webinar</th>
                  <th style={thStyle}>Registered</th>
                  <th style={thStyle}>Assigned To</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(l => (
                  <tr key={l.id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, color: '#3B0764' }}>{l.full_name || '—'}</span>
                        <SourceBadge source={l.source} />
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.80rem', color: 'rgba(91,33,182,0.85)' }}>
                      {fmtPhone(l.whatsapp_number)}
                    </td>
                    {fieldKeys.map(k => {
                      const v = l.field_data && l.field_data[k];
                      return <td key={k} style={tdStyle}>{(v != null && v !== '') ? <span style={pillStyle('#EDE9FE', '#5B21B6')}>{String(v)}</span> : <span style={dashStyle}>—</span>}</td>;
                    })}
                    <td style={{ ...tdStyle, fontWeight: 600, fontSize: '0.82rem' }}>{webinarNameById[String(l.webinar_id)] || '—'}</td>
                    <td style={{ ...tdStyle, fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)' }}>{fmtDate(l.created_at)}</td>
                    <td style={tdStyle}>
                      {l.assigned_to_name
                        ? <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.84rem' }}>{l.assigned_to_name}</span>
                        : <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 50, fontSize: '0.72rem', fontWeight: 700, background: 'rgba(107,114,128,0.12)', color: '#6B7280' }}>Unassigned</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>Sugar</th>
                  <th style={thStyle}>Duration</th>
                  <th style={thStyle}>Language</th>
                  <th style={thStyle}>Medication</th>
                  <th style={thStyle}>Knows Tamil</th>
                  <th style={thStyle}>Occupation</th>
                  <th style={thStyle}>Ad Source</th>
                  <th style={thStyle}>Webinar</th>
                  <th style={thStyle}>Registered</th>
                  <th style={thStyle}>Assigned To</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(l => {
                  const sugar = SUGAR_BADGE[l.sugar_level] || { bg: '#F3F4F6', fg: '#4B5563' };
                  return (
                    <tr key={l.id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, color: '#3B0764' }}>{l.full_name || '—'}</span>
                          <SourceBadge source={l.source} />
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{l.email || '—'}</div>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.80rem' }}>
                        {fmtPhone(l.whatsapp_number)}
                      </td>
                      <td style={tdStyle}><span style={badgeStyle(sugar)}>{l.sugar_level || '—'}</span></td>
                      <td style={tdStyle}>
                        {l.diabetes_duration
                          ? <span style={pillStyle('#FEF3C7', '#92400E')}>{DURATION_LABELS[l.diabetes_duration] || l.diabetes_duration}</span>
                          : <span style={dashStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        {l.language_pref
                          ? <span style={pillStyle('#E0F2FE', '#075985')}>{LANG_LABELS[l.language_pref] || l.language_pref}</span>
                          : <span style={dashStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        {l.on_medication
                          ? <span style={pillStyle('#EEF2FF', '#3730A3')}>{MEDICATION_LABELS[l.on_medication] || l.on_medication}</span>
                          : <span style={dashStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        {l.age_group
                          ? <span style={pillStyle('#F5F3FF', '#5B21B6')}>{fmtTamilOrAge(l.age_group)}</span>
                          : <span style={dashStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        {l.occupation
                          ? <span style={pillStyle('#CCFBF1', '#115E59')}>{OCCUPATION_LABELS[l.occupation] || l.occupation}</span>
                          : <span style={dashStyle}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        {l.utm_content
                          ? <span style={{ ...pillStyle('#DBEAFE', '#1E40AF'), maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', verticalAlign: 'middle' }} title={l.utm_content}>{l.utm_content}</span>
                          : <span style={dashStyle}>—</span>}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 600, fontSize: '0.82rem' }}>
                        {webinarNameById[String(l.webinar_id)] || '—'}
                      </td>
                      <td style={{ ...tdStyle, fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)' }}>{fmtDate(l.created_at)}</td>
                      <td style={tdStyle}>
                        {l.assigned_to_name
                          ? <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.84rem' }}>{l.assigned_to_name}</span>
                          : <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 50, fontSize: '0.72rem', fontWeight: 700, background: 'rgba(107,114,128,0.12)', color: '#6B7280' }}>Unassigned</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderTop: '1px solid rgba(209,196,240,0.30)',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)',
            flexWrap: 'wrap', gap: 8,
          }}>
            <span>
              Showing <b style={{ color: '#3B0764' }}>{pageStart + 1}</b>–
              <b style={{ color: '#3B0764' }}>{Math.min(pageStart + PAGE_SIZE, filtered.length)}</b> of{' '}
              <b style={{ color: '#3B0764' }}>{filtered.length}</b>
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <PageBtn disabled={currentPage === 1} onClick={() => setPage(p => Math.max(1, p - 1))}>‹ Prev</PageBtn>
              <span style={{ padding: '0 10px', fontWeight: 700, color: '#3B0764' }}>
                Page {currentPage} / {totalPages}
              </span>
              <PageBtn disabled={currentPage === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next ›</PageBtn>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

function Pill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 13px', borderRadius: 50,
        border: active ? 'none' : '1px solid rgba(91,33,182,0.20)',
        background: active ? '#5B21B6' : 'transparent',
        color: active ? '#fff' : 'rgba(91,33,182,0.75)',
        fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700,
        cursor: 'pointer', whiteSpace: 'nowrap',
        boxShadow: active ? '0 2px 6px rgba(91,33,182,0.25)' : 'none',
      }}
    >
      {label}
    </button>
  );
}

function PageBtn({ children, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 12px', borderRadius: 8,
        border: '1px solid rgba(91,33,182,0.20)',
        background: disabled ? 'rgba(237,234,248,0.50)' : '#fff',
        color: disabled ? 'rgba(91,33,182,0.35)' : '#5B21B6',
        fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const dateInputStyle = {
  height: '2.1rem', padding: '0 10px', borderRadius: 10,
  border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
  fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#3B0764',
};

const thStyle = {
  padding: '12px 16px',
  fontSize: '0.72rem',
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
  verticalAlign: 'middle',
};

function badgeStyle(badge) {
  return {
    display: 'inline-block', padding: '3px 10px', borderRadius: 50,
    fontSize: '0.72rem', fontWeight: 700,
    background: badge.bg, color: badge.fg,
    whiteSpace: 'nowrap',
  };
}

function pillStyle(bg, fg) {
  return {
    display: 'inline-block', padding: '3px 10px', borderRadius: 50,
    fontSize: '0.72rem', fontWeight: 700,
    background: bg, color: fg,
    whiteSpace: 'nowrap',
  };
}

const dashStyle = { color: 'rgba(91,33,182,0.30)', fontSize: '0.82rem' };

/* Custom multi-select dropdown for the webinar filter. Matches the rest of
   the toolbar's purple-brand pill / button styling (no more clashing native
   browser select). Each row is a checkbox + label so admins can tick more
   than one webinar; the trigger label summarises the selection. */
function MultiWebinarSelect({ webinars, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  function toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  }
  function selectAll() {
    onChange(new Set(webinars.map(w => String(w.id))));
  }
  function clearAll() {
    onChange(new Set());
  }

  // Trigger label summarises the current selection.
  let triggerLabel;
  if (selected.size === 0) {
    triggerLabel = 'All webinars';
  } else if (selected.size === 1) {
    const onlyId = [...selected][0];
    const w = webinars.find(x => String(x.id) === String(onlyId));
    triggerLabel = w ? w.name : '1 webinar';
  } else {
    triggerLabel = `${selected.size} webinars`;
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          height: '2.1rem', padding: '0 30px 0 12px', borderRadius: 10,
          border: open ? '1px solid rgba(91,33,182,0.55)' : '1px solid rgba(139,92,246,0.25)',
          background: '#fff',
          fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
          color: selected.size === 0 ? 'rgba(91,33,182,0.55)' : '#3B0764',
          fontWeight: 600,
          cursor: 'pointer', outline: 'none', textAlign: 'left',
          position: 'relative', whiteSpace: 'nowrap', minWidth: 170,
          boxShadow: open ? '0 0 0 3px rgba(91,33,182,0.08)' : 'none',
          transition: 'border 200ms, box-shadow 200ms',
        }}
      >
        {triggerLabel}
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
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0,
          minWidth: 240, maxWidth: 320,
          background: '#fff',
          border: '1px solid rgba(139,92,246,0.18)',
          borderRadius: 12,
          boxShadow: '0 12px 40px rgba(91,33,182,0.18)',
          zIndex: 9999,
          overflow: 'hidden',
          fontFamily: 'Outfit, sans-serif',
        }}>
          {/* Bulk-action header */}
          <div style={{
            display: 'flex', gap: 6, padding: '8px 10px',
            borderBottom: '1px solid rgba(139,92,246,0.15)',
            background: 'rgba(237,234,248,0.50)',
          }}>
            <button
              type="button"
              onClick={selectAll}
              disabled={webinars.length === 0 || selected.size === webinars.length}
              style={{
                padding: '4px 10px', borderRadius: 8, border: '1px solid rgba(91,33,182,0.25)',
                background: 'rgba(255,255,255,0.70)', color: '#5B21B6',
                fontWeight: 700, fontSize: '0.72rem',
                cursor: 'pointer',
                opacity: webinars.length === 0 || selected.size === webinars.length ? 0.45 : 1,
              }}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={selected.size === 0}
              style={{
                padding: '4px 10px', borderRadius: 8, border: '1px solid rgba(220,38,38,0.25)',
                background: 'rgba(254,242,242,0.70)', color: '#B91C1C',
                fontWeight: 700, fontSize: '0.72rem',
                cursor: 'pointer',
                opacity: selected.size === 0 ? 0.45 : 1,
              }}
            >
              Clear
            </button>
          </div>

          {/* Checkbox list */}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {webinars.length === 0 ? (
              <div style={{ padding: 14, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.80rem' }}>
                No past or current webinars.
              </div>
            ) : (
              webinars.map(w => {
                const id = String(w.id);
                const checked = selected.has(id);
                return (
                  <label
                    key={id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px', cursor: 'pointer',
                      background: checked ? 'rgba(91,33,182,0.06)' : 'transparent',
                      borderBottom: '1px solid rgba(139,92,246,0.08)',
                      transition: 'background 120ms',
                    }}
                    onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'rgba(139,92,246,0.06)'; }}
                    onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(id)}
                      style={{ width: 15, height: 15, accentColor: '#5B21B6', cursor: 'pointer' }}
                    />
                    <span style={{
                      flex: 1, fontSize: '0.82rem', color: '#3B0764', fontWeight: 600,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {w.name}
                      {!w.is_active && (
                        <span style={{ marginLeft: 6, fontSize: '0.66rem', color: 'rgba(91,33,182,0.50)', fontWeight: 500 }}>
                          (inactive)
                        </span>
                      )}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
