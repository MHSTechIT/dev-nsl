import { useState, useEffect, useCallback, useRef } from 'react';
import DatePicker from './DatePicker';

/* ── SVG Icons ── */
const Icons = {
  rocket: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
    </svg>
  ),
  blood: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a7 7 0 1 0 0 14A7 7 0 0 0 12 2z" style={{display:'none'}}/>
      <path d="M12 2C6 9 4 13.5 4 16a8 8 0 0 0 16 0c0-2.5-2-7-8-14z"/>
    </svg>
  ),
  xCircle: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>
    </svg>
  ),
  checkCircle: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>
    </svg>
  ),
  ban: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 14.14 14.14"/>
    </svg>
  ),
  clipboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
      <path d="m9 14 2 2 4-4"/>
    </svg>
  ),
  messageCircle: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>
    </svg>
  ),
  youtube: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/>
      <path d="m10 15 5-3-5-3z"/>
    </svg>
  ),
  shoppingBag: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  ),
  eye: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ),
};

/* ── Stat box definitions (funnel order) ── */
const STAT_BOXES = [
  {
    key: 'page_visited',
    label: 'Page Visits',
    sub: 'Total site visitors',
    icon: Icons.eye,
    color: '#0891B2',
    bg: 'rgba(8,145,178,0.08)',
  },
  {
    key: 'cta_clicked',
    label: 'Start Registration',
    sub: 'CTA Button',
    icon: Icons.rocket,
    color: '#5B21B6',
    bg: 'rgba(91,33,182,0.08)',
  },
  {
    key: '__sugar__',
    label: 'Sugar Level Selected',
    sub: '150–250 + 250+ mg/dL',
    icon: Icons.blood,
    color: '#DC2626',
    bg: 'rgba(220,38,38,0.08)',
    combined: ['sugar_150_250', 'sugar_250_plus'],
  },
  {
    key: 'disqualified_no_diabetes',
    label: 'No Diabetes',
    sub: 'Disqualified',
    icon: Icons.xCircle,
    color: '#9CA3AF',
    bg: 'rgba(156,163,175,0.10)',
  },
  {
    key: 'tamil_yes',
    label: 'Tamil: Yes',
    sub: 'Language Qualified',
    icon: Icons.checkCircle,
    color: '#059669',
    bg: 'rgba(5,150,105,0.08)',
  },
  {
    key: 'tamil_no',
    label: 'Tamil: No',
    sub: 'Language Disqualified',
    icon: Icons.ban,
    color: '#9CA3AF',
    bg: 'rgba(156,163,175,0.10)',
  },
  {
    key: 'registration_submitted',
    label: 'Registration Submitted',
    sub: 'Form completed',
    icon: Icons.clipboard,
    color: '#2563EB',
    bg: 'rgba(37,99,235,0.08)',
  },
  {
    key: 'wa_join_clicked',
    label: 'WhatsApp Join Clicked',
    sub: 'Group link opened',
    icon: Icons.messageCircle,
    color: '#16A34A',
    bg: 'rgba(22,163,74,0.08)',
  },
  {
    key: 'youtube_clicked',
    label: 'YouTube Clicked',
    sub: 'Channel link opened',
    icon: Icons.youtube,
    color: '#DC2626',
    bg: 'rgba(220,38,38,0.08)',
  },
  {
    key: 'explore_product_clicked',
    label: 'Explore Products',
    sub: 'Product page opened',
    icon: Icons.shoppingBag,
    color: '#7C3AED',
    bg: 'rgba(124,58,237,0.08)',
  },
];


/* ── Drop-off summary boxes ── */
const DROPOFF_BOXES = [
  {
    label: 'CTA → Sugar Page',
    entered: (c) => c.cta_clicked || 0,
    acted:   (c) => (c.sugar_150_250 || 0) + (c.sugar_250_plus || 0) + (c.disqualified_no_diabetes || 0),
  },
  {
    label: 'Sugar → Tamil Page',
    entered: (c) => (c.sugar_150_250 || 0) + (c.sugar_250_plus || 0) + (c.disqualified_no_diabetes || 0),
    acted:   (c) => (c.tamil_yes || 0) + (c.tamil_no || 0),
  },
  {
    label: 'Tamil → Registration',
    entered: (c) => (c.tamil_yes || 0) + (c.tamil_no || 0),
    acted:   (c) => c.registration_submitted || 0,
  },
  {
    label: 'Registration → WhatsApp',
    entered: (c) => c.registration_submitted || 0,
    acted:   (c) => c.wa_join_clicked || 0,
  },
];

