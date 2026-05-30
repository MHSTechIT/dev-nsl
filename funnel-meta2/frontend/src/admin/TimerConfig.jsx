import { useEffect, useState, useCallback } from 'react';
import DateTimePicker from './DateTimePicker';

function toLocalDatetimeValue(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 16);
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
export default function TimerConfig({ token }) {
  /* ── Left-side state ── */
  const [currentWebinar, setCurrentWebinar] = useState('');         // registration deadline (next_webinar_at)
  const [currentWebinarDate, setCurrentWebinarDate] = useState(''); // actual webinar date (current_webinar_date)
  const [nextWebinar, setNextWebinar] = useState('');               // upcoming registration deadline (backup_webinar_at)
  const [nextWebinarDate, setNextWebinarDate] = useState('');       // upcoming actual webinar date (next_webinar_date)
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    fetch('/api/webinar-config')
      .then(r => r.json())
      .then(d => {
        setCurrentWebinar(toLocalDatetimeValue(d.next_webinar_at));
        setCurrentWebinarDate(toLocalDatetimeValue(d.current_webinar_date));
        setNextWebinar(toLocalDatetimeValue(d.backup_webinar_at));
        setNextWebinarDate(toLocalDatetimeValue(d.next_webinar_date));
      });
  }, []);

  /* ── Right-side state ── */
  const [webinars, setWebinars]           = useState([]);
  const [webinarsLoading, setWebinarsLoading] = useState(true);

  const fetchWebinars = useCallback(async () => {
    setWebinarsLoading(true);
    try {
      const res = await fetch('/api/admin/webinars', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setWebinars(data.webinars || []);
    } catch (_) {
      setWebinars([]);
    } finally {
      setWebinarsLoading(false);
    }
  }, [token]);

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

    const res = await fetch('/api/admin/webinar-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    setSaving(false);
    setToast({ ok: res.ok, msg: res.ok ? 'Settings saved! Countdown timer updated.' : 'Failed to save settings.' });
    setTimeout(() => setToast(null), 3500);

    // Refresh webinar list after save
    if (res.ok) fetchWebinars();
  }

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
      <div className="timer-layout" style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ══ LEFT COLUMN — existing content, zero logic changes ══ */}
        <div className="timer-left" style={{ flex: '0 0 420px', minWidth: 280 }}>
          <div className="space-y-5">
            <div>
              <h3 className="font-sans text-xl font-bold text-purple-900">Webinar Timer</h3>
              <p className="font-sans text-sm text-purple-400 mt-1">
                All times in IST (India Standard Time). Changes update the countdown timer instantly for all visitors.
              </p>
            </div>

            {/* Current Webinar */}
            <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors">
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
              <p className="font-sans text-xs text-purple-400 mb-3">Registration countdown ends in</p>
              <DateTimePicker value={currentWebinar} onChange={setCurrentWebinar} />
              {currentWebinar && (
                <p className="font-sans text-xs text-purple-400 mt-2">
                  {new Date(fromLocalDatetimeValue(currentWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                </p>
              )}

              {/* Actual webinar date (separate from the registration deadline) */}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
                <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar date (when this session actually happens)</p>
                <DateTimePicker value={currentWebinarDate} onChange={setCurrentWebinarDate} />
                {currentWebinarDate && (
                  <p className="font-sans text-xs text-purple-400 mt-2">
                    {new Date(fromLocalDatetimeValue(currentWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                  </p>
                )}
              </div>
            </div>

            {/* Next Webinar */}
            <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors">
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
              <p className="font-sans text-xs text-purple-400 mb-3">Auto-switches when current webinar ends</p>
              <DateTimePicker value={nextWebinar} onChange={setNextWebinar} />
              {nextWebinar && (
                <p className="font-sans text-xs text-purple-400 mt-2">
                  {new Date(fromLocalDatetimeValue(nextWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                </p>
              )}

              {/* Actual next-webinar date */}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
                <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar date (when next session actually happens)</p>
                <DateTimePicker value={nextWebinarDate} onChange={setNextWebinarDate} />
                {nextWebinarDate && (
                  <p className="font-sans text-xs text-purple-400 mt-2">
                    {new Date(fromLocalDatetimeValue(nextWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                  </p>
                )}
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

        {/* ══ RIGHT COLUMN — webinar session history ══ */}
        <div className="timer-right" style={{ flex: 1, minWidth: 260 }}>
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
              webinars.map(w => <WebinarCard key={w.id} webinar={w} />)
            )}
          </div>
        </div>

      </div>
    </>
  );
}
