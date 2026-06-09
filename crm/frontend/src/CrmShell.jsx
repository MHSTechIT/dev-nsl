import { useState, useEffect } from 'react';
import AdminLogin           from './admin/AdminLogin';
import SaveSuccess          from './components/SaveSuccess';
import MarketingModule      from './modules/MarketingModule';
import UsersModule          from './modules/UsersModule';
import SalesDashboardModule from './modules/SalesDashboardModule';
import ZoomModule           from './modules/ZoomModule';

const MODULES = [
  {
    id: 'marketing',
    label: 'Marketing',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 11l18-8-3 18-7-3-2 5-2-7-4-2 0-3z"/>
      </svg>
    ),
    enabled: true,
  },
  {
    id: 'users',
    label: 'Users',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 00-3-3.87"/>
        <path d="M16 3.13a4 4 0 010 7.75"/>
      </svg>
    ),
    enabled: true,
  },
  {
    id: 'sales',
    label: 'Web Reminder',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/>
        <line x1="12" y1="20" x2="12" y2="4"/>
        <line x1="6"  y1="20" x2="6"  y2="14"/>
        <line x1="3"  y1="20" x2="21" y2="20"/>
      </svg>
    ),
    enabled: true,
  },
  {
    id: 'zoom',
    label: 'Zoom',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="23 7 16 12 23 17 23 7"/>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
    ),
    enabled: true,
  },
];

const MODULE_TITLES = {
  marketing: { title: 'Page Performance', subtitle: 'Marketing dashboard' },
  users:     { title: 'Users',            subtitle: 'Manage staff and access' },
  sales:     { title: 'Web Reminder',     subtitle: 'Revenue and pipeline metrics' },
  zoom:      { title: 'Zoom',             subtitle: 'Webinar & meeting integration' },
};

function ComingSoonPanel({ label }) {
  return (
    <div className="bg-white rounded-card shadow-card p-6" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 320, textAlign: 'center', gap: 10 }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(91,33,182,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <polyline points="12 7 12 12 15 14"/>
        </svg>
      </div>
      <h2 style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.15rem', color: '#3B0764', margin: 0 }}>{label} — coming soon</h2>
      <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: 'rgba(91,33,182,0.55)', margin: 0, maxWidth: 360 }}>
        This module is reserved. Tell me what fields and actions you need, and I'll build it out.
      </p>
    </div>
  );
}

const WORKSPACES = [
  { id: 'meta',       label: 'Meta'       },
  { id: 'yt',         label: 'YT'         },
  { id: 'meta2',      label: 'Meta 2.0'   },
  { id: 'metatemp',   label: 'Meta Temp'  },
];