/* ── Helper: format ISO → readable date ── */
function fmtSession(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/* ── Skeleton box ── */
function SkeletonBox() {
  return (
    <div style={{
      borderRadius: 16, border: '1px solid rgba(147,51,234,0.10)',
      background: 'rgba(237,234,248,0.60)', padding: '20px 16px',
      minHeight: 110,
      animation: 'dashPulse 1.4s ease-in-out infinite',
    }} />
  );
}

/* ── Single stat box ── */
function StatBox({ box, counts }) {
  let count = 0;
  if (box.combined) {
    count = box.combined.reduce((s, k) => s + (counts[k] || 0), 0);
  } else {
    count = counts[box.key] || 0;
  }

  return (
    <div style={{
      borderRadius: 16,
      border: '1px solid rgba(147,51,234,0.12)',
      background: '#fff',
      padding: '18px 16px 16px',
      boxShadow: '0 2px 12px rgba(91,33,182,0.07)',
      display: 'flex', flexDirection: 'column', gap: 8,
      transition: 'box-shadow 200ms',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: box.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: box.color,
      }}>
        {box.icon}
      </div>
      <div style={{
        fontFamily: 'Outfit, sans-serif',
        fontSize: '1.9rem', fontWeight: 800,
        color: box.color, lineHeight: 1,
      }}>
        {count.toLocaleString()}
      </div>
      <div>
        <div style={{
          fontFamily: 'Outfit, sans-serif',
          fontSize: '0.80rem', fontWeight: 700,
          color: '#3B0764', lineHeight: 1.2,
        }}>
          {box.label}
        </div>
        <div style={{
          fontFamily: 'Outfit, sans-serif',
          fontSize: '0.68rem', fontWeight: 500,
          color: 'rgba(91,33,182,0.50)', marginTop: 2,
        }}>
          {box.sub}
        </div>
      </div>
    </div>
  );
}

/* ── Drop-off summary box ── */
function DropoffBox({ box, counts }) {
  const entered = box.entered(counts);
  const acted = box.acted(counts);
  const noAction = Math.max(0, entered - acted);
  const pct = entered > 0 ? Math.round((noAction / entered) * 100) : 0;

  const color = pct > 50 ? '#DC2626' : pct > 25 ? '#D97706' : '#059669';
  const bg = pct > 50 ? 'rgba(220,38,38,0.08)' : pct > 25 ? 'rgba(217,119,6,0.08)' : 'rgba(5,150,105,0.08)';
  const ringBg = pct > 50 ? 'rgba(220,38,38,0.12)' : pct > 25 ? 'rgba(217,119,6,0.12)' : 'rgba(5,150,105,0.12)';

  return (
    <div style={{
      borderRadius: 16,
      border: '1px solid rgba(147,51,234,0.12)',
      background: '#fff',
      padding: '18px 16px 16px',
      boxShadow: '0 2px 12px rgba(91,33,182,0.07)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: ringBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: color,
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>
        </svg>
      </div>
      <div style={{
        fontFamily: 'Outfit, sans-serif',
        fontSize: '1.9rem', fontWeight: 800,
        color: color, lineHeight: 1,
      }}>
        {pct}%
      </div>
      <div>
        <div style={{
          fontFamily: 'Outfit, sans-serif',
          fontSize: '0.80rem', fontWeight: 700,
          color: '#3B0764', lineHeight: 1.2,
        }}>
          {box.label}
        </div>
        <div style={{
          fontFamily: 'Outfit, sans-serif',
          fontSize: '0.68rem', fontWeight: 500,
          color: 'rgba(91,33,182,0.50)', marginTop: 2,
        }}>
          {noAction} no action · {entered} entered
        </div>
      </div>
    </div>
  );
}

/* ── Date pill button ── */
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

/* ── Custom Dropdown ── */
function CustomSelect({ value, onChange, options, placeholder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
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

/* ══════════════════ Main component ══════════════════ */
export default function HomeDashboard({ token }) {
  const [counts, setCounts]       = useState({});
  const [sessions, setSessions]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [lastUpdated, setLastUpdated] = useState('');

  const [dateRange, setDateRange] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo]   = useState('');
  const [webinarAt, setWebinarAt] = useState('');

  const fetchDashboard = useCallback(async () => {
    setError('');
    const params = new URLSearchParams();

    if (dateRange === 'today') {
      const d = new Date().toISOString().slice(0, 10);
      params.set('from', d); params.set('to', d);
    } else if (dateRange === 'week') {
      const to = new Date();
      const from = new Date(to); from.setDate(from.getDate() - 6);
      params.set('from', from.toISOString().slice(0, 10));
      params.set('to',   to.toISOString().slice(0, 10));
    } else if (dateRange === 'month') {
      const to = new Date();
      const from = new Date(to.getFullYear(), to.getMonth(), 1);
      params.set('from', from.toISOString().slice(0, 10));
      params.set('to',   to.toISOString().slice(0, 10));
    } else if (dateRange === 'custom' && customFrom) {
      params.set('from', customFrom);
      if (customTo) params.set('to', customTo);
    }
    if (webinarAt) params.set('webinar_at', webinarAt);

    try {
      const res = await fetch(`/api/admin/dashboard?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      setCounts(json.counts || {});
      setSessions(json.sessions || []);
      const now = new Date();
      setLastUpdated(now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    } catch (err) {
      setError('Could not load dashboard data. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [token, dateRange, customFrom, customTo, webinarAt]);

  /* Initial load */
  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  /* Auto-refresh every 30s */
  useEffect(() => {
    const id = setInterval(fetchDashboard, 30_000);
    return () => clearInterval(id);
  }, [fetchDashboard]);

  const inputStyle = {
    height: '2.1rem', borderRadius: 10, border: '1px solid rgba(139,92,246,0.25)',
    padding: '0 10px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
    color: '#3B0764', outline: 'none', background: '#fff', cursor: 'pointer',
  };

  const selectStyle = {
    ...inputStyle, paddingRight: 8, maxWidth: 220,
  };

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <style>{`
        @keyframes dashPulse {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.45; }
        }
        @media (max-width: 640px) {
          .dash-stat-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .dash-dropoff-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .dash-header { flex-direction: column !important; align-items: flex-start !important; gap: 8px !important; }
          .dash-filter-bar { padding: 8px 10px !important; gap: 6px !important; }
        }
        @media (max-width: 380px) {
          .dash-stat-grid { grid-template-columns: 1fr !important; }
          .dash-dropoff-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* ── Header ── */}
      <div className="dash-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 800, color: '#3B0764' }}>
            Page Performance
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.72rem', color: 'rgba(91,33,182,0.50)' }}>
            Button click analytics across all funnel pages
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {lastUpdated && (
            <span style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.45)', whiteSpace: 'nowrap' }}>
              Last updated: {lastUpdated}
            </span>
          )}
          <button
            onClick={fetchDashboard}
            style={{
              height: '2rem', padding: '0 12px', borderRadius: 8, border: 'none',
              background: 'rgba(91,33,182,0.08)', color: '#5B21B6',
              fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── Filter bar — Date Range ── */}
      <div className="dash-filter-bar" style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: 'rgba(237,234,248,0.50)', borderRadius: 14,
        border: '1px solid rgba(139,92,246,0.15)',
        padding: '10px 14px', marginBottom: sessions.length > 0 ? 10 : 24,
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.55)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', whiteSpace: 'nowrap' }}>Date Range</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {[
            { id: 'all',    label: 'All Time' },
            { id: 'today',  label: 'Today' },
            { id: 'week',   label: 'This Week' },
            { id: 'month',  label: 'This Month' },
            { id: 'custom', label: 'Custom' },
          ].map(p => (
            <Pill key={p.id} label={p.label} active={dateRange === p.id} onClick={() => setDateRange(p.id)} />
          ))}
        </div>
        {dateRange === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <DatePicker value={customFrom} onChange={setCustomFrom} placeholder="From date" />
            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.45)', fontWeight: 600 }}>to</span>
            <DatePicker value={customTo} onChange={setCustomTo} placeholder="To date" />
          </div>
        )}
        {(dateRange !== 'all' || webinarAt) && (
          <button onClick={() => { setDateRange('all'); setCustomFrom(''); setCustomTo(''); setWebinarAt(''); }}
            style={{ height: '2.1rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(239,68,68,0.30)', background: 'rgba(254,242,242,0.80)', fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: '#DC2626', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            ✕ Clear
          </button>
        )}
      </div>

      {/* ── Filter bar — Webinar Session ── */}
      {sessions.length > 0 && (
        <div className="dash-filter-bar" style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: 'rgba(237,234,248,0.50)', borderRadius: 14,
          border: '1px solid rgba(139,92,246,0.15)',
          padding: '10px 14px', marginBottom: 24,
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.55)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>
          </svg>
          <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', whiteSpace: 'nowrap' }}>Webinar</span>
          <CustomSelect
            value={webinarAt}
            onChange={setWebinarAt}
            placeholder="All Webinars"
            options={[
              { value: '', label: 'All Webinars' },
              ...sessions.map(s => ({ value: s, label: fmtSession(s) })),
            ]}
          />
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{
          background: 'rgba(254,242,242,0.80)', border: '1px solid rgba(239,68,68,0.30)',
          borderRadius: 12, padding: '12px 16px', marginBottom: 20,
          color: '#DC2626', fontSize: '0.82rem', fontWeight: 600,
        }}>
          {error}
        </div>
      )}

      {/* ── Stat grid ── */}
      <div className="dash-stat-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))',
        gap: 12, marginBottom: 28,
      }}>
        {loading
          ? Array.from({ length: 9 }).map((_, i) => <SkeletonBox key={i} />)
          : STAT_BOXES.map(box => <StatBox key={box.key} box={box} counts={counts} />)
        }
      </div>

      {/* ── Drop-off summary boxes ── */}
      {!loading && (
        <div className="dash-dropoff-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12, marginBottom: 28,
        }}>
          {DROPOFF_BOXES.map(box => (
            <DropoffBox key={box.label} box={box} counts={counts} />
          ))}
        </div>
      )}

    </div>
  );
}
