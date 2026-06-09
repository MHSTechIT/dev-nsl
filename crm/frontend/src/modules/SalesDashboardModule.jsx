import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import BrandSelect from '../components/BrandSelect';
import ManagerProfileMenu from '../components/ManagerProfileMenu';
import SalesLeadsTable        from './SalesLeadsTable';
import SalesLeadsLogicView    from './SalesLeadsLogicView';
import SalesNotificationsView from './SalesNotificationsView';
import SalesTimerView         from './SalesTimerView';
import SalesAlertsView        from './SalesAlertsView';
import AccessView             from '../admin/AccessView';
import SalesCompletedCallsView from './SalesCompletedCallsView';
import SalesNewPageView       from './SalesNewPageView';
import UsersModule            from './UsersModule';

const TABS = [
  {
    // Lead-ops landing tab (Performance tab was removed). Renders
    // SalesNewPageView. Rename id/label when its scope is finalized.
    id: 'newpage',
    label: 'New Page',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    id: 'leads',
    label: 'Leads',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
        <rect x="9" y="3" width="6" height="4" rx="1"/>
        <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
      </svg>
    ),
  },
  {
    id: 'logic',
    label: 'Leads Logic',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
      </svg>
    ),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
    ),
  },
  {
    // New tab — functionality to be wired in a follow-up. For now it
    // renders a placeholder card so the tab is reachable and the layout
    // is settled.
    id: 'completed_calls',
    label: 'Completed Calls',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        <polyline points="9 12 11 14 15 10"/>
      </svg>
    ),
  },
  {
    id: 'timer',
    label: 'Timer',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9"/>
        <polyline points="12 7 12 12 15 14"/>
      </svg>
    ),
  },
  {
    id: 'alerts',
    label: 'Alerts',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    ),
  },
  {
    id: 'access',
    label: 'Access',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
      </svg>
    ),
  },
];

/* Sales (Web Reminder) pages a manager/TL/admin sales user can be granted/denied. */
const SALES_ACCESS_PAGES = [
  { id: 'newpage',        label: 'New Page' },
  { id: 'leads',          label: 'Leads' },
  { id: 'logic',          label: 'Leads Logic' },
  { id: 'notifications',  label: 'Notifications' },
  { id: 'completed_calls',label: 'Completed Calls' },
  { id: 'timer',          label: 'Timer' },
  { id: 'alerts',         label: 'Alerts' },
  { id: 'users',          label: 'Users' },
];

/* The actual pages a caller sees in the CallerShell login — used for
   junior_caller / senior_caller users in the Access panel. */
const CALLER_ACCESS_PAGES = [
  { id: 'call',         label: 'Call' },
  { id: 'assigned',     label: 'Assigned Leads' },
  { id: 'completed',    label: 'Completed Leads' },
  { id: 'not_picked',   label: 'Not Picked' },
  { id: 'missed_calls', label: 'Missed Calls' },
  { id: 'untouched',    label: 'Untouched' },
  { id: 'next_batch',   label: 'Next Batch' },
];

const CALLER_ROLES = new Set(['junior_caller', 'senior_caller']);
const accessPagesForUser = (u) => (CALLER_ROLES.has(u.role) ? CALLER_ACCESS_PAGES : SALES_ACCESS_PAGES);

/* Manager-mode only — a "User" tab slotted next to Notifications. */
const USER_TAB = {
  id: 'user',
  label: 'User',
  icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  ),
};

