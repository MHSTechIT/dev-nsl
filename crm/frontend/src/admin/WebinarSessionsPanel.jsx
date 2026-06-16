import { useState, useEffect, useCallback } from 'react';

/* WebinarSessionsPanel — the "Webinar Sessions" list (one card per webinar,
   each tracking its own leads). Self-contained: fetches its own webinars for the
   active workspace (source). Lives on the Zoom page; previously sat under the
   Timer & Controls tab. */

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
export default function WebinarSessionsPanel({ token, source = 'meta' }) {
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

  return (
    <div className="bg-white rounded-card border border-purple-100 p-5">
      <style>{`@keyframes timerPulse { 0%,100%{opacity:1} 50%{opacity:0.45} }
        @media (max-width: 640px) { .timer-session-card { padding: 12px 14px !important; } }`}</style>

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
              Set the webinar date under Timer &amp; Controls to create one.
            </p>
          </div>
        ) : (
          /* Sort by the numeric suffix in the webinar name, DESCENDING —
             highest number on top, lowest at the bottom. Falls back to
             alphabetic compare on the raw name when there's no number. */
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
  );
}
