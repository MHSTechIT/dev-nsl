import { useState, useEffect } from 'react';
import AdminLogin           from './admin/AdminLogin';
import MarketingModule      from './modules/MarketingModule';
import UsersModule          from './modules/UsersModule';
import SalesDashboardModule from './modules/SalesDashboardModule';

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
    label: 'Sales',
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
];

const MODULE_TITLES = {
  marketing: { title: 'Page Performance', subtitle: 'Marketing dashboard' },
  users:     { title: 'Users',            subtitle: 'Manage staff and access' },
  sales:     { title: 'Sales',            subtitle: 'Revenue and pipeline metrics' },
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

export default function CrmShell() {
  const [token, setToken]           = useState(() => sessionStorage.getItem('mhs_admin_token') || '');
  const [activeModule, setActive]   = useState('marketing');
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer

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
          width: 240,
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
        {/* Brand */}
        <div style={{ padding: '24px 20px 18px', borderBottom: '1px solid rgba(209,196,240,0.35)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <img
            src="/favicon.png"
            alt="MHS"
            style={{ width: 40, height: 40, objectFit: 'contain', flexShrink: 0 }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#3B0764' }}>MHS CRM</div>
            <div style={{ fontSize: '0.7rem', color: 'rgba(91,33,182,0.50)' }}>Admin Panel</div>
          </div>
        </div>

        {/* Module list */}
        <nav style={{ padding: '14px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', minHeight: 0 }}>
          <p style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(91,33,182,0.40)', margin: '4px 8px 8px' }}>Modules</p>
          {MODULES.map(m => {
            const isActive = activeModule === m.id;
            return (
              <button
                key={m.id}
                onClick={() => { if (m.enabled) { setActive(m.id); setSidebarOpen(false); } }}
                disabled={!m.enabled}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 12px', borderRadius: 10, border: 'none',
                  background: isActive ? 'rgba(91,33,182,0.10)' : 'transparent',
                  color: isActive ? '#5B21B6' : 'rgba(59,7,100,0.78)',
                  fontFamily: 'Outfit, sans-serif',
                  fontWeight: isActive ? 700 : 600,
                  fontSize: '0.88rem',
                  cursor: m.enabled ? 'pointer' : 'not-allowed',
                  opacity: m.enabled ? 1 : 0.45,
                  textAlign: 'left',
                  transition: 'background 150ms',
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
                <span>{m.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Logout */}
        <div style={{ padding: '12px 12px 18px', borderTop: '1px solid rgba(209,196,240,0.35)' }}>
          <button
            onClick={handleLogout}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', borderRadius: 10, border: 'none',
              background: 'transparent',
              color: '#DC2626',
              fontFamily: 'Outfit,sans-serif', fontWeight: 600, fontSize: '0.86rem',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'background 150ms',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(254,242,242,0.70)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign Out
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
          {activeModule !== 'marketing' && activeModule !== 'sales' && (
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

        {/* Active module */}
        {activeModule === 'marketing' && <MarketingModule token={token} />}
        {activeModule === 'users'     && <UsersModule token={token} />}
        {activeModule === 'sales'     && <SalesDashboardModule token={token} />}
      </main>
    </div>
  );
}
