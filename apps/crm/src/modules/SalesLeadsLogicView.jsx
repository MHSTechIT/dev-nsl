import { useState, useEffect } from 'react';
import LeadShareLogicModal from './LeadShareLogicModal';
import Toast               from '../components/Toast';

/* ──────────────────────────────────────────────────────────────────────────
   Read-only view of the saved Leads Share Logic configuration.
   Shows per webinar: who's enabled, what lead types each caller accepts,
   their round-robin position, and the cursor's current state.
   ────────────────────────────────────────────────────────────────────────── */

const ROLE_BADGE = {
  junior_caller: { bg: '#FEF9C3', fg: '#A16207', label: 'Junior Caller' },
  senior_caller: { bg: '#FFEDD5', fg: '#C2410C', label: 'Senior Caller' },
};

const LEAD_TYPE_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
  'all':     { bg: '#EDE9FE', fg: '#5B21B6' },
};

export default function SalesLeadsLogicView({ token }) {
  const [webinars, setWebinars]   = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [config, setConfig]       = useState({});       // { webinarId: callers[] }
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [showModal, setShowModal] = useState(false);
  const [toast, setToast]         = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/webinars', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error('Failed to load webinars.');
        const data = await res.json();
        const all  = data.webinars || [];
        const current  = all.find(w => w.is_active);
        const upcoming = all.find(w => !w.is_active && (w.lead_count ?? 0) === 0)
                      || all.find(w => !w.is_active);
        const picked = [current, upcoming].filter(Boolean);
        if (cancelled) return;
        setWebinars(picked);
        setActiveTab(picked[0]?.id || null);
        if (picked.length === 0) { setLoading(false); setError('No webinars found.'); }
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!activeTab || config[activeTab]) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/lead-share-config?webinar_id=${encodeURIComponent(activeTab)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Failed to load configuration.');
        const data = await res.json();
        if (cancelled) return;
        setConfig(prev => ({ ...prev, [activeTab]: data.callers || [] }));
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, config, token]);

  const tabConfig = config[activeTab] || [];
  const enabled   = tabConfig.filter(c => c.enabled && c.is_active);
  const disabled  = tabConfig.filter(c => !c.enabled || !c.is_active);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>{`
        @media (max-width: 700px) {
          .ll-summary-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

      {/* Toolbar: Leads Share Logic button (opens edit modal) + webinar tabs */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: '#fff', borderRadius: 14, padding: 6, boxShadow: '0 2px 12px rgba(91,33,182,0.08)' }}>
        {webinars.map((w, idx) => {
          const active = activeTab === w.id;
          const role = idx === 0 ? 'current webinar' : 'upcoming webinar';
          return (
            <button
              key={w.id}
              onClick={() => setActiveTab(w.id)}
              style={{
                padding: '8px 14px', borderRadius: 10, border: 'none',
                background: active ? '#5B21B6' : 'transparent',
                color:      active ? '#fff'    : 'rgba(91,33,182,0.65)',
                fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.82rem',
                cursor: 'pointer', whiteSpace: 'nowrap',
                boxShadow: active ? '0 2px 10px rgba(91,33,182,0.30)' : 'none',
              }}
            >
              {role} ({(w.name || '').toLowerCase()})
            </button>
          );
        })}
        </div>

        <button
          onClick={() => setShowModal(true)}
          style={{
            padding: '10px 20px', borderRadius: 50, border: 'none',
            background: '#5B21B6', color: '#fff',
            fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(91,33,182,0.30)',
            display: 'inline-flex', alignItems: 'center', gap: 8,
            flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3"/>
            <circle cx="6" cy="12" r="3"/>
            <circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          Leads Share Logic
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* Summary grid */}
      <div className="ll-summary-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Stat label="Eligible Callers" value={enabled.length} accent="#5B21B6" tint="rgba(91,33,182,0.08)" />
        <Stat label="Disabled / Inactive" value={disabled.length} accent="#6B7280" tint="rgba(107,114,128,0.12)" />
        <Stat label="Receive 250+" value={enabled.filter(c => c.allowed_lead_types.includes('all') || c.allowed_lead_types.includes('250+')).length} accent="#B91C1C" tint="rgba(239,68,68,0.10)" />
        <Stat label="Receive 150-250" value={enabled.filter(c => c.allowed_lead_types.includes('all') || c.allowed_lead_types.includes('150-250')).length} accent="#A16207" tint="rgba(245,197,24,0.12)" />
      </div>

      {/* Eligible callers list */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(209,196,240,0.40)' }}>
          <h3 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#3B0764' }}>
            Round-robin queue
          </h3>
          <p style={{ margin: '2px 0 0', fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>
            New leads cycle through these callers in order, skipping anyone whose lead-type filter doesn't match.
          </p>
        </div>

        {loading ? (
          <EmptyBlock>Loading configuration…</EmptyBlock>
        ) : enabled.length === 0 ? (
          <EmptyBlock title="No callers enabled" subtitle='Open "Leads Share Logic" in the Leads tab to add some.' />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <th style={thStyle}>#</th>
                  <th style={thStyle}>Caller</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Receives</th>
                </tr>
              </thead>
              <tbody>
                {enabled.map((c, idx) => {
                  const role = ROLE_BADGE[c.role] || { bg: '#F3F4F6', fg: '#4B5563', label: c.role };
                  return (
                    <tr key={c.caller_id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
                      <td style={{ ...tdStyle, fontWeight: 700, color: '#5B21B6', width: 50 }}>{idx + 1}</td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, color: '#3B0764' }}>{c.full_name}</div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{c.email}</div>
                      </td>
                      <td style={tdStyle}><span style={badgeStyle(role)}>{role.label}</span></td>
                      <td style={tdStyle}>
                        <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                          {c.allowed_lead_types.map(t => {
                            const b = LEAD_TYPE_BADGE[t] || { bg: '#F3F4F6', fg: '#4B5563' };
                            return <span key={t} style={badgeStyle({ ...b, label: t })}>{t}</span>;
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <LeadShareLogicModal
          token={token}
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            setToast('Configuration saved');
            // Force reload of the active tab's config so the view reflects the save
            setConfig(prev => {
              if (!activeTab) return prev;
              const next = { ...prev };
              delete next[activeTab];
              return next;
            });
          }}
        />
      )}

      {toast && <Toast message={toast} kind="success" onDone={() => setToast('')} />}

      {/* Disabled / inactive — collapsed list */}
      {disabled.length > 0 && (
        <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(209,196,240,0.40)' }}>
            <h3 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#3B0764' }}>
              Not in rotation
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>
              These callers won't receive new leads until they're re-enabled and active.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {disabled.map(c => {
              const role = ROLE_BADGE[c.role] || { bg: '#F3F4F6', fg: '#4B5563', label: c.role };
              const reason = !c.is_active ? 'inactive account' : 'disabled in rotation';
              return (
                <div key={c.caller_id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 18px', borderTop: '1px solid rgba(209,196,240,0.30)',
                  fontFamily: 'Outfit, sans-serif',
                  opacity: 0.75,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.86rem' }}>{c.full_name}</span>
                    <span style={badgeStyle(role)}>{role.label}</span>
                  </div>
                  <span style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>{reason}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent, tint }) {
  return (
    <div className="bg-white rounded-card shadow-card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: tint, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span style={{ color: accent, fontWeight: 800, fontSize: '0.95rem' }}>{value}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.74rem', fontWeight: 600, color: 'rgba(91,33,182,0.55)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      </div>
    </div>
  );
}

function EmptyBlock({ title, subtitle, children }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', fontFamily: 'Outfit, sans-serif' }}>
      {children
        ? <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.88rem' }}>{children}</div>
        : <>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.95rem', marginBottom: 6 }}>{title}</div>
            {subtitle && <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>{subtitle}</div>}
          </>
      }
    </div>
  );
}

const thStyle = {
  padding: '12px 16px',
  fontSize: '0.72rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'rgba(91,33,182,0.60)',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '14px 16px',
  fontSize: '0.86rem',
  color: '#3B0764',
  verticalAlign: 'middle',
};

function badgeStyle(b) {
  return {
    display: 'inline-block', padding: '3px 10px', borderRadius: 50,
    fontSize: '0.72rem', fontWeight: 700,
    background: b.bg, color: b.fg,
    whiteSpace: 'nowrap',
  };
}
