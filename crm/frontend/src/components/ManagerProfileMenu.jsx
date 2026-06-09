import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

/* Logo button + profile popover for the manager / TL dashboards — clicking the
   logo reveals the user's name, position, phone and email, plus Settings and
   Sign Out. Shared by SalesDashboardModule (sales) and MarketingModule
   (marketing manager) so both surfaces get the same affordance. */
export default function ManagerProfileMenu({ profile, onSignOut, onOpenSettings }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 16 });
  const wrapRef = useRef(null);
  const btnRef = useRef(null);

  function toggle() {
    setOpen(o => {
      const next = !o;
      if (next && btnRef.current) {
        const r = btnRef.current.getBoundingClientRect();
        setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
      }
      return next;
    });
  }

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    function onScroll() { setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const roleLabel = String(profile?.role || '')
    .split('_').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const iconStroke = { stroke: '#5B21B6', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title="Profile"
        aria-label="Profile"
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          lineHeight: 0, transition: 'transform 150ms',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.06)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        <img src="/favicon.png" alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />
      </button>

      {open && createPortal(
        <div onMouseDown={e => e.stopPropagation()} style={{
          position: 'fixed', top: pos.top, right: pos.right,
          width: 264, background: '#fff', borderRadius: 14,
          border: '1px solid rgba(209,196,240,0.60)',
          boxShadow: '0 16px 48px rgba(91,33,182,0.22)',
          zIndex: 10000, overflow: 'hidden', fontFamily: 'Outfit, sans-serif',
        }}>
          <div style={{ padding: '16px 16px 14px' }}>
            <div style={{ fontWeight: 800, fontSize: '1rem', color: '#3B0764', wordBreak: 'break-word' }}>
              {profile?.full_name || '—'}
            </div>
            {roleLabel && (
              <span style={{
                display: 'inline-block', marginTop: 6, padding: '2px 10px', borderRadius: 50,
                background: 'rgba(91,33,182,0.10)', color: '#5B21B6',
                fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                {roleLabel}
              </span>
            )}
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: '0.82rem', color: 'rgba(59,7,100,0.85)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" {...iconStroke} style={{ flexShrink: 0 }}>
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
                <span style={{ wordBreak: 'break-word' }}>{profile?.phone || 'No phone'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: '0.82rem', color: 'rgba(59,7,100,0.85)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" {...iconStroke} style={{ flexShrink: 0 }}>
                  <rect x="2" y="4" width="20" height="16" rx="2"/>
                  <path d="M22 7l-10 6L2 7"/>
                </svg>
                <span style={{ wordBreak: 'break-word' }}>{profile?.email || '—'}</span>
              </div>
            </div>
          </div>
          {onOpenSettings && (
            <button
              type="button"
              onClick={() => { setOpen(false); onOpenSettings(); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                padding: '11px 16px', border: 'none', borderTop: '1px solid rgba(209,196,240,0.55)',
                background: '#fff', color: '#5B21B6',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.84rem', cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
              Settings
            </button>
          )}
          <button
            type="button"
            onClick={onSignOut}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              padding: '11px 16px', border: 'none', borderTop: '1px solid rgba(209,196,240,0.55)',
              background: 'rgba(254,242,242,0.70)', color: '#DC2626',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.84rem', cursor: 'pointer',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign Out
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
