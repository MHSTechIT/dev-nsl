import { useState, useEffect } from 'react';
import BrandSelect from '../components/BrandSelect';
import ManagerProfileMenu from '../components/ManagerProfileMenu';
import FunnelOverview      from '../admin/FunnelOverview';
import HomeDashboard       from '../admin/HomeDashboard';
import LeadsTable          from '../admin/LeadsTable';
import WhatsAppLinksEditor from '../admin/WhatsAppLinksEditor';
import TimerConfig         from '../admin/TimerConfig';
import SettingsConfig      from '../admin/SettingsConfig';
import AccessView          from '../admin/AccessView';
import WhapiView           from '../admin/WhapiView';

const TAB_ICONS = {
  funnel: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  ),
  access: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
  ),
  whapi: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  ),
};

const TABS = [
  { id: 'funnel',    label: 'Funnel' },
  { id: 'dashboard', label: 'Page Performance' },
  { id: 'leads',     label: 'Leads' },
  { id: 'whatsapp',  label: 'WhatsApp Links' },
  { id: 'timer',     label: 'Timer & Controls' },
  { id: 'settings',  label: 'Alerts' },
  { id: 'access',    label: 'Access' },
  { id: 'whapi',     label: 'Whapi' },
];

const WORKSPACE_OPTS = [
  { id: 'meta',  label: 'Meta' },
  { id: 'yt',    label: 'YT' },
  { id: 'meta2', label: 'Meta 2.0' },
  { id: 'metatemp', label: 'Meta Temp' },
];

export default function MarketingModule({
  token,
  source = 'meta',
  onSourceChange,
  /* When a marketing manager (not the super-admin) is logged in, these are
     provided so the module renders its own profile menu + Sign Out and gates
     its tabs by the manager's crm_users.page_access — mirroring CallerShell
     and the Sales dashboard. Omitted for the super-admin CrmShell, where every
     tab is always shown. */
  profile        = null,
  onSignOut      = null,
  onOpenSettings = null,
}) {
  const [tab, setTab] = useState('funnel');

  /* Funnel + Page Performance are hidden in the Meta Temp workspace. */
  const HIDDEN_IN_METATEMP = ['funnel', 'dashboard'];
  const METATEMP_ONLY = ['whapi']; // Whapi tab only shows in the Meta Temp workspace
  const workspaceTabs = source === 'metatemp'
    ? TABS.filter(t => !HIDDEN_IN_METATEMP.includes(t.id))
    : TABS.filter(t => !METATEMP_ONLY.includes(t.id));

  /* Per-user page access — only when a manager profile is present. Default ON:
     a missing key (or no profile → super-admin) means the tab is shown. The
     Access-panel page ids line up 1:1 with the marketing tab ids. */
  const [pageAccess, setPageAccess] = useState({});
  useEffect(() => {
    if (!profile || !token) return;
    fetch('/api/admin/my-page-access', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setPageAccess(d.page_access || {}))
      .catch(() => {});
  }, [profile, token]);

  const visibleTabs = profile
    ? workspaceTabs.filter(t => pageAccess[t.id] !== false)
    : workspaceTabs;

  /* If the active tab gets hidden by a workspace switch or an access change,
     fall back to the first visible tab. */
  useEffect(() => {
    if (!visibleTabs.some(t => t.id === tab)) setTab(visibleTabs[0]?.id || 'leads');
  }, [source, pageAccess]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <style>{`
        /* Always-on scrollbar hide; overflow itself set inline. */
        .marketing-tabs-bar::-webkit-scrollbar { width: 0; height: 0; display: none; }
        @media (max-width: 640px) {
          .marketing-tab-btn { padding: 8px 10px !important; font-size: 0.75rem !important; gap: 5px !important; }
          .marketing-content-card { padding: 16px !important; }
        }
      `}</style>

      {/* Heading line: tab bar (left) + workspace dropdown (top-right) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'nowrap' }}>
      <div className="marketing-tabs-bar" style={{
        display: 'inline-flex', maxWidth: '100%', gap: 4,
        background: '#fff', borderRadius: 16, padding: 6,
        boxShadow: '0 2px 12px rgba(91,33,182,0.08)',
        minWidth: 0, flexShrink: 1,
        overflowX: 'auto', WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none', msOverflowStyle: 'none',
      }}>
        {visibleTabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="marketing-tab-btn"
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 16px', borderRadius: 12, border: 'none',
              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.85rem',
              cursor: 'pointer', transition: 'all 200ms', whiteSpace: 'nowrap', flexShrink: 0,
              background: tab === t.id ? '#5B21B6' : 'transparent',
              color:      tab === t.id ? '#fff'    : 'rgba(91,33,182,0.55)',
              boxShadow:  tab === t.id ? '0 2px 10px rgba(91,33,182,0.30)' : 'none',
            }}
          >
            {TAB_ICONS[t.id]}
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

        {/* Workspace dropdown — top-right of the heading line. Drives the
            global workspace so it stays in sync with the sidebar switcher. */}
        <div style={{ marginLeft: 'auto', flexShrink: 0, width: 160 }}>
          <BrandSelect
            value={source}
            onChange={(v) => onSourceChange && onSourceChange(v)}
            disabled={!onSourceChange}
            options={WORKSPACE_OPTS.map(o => ({ value: o.id, label: o.label }))}
          />
        </div>

        {/* Profile menu (marketing manager login only) — name, role, Settings,
            Sign Out. Absent for the super-admin CrmShell, which has its own
            sidebar + logout. */}
        {profile && onSignOut && (
          <ManagerProfileMenu profile={profile} onSignOut={onSignOut} onOpenSettings={onOpenSettings} />
        )}
      </div>

      {/* Content card */}
      <div className="marketing-content-card bg-white rounded-card shadow-card p-6">
        {tab === 'funnel'    && <FunnelOverview token={token} source={source} />}
        {tab === 'dashboard' && <HomeDashboard token={token} source={source} />}
        {tab === 'leads'     && <LeadsTable token={token} source={source} />}
        {tab === 'whatsapp'  && <WhatsAppLinksEditor token={token} source={source} />}
        {tab === 'timer'     && <TimerConfig token={token} source={source} />}
        {tab === 'settings'  && <SettingsConfig token={token} source={source} />}
        {tab === 'access'    && <AccessView token={token} pages={workspaceTabs.map(t => ({ id: t.id, label: t.label }))} />}
        {tab === 'whapi'     && <WhapiView token={token} source={source} />}
      </div>
    </div>
  );
}
