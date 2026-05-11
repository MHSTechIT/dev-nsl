import { useState, useEffect, useRef } from 'react';
import AdminLogin              from './admin/AdminLogin';
import AssignedLeadsModule     from './modules/AssignedLeadsModule';
import UntouchedLeadsModule    from './modules/UntouchedLeadsModule';
import CompletedLeadsModule    from './modules/CompletedLeadsModule';
import NotPickedLeadsModule    from './modules/NotPickedLeadsModule';
import MissedCallsModule       from './modules/MissedCallsModule';
import IncomingCallToast       from './components/IncomingCallToast';

const PAGES = [
  {
    id: 'assigned',
    label: 'Assigned Leads',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2h-4"/>
        <path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2"/>
        <line x1="9" y1="11" x2="15" y2="11"/>
        <line x1="9" y1="15" x2="13" y2="15"/>
      </svg>
    ),
  },
  {
    id: 'completed',
    label: 'Completed Leads',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    ),
  },
  {
    id: 'not_picked',
    label: 'Not Picked',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        <line x1="22" y1="2" x2="2" y2="22"/>
      </svg>
    ),
  },
  {
    id: 'missed_calls',
    label: 'Missed Calls',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        <polyline points="14 2 18 6 22 2"/>
      </svg>
    ),
  },
  {
    id: 'untouched',
    label: 'Untouched',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    ),
  },
];

const PAGE_TITLES = {
  assigned:     { title: 'Assigned Leads',   subtitle: 'Leads assigned to you for follow-up' },
  untouched:    { title: 'Untouched',        subtitle: "Leads you haven't contacted yet" },
  completed:    { title: 'Completed Leads',  subtitle: 'Leads you have already handled' },
  not_picked:   { title: 'Not Picked',       subtitle: "Calls that didn't connect" },
  missed_calls: { title: 'Missed Calls',     subtitle: "Customers who called you but weren't picked up" },
};

