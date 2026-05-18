import { useState, useEffect, useRef, useCallback } from 'react';
import AdminLogin              from './admin/AdminLogin';
import CallModule              from './modules/CallModule';
import AssignedLeadsModule     from './modules/AssignedLeadsModule';
import UntouchedLeadsModule    from './modules/UntouchedLeadsModule';
import CompletedLeadsModule    from './modules/CompletedLeadsModule';
import NotPickedLeadsModule    from './modules/NotPickedLeadsModule';
import MissedCallsModule       from './modules/MissedCallsModule';
import NextBatchModule         from './modules/NextBatchModule';
import IncomingCallToast       from './components/IncomingCallToast';
import MascotBot               from './components/MascotBot';

const PAGES = [
  {
    id: 'call',
    label: 'Call',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
      </svg>
    ),
  },
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
  {
    id: 'next_batch',
    label: 'Next Batch',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8"  y1="2" x2="8"  y2="6"/>
        <line x1="3"  y1="10" x2="21" y2="10"/>
        <polyline points="9 16 11 18 15 14"/>
      </svg>
    ),
  },
];

const PAGE_TITLES = {
  call:         { title: 'Call',             subtitle: '' },
  assigned:     { title: 'Assigned Leads',   subtitle: 'Leads assigned to you for follow-up' },
  untouched:    { title: 'Untouched',        subtitle: "Leads you haven't contacted yet" },
  completed:    { title: 'Completed Leads',  subtitle: 'Leads you have already handled' },
  not_picked:   { title: 'Not Picked',       subtitle: "Calls that didn't connect" },
  missed_calls: { title: 'Missed Calls',     subtitle: "Customers who called you but weren't picked up" },
  next_batch:   { title: 'Next Batch',       subtitle: "Parked here when Q14 was answered 'Yes' — promoted to Assigned when admin starts a new batch" },
};

