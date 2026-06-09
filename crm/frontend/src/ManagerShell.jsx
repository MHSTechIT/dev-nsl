import { useState, useEffect } from 'react';
import AdminLogin           from './admin/AdminLogin';
import SalesDashboardModule from './modules/SalesDashboardModule';
import MarketingModule      from './modules/MarketingModule';
import ManagerSettings      from './ManagerSettings';

/* ──────────────────────────────────────────────────────────────────────────
   ManagerShell — the dashboard a `manager` lands on after login.

   A single screen: the Web Reminder, whose tab bar carries an extra "User"
   tab (next to Notifications) for managing the department's users. Sign Out
   sits at the top-right of the tab row.

   Auth: gated on the CRM-user JWT (mhs_crm_token) + the stored user, whose
   role must be 'manager'. SalesDashboardModule calls /api/admin/* with that
   JWT — the backend's adminAuth accepts a manager JWT and department-scopes
   the crm-users endpoints.
   ────────────────────────────────────────────────────────────────────────── */

export default function ManagerShell() {
  const [user, setUser] = useState(() => {
    const raw = sessionStorage.getItem('mhs_crm_user');
    if (raw) { try { return JSON.parse(raw); } catch { return null; } }
    return null;
  });
  const jwt = sessionStorage.getItem('mhs_crm_token') || '';
  const [view, setView] = useState('dashboard');   // 'dashboard' | 'settings'
  /* Marketing managers run the Marketing module, which needs a workspace.
     Persisted so it survives refreshes, matching the super-admin shell. */
  const [workspace, setWorkspace] = useState(() => sessionStorage.getItem('mhs_crm_workspace') || 'meta');
  useEffect(() => { sessionStorage.setItem('mhs_crm_workspace', workspace); }, [workspace]);
  const isMarketing = (user?.department || null) === 'marketing';

  useEffect(() => {
    document.body.style.maxWidth   = 'none';
    document.body.style.margin     = '0';
    document.body.style.background = '#EDEAF8';
    return () => {
      document.body.style.maxWidth   = '';
      document.body.style.margin     = '';
      document.body.style.background = '';
    };
  }, []);

  function handleLogout() {
    sessionStorage.removeItem('mhs_crm_user');
    sessionStorage.removeItem('mhs_crm_token');
    setUser(null);
  }

  // Only a logged-in manager may see this shell.
  if (!user || !jwt || user.role !== 'manager') return <AdminLogin />;

  return (
    <div style={{ minHeight: '100vh', background: '#EDEAF8', fontFamily: 'Outfit, sans-serif', padding: '24px clamp(16px, 4vw, 32px)' }}>
      {view === 'settings' ? (
        <ManagerSettings token={jwt} onBack={() => setView('dashboard')} />
      ) : isMarketing ? (
        /* Marketing manager → the Marketing module (Funnel, Page Performance,
           Leads, WhatsApp, Timer, Alerts, Access, Whapi), gated by page_access. */
        <MarketingModule
          token={jwt}
          source={workspace}
          onSourceChange={setWorkspace}
          profile={user}
          onSignOut={handleLogout}
          onOpenSettings={() => setView('settings')}
        />
      ) : (
        <SalesDashboardModule
          token={jwt}
          managerMode
          lockedDepartment={user.department || null}
          lockedManagerId={user.id}
          managerProfile={user}
          onSignOut={handleLogout}
          onOpenSettings={() => setView('settings')}
        />
      )}
    </div>
  );
}