export default function CallerShell({ callerName: nameProp, callerRole: roleProp }) {
  const [user, setUser]             = useState(() => {
    const raw = sessionStorage.getItem('mhs_crm_user');
    if (raw) { try { return JSON.parse(raw); } catch { return null; } }
    return null;
  });
  const [activePage, setActive]       = useState('assigned');
  const [showDropdown, setShowDropdown] = useState(false);
  const [externalHighlightId, setExternalHighlightId] = useState(null);
  const dropRef = useRef(null);

  /* Toast → "Open lead" handler: jump to Assigned tab and ask the module
     to highlight the row. The module clears the highlight on its own timer. */
  const handleOpenLead = (leadId) => {
    setActive('assigned');
    setExternalHighlightId(leadId);
    // Reset the marker after 4s so re-clicking the same lead re-triggers
    setTimeout(() => setExternalHighlightId(prev => prev === leadId ? null : prev), 4000);
  };

  useEffect(() => {
    document.body.style.maxWidth = 'none';
    document.body.style.margin   = '0';
    document.body.style.background = '#EDEAF8';
    return () => {
      document.body.style.maxWidth = '';
      document.body.style.margin = '';
      document.body.style.background = '';
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
    sessionStorage.removeItem('mhs_crm_user');
    sessionStorage.removeItem('mhs_crm_token');
    sessionStorage.removeItem('mhs_admin_token');
    setUser(null);
  }

  if (!user) return <AdminLogin />;

  const callerName = user.full_name || nameProp || 'Caller';
  const callerRole = user.role      || roleProp || 'junior_caller';
  const jwt        = sessionStorage.getItem('mhs_crm_token') || '';     // caller JWT for /api/caller/*
  const roleLabel  = (
    callerRole === 'senior_caller' ? 'Senior Caller' :
    callerRole === 'junior_caller' ? 'Junior Caller' :
    callerRole === 'manager'       ? 'Manager' :
    callerRole === 'trainer'       ? 'Trainer' :
    callerRole === 'admin'         ? 'Admin' :
    callerRole === 'team_leader'   ? 'Team Leader' :
    'Team Member'
  );

  return (
    <div style={{ minHeight: '100vh', background: '#EDEAF8', fontFamily: 'Outfit, sans-serif', padding: 16 }}>
      <style>{`
        @media (max-width: 720px) {
          .caller-topbar  { gap: 8px !important; }
          .caller-tabs    { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding: 4px !important; }
          .caller-tabs::-webkit-scrollbar { display: none; }
          .caller-tab-btn { padding: 8px 12px !important; font-size: 0.78rem !important; }
        }
      `}</style>

      {/* ── Top bar: tab card (left/center) + floating logo (right) ── */}
      <div
        className="caller-topbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* White card holds ONLY the tabs */}
        <div
          className="caller-tabs"
          style={{
            display: 'flex',
            gap: 4,
            background: '#fff',
            borderRadius: 16,
            padding: 6,
            border: '1px solid rgba(209,196,240,0.40)',
            boxShadow: '0 8px 32px rgba(91,33,182,0.10), 0 2px 8px rgba(91,33,182,0.04)',
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          {PAGES.map(p => {
            const isActive = activePage === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setActive(p.id)}
                className="caller-tab-btn"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '8px 16px', borderRadius: 12, border: 'none',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.85rem',
                  cursor: 'pointer', transition: 'all 200ms', whiteSpace: 'nowrap', flexShrink: 0,
                  background: isActive ? '#5B21B6' : 'transparent',
                  color:      isActive ? '#fff'    : 'rgba(91,33,182,0.55)',
                  boxShadow:  isActive ? '0 2px 10px rgba(91,33,182,0.30)' : 'none',
                }}
              >
                {p.icon}
                <span>{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* Floating logo (no card) on the right — click toggles dropdown */}
        <div ref={dropRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setShowDropdown(v => !v)}
            aria-label="Account menu"
            title="Account menu"
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: showDropdown ? 0.75 : 1,
              transition: 'opacity 180ms',
            }}
          >
            <img
              src="/favicon.png"
              alt="MHS"
              style={{ width: 40, height: 40, objectFit: 'contain' }}
            />
          </button>

          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 10px)',
                right: 0,
                minWidth: 220,
                background: '#fff',
                borderRadius: 14,
                border: '1px solid rgba(209,196,240,0.60)',
                boxShadow: '0 16px 48px rgba(91,33,182,0.20)',
                overflow: 'hidden',
                zIndex: 100,
                fontFamily: 'Outfit, sans-serif',
              }}
            >
              {/* User identity */}
              <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid rgba(209,196,240,0.40)' }}>
                <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(91,33,182,0.45)', marginBottom: 4 }}>
                  Signed in as
                </div>
                <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#3B0764', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {callerName}
                </div>
                <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)', marginTop: 2 }}>
                  {roleLabel}
                </div>
                {user.email && (
                  <div style={{ fontSize: '0.7rem', color: 'rgba(91,33,182,0.45)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {user.email}
                  </div>
                )}
              </div>

              {/* Sign out */}
              <button
                onClick={handleLogout}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  border: 'none',
                  background: 'transparent',
                  textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 10,
                  fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem', fontWeight: 600,
                  color: '#DC2626',
                  cursor: 'pointer',
                  transition: 'background 150ms',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(254,242,242,0.70)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Page header ── */}
      <div style={{ marginBottom: 16, padding: '0 4px' }}>
        <h1 style={{ margin: 0, fontWeight: 700, fontSize: '1.25rem', color: '#3B0764' }}>
          {PAGE_TITLES[activePage]?.title || 'Dashboard'}
        </h1>
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)' }}>
          {PAGE_TITLES[activePage]?.subtitle || ''}
        </p>
      </div>

      {/* ── Active page ── */}
      {activePage === 'assigned'     && <AssignedLeadsModule  jwt={jwt} externalHighlightId={externalHighlightId} />}
      {activePage === 'untouched'    && <UntouchedLeadsModule jwt={jwt} />}
      {activePage === 'completed'    && <CompletedLeadsModule jwt={jwt} />}
      {activePage === 'not_picked'   && <NotPickedLeadsModule jwt={jwt} />}
      {activePage === 'missed_calls' && <MissedCallsModule    jwt={jwt} />}

      {/* ── Floating incoming-call toasts (top-right, persists across tabs) ── */}
      <IncomingCallToast jwt={jwt} onOpenLead={handleOpenLead} />
    </div>
  );
}
