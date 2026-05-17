import { useState, useRef, useEffect } from 'react';
import SalesLeadsTable        from './SalesLeadsTable';
import SalesLeadsLogicView    from './SalesLeadsLogicView';
import SalesPerformanceView   from './SalesPerformanceView';

const TABS = [
  {
    id: 'performance',
    label: 'Performance',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/>
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
];

export default function SalesDashboardModule({ token }) {
  const [tab, setTab] = useState('performance');
  /* Right-side slot that sits on the same row as the tab bar. The
     Performance view portals its Refresh + Export CSV buttons into this
     slot via the `actionsSlotRef` prop so the actions logically belong
     to that view but visually live up here next to the tabs. The slot is
     re-rendered with `slotEl` state so the child's first portal attempt
     reliably finds the DOM node. */
  const actionsSlotRef = useRef(null);
  const [slotEl, setSlotEl] = useState(null);
  useEffect(() => { setSlotEl(actionsSlotRef.current); }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>{`
        @media (max-width: 640px) {
          .sales-tabs-bar { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
          .sales-tabs-bar::-webkit-scrollbar { display: none; }
          .sales-tab-btn  { padding: 8px 10px !important; font-size: 0.75rem !important; gap: 5px !important; }
        }
      `}</style>

      {/* Tab bar (left) + action slot (right) — one row.
          Sticky-top so it stays visible as the user scrolls the data below. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        position: 'sticky', top: 0, zIndex: 30,
        background: '#EDEAF8', padding: '6px 0',
      }}>
        <div className="sales-tabs-bar" style={{ display: 'flex', gap: 4, background: '#fff', borderRadius: 16, padding: 6, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', minWidth: 0 }}>
          {TABS.map(t => {
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
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <div
          ref={actionsSlotRef}
          style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}
        />
      </div>

      {tab === 'performance' && <SalesPerformanceView token={token} actionsSlotEl={slotEl} />}
      {tab === 'leads'       && <SalesLeadsTable      token={token} />}
      {tab === 'logic'       && <SalesLeadsLogicView  token={token} />}
    </div>
  );
}