export default function CrmShell() {
  /* Global "save success" animation — wrap window.fetch while the admin shell
     is mounted and fire `mhs:saved` on any successful admin mutation
     (POST/PUT/PATCH to /api/admin/*). SaveSuccess (rendered below) plays the
     tick animation. Restored on unmount, so the caller login is never affected. */
  useEffect(() => {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const res = await orig(...args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const method = String(
          (args[1] && args[1].method) || (typeof args[0] === 'object' && args[0] && args[0].method) || 'GET'
        ).toUpperCase();
        if (res && res.ok && /^(POST|PUT|PATCH)$/.test(method) && url.includes('/api/admin/')) {
          window.dispatchEvent(new Event('mhs:saved'));
        }
      } catch { /* observation only — never break the request */ }
      return res;
    };
    return () => { window.fetch = orig; };
  }, []);

  const [token, setToken]           = useState(() => sessionStorage.getItem('mhs_admin_token') || '');
  const [activeModule, setActive]   = useState('marketing');
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const [workspace, setWorkspace]   = useState(() => sessionStorage.getItem('mhs_crm_workspace') || 'meta');
  const [wsOpen, setWsOpen]         = useState(false);
  /* Collapsed sidebar — clicking the brand row toggles between full (200px)
     and rail (72px). Persisted across sessions. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => sessionStorage.getItem('mhs_crm_sidebar_collapsed') === '1'
  );
  useEffect(() => {
    sessionStorage.setItem('mhs_crm_sidebar_collapsed', sidebarCollapsed ? '1' : '0');
    // Close any open workspace dropdown when collapsing so its panel doesn't
    // hang over the icon rail awkwardly.
    if (sidebarCollapsed) setWsOpen(false);
  }, [sidebarCollapsed]);

  useEffect(() => { sessionStorage.setItem('mhs_crm_workspace', workspace); }, [workspace]);

  useEffect(() => {
    if (!wsOpen) return;
    function onDocClick() { setWsOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [wsOpen]);

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

  function handleLogout() {
    sessionStorage.removeItem('mhs_admin_token');
    setToken('');
  }

  if (!token) return <AdminLogin onLogin={setToken} />;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#EDEAF8', fontFamily: 'Outfit, sans-serif', padding: 16, gap: 16 }}>
      {/* Global save-success tick animation (plays on any admin save). */}
      <SaveSuccess />
      <style>{`
        @media (max-width: 900px) {
          .crm-shell-row { padding: 0 !important; gap: 0 !important; }
          .crm-sidebar {
            position: fixed !important;
            top: 12px; left: 12px; bottom: 12px;
            transform: translateX(calc(-100% - 16px));
            transition: transform 220ms ease;
            z-index: 60;
          }
          .crm-sidebar.open { transform: translateX(0); }
          .crm-main { padding: 16px !important; }
          .crm-hamburger { display: inline-flex !important; }
          .crm-backdrop { display: block !important; }
        }
        .crm-hamburger { display: none; }
        .crm-backdrop { display: none; position: fixed; inset: 0; background: rgba(15,0,40,0.35); z-index: 50; }
      `}</style>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div className="crm-backdrop" style={{ display: 'block' }} onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar (floating card — full viewport height, content scrolls inside) */}
      <aside
        className={`crm-sidebar ${sidebarOpen ? 'open' : ''}`}
        style={{
          width: sidebarCollapsed ? 72 : 200,
          transition: 'width 220ms ease',
          background: '#fff',
          borderRadius: 20,
          border: '1px solid rgba(209,196,240,0.40)',
          boxShadow: '0 8px 32px rgba(91,33,182,0.10), 0 2px 8px rgba(91,33,182,0.04)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          position: 'sticky',
          top: 16,
          height: 'calc(100vh - 32px)',
          overflow: 'hidden',
        }}
      >
        {/* Brand — click to toggle collapsed/expanded */}
        <button
          type="button"
          onClick={() => setSidebarCollapsed(c => !c)}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            padding: sidebarCollapsed ? '24px 0 18px' : '24px 20px 18px',
            borderBottom: '1px solid rgba(209,196,240,0.35)',
            border: 'none', borderRadius: 0,
            background: 'transparent', cursor: 'pointer',
            display: 'flex', alignItems: 'center',
            gap: sidebarCollapsed ? 0 : 12,
            justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            width: '100%', textAlign: 'left',
            transition: 'background 150ms, padding 220ms',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,33,182,0.04)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <img
            src="/favicon.png"
            alt="MHS"
            style={{ width: 40, height: 40, objectFit: 'contain', flexShrink: 0 }}
          />
          {!sidebarCollapsed && (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#3B0764' }}>MHS CRM</div>
              <div style={{ fontSize: '0.7rem', color: 'rgba(91,33,182,0.50)' }}>Admin Panel</div>
            </div>
          )}
        </button>

        {/* Module list */}
        <nav style={{ padding: sidebarCollapsed ? '14px 6px' : '14px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', minHeight: 0 }}>
          {/* Workspace switcher removed from the sidebar per request. The active
              workspace stays in `workspace` state (default Meta) and is switched
              from the module-level dropdowns (Marketing / Sales). */}

          {/* The sidebar always shows every module regardless of the selected
              workspace — switching workspace inside Marketing must not change
              the sidebar. (Non-Meta data panels still fall back to their own
              placeholders where applicable.) */}
          {MODULES.map(m => {
            const isActive = activeModule === m.id;
            return (
              <button
                key={m.id}
                onClick={() => { if (m.enabled) { setActive(m.id); setSidebarOpen(false); } }}
                disabled={!m.enabled}
                title={sidebarCollapsed ? m.label : undefined}
                style={{
                  display: 'flex', alignItems: 'center',
                  gap: sidebarCollapsed ? 0 : 12,
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                  padding: sidebarCollapsed ? '12px 8px' : '10px 12px',
                  borderRadius: 10, border: 'none',
                  background: isActive ? 'rgba(91,33,182,0.10)' : 'transparent',
                  color: isActive ? '#5B21B6' : 'rgba(59,7,100,0.78)',
                  fontFamily: 'Outfit, sans-serif',
                  fontWeight: isActive ? 700 : 600,
                  fontSize: '0.88rem',
                  cursor: m.enabled ? 'pointer' : 'not-allowed',
                  opacity: m.enabled ? 1 : 0.45,
                  textAlign: 'left',
                  transition: 'background 150ms, gap 200ms, padding 200ms',
                  position: 'relative',
                }}
                onMouseEnter={e => { if (m.enabled && !isActive) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
                onMouseLeave={e => { if (m.enabled && !isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                {/* Active indicator */}
                {isActive && (
                  <span style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 4, background: '#5B21B6' }} />
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, color: isActive ? '#5B21B6' : 'rgba(91,33,182,0.55)' }}>
                  {m.icon}
                </span>
                {!sidebarCollapsed && <span>{m.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Logout */}
        <div style={{ padding: sidebarCollapsed ? '12px 6px 18px' : '12px 12px 18px', borderTop: '1px solid rgba(209,196,240,0.35)' }}>
          <button
            onClick={handleLogout}
            title={sidebarCollapsed ? 'Sign Out' : undefined}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center',
              gap: sidebarCollapsed ? 0 : 10,
              justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
              padding: sidebarCollapsed ? '12px 8px' : '10px 12px',
              borderRadius: 10, border: 'none',
              background: 'transparent',
              color: '#DC2626',
              fontFamily: 'Outfit,sans-serif', fontWeight: 600, fontSize: '0.86rem',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'background 150ms, gap 200ms, padding 200ms',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(254,242,242,0.70)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            {!sidebarCollapsed && <span>Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="crm-main" style={{ flex: 1, padding: 28, minWidth: 0 }}>
        {/* Top bar with hamburger (mobile only) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: (activeModule === 'marketing' || activeModule === 'sales') ? 0 : 20 }}>
          <button
            className="crm-hamburger"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            style={{
              width: 40, height: 40, borderRadius: 10, border: 'none',
              background: '#fff', boxShadow: '0 2px 10px rgba(91,33,182,0.10)',
              alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: '#5B21B6',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
          {workspace === 'yt' && activeModule !== 'marketing' && activeModule !== 'users' && activeModule !== 'sales' ? (
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ margin: 0, fontWeight: 700, fontSize: '1.25rem', color: '#3B0764' }}>YT · {MODULE_TITLES[activeModule]?.title || 'Dashboard'}</h1>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)' }}>YouTube workspace</p>
            </div>
          ) : (activeModule !== 'marketing' && activeModule !== 'sales' && activeModule !== 'users') && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ margin: 0, fontWeight: 700, fontSize: '1.25rem', color: '#3B0764' }}>
                {MODULE_TITLES[activeModule]?.title || 'Dashboard'}
              </h1>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)' }}>
                {MODULE_TITLES[activeModule]?.subtitle || ''}
              </p>
            </div>
          )}
        </div>

        {/* Active module — Marketing is wired for both Meta and YT (filtered by source).
            Users + Sales are Meta-only for now; YT shows a coming-soon placeholder. */}
        <>
          {activeModule === 'marketing' && <MarketingModule token={token} source={workspace} onSourceChange={setWorkspace} />}
          {/* Users (user management) and Web Reminder (sales dashboard) both
              already aggregate every workspace's data, so they render in ALL
              workspaces — not just Meta. Users lists every workspace's users
              (workspace={null}); the sales dashboard has its own workspace filter. */}
          {activeModule === 'users' && <UsersModule token={token} workspace={null} />}
          {activeModule === 'sales' && <SalesDashboardModule token={token} />}
          {activeModule === 'zoom' && <ZoomModule token={token} source={workspace} />}
        </>
      </main>
    </div>
  );
}
