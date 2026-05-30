import { useState, useEffect, useRef } from 'react';
import AdminLogin from './AdminLogin';
import FunnelOverview from './FunnelOverview';
import HomeDashboard from './HomeDashboard';
import LeadsTable from './LeadsTable';
import WhatsAppLinksEditor from './WhatsAppLinksEditor';
import TimerConfig from './TimerConfig';

const TAB_ICONS = {
  funnel: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* Classic funnel silhouette */}
      <path d="M3 4h18l-7 9v7l-4-2v-5L3 4z"/>
    </svg>
  ),
  dashboard: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  ),
  leads: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
      <rect x="9" y="3" width="6" height="4" rx="1"/>
      <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
    </svg>
  ),
  whatsapp: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  ),
  timer: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>
    </svg>
  ),
};

const TABS = [
  { id: 'funnel',    label: 'Funnel' },
  { id: 'dashboard', label: 'Page Performance' },
  { id: 'leads',     label: 'Leads' },
  { id: 'whatsapp',  label: 'WhatsApp Links' },
  { id: 'timer',     label: 'Timer & Controls' },
];

/* ── Change Password Modal ── */
function ChangePwModal({ token, onClose, onSuccess }) {
  const [currentPw, setCurrentPw]   = useState('');
  const [newPw, setNewPw]           = useState('');
  const [confirmPw, setConfirmPw]   = useState('');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [success, setSuccess]       = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew]       = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!currentPw) { setError('Please enter your current password.'); return; }
    if (newPw.length < 6) { setError('New password must be at least 6 characters.'); return; }
    if (newPw !== confirmPw) { setError('New passwords do not match.'); return; }

    setLoading(true);
    try {
      const res = await fetch('/api/admin/change-password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Incorrect current password.');
      } else {
        sessionStorage.setItem('mhs_admin_token', newPw);
        setSuccess(true);
        setTimeout(() => { onSuccess(newPw); onClose(); }, 1600);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    /* backdrop */
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(15,0,40,0.45)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
      }}
    >
      <div style={{
        width: '100%', maxWidth: 400,
        background: '#fff', borderRadius: 20,
        border: '1px solid rgba(147,51,234,0.15)',
        boxShadow: '0 24px 64px rgba(91,33,182,0.22)',
        padding: '32px 28px 28px',
        fontFamily: 'Outfit, sans-serif',
      }}>
        {/* Icon + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: 'linear-gradient(135deg,#5B21B6,#9333EA)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
          </div>
          <div>
            <h2 style={{ fontWeight: 700, fontSize: '1.1rem', color: '#3B0764', margin: 0 }}>Change Password</h2>
            <p style={{ fontSize: '0.75rem', color: 'rgba(91,33,182,0.50)', margin: 0, marginTop: 2 }}>Update your admin password</p>
          </div>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'linear-gradient(135deg,#5B21B6,#9333EA)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>
            </div>
            <p style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem' }}>Password updated!</p>
            <p style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.50)', marginTop: 4 }}>You're all set.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Current password */}
            <div>
              <label style={{ fontSize: '0.76rem', fontWeight: 600, color: '#4A1A94', display: 'block', marginBottom: 5 }}>Current Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPw}
                  onChange={e => setCurrentPw(e.target.value)}
                  placeholder="Enter current password"
                  style={{ width: '100%', height: '2.8rem', padding: '0 40px 0 12px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit,sans-serif', fontSize: '0.9rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
                />
                <button type="button" onClick={() => setShowCurrent(v => !v)} tabIndex={-1}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(91,33,182,0.45)', padding: 2 }}>
                  {showCurrent
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                </button>
              </div>
            </div>

            {/* New password */}
            <div>
              <label style={{ fontSize: '0.76rem', fontWeight: 600, color: '#4A1A94', display: 'block', marginBottom: 5 }}>New Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPw}
                  onChange={e => setNewPw(e.target.value)}
                  placeholder="Min. 6 characters"
                  style={{ width: '100%', height: '2.8rem', padding: '0 40px 0 12px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit,sans-serif', fontSize: '0.9rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
                />
                <button type="button" onClick={() => setShowNew(v => !v)} tabIndex={-1}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(91,33,182,0.45)', padding: 2 }}>
                  {showNew
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                </button>
              </div>
            </div>

            {/* Confirm password */}
            <div>
              <label style={{ fontSize: '0.76rem', fontWeight: 600, color: '#4A1A94', display: 'block', marginBottom: 5 }}>Confirm New Password</label>
              <input
                type="password"
                value={confirmPw}
                onChange={e => setConfirmPw(e.target.value)}
                placeholder="Re-enter new password"
                style={{ width: '100%', height: '2.8rem', padding: '0 12px', borderRadius: 10, border: confirmPw && confirmPw !== newPw ? '1px solid rgba(248,113,113,0.7)' : '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit,sans-serif', fontSize: '0.9rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>

            {error && (
              <p style={{ fontSize: '0.78rem', color: '#EF4444', fontWeight: 500, margin: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span>⚠</span> {error}
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button type="button" onClick={onClose}
                style={{ flex: 1, height: '2.7rem', borderRadius: 50, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.50)', fontFamily: 'Outfit,sans-serif', fontWeight: 600, fontSize: '0.88rem', color: '#5B21B6', cursor: 'pointer' }}>
                Cancel
              </button>
              <button type="submit" disabled={loading}
                style={{ flex: 1, height: '2.7rem', borderRadius: 50, border: 'none', background: loading ? 'rgba(91,33,182,0.55)' : '#5B21B6', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.88rem', color: '#fff', cursor: loading ? 'not-allowed' : 'pointer', boxShadow: '0 4px 16px rgba(91,33,182,0.30)' }}>
                {loading ? 'Saving…' : 'Save Password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════ AdminPage ══════════════════════ */
export default function AdminPage() {
  const [token, setToken]           = useState(() => sessionStorage.getItem('mhs_admin_token') || '');
  const [tab, setTab]               = useState('funnel');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const dropRef = useRef(null);

  useEffect(() => {
    document.body.style.maxWidth = 'none';
    document.body.style.margin = '0';
    return () => {
      document.body.style.maxWidth = '';
      document.body.style.margin = '';
    };
  }, []);

  /* close dropdown on outside click */
  useEffect(() => {
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleLogout() {
    sessionStorage.removeItem('mhs_admin_token');
    setToken('');
  }

  if (!token) return <AdminLogin onLogin={setToken} />;

  return (
    <div className="min-h-screen" style={{ maxWidth: 'none', background: '#EDEAF8' }}>
      <style>{`
        @media (max-width: 640px) {
          .admin-tabs-bar { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
          .admin-tabs-bar::-webkit-scrollbar { display: none; }
          .admin-tab-btn { padding: 8px 10px !important; font-size: 0.75rem !important; gap: 5px !important; }
          .admin-content-card { padding: 16px !important; }
          .admin-outer { padding-left: 12px !important; padding-right: 12px !important; padding-top: 12px !important; }
        }
      `}</style>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 admin-outer">

        {/* ── Top row: Tab bar  +  Profile icon ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 8 }}>

          {/* Tabs */}
          <div className="admin-tabs-bar" style={{ display: 'flex', gap: 4, background: '#fff', borderRadius: 16, padding: 6, boxShadow: '0 2px 12px rgba(91,33,182,0.10)', minWidth: 0, flex: '1 1 0' }}>
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="admin-tab-btn"
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '8px 16px', borderRadius: 12, border: 'none',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.85rem',
                  cursor: 'pointer', transition: 'all 200ms', whiteSpace: 'nowrap', flexShrink: 0,
                  background: tab === t.id ? '#5B21B6' : 'transparent',
                  color:      tab === t.id ? '#fff'    : 'rgba(91,33,182,0.50)',
                  boxShadow:  tab === t.id ? '0 2px 10px rgba(91,33,182,0.30)' : 'none',
                }}
              >
                {TAB_ICONS[t.id]}
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </div>

          {/* Profile avatar + dropdown */}
          <div ref={dropRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setShowDropdown(v => !v)}
              style={{
                background: 'none', border: 'none',
                padding: 0, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: showDropdown ? 0.75 : 1,
                transition: 'opacity 180ms',
              }}
            >
              <img
                src="/favicon.png"
                alt="Admin"
                style={{ width: 36, height: 36, objectFit: 'contain' }}
              />
            </button>

            {/* Dropdown menu */}
            {showDropdown && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                background: '#fff', borderRadius: 14,
                border: '1px solid rgba(209,196,240,0.60)',
                boxShadow: '0 8px 32px rgba(91,33,182,0.18)',
                minWidth: 188, overflow: 'hidden',
                fontFamily: 'Outfit, sans-serif',
                zIndex: 100,
              }}>
                {/* Account label */}
                <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid rgba(209,196,240,0.35)' }}>
                  <p style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.42)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Admin Account</p>
                </div>

                {/* Sign Out */}
                <button
                  onClick={handleLogout}
                  style={{
                    width: '100%', padding: '11px 16px', border: 'none',
                    background: 'transparent', textAlign: 'left',
                    display: 'flex', alignItems: 'center', gap: 10,
                    fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem', fontWeight: 600,
                    color: '#DC2626', cursor: 'pointer',
                    transition: 'background 150ms',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(254,242,242,0.70)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Content card */}
        <div className="bg-white rounded-card shadow-card p-6 admin-content-card">
          {tab === 'funnel'    && <FunnelOverview token={token} />}
          {tab === 'dashboard' && <HomeDashboard token={token} />}
          {tab === 'leads'     && <LeadsTable token={token} />}
          {tab === 'whatsapp'  && <WhatsAppLinksEditor token={token} />}
          {tab === 'timer'     && <TimerConfig token={token} />}
        </div>
      </div>

      {/* Change Password modal */}
      {showChangePw && (
        <ChangePwModal
          token={token}
          onClose={() => setShowChangePw(false)}
          onSuccess={newToken => setToken(newToken)}
        />
      )}
    </div>
  );
}
