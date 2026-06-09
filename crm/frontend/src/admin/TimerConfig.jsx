import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import DateTimePicker from './DateTimePicker';

function toLocalDatetimeValue(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 16);
}

/* Parse the stored form-ids column (JSON array string) into an array. Tolerates
   legacy single-id strings and nulls. */
function parseFormIds(v) {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(String);
    return [String(parsed)];
  } catch {
    return [String(v)];
  }
}

function fromLocalDatetimeValue(localVal) {
  if (!localVal) return null;
  const [date, time] = localVal.split('T');
  const [y, mo, d]  = date.split('-').map(Number);
  const [h, m]      = time.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - 5.5 * 60 * 60 * 1000).toISOString();
}

function fmtIST(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/* ── Webinar Session Card ── */
function WebinarCard({ webinar }) {
  const isFuture = webinar.webinar_at && new Date(webinar.webinar_at) > new Date();
  const status = webinar.is_active ? 'active' : isFuture ? 'upcoming' : 'inactive';
  const statusStyle = {
    active:   { bg: 'rgba(5,150,105,0.10)',  color: '#059669', dot: '#059669', label: 'Active' },
    upcoming: { bg: 'rgba(37,99,235,0.10)',  color: '#2563EB', dot: '#3B82F6', label: 'Upcoming' },
    inactive: { bg: 'rgba(156,163,175,0.12)', color: '#9CA3AF', dot: '#D1D5DB', label: 'Inactive' },
  }[status];

  return (
    <div className="timer-session-card" style={{
      borderRadius: 14,
      border: webinar.is_active
        ? '1.5px solid rgba(91,33,182,0.35)'
        : status === 'upcoming'
          ? '1.5px solid rgba(37,99,235,0.25)'
          : '1px solid rgba(147,51,234,0.10)',
      background: webinar.is_active ? 'rgba(237,234,248,0.55)' : '#fff',
      padding: '14px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      transition: 'all 200ms',
    }}>
      <div style={{ minWidth: 0 }}>
        {/* Status badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 20,
            fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: statusStyle.bg,
            color: statusStyle.color,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%',
              background: statusStyle.dot,
              display: 'inline-block',
            }} />
            {statusStyle.label}
          </span>
        </div>

        {/* Name + Date/time */}
        <div style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', fontWeight: 700,
          color: '#3B0764', lineHeight: 1.3,
        }}>
          {webinar.name ? (
            <>
              {webinar.name.replace(/^AWS-/, 'AWS - ')}
              <span style={{
                fontSize: '0.72rem', fontWeight: 500, fontStyle: 'italic',
                color: 'rgba(91,33,182,0.70)', marginLeft: 6,
              }}>
                ({fmtIST(webinar.webinar_at)} IST)
              </span>
            </>
          ) : (
            `${fmtIST(webinar.webinar_at)} IST`
          )}
        </div>

        {/* Created at */}
        <div style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '0.68rem',
          color: 'rgba(91,33,182,0.40)', marginTop: 2,
        }}>
          Created {fmtIST(webinar.created_at)}
        </div>
      </div>

      {/* Lead count badge */}
      <div style={{
        flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
        background: webinar.is_active ? '#5B21B6' : 'rgba(91,33,182,0.08)',
        borderRadius: 12, padding: '8px 14px', minWidth: 60,
      }}>
        <span style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '1.3rem', fontWeight: 800,
          color: webinar.is_active ? '#fff' : '#5B21B6', lineHeight: 1,
        }}>
          {webinar.lead_count}
        </span>
        <span style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '0.60rem', fontWeight: 600,
          color: webinar.is_active ? 'rgba(255,255,255,0.70)' : 'rgba(91,33,182,0.50)',
          textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2,
        }}>
          Leads
        </span>
      </div>
    </div>
  );
}

/* ── Skeleton Card ── */
function SkeletonCard() {
  return (
    <div style={{
      borderRadius: 14, border: '1px solid rgba(147,51,234,0.08)',
      background: 'rgba(237,234,248,0.45)', padding: '14px 16px', height: 88,
      animation: 'timerPulse 1.4s ease-in-out infinite',
    }} />
  );
}