export default function SalesDashboardModule({
  token,
  managerMode      = false,   // manager dashboard → adds the User tab + profile menu
  lockedDepartment = null,
  lockedManagerId  = null,
  onSignOut        = null,
  onOpenSettings   = null,
  managerProfile   = null,
  // ── TL (Team Leader) mode ──────────────────────────────────────────
  // Same surface as the super-admin Web Reminder + Manager dashboard,
  // just scoped to a single TL's team. Backend routes detect the
  // team_leader JWT role and add a parallel WHERE team_leader_id = $1
  // to each query. Frontend passes the TL's id down so child views
  // and forms can lock their fields to the right team.
  tlMode             = false,
  lockedTeamLeaderId = null,
  tlProfile          = null,
}) {
  const [tab, setTab] = useState('newpage');
  /* Workspace filter — governs every Web Reminder tab at once. 'all' aggregates
     meta+yt+meta2 (data tabs); concrete sources scope to one workspace.
     Persisted so it survives tab switches / refreshes. */
  const [source, setSource] = useState(() => sessionStorage.getItem('mhs_wr_source') || 'all');
  useEffect(() => { sessionStorage.setItem('mhs_wr_source', source); }, [source]);
  const WORKSPACE_OPTS = [
    { id: 'all',   label: 'All workspaces' },
    { id: 'meta',  label: 'Meta' },
    { id: 'yt',    label: 'YT' },
    { id: 'meta2', label: 'Meta 2.0' },
    { id: 'metatemp', label: 'Meta Temp' },
  ];
  /* Manager mode slots the "User" tab in just before Notifications and drops
     "Timer" — Timer lives in the Settings page (reached via the profile menu).
     Order: New Page · Leads · Leads Logic · User · Notifications.

     TL mode: New Page · Leads · Leads Logic · User · Notifications ·
     Completed Calls. Timer and Alerts are intentionally hidden — TLs
     don't tune global timer config and don't manage Telegram recipients
     (those are manager+ responsibilities). */
  // Slot USER_TAB immediately before the Notifications tab, id-based so the
  // ordering survives tabs being inserted/removed elsewhere in TABS.
  const withUserBeforeNotifications = (list) => {
    const i = list.findIndex(t => t.id === 'notifications');
    return i === -1 ? [...list, USER_TAB] : [...list.slice(0, i), USER_TAB, ...list.slice(i)];
  };
  let tabs;
  if (tlMode) {
    // Drop the 'timer' and 'alerts' tabs from the TL view.
    const tlVisible = TABS.filter(t => t.id !== 'timer' && t.id !== 'alerts');
    tabs = withUserBeforeNotifications(tlVisible);
  } else if (managerMode) {
    // Manager subset: New Page, Leads, Leads Logic, User, Notifications.
    // Timer/Alerts/Completed Calls are intentionally out.
    const mgrIds = ['newpage', 'leads', 'logic', 'notifications'];
    tabs = withUserBeforeNotifications(TABS.filter(t => mgrIds.includes(t.id)));
  } else {
    tabs = TABS;
  }

  /* Per-user page access — mirrors CallerShell. A manager/TL only sees the
     pages left ON in the Access panel (crm_users.page_access). Default ON:
     a missing key (or super-admin, who gets {}) means "shown". The 'user'
     tab maps to the 'users' Access key; every other tab uses its own id. */
  const [pageAccess, setPageAccess] = useState({});
  useEffect(() => {
    if (!(tlMode || managerMode) || !token) return;
    fetch('/api/admin/my-page-access', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setPageAccess(d.page_access || {}))
      .catch(() => {});
  }, [tlMode, managerMode, token]);

  if (tlMode || managerMode) {
    const accessIdOf = (id) => (id === 'user' ? 'users' : id);
    tabs = tabs.filter(t => pageAccess[accessIdOf(t.id)] !== false);
  }

  /* If the active tab got hidden by an access change, fall back to the first
     still-visible tab so the user is never left on a blank panel. */
  useEffect(() => {
    if (tabs.length && !tabs.some(t => t.id === tab)) setTab(tabs[0].id);
  }, [pageAccess]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Convenience: which scoped-profile mode is active? Used for the profile
     menu + downstream prop forwarding. tlProfile takes precedence when
     both are accidentally true (defensive). */
  const profileForMenu = tlMode ? tlProfile : managerProfile;
  const showProfileMenu = (tlMode || managerMode) && onSignOut;
  /* Right-side slot that sits on the same row as the tab bar. The
     Performance view portals its Refresh + Export CSV buttons into this
     slot via the `actionsSlotRef` prop so the actions logically belong
     to that view but visually live up here next to the tabs. The slot is
     re-rendered with `slotEl` state so the child's first portal attempt
     reliably finds the DOM node. */
  const actionsSlotRef = useRef(null);
  const [slotEl, setSlotEl] = useState(null);
  useEffect(() => { setSlotEl(actionsSlotRef.current); }, []);

  /* Auto-pause notification count — polled here in the parent (not just in
     SalesNotificationsView) so the Notifications tab can show a live badge
     even while the user is on another tab. 30 s poll mirrors the view. */
  const [notifCount, setNotifCount] = useState(0);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const loadCount = async () => {
      try {
        // The backend infers the team-leader scope from the JWT itself
        // (no extra query param needed) — same way managerMode works.
        const res = await fetch(`/api/admin/auto-paused-callers?source=${encodeURIComponent(source)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setNotifCount((data.callers || []).length);
      } catch { /* ignore — badge just stays at its last value */ }
    };
    loadCount();
    const id = setInterval(loadCount, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [token, source]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>{`
        /* Always-on horizontal scrollbar hide so the tab pill stays
           inside its white card at every viewport. Overflow itself is
           always-on (set inline below). */
        .sales-tabs-bar::-webkit-scrollbar { width: 0; height: 0; display: none; }
        @media (max-width: 640px) {
          .sales-tab-btn  { padding: 8px 10px !important; font-size: 0.75rem !important; gap: 5px !important; }
        }
      `}</style>

      {/* Tab bar (left) + action slot (right) — one row.
          Sticky-top so it stays visible as the user scrolls the data below. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'nowrap',
        position: 'sticky', top: 0, zIndex: 30,
        background: '#EDEAF8', padding: '6px 0',
      }}>
        <div className="sales-tabs-bar" style={{
          display: 'flex', gap: 4, background: '#fff', borderRadius: 16, padding: 6,
          boxShadow: '0 2px 12px rgba(91,33,182,0.08)',
          minWidth: 0, flexShrink: 1,
          overflowX: 'auto', WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none', msOverflowStyle: 'none',
        }}>
          {tabs.map(t => {
            const isActive = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="sales-tab-btn"
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
                {t.icon}
                <span>{t.label}</span>
                {t.id === 'notifications' && notifCount > 0 && (
                  <span
                    style={{
                      minWidth: 18, height: 18, padding: '0 5px',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: 50, background: '#DC2626', color: '#fff',
                      fontFamily: 'Outfit, sans-serif', fontWeight: 800,
                      fontSize: '0.66rem', lineHeight: 1, flexShrink: 0,
                      boxShadow: isActive ? '0 0 0 2px #5B21B6' : '0 0 0 2px #fff',
                    }}
                  >
                    {notifCount > 99 ? '99+' : notifCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {/* Workspace dropdown — top-right of the tabs line (like Marketing), no label. */}
        <div style={{ marginLeft: 'auto', flexShrink: 0, width: 160 }}>
          <BrandSelect
            value={source}
            onChange={(v) => setSource(v)}
            options={WORKSPACE_OPTS.map(o => ({ value: o.id, label: o.label }))}
          />
        </div>
        <div
          ref={actionsSlotRef}
          style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}
        />
        {showProfileMenu && (
          <ManagerProfileMenu profile={profileForMenu} onSignOut={onSignOut} onOpenSettings={onOpenSettings} />
        )}
      </div>

      {tab === 'newpage'       && <SalesNewPageView       token={token} source={source} />}
      {tab === 'leads'         && <SalesLeadsTable        token={token} source={source} />}
      {tab === 'logic'         && <SalesLeadsLogicView    token={token} source={source} />}
      {tab === 'notifications' && <SalesNotificationsView token={token} source={source} />}
      {tab === 'user'          && (
        <UsersModule
          token={token}
          lockedDepartment={lockedDepartment}
          lockedManagerId={lockedManagerId}
          tlMode={tlMode}
          lockedTeamLeaderId={lockedTeamLeaderId}
          actionsSlotEl={slotEl}
        />
      )}
      {tab === 'completed_calls' && <SalesCompletedCallsView token={token} source={source} />}
      {tab === 'timer'         && <SalesTimerView         token={token} source={source} readOnly={tlMode} />}
      {tab === 'alerts'        && <SalesAlertsView        token={token} source={source} />}
      {tab === 'access'        && <AccessView token={token} department="sales" pages={SALES_ACCESS_PAGES} pagesForUser={accessPagesForUser} />}
    </div>
  );
}
