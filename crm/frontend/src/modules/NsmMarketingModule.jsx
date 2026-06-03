import { useState } from 'react';
import NsmWebinarPage from './NsmWebinarPage';
import NsmLeadsPage from './NsmLeadsPage';
import NsmSettingsPage from './NsmSettingsPage';
import NsmIvrPage from './NsmIvrPage';
import NsmTelePage from './NsmTelePage';

/* NSM-Caller › Marketing
   ----------------------
   A dedicated Marketing surface for the NSM-Caller workspace with three
   sub-pages: Webinar, Leads, Settings. The tab-bar styling mirrors
   MarketingModule so it feels native. Each page is a reserved placeholder
   for now — wire real content in as the spec lands. We deliberately do NOT
   reuse the Meta-scoped admin components here, because the backend's
   getSource() falls back to 'meta' for unknown sources, which would show
   Meta's data under the NSM-Caller label. */

const TAB_ICONS = {
  webinar: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7"/>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
    </svg>
  ),
  leads: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
      <rect x="9" y="3" width="6" height="4" rx="1"/>
      <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
  ivr: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
    </svg>
  ),
  tele: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  ),
};

const TABS = [
  { id: 'webinar',  label: 'Webinar'  },
  { id: 'leads',    label: 'Leads'    },
  { id: 'settings', label: 'Settings' },
];

const TAB_BLURB = {
  webinar:  'Webinar scheduling and details for the NSM-Caller workspace.',
  leads:    'Lead list and management for the NSM-Caller workspace.',
  settings: 'Configuration for the NSM-Caller workspace.',
};

function PlaceholderPage({ label, blurb }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 280, textAlign: 'center', gap: 10 }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(91,33,182,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <polyline points="12 7 12 12 15 14"/>
        </svg>
      </div>
      <h2 style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.15rem', color: '#3B0764', margin: 0 }}>{label} — coming soon</h2>
      <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: 'rgba(91,33,182,0.55)', margin: 0, maxWidth: 380 }}>
        {blurb} Tell me what fields and actions you need, and I'll build it out.
      </p>
    </div>
  );
}

export default function NsmMarketingModule({ token, source = 'nsm-caller', apiBase = '/api/admin/nsm' }) {
  const [tab, setTab] = useState('webinar');
  // Both NSM workspaces get an "IVR" tab after Settings — each schedules
  // Cloudshope calls against its OWN leads (caller → nsm_leads, ivr → nsm_ivr_leads).
  const TABS_ALL = [...TABS, { id: 'ivr', label: 'IVR' }, { id: 'tele', label: 'Tele' }];
  const active = TABS_ALL.find(t => t.id === tab) || TABS_ALL[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <style>{`
        .marketing-tabs-bar::-webkit-scrollbar { width: 0; height: 0; display: none; }
        @media (max-width: 640px) {
          .marketing-tab-btn { padding: 8px 10px !important; font-size: 0.75rem !important; gap: 5px !important; }
          .marketing-content-card { padding: 16px !important; }
        }
      `}</style>

      {/* Tab bar */}
      <div className="marketing-tabs-bar" style={{
        display: 'inline-flex', alignSelf: 'flex-start', maxWidth: '100%', gap: 4,
        background: '#fff', borderRadius: 16, padding: 6,
        boxShadow: '0 2px 12px rgba(91,33,182,0.08)',
        minWidth: 0, flexShrink: 1,
        overflowX: 'auto', WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none', msOverflowStyle: 'none',
      }}>
        {TABS_ALL.map(t => (
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
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content — Webinar + Leads are live pages; Settings is still reserved. */}
      {tab === 'webinar' ? (
        <NsmWebinarPage token={token} apiBase={apiBase} />
      ) : tab === 'leads' ? (
        <NsmLeadsPage token={token} apiBase={apiBase} />
      ) : tab === 'settings' ? (
        <NsmSettingsPage token={token} apiBase={apiBase} />
      ) : tab === 'ivr' ? (
        <NsmIvrPage token={token} apiBase={apiBase} />
      ) : tab === 'tele' ? (
        <NsmTelePage token={token} apiBase={apiBase} />
      ) : (
        <div className="marketing-content-card bg-white rounded-card shadow-card p-6">
          <PlaceholderPage label={active.label} blurb={TAB_BLURB[tab]} />
        </div>
      )}
    </div>
  );
}