export default function CallerShell({ callerName: nameProp, callerRole: roleProp }) {
  const [user, setUser]             = useState(() => {
    const raw = sessionStorage.getItem('mhs_crm_user');
    if (raw) { try { return JSON.parse(raw); } catch { return null; } }
    return null;
  });
  const [activePage, setActive]       = useState('call');
  /* When the Call page's big start button is pressed, we navigate to the
     Assigned tab and flag a one-shot "auto-start me when leads are ready".
     AssignedLeadsModule consumes the flag and clears it on first trigger. */
  const [pendingAutoStart, setPendingAutoStart] = useState(false);
  const requestAutoStart   = useCallback(() => {
    setActive('assigned');
    setPendingAutoStart(true);
  }, []);
  const clearPendingAutoStart = useCallback(() => setPendingAutoStart(false), []);
  const [showDropdown, setShowDropdown] = useState(false);
  /* Hamburger toggle — when true, the tab bar collapses into a single
     three-line button. Defaults to COLLAPSED on every login / refresh so
     the caller sees the clean Call page (robot + Start Call) without the
     tab strip cluttering the layout. Clicking the hamburger expands the
     full tab strip on demand. */
  const [tabsCollapsed, setTabsCollapsed] = useState(true);
  const [externalHighlightId, setExternalHighlightId] = useState(null);
  const dropRef = useRef(null);
  /* Pause state — live-tracked via /api/caller/me + SSE caller.paused / caller.resumed.
     null = unknown (still loading), true = active, false = paused-by-admin. */
  const [isActive, setIsActive] = useState(null);

  /* Mascot mood — purely-visual local state owned by the shell.
     `setMood(mood)`              → switch to mood, stays there.
     `setMood(mood, autoRevertMs)` → switch to mood, auto-revert to 'idle' after Nms.
     Any pending revert timer is cleared on each call. */
  const [mascotMood, setMascotMood] = useState('idle');
  const mascotTimerRef = useRef(null);
  const setMood = useCallback((mood, autoRevertMs) => {
    if (mascotTimerRef.current) {
      clearTimeout(mascotTimerRef.current);
      mascotTimerRef.current = null;
    }
    setMascotMood(mood || 'idle');
    if (mood && mood !== 'idle' && typeof autoRevertMs === 'number' && autoRevertMs > 0) {
      mascotTimerRef.current = setTimeout(() => {
        mascotTimerRef.current = null;
        setMascotMood('idle');
      }, autoRevertMs);
    }
  }, []);
  useEffect(() => () => {
    if (mascotTimerRef.current) clearTimeout(mascotTimerRef.current);
  }, []);

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

  /* Pause check — fetch /api/caller/me on mount and on any caller.paused /
     caller.resumed SSE message. The overlay below renders when is_active is
     explicitly false; null (still loading) renders nothing so we don't flash
     it during the first paint. */
  const jwtForEffect = user ? (sessionStorage.getItem('mhs_crm_token') || '') : '';
  useEffect(() => {
    if (!user || !jwtForEffect) return undefined;
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch('/api/caller/me', {
          headers: { Authorization: `Bearer ${jwtForEffect}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setIsActive(data?.caller?.is_active !== false);
      } catch { /* network blips don't lock anyone out */ }
    }
    refresh();
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwtForEffect)}`;
    const es  = new EventSource(url);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'caller.paused')  setIsActive(false);
        if (msg?.type === 'caller.resumed') setIsActive(true);
      } catch { /* ignore */ }
    };
    return () => { cancelled = true; es.close(); };
  }, [user, jwtForEffect]);

  /* Activity heartbeat — POST /api/caller/heartbeat every 30s reflecting the
     latest activity state stamped into localStorage by AssignedLeadsModule.
     Also fires an immediate heartbeat on any `mhs:activity:changed` window
     event so the admin's Status column reacts within a second to start-call /
     break-start / break-end transitions instead of waiting up to 30s. */
  useEffect(() => {
    if (!user || !jwtForEffect) return undefined;
    const activityKey = (() => {
      try {
        const [, payload] = jwtForEffect.split('.');
        const uid = JSON.parse(atob(payload || ''))?.user_id;
        return uid ? `mhs_activity_${uid}` : 'mhs_activity_anon';
      } catch { return 'mhs_activity_anon'; }
    })();

    function readState() {
      try {
        const raw = localStorage.getItem(activityKey);
        if (!raw) return { status: 'idle', break: null };
        const parsed = JSON.parse(raw);
        return {
          status: parsed?.status || 'idle',
          break:  parsed?.break  || null,
        };
      } catch { return { status: 'idle', break: null }; }
    }

    async function send() {
      const state = readState();
      try {
        await fetch('/api/caller/heartbeat', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtForEffect}` },
          body:    JSON.stringify(state),
        });
      } catch { /* network blips ignored — next tick will retry */ }
    }

    // Fire one heartbeat immediately on mount so the admin sees the caller
    // online without a 30s lag.
    send();

    const intervalId = setInterval(send, 30_000);
    const onChange = () => { send(); };
    window.addEventListener('mhs:activity:changed', onChange);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('mhs:activity:changed', onChange);
    };
  }, [user, jwtForEffect]);

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
        {/* Tab card — wraps a hamburger toggle + the tab buttons.
            When `tabsCollapsed` is true, ONLY the hamburger shows
            (the tabs are removed from layout). Click the hamburger
            to re-expand. */}
        <div
          className="caller-tabs"
          style={{
            display: 'flex',
            alignItems: 'center',
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
          {/* Hamburger — always visible, toggles the tab strip */}
          <button
            type="button"
            onClick={() => setTabsCollapsed(c => !c)}
            aria-label={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
            title={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 38, height: 38, borderRadius: 12, border: 'none',
              cursor: 'pointer', transition: 'background 180ms',
              background: tabsCollapsed ? '#5B21B6' : 'rgba(91,33,182,0.08)',
              color: tabsCollapsed ? '#fff' : '#5B21B6',
              flexShrink: 0,
            }}
            onMouseEnter={e => { if (!tabsCollapsed) e.currentTarget.style.background = 'rgba(91,33,182,0.15)'; }}
            onMouseLeave={e => { if (!tabsCollapsed) e.currentTarget.style.background = 'rgba(91,33,182,0.08)'; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          {!tabsCollapsed && PAGES.map(p => {
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

      {/* ── Page header ──
         The Call page is fullscreen-cinematic on purpose (orbit flow +
         centred glow button), so its header is suppressed. Every other
         page still shows the standard title + subtitle. */}
      {activePage !== 'call' && (
        <div style={{ marginBottom: 16, padding: '0 4px' }}>
          <h1 style={{ margin: 0, fontWeight: 700, fontSize: '1.25rem', color: '#3B0764' }}>
            {PAGE_TITLES[activePage]?.title || 'Dashboard'}
          </h1>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)' }}>
            {PAGE_TITLES[activePage]?.subtitle || ''}
          </p>
        </div>
      )}

      {/* ── Active page ── */}
      {activePage === 'call'         && <CallModule           jwt={jwt} onStartAutoCall={requestAutoStart} />}
      {activePage === 'assigned'     && <AssignedLeadsModule  jwt={jwt} externalHighlightId={externalHighlightId} setMood={setMood} pendingAutoStart={pendingAutoStart} clearPendingAutoStart={clearPendingAutoStart} />}
      {activePage === 'untouched'    && <UntouchedLeadsModule jwt={jwt} />}
      {activePage === 'completed'    && <CompletedLeadsModule jwt={jwt} />}
      {activePage === 'not_picked'   && <NotPickedLeadsModule jwt={jwt} />}
      {activePage === 'missed_calls' && <MissedCallsModule    jwt={jwt} />}
      {activePage === 'next_batch'   && <NextBatchModule      jwt={jwt} />}

      {/* ── Floating incoming-call toasts (top-right, persists across tabs) ── */}
      <IncomingCallToast jwt={jwt} onOpenLead={handleOpenLead} />

      {/* ── Mascot bot (bottom-right) — removed per design.
           The CallModule already shows a much larger version of the same
           bot in the center of the Call page; the corner duplicate just
           competed for attention. Kept the import + setMood plumbing in
           case we want to bring it back behind a toggle later. */}
      {false && <MascotBot mood={mascotMood} />}

      {/* ── Paused-by-admin blocking overlay ──
         Renders only when /api/caller/me reports is_active = false. No dismiss
         button by design — the caller has to wait for admin to resume them.
         z-index sits above every other modal (break-picker is 9700, this is
         9900) so even an in-flight call modal can't be touched. */}
      {isActive === false && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9900,
          background: 'rgba(15,0,40,0.75)',
          backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 16px', fontFamily: 'Outfit, sans-serif',
        }}>
          <div style={{
            width: '100%', maxWidth: 420, background: '#fff', borderRadius: 22,
            padding: '32px 28px', textAlign: 'center',
            boxShadow: '0 32px 80px rgba(15,0,40,0.50)',
          }}>
            <div style={{
              width: 64, height: 64, margin: '0 auto 16px', borderRadius: '50%',
              background: 'rgba(220,38,38,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="#DC2626">
                <rect x="6" y="5" width="4" height="14"/>
                <rect x="14" y="5" width="4" height="14"/>
              </svg>
            </div>
            <h2 style={{ margin: 0, fontWeight: 800, fontSize: '1.18rem', color: '#3B0764' }}>
              You're paused by admin
            </h2>
            <p style={{ margin: '8px 0 0', fontSize: '0.86rem', color: 'rgba(91,33,182,0.70)', lineHeight: 1.5 }}>
              Your account has been temporarily paused. You can't make outbound
              calls or receive new leads until admin resumes you. Please reach
              out to your manager.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
