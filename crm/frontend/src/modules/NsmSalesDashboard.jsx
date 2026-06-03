import { useState } from 'react';
import NsmLeadsPage from './NsmLeadsPage';
import NsmLeadsLogicView from './NsmLeadsLogicView';
import NsmSalesPerformanceView from './NsmSalesPerformanceView';
import NsmSalesNewPageView from './NsmSalesNewPageView';
import NsmSalesNotificationsView from './NsmSalesNotificationsView';
import NsmSalesCompletedCallsView from './NsmSalesCompletedCallsView';
import NsmSalesTimerView from './NsmSalesTimerView';
import NsmSalesAlertsView from './NsmSalesAlertsView';

/* NSM-Caller › Web Reminder
   -------------------------
   Independent clone of the Meta Web Reminder (SalesDashboardModule) console —
   same tab UI/layout, but on NSM's own data. The Leads tab runs on nsm_leads
   today; the call/telephony-driven tabs (Performance, Completed Calls,
   Notifications, New Page) and the config tabs (Leads Logic, Timer, Alerts)
   are reserved until NSM's own call layer + config tables are wired (next
   phase). Shares nothing with Meta. */

const TAB_ICONS = {
  performance: (<><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></>),
  newpage:     (<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>),
  leads:       (<><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></>),
  logic:       (<><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></>),
  notifications: (<><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></>),
  completed_calls: (<><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/><polyline points="9 12 11 14 15 10"/></>),
  timer:       (<><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></>),
  alerts:      (<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>),
};

const TABS = [
  { id: 'leads',           label: 'Leads' },
  { id: 'performance',     label: 'Performance' },
  { id: 'newpage',         label: 'New Page' },
  { id: 'logic',           label: 'Leads Logic' },
  { id: 'notifications',   label: 'Notifications' },
  { id: 'completed_calls', label: 'Completed Calls' },
  { id: 'timer',           label: 'Timer' },
  { id: 'alerts',          label: 'Alerts' },
];

const RESERVED = {
  performance:     'Caller performance — needs NSM call records + activity heartbeats.',
  newpage:         'Caller report — needs the NSM call layer.',
  logic:           'Lead → caller assignment rules for NSM batches.',
  notifications:   'Auto-paused caller alerts — needs the NSM call layer.',
  completed_calls: 'Completed call notes + recordings — needs the NSM call layer.',
  timer:           'NSM scheduler / timing configuration.',
  alerts:          'Telegram alert recipients for NSM.',
};

function ReservedView({ label, note }) {
  return (
    <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', minHeight: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 10, padding: 32 }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(91,33,182,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
      </div>
      <h2 style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.15rem', color: '#3B0764', margin: 0 }}>{label} — coming next</h2>
      <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: 'rgba(91,33,182,0.55)', margin: 0, maxWidth: 420 }}>{note}</p>
    </div>
  );
}

export default function NsmSalesDashboard({ token }) {
  const [tab, setTab] = useState('leads');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>{`.nsm-sales-tabs::-webkit-scrollbar{width:0;height:0;display:none}`}</style>

      {/* Sticky tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 30, background: '#EDEAF8', padding: '6px 0' }}>
        <div className="nsm-sales-tabs" style={{ display: 'flex', gap: 4, background: '#fff', borderRadius: 16, padding: 6, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', minWidth: 0, flexShrink: 1, overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {TABS.map(t => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 12, border: 'none', fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', transition: 'all 200ms', whiteSpace: 'nowrap', flexShrink: 0, background: active ? '#5B21B6' : 'transparent', color: active ? '#fff' : 'rgba(91,33,182,0.55)', boxShadow: active ? '0 2px 10px rgba(91,33,182,0.30)' : 'none' }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{TAB_ICONS[t.id]}</svg>
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'leads'           ? <NsmLeadsPage token={token} />
        : tab === 'performance'     ? <NsmSalesPerformanceView token={token} />
        : tab === 'newpage'         ? <NsmSalesNewPageView token={token} />
        : tab === 'logic'           ? <NsmLeadsLogicView token={token} />
        : tab === 'notifications'   ? <NsmSalesNotificationsView token={token} />
        : tab === 'completed_calls' ? <NsmSalesCompletedCallsView token={token} />
        : tab === 'timer'           ? <NsmSalesTimerView token={token} />
        : tab === 'alerts'          ? <NsmSalesAlertsView token={token} />
        : <ReservedView label={TABS.find(t => t.id === tab)?.label || 'View'} note={RESERVED[tab] || ''} />}
    </div>
  );
}
