import { useState } from 'react';
import FunnelOverview      from '../admin/FunnelOverview';
import HomeDashboard       from '../admin/HomeDashboard';
import LeadsTable          from '../admin/LeadsTable';
import WhatsAppLinksEditor from '../admin/WhatsAppLinksEditor';
import TimerConfig         from '../admin/TimerConfig';
import SettingsConfig      from '../admin/SettingsConfig';

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
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
};

const TABS = [
  { id: 'funnel',    label: 'Funnel' },
  { id: 'dashboard', label: 'Page Performance' },
  { id: 'leads',     label: 'Leads' },
  { id: 'whatsapp',  label: 'WhatsApp Links' },
  { id: 'timer',     label: 'Timer & Controls' },
  { id: 'settings',  label: 'Settings' },
];

export default function MarketingModule({ token, source = 'meta' }) {
  const [tab, setTab] = useState('funnel');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <style>{`
        @media (max-width: 640px) {
          .marketing-tabs-bar { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
          .marketing-tabs-bar::-webkit-scrollbar { display: none; }
          .marketing-tab-btn { padding: 8px 10px !important; font-size: 0.75rem !important; gap: 5px !important; }
          .marketing-content-card { padding: 16px !important; }
        }
      `}</style>

      {/* Tab bar */}
      <div className="marketing-tabs-bar" style={{ display: 'flex', gap: 4, background: '#fff', borderRadius: 16, padding: 6, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', minWidth: 0 }}>
        {TABS.map(t => (
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

      {/* Content card */}
      <div className="marketing-content-card bg-white rounded-card shadow-card p-6">
        {tab === 'funnel'    && <FunnelOverview token={token} source={source} />}
        {tab === 'dashboard' && <HomeDashboard token={token} source={source} />}
        {tab === 'leads'     && <LeadsTable token={token} source={source} />}
        {tab === 'whatsapp'  && <WhatsAppLinksEditor token={token} source={source} />}
        {tab === 'timer'     && <TimerConfig token={token} source={source} />}
        {tab === 'settings'  && <SettingsConfig token={token} source={source} />}
      </div>
    </div>
  );
}