/* ══════════════════════════════════════════ */
export default function TimerConfig({ token, source = 'meta' }) {
  /* ── Left-side state ── */
  const [currentWebinar, setCurrentWebinar] = useState('');         // registration deadline (next_webinar_at)
  const [currentWebinarDate, setCurrentWebinarDate] = useState(''); // actual webinar date (current_webinar_date)
  const [nextWebinar, setNextWebinar] = useState('');               // upcoming registration deadline (backup_webinar_at)
  const [nextWebinarDate, setNextWebinarDate] = useState('');       // upcoming actual webinar date (next_webinar_date)
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  /* Meta lead-gen form linkage — only shown/used in the Meta Temp workspace.
     Multiple forms can be linked per webinar; stored as a JSON array string in
     the current_form_id / next_form_id columns. */
  const showForms = source === 'metatemp';
  const [currentFormIds, setCurrentFormIds] = useState([]);
  const [nextFormIds, setNextFormIds]       = useState([]);
  const [forms, setForms]                   = useState([]);
  // Meta Temp extras: actual webinar date/time + webinar (Zoom) link, per webinar.
  const [currentWebinarDT, setCurrentWebinarDT]     = useState('');
  const [currentWebinarLink, setCurrentWebinarLink] = useState('');
  const [nextWebinarDT, setNextWebinarDT]           = useState('');
  const [nextWebinarLink, setNextWebinarLink]       = useState('');

  useEffect(() => {
    fetch(`/api/webinar-config?source=${source}`)
      .then(r => r.json())
      .then(d => {
        setCurrentWebinar(toLocalDatetimeValue(d.next_webinar_at));
        setCurrentWebinarDate(toLocalDatetimeValue(d.current_webinar_date));
        setNextWebinar(toLocalDatetimeValue(d.backup_webinar_at));
        setNextWebinarDate(toLocalDatetimeValue(d.next_webinar_date));
        setCurrentFormIds(parseFormIds(d.current_form_id));
        setNextFormIds(parseFormIds(d.next_form_id));
        setCurrentWebinarDT(toLocalDatetimeValue(d.current_webinar_datetime));
        setCurrentWebinarLink(d.current_webinar_link || '');
        setNextWebinarDT(toLocalDatetimeValue(d.next_webinar_datetime));
        setNextWebinarLink(d.next_webinar_link || '');
      });
  }, [source]);

  /* Load the Meta lead-gen form list for the dropdowns (Meta Temp only). */
  useEffect(() => {
    if (!showForms) { setForms([]); return; }
    fetch('/api/admin/meta-leadgen-forms', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setForms(d.forms || []))
      .catch(() => setForms([]));
  }, [showForms, token]);

  /* Only ACTIVE Meta forms are offered for linking. */
  const activeForms = forms.filter(f => String(f.status || '').toUpperCase() === 'ACTIVE');

  /* Reusable multi-select Meta-form dropdown for a webinar card. */
  function MetaFormSelect({ label, value, onChange }) {
    const options = activeForms.map((f) => ({ value: String(f.id), label: `${f.name || f.id}${f.page_name ? ` · ${f.page_name}` : ''}` }));
    return (
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
        <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>
          {label}
          <span style={{ color: 'rgba(91,33,182,0.45)', fontWeight: 500 }}> · {value.length} selected of {activeForms.length} active</span>
        </p>
        <BrandSelect
          multiple
          value={value}
          onChange={onChange}
          options={options}
          searchable
          searchPlaceholder="Search forms…"
          placeholder="Select forms…"
        />
      </div>
    );
  }

  /* ── Right-side state ── */
  const [webinars, setWebinars]           = useState([]);
  const [webinarsLoading, setWebinarsLoading] = useState(true);

  const fetchWebinars = useCallback(async () => {
    setWebinarsLoading(true);
    try {
      const res = await fetch(`/api/admin/webinars?source=${source}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setWebinars(data.webinars || []);
    } catch (_) {
      setWebinars([]);
    } finally {
      setWebinarsLoading(false);
    }
  }, [token, source]);

  useEffect(() => { fetchWebinars(); }, [fetchWebinars]);

  /* ── Derived: which webinar maps to "Current" / "Next" labels ── */
  const activeWebinar = webinars.find(w => w.is_active);
  const upcomingWebinar = webinars
    .filter(w => !w.is_active && w.webinar_at && new Date(w.webinar_at) > new Date())
    .sort((a, b) => new Date(a.webinar_at) - new Date(b.webinar_at))[0];
  const fmtName = n => n ? n.replace(/^AWS-/, 'AWS - ') : '';

  /* ── Save handler ── */
  async function handleSave() {
    setSaving(true);
    setToast(null);
    const body = {};
    if (currentWebinar)     body.next_webinar_at      = fromLocalDatetimeValue(currentWebinar);
    if (currentWebinarDate) body.current_webinar_date = fromLocalDatetimeValue(currentWebinarDate);
    if (nextWebinar)        body.backup_webinar_at    = fromLocalDatetimeValue(nextWebinar);
    if (nextWebinarDate)    body.next_webinar_date    = fromLocalDatetimeValue(nextWebinarDate);
    // Persist Meta form linkage (Meta Temp only) as a JSON array of form ids.
    if (showForms) {
      body.current_form_id = JSON.stringify(currentFormIds);
      body.next_form_id    = JSON.stringify(nextFormIds);
      body.current_webinar_datetime = fromLocalDatetimeValue(currentWebinarDT);
      body.current_webinar_link     = currentWebinarLink.trim();
      body.next_webinar_datetime    = fromLocalDatetimeValue(nextWebinarDT);
      body.next_webinar_link        = nextWebinarLink.trim();
    }

    const res = await fetch('/api/admin/webinar-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, source }),
    });
    setSaving(false);
    setToast({ ok: res.ok, msg: res.ok ? 'Settings saved! Countdown timer updated.' : 'Failed to save settings.' });
    setTimeout(() => setToast(null), 3500);

    // Refresh webinar list after save
    if (res.ok) fetchWebinars();
  }

  /* ── Layout pieces (rendered in different arrangements per workspace) ── */
  const timerHeader = (
    <div>
      <h3 className="font-sans text-xl font-bold text-purple-900">Webinar Timer</h3>
      <p className="font-sans text-sm text-purple-400 mt-1">
        All times in IST (India Standard Time). Changes update the countdown timer instantly for all visitors.
      </p>
    </div>
  );

  const currentCard = (
    <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors" style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', whiteSpace: 'nowrap', marginBottom: 4 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 20,
          fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: 'rgba(5,150,105,0.10)', color: '#059669',
          flexShrink: 0,
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#059669', display: 'inline-block' }} />
          Live
        </span>
        <label className="font-sans font-semibold text-purple-900 text-sm" style={{ margin: 0 }}>
          Current Webinar
          {activeWebinar?.name && (
            <span style={{
              fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700,
              color: '#059669', marginLeft: 6,
            }}>
              ({fmtName(activeWebinar.name)})
            </span>
          )}
        </label>
      </div>
      <p className="font-sans text-xs text-purple-400 mb-3">{showForms ? 'Start Date' : 'Registration countdown ends in'}</p>
      <DateTimePicker value={currentWebinar} onChange={setCurrentWebinar} />
      {currentWebinar && (
        <p className="font-sans text-xs text-purple-400 mt-2">
          {new Date(fromLocalDatetimeValue(currentWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
        </p>
      )}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
        <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>{showForms ? 'End Date' : 'Webinar date (when this session actually happens)'}</p>
        <DateTimePicker value={currentWebinarDate} onChange={setCurrentWebinarDate} />
        {currentWebinarDate && (
          <p className="font-sans text-xs text-purple-400 mt-2">
            {new Date(fromLocalDatetimeValue(currentWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
          </p>
        )}
      </div>
      {showForms && (
        <MetaFormSelect label="Meta lead forms (current webinar)" value={currentFormIds} onChange={setCurrentFormIds} />
      )}
    </div>
  );

  const nextCard = (
    <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors" style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 20,
          fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: 'rgba(37,99,235,0.10)', color: '#2563EB',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#2563EB', display: 'inline-block' }} />
          Upcoming
        </span>
      </div>
      <label className="block font-sans font-semibold text-purple-900 text-sm mb-1">
        Next Webinar
        {upcomingWebinar?.name && (
          <span style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700,
            color: '#2563EB', marginLeft: 6,
          }}>
            ({fmtName(upcomingWebinar.name)})
          </span>
        )}
      </label>
      <p className="font-sans text-xs text-purple-400 mb-3">{showForms ? 'Start Date' : 'Auto-switches when current webinar ends'}</p>
      <DateTimePicker value={nextWebinar} onChange={setNextWebinar} />
      {nextWebinar && (
        <p className="font-sans text-xs text-purple-400 mt-2">
          {new Date(fromLocalDatetimeValue(nextWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
        </p>
      )}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
        <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>{showForms ? 'End Date' : 'Webinar date (when next session actually happens)'}</p>
        <DateTimePicker value={nextWebinarDate} onChange={setNextWebinarDate} />
        {nextWebinarDate && (
          <p className="font-sans text-xs text-purple-400 mt-2">
            {new Date(fromLocalDatetimeValue(nextWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
          </p>
        )}
      </div>
      {showForms && (
        <MetaFormSelect label="Meta lead forms (next webinar)" value={nextFormIds} onChange={setNextFormIds} />
      )}
    </div>
  );

  const saveRow = (
    <div className="flex items-center gap-4 pt-1">
      <button
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center gap-2 bg-purple text-white font-sans font-semibold px-6 py-2.5 rounded-pill disabled:opacity-50 hover:bg-purple-700 transition-colors shadow-[0_2px_12px_rgba(91,33,182,0.25)]"
      >
        {saving ? (
          <>
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Saving...
          </>
        ) : 'Save Settings'}
      </button>
      {toast && (
        <span className={`font-sans text-sm font-medium ${toast.ok ? 'text-brand-green' : 'text-red-500'}`}>
          {toast.ok
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1"><polyline points="20 6 9 17 4 12"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          }{toast.msg}
        </span>
      )}
    </div>
  );

  const sessionsPanel = (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <div>
          <h3 style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '1.05rem',
            fontWeight: 800, color: '#3B0764', margin: 0,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: '-3px', marginRight: 6 }}>
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            Webinar Sessions
          </h3>
          <p style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem',
            color: 'rgba(91,33,182,0.45)', margin: '2px 0 0',
          }}>
            Each session tracks its own leads
          </p>
        </div>
        <button
          onClick={fetchWebinars}
          style={{
            padding: '5px 12px', borderRadius: 8, border: 'none',
            background: 'rgba(91,33,182,0.08)', color: '#5B21B6',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.75rem', fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          ↻
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 560, overflowY: 'auto', paddingRight: 4 }}>
        {webinarsLoading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : webinars.length === 0 ? (
          <div style={{
            borderRadius: 14, border: '1px dashed rgba(147,51,234,0.20)',
            padding: '28px 20px', textAlign: 'center',
          }}>
            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'center' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.40)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
              </svg>
            </div>
            <p style={{
              fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
              fontWeight: 600, color: 'rgba(91,33,182,0.50)', margin: 0,
            }}>
              No webinar sessions yet.
            </p>
            <p style={{
              fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem',
              color: 'rgba(91,33,182,0.35)', margin: '4px 0 0',
            }}>
              Pick a date on the left and click "Save Settings".
            </p>
          </div>
        ) : (
          [...webinars].sort((a, b) => {
            const numOf = (w) => {
              const m = /(\d+)\s*$/.exec(w.name || '');
              return m ? parseInt(m[1], 10) : -Infinity;
            };
            const na = numOf(a), nb = numOf(b);
            if (na !== nb) return nb - na;
            return String(b.name || '').localeCompare(String(a.name || ''));
          }).map(w => <WebinarCard key={w.id} webinar={w} />)
        )}
      </div>
    </>
  );

  return (
    <>
      <style>{`
        @keyframes timerPulse { 0%,100%{opacity:1} 50%{opacity:0.45} }
        @media (max-width: 640px) {
          .timer-layout { flex-direction: column !important; gap: 20px !important; }
          .timer-left { flex: 1 1 auto !important; min-width: 0 !important; max-width: 100% !important; }
          .timer-right { min-width: 0 !important; }
          .timer-session-card { padding: 12px 14px !important; }
        }
      `}</style>
      {showForms ? (
      /* ══ META TEMP layout — Current top-left, Upcoming top-right, Sessions bottom ══ */
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Full-width header so both webinar cards top-align in one row */}
        {timerHeader}
      <div className="timer-layout" style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ══ TOP-LEFT — Current Webinar ══ */}
        <div className="timer-left" style={{ flex: '1 1 360px', minWidth: 280 }}>
          <div className="space-y-5">
            {/* Current Webinar */}
            <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors" style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', whiteSpace: 'nowrap', marginBottom: 4 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 20,
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'rgba(5,150,105,0.10)', color: '#059669',
                  flexShrink: 0,
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#059669', display: 'inline-block' }} />
                  Live
                </span>
                <label className="font-sans font-semibold text-purple-900 text-sm" style={{ margin: 0 }}>
                  Current Webinar
                  {activeWebinar?.name && (
                    <span style={{
                      fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700,
                      color: '#059669', marginLeft: 6,
                    }}>
                      ({fmtName(activeWebinar.name)})
                    </span>
                  )}
                </label>
              </div>
              <p className="font-sans text-xs text-purple-400 mb-3">{showForms ? 'Start Date' : 'Registration countdown ends in'}</p>
              <DateTimePicker value={currentWebinar} onChange={setCurrentWebinar} />
              {currentWebinar && (
                <p className="font-sans text-xs text-purple-400 mt-2">
                  {new Date(fromLocalDatetimeValue(currentWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                </p>
              )}

              {/* Actual webinar date — separate from the registration deadline */}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
                <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>{showForms ? 'End Date' : 'Webinar date (when this session actually happens)'}</p>
                <DateTimePicker value={currentWebinarDate} onChange={setCurrentWebinarDate} />
                {currentWebinarDate && (
                  <p className="font-sans text-xs text-purple-400 mt-2">
                    {new Date(fromLocalDatetimeValue(currentWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                  </p>
                )}
              </div>

              {showForms && (
                <MetaFormSelect label="Meta lead forms (current webinar)" value={currentFormIds} onChange={setCurrentFormIds} />
              )}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
                <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar Date &amp; Time</p>
                <DateTimePicker value={currentWebinarDT} onChange={setCurrentWebinarDT} />
              </div>
              <div style={{ marginTop: 14 }}>
                <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar Link</p>
                <input
                  type="text"
                  value={currentWebinarLink}
                  onChange={(e) => setCurrentWebinarLink(e.target.value)}
                  placeholder="https://zoom.us/j/…"
                  style={{ width: '100%', height: '2.6rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            </div>

            {/* Save */}
            <div className="flex items-center gap-4 pt-1">
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-purple text-white font-sans font-semibold px-6 py-2.5 rounded-pill disabled:opacity-50 hover:bg-purple-700 transition-colors shadow-[0_2px_12px_rgba(91,33,182,0.25)]"
              >
                {saving ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                    Saving...
                  </>
                ) : 'Save Settings'}
              </button>
              {toast && (
                <span className={`font-sans text-sm font-medium ${toast.ok ? 'text-brand-green' : 'text-red-500'}`}>
                  {toast.ok
                    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1"><polyline points="20 6 9 17 4 12"/></svg>
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  }{toast.msg}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ══ TOP-RIGHT — Upcoming Webinar ══ */}
        <div className="timer-right" style={{ flex: '1 1 360px', minWidth: 280 }}>
          {/* Next Webinar */}
          <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors" style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 20,
                fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'rgba(37,99,235,0.10)', color: '#2563EB',
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#2563EB', display: 'inline-block' }} />
                Upcoming
              </span>
            </div>
            <label className="block font-sans font-semibold text-purple-900 text-sm mb-1">
              Next Webinar
              {upcomingWebinar?.name && (
                <span style={{
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700,
                  color: '#2563EB', marginLeft: 6,
                }}>
                  ({fmtName(upcomingWebinar.name)})
                </span>
              )}
            </label>
            <p className="font-sans text-xs text-purple-400 mb-3">{showForms ? 'Start Date' : 'Auto-switches when current webinar ends'}</p>
            <DateTimePicker value={nextWebinar} onChange={setNextWebinar} />
            {nextWebinar && (
              <p className="font-sans text-xs text-purple-400 mt-2">
                {new Date(fromLocalDatetimeValue(nextWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
              </p>
            )}

            {/* Actual next-webinar date */}
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
              <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>{showForms ? 'End Date' : 'Webinar date (when next session actually happens)'}</p>
              <DateTimePicker value={nextWebinarDate} onChange={setNextWebinarDate} />
              {nextWebinarDate && (
                <p className="font-sans text-xs text-purple-400 mt-2">
                  {new Date(fromLocalDatetimeValue(nextWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                </p>
              )}
            </div>

            {showForms && (
              <MetaFormSelect label="Meta lead forms (next webinar)" value={nextFormIds} onChange={setNextFormIds} />
            )}
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
              <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar Date &amp; Time</p>
              <DateTimePicker value={nextWebinarDT} onChange={setNextWebinarDT} />
            </div>
            <div style={{ marginTop: 14 }}>
              <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar Link</p>
              <input
                type="text"
                value={nextWebinarLink}
                onChange={(e) => setNextWebinarLink(e.target.value)}
                placeholder="https://zoom.us/j/…"
                style={{ width: '100%', height: '2.6rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ══ BOTTOM — Webinar Sessions (full width) ══ */}
      <div className="bg-white rounded-card border border-purple-100 p-5">
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 14,
          }}>
            <div>
              <h3 style={{
                fontFamily: 'Outfit, sans-serif', fontSize: '1.05rem',
                fontWeight: 800, color: '#3B0764', margin: 0,
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: '-3px', marginRight: 6 }}>
                  <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
                Webinar Sessions
              </h3>
              <p style={{
                fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem',
                color: 'rgba(91,33,182,0.45)', margin: '2px 0 0',
              }}>
                Each session tracks its own leads
              </p>
            </div>
            <button
              onClick={fetchWebinars}
              style={{
                padding: '5px 12px', borderRadius: 8, border: 'none',
                background: 'rgba(91,33,182,0.08)', color: '#5B21B6',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.75rem', fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ↻
            </button>
          </div>

          {/* List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {webinarsLoading ? (
              <>
                <SkeletonCard />
                <SkeletonCard />
              </>
            ) : webinars.length === 0 ? (
              <div style={{
                borderRadius: 14, border: '1px dashed rgba(147,51,234,0.20)',
                padding: '28px 20px', textAlign: 'center',
              }}>
                <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'center' }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.40)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
                  </svg>
                </div>
                <p style={{
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
                  fontWeight: 600, color: 'rgba(91,33,182,0.50)', margin: 0,
                }}>
                  No webinar sessions yet.
                </p>
                <p style={{
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem',
                  color: 'rgba(91,33,182,0.35)', margin: '4px 0 0',
                }}>
                  Pick a date on the left and click "Save Settings".
                </p>
              </div>
            ) : (
              /* Sort by the numeric suffix in the webinar name, DESCENDING —
                 highest number on top (YT-105), lowest at the bottom (YT-101).
                 Falls back to alphabetic compare on the raw name when there's
                 no number to parse, so unnamed rows still sort deterministically. */
              [...webinars].sort((a, b) => {
                const numOf = (w) => {
                  const m = /(\d+)\s*$/.exec(w.name || '');
                  return m ? parseInt(m[1], 10) : -Infinity;
                };
                const na = numOf(a), nb = numOf(b);
                if (na !== nb) return nb - na;
                return String(b.name || '').localeCompare(String(a.name || ''));
              }).map(w => <WebinarCard key={w.id} webinar={w} />)
            )}
          </div>
        </div>

      </div>
      ) : (
      /* ══ Other workspaces — original layout: Current + Upcoming stacked left, Sessions right ══ */
        <div className="timer-layout" style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="timer-left" style={{ flex: '0 0 420px', minWidth: 280 }}>
            <div className="space-y-5">
              {timerHeader}
              {currentCard}
              {nextCard}
              {saveRow}
            </div>
          </div>
          <div className="timer-right" style={{ flex: 1, minWidth: 260 }}>
            {sessionsPanel}
          </div>
        </div>
      )}
    </>
  );
}

const bsInputStyle = {
  width: '100%', height: '2.8rem', padding: '0 12px', borderRadius: 10,
  border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)',
  fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764',
  outline: 'none', boxSizing: 'border-box',
};

/* Brand-styled single-select dropdown — matches the CRM's BrandSelect
   (option panel portaled to <body> so it never gets clipped). Replaces the
   native <select> so the Meta-form list matches the rest of the UI. */
function BrandSelect({ value, onChange, options = [], disabled = false, searchable = false, searchPlaceholder = 'Search…', multiple = false, placeholder = 'Select…' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos]   = useState({ top: 0, left: 0, width: 0, maxH: 280 });
  const wrapRef    = useRef(null);
  const triggerRef = useRef(null);
  const panelRef   = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    // Close on page scroll — but NOT when the scroll happens inside the
    // dropdown's own option list (that was the bug that blocked scrolling).
    function onScroll(e) {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  function toggle() {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const maxH = Math.min(340, Math.max(180, spaceBelow));
      const top  = spaceBelow >= 200 ? r.bottom + 4 : Math.max(8, r.top - maxH - 4);
      setPos({ top, left: r.left, width: r.width, maxH });
      setQuery('');
    }
    setOpen(o => !o);
  }

  const valArr = multiple ? (Array.isArray(value) ? value.map(String) : []) : [];
  const isSelectedVal = (ov) => multiple ? valArr.includes(String(ov)) : String(ov) === String(value);

  function pick(v) {
    if (multiple) {
      const s = String(v);
      onChange(valArr.includes(s) ? valArr.filter(x => x !== s) : [...valArr, s]);
      // keep the panel open so several forms can be ticked in one go
    } else {
      onChange(v); setOpen(false);
    }
  }

  const selected = options.find(o => String(o.value) === String(value));
  const label    = multiple
    ? (valArr.length ? `${valArr.length} form${valArr.length === 1 ? '' : 's'} selected` : '')
    : (selected ? selected.label : '');
  const isPlaceholder = multiple ? valArr.length === 0 : !value;

  const placeholderOpt = options.find(o => o.value === '');
  const realOptions    = options.filter(o => o.value !== '');
  const q = query.trim().toLowerCase();
  const filtered = q ? realOptions.filter(o => String(o.label).toLowerCase().includes(q)) : realOptions;
  const visible  = placeholderOpt ? [placeholderOpt, ...filtered] : filtered;

  const rowFor = (o) => {
    const isSel = isSelectedVal(o.value);
    return (
      <div
        key={String(o.value) || '__none__'}
        onClick={() => pick(o.value)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 12px', cursor: 'pointer',
          fontSize: '0.88rem', color: '#3B0764',
          fontWeight: isSel ? 700 : 500,
          background: isSel ? 'rgba(91,33,182,0.07)' : 'transparent',
          borderBottom: '1px solid rgba(139,92,246,0.07)',
          transition: 'background 120ms',
        }}
        onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'rgba(139,92,246,0.06)'; }}
        onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
      >
        {multiple ? (
          /* Checkbox indicator */
          <span style={{
            width: 16, height: 16, flexShrink: 0, borderRadius: 4,
            border: isSel ? '1px solid #5B21B6' : '1px solid rgba(91,33,182,0.35)',
            background: isSel ? '#5B21B6' : '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {isSel && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff"
                strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        ) : (
          <span style={{ width: 14, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
            {isSel && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {o.label}
        </span>
      </div>
    );
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        style={{
          ...bsInputStyle,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
          opacity: disabled ? 0.6 : 1,
          fontWeight: isPlaceholder ? 400 : 600,
          color: isPlaceholder ? 'rgba(91,33,182,0.50)' : '#3B0764',
          border: open ? '1px solid rgba(91,33,182,0.55)' : bsInputStyle.border,
          boxShadow: open ? '0 0 0 3px rgba(91,33,182,0.10)' : 'none',
          transition: 'border 160ms, box-shadow 160ms',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || placeholder}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 180ms' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: pos.width,
            background: '#fff', border: '1px solid rgba(139,92,246,0.18)', borderRadius: 10,
            boxShadow: '0 14px 44px rgba(91,33,182,0.20)',
            zIndex: 10000, overflow: 'hidden', fontFamily: 'Outfit, sans-serif',
            display: 'flex', flexDirection: 'column', maxHeight: pos.maxH,
          }}
        >
          {searchable && (
            <div style={{ padding: 8, borderBottom: '1px solid rgba(139,92,246,0.12)', flexShrink: 0 }}>
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                style={{
                  width: '100%', height: 34, padding: '0 10px', borderRadius: 8,
                  border: '1px solid rgba(139,92,246,0.25)', outline: 'none',
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', color: '#3B0764',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.7rem', color: 'rgba(91,33,182,0.55)', padding: '6px 2px 0', fontWeight: 600 }}>
                {q ? `${filtered.length} of ${realOptions.length}` : realOptions.length} form{realOptions.length === 1 ? '' : 's'}
              </div>
            </div>
          )}
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {visible.length === 0
              ? <div style={{ padding: '14px 12px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: 'rgba(91,33,182,0.5)' }}>No matches.</div>
              : visible.map(rowFor)}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
