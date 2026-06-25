import { useState, useEffect } from 'react';
import Toast               from '../components/Toast';

/* ──────────────────────────────────────────────────────────────────────────
   Read-only view of the saved Leads Share Logic configuration.
   Shows per webinar: who's enabled, what lead types each caller accepts,
   their round-robin position, and the cursor's current state.
   ────────────────────────────────────────────────────────────────────────── */

/* Sentinel tab id used when no webinar exists — edits the per-workspace
   Leads-Logic TEMPLATE (saved/loaded with ?source= instead of ?webinar_id=). */
const TEMPLATE_ID = '__template__';

const ROLE_BADGE = {
  junior_caller: { bg: '#FEF9C3', fg: '#A16207', label: 'Junior Caller' },
  senior_caller: { bg: '#FFEDD5', fg: '#C2410C', label: 'Senior Caller' },
};

const LEAD_TYPE_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
  'all':     { bg: '#EDE9FE', fg: '#5B21B6' },
};

const LEAD_TYPES = [
  { value: '250+',    label: '250+',    bg: '#FEE2E2', fg: '#B91C1C' },
  { value: '150-250', label: '150-250', bg: '#FEF9C3', fg: '#A16207' },
  { value: 'all',     label: 'all',     bg: '#EDE9FE', fg: '#5B21B6' },
];

export default function SalesLeadsLogicView({ token, source = 'all' }) {
  const [webinars, setWebinars]   = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [config, setConfig]       = useState({});       // { webinarId: callers[] }
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [toast, setToast]         = useState('');
  /* Inline edit state — editing the round-robin queue on this page. */
  const [editing, setEditing]     = useState(false);
  const [editRows, setEditRows]   = useState([]);   // [{caller_id, full_name, email, role, is_active, enabled, types:Set}]
  const [saving, setSaving]       = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/webinars?source=${encodeURIComponent(source)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error('Failed to load webinars.');
        const data = await res.json();
        const all  = data.webinars || [];
        const now = Date.now();
        const current  = all.find(w => w.is_active);
        // "Upcoming" = an inactive webinar whose date is still in the FUTURE.
        // A past inactive webinar (already happened) is NOT upcoming — showing it
        // made a stale 0-lead past webinar (e.g. aws-113) appear as the current/
        // upcoming card. Only current + a real future webinar should show here.
        const upcoming = all.find(w => !w.is_active && w.webinar_at && new Date(w.webinar_at).getTime() > now);
        const picked = [current, upcoming].filter(Boolean);
        if (cancelled) return;
        // No live/upcoming webinar → fall back to the WORKSPACE TEMPLATE tab so
        // the admin can still set the Leads Logic. Whatever they save here is
        // applied automatically once a webinar is created or promoted.
        if (picked.length === 0) {
          setWebinars([{ id: TEMPLATE_ID, name: 'workspace default', isTemplate: true }]);
          setActiveTab(TEMPLATE_ID);
        } else {
          setWebinars(picked);
          setActiveTab(picked[0]?.id || null);
        }
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [token, source]);

  useEffect(() => {
    if (!activeTab || config[activeTab]) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const qs = activeTab === TEMPLATE_ID
          ? `source=${encodeURIComponent(source)}`
          : `webinar_id=${encodeURIComponent(activeTab)}`;
        const res = await fetch(`/api/admin/lead-share-config?${qs}`, {
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
  }, [activeTab, config, token, source]);

  const tabConfig = config[activeTab] || [];
  /* In rotation = enabled in the lead-share config. A paused (inactive)
     caller still stays in the round-robin — leads queue up for them to work
     on resume — so is_active does NOT affect rotation membership. Only an
     explicitly-disabled config row drops a caller out of rotation. */
  const enabled   = tabConfig.filter(c => c.enabled);
  const disabled  = tabConfig.filter(c => !c.enabled);

  /* ── Inline edit handlers ────────────────────────────────────────────── */
  function startEdit() {
    const rows = (config[activeTab] || []).map(c => ({
      caller_id: c.caller_id,
      full_name: c.full_name,
      email:     c.email,
      role:      c.role,
      is_active: c.is_active,
      enabled:   !!c.enabled,
      types:     new Set(c.allowed_lead_types && c.allowed_lead_types.length ? c.allowed_lead_types : ['all']),
    }));
    setEditRows(rows);
    setEditing(true);
    setError('');
  }
  function cancelEdit() { setEditing(false); setEditRows([]); }

  function toggleRowEnabled(id, value) {
    setEditRows(prev => prev.map(r => (r.caller_id === id ? { ...r, enabled: value } : r)));
  }
  function toggleRowType(id, type, checked) {
    setEditRows(prev => prev.map(r => {
      if (r.caller_id !== id) return r;
      const t = new Set(r.types);
      if (checked) {
        if (type === 'all') { t.clear(); t.add('all'); }
        else { t.delete('all'); t.add(type); }
      } else {
        t.delete(type);
        if (t.size === 0) t.add('all');   // never leave a row with no type
      }
      return { ...r, types: t };
    }));
  }
  function moveRow(idx, dir) {
    setEditRows(prev => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }
  async function saveEdit() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        // Template tab → save to the workspace (source); else per-webinar.
        ...(activeTab === TEMPLATE_ID ? { source } : { webinar_id: activeTab }),
        callers: editRows.map((r, idx) => ({
          caller_id:          r.caller_id,
          enabled:            !!r.enabled,
          // Lead-type filter removed from the UI — every caller receives all.
          allowed_lead_types: ['all'],
          position:           idx,
        })),
      };
      const res = await fetch('/api/admin/lead-share-config', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed.');
      // Drop the cached config so the read-only view reloads the saved state.
      setConfig(prev => { const n = { ...prev }; delete n[activeTab]; return n; });
      setEditing(false);
      setEditRows([]);
      setToast('Configuration saved');
    } catch (e) {
      setError(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

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
          const role = w.isTemplate ? 'leads logic (applies to next webinar)'
                     : idx === 0    ? 'current webinar'
                     :                'upcoming webinar';
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
              {w.isTemplate ? role : `${role} (${(w.name || '').toLowerCase()})`}
            </button>
          );
        })}
        </div>

        {editing ? (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={cancelEdit}
              disabled={saving}
              style={{
                padding: '10px 18px', borderRadius: 50,
                border: '1px solid rgba(91,33,182,0.30)', background: '#fff', color: '#5B21B6',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                cursor: saving ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={saveEdit}
              disabled={saving}
              style={{
                padding: '10px 22px', borderRadius: 50, border: 'none',
                background: saving ? 'rgba(91,33,182,0.55)' : '#5B21B6', color: '#fff',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                cursor: saving ? 'not-allowed' : 'pointer',
                boxShadow: '0 4px 16px rgba(91,33,182,0.30)',
                display: 'inline-flex', alignItems: 'center', gap: 8,
              }}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        ) : (
          <button
            onClick={startEdit}
            disabled={loading || !activeTab}
            style={{
              padding: '10px 20px', borderRadius: 50, border: 'none',
              background: '#5B21B6', color: '#fff',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
              cursor: loading || !activeTab ? 'not-allowed' : 'pointer', opacity: loading || !activeTab ? 0.6 : 1,
              boxShadow: '0 4px 16px rgba(91,33,182,0.30)',
              display: 'inline-flex', alignItems: 'center', gap: 8,
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
            Edit
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* Eligible callers list */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(209,196,240,0.40)' }}>
          <h3 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#3B0764' }}>
            Round-robin queue
          </h3>
          <p style={{ margin: '2px 0 0', fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>
            New leads cycle through these callers in order.
          </p>
        </div>

        {loading ? (
          <EmptyBlock>Loading configuration…</EmptyBlock>
        ) : editing ? (
          editRows.length === 0 ? (
            <EmptyBlock title="No callers found" subtitle="Create callers in the Users module first." />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
                <thead>
                  <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                    <th style={thStyle}>Order</th>
                    <th style={thStyle}>Caller</th>
                    <th style={thStyle}>Role</th>
                    <th style={thStyle}>In rotation</th>
                  </tr>
                </thead>
                <tbody>
                  {editRows.map((r, idx) => {
                    const role = ROLE_BADGE[r.role] || { bg: '#F3F4F6', fg: '#4B5563', label: r.role };
                    return (
                      <tr key={r.caller_id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)', background: r.enabled ? 'rgba(91,33,182,0.03)' : 'transparent' }}>
                        <td style={{ ...tdStyle, width: 92 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 700, color: '#5B21B6', minWidth: 14 }}>{idx + 1}</span>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <button type="button" onClick={() => moveRow(idx, -1)} disabled={idx === 0} title="Move up" style={arrowBtn(idx === 0)}>▲</button>
                              <button type="button" onClick={() => moveRow(idx, 1)} disabled={idx === editRows.length - 1} title="Move down" style={arrowBtn(idx === editRows.length - 1)}>▼</button>
                            </div>
                          </div>
                        </td>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 600, color: '#3B0764' }}>{r.full_name}</div>
                          <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{r.email}</div>
                        </td>
                        <td style={tdStyle}><span style={badgeStyle(role)}>{role.label}</span></td>
                        <td style={tdStyle}>
                          <input type="checkbox" checked={r.enabled} onChange={e => toggleRowEnabled(r.caller_id, e.target.checked)} style={{ width: 18, height: 18, accentColor: '#5B21B6', cursor: 'pointer' }} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : enabled.length === 0 ? (
          <EmptyBlock title="No callers enabled" subtitle='Click "Edit" above to add some.' />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <th style={thStyle}>#</th>
                  <th style={thStyle}>Caller</th>
                  <th style={thStyle}>Role</th>
                  {/* Count of leads in THIS webinar already routed to the
                      caller — lets admins eyeball whether the rotation is
                      balancing fairly. Powered by `assigned_count` from the
                      lead-share-config response. */}
                  <th style={thStyle}>Assigned</th>
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
                      {/* Assigned-count pill. Greys out for zero so the eye
                          immediately spots callers who haven't received any
                          leads yet (often a sign of a stuck round-robin).
                          Coerce `undefined` → 0 so the pill never renders
                          blank if a back-compat backend skips the field. */}
                      <td style={tdStyle}>
                        {(() => {
                          const n = Number(c.assigned_count) || 0;
                          return (
                            <span style={badgeStyle({
                              bg: n > 0 ? '#DDD6FE' : '#F3F4F6',
                              fg: n > 0 ? '#5B21B6' : '#9CA3AF',
                              label: n,
                            })}>
                              {n}
                            </span>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {toast && <Toast message={toast} kind="success" onDone={() => setToast('')} />}

      {/* Disabled / inactive — collapsed list (hidden while editing; the edit
          table already lists every caller) */}
      {!editing && disabled.length > 0 && (
        <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(209,196,240,0.40)' }}>
            <h3 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#3B0764' }}>
              Not in rotation
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>
              These callers won't receive new leads until they're re-enabled in the rotation.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {disabled.map(c => {
              const role = ROLE_BADGE[c.role] || { bg: '#F3F4F6', fg: '#4B5563', label: c.role };
              const reason = 'disabled in rotation';
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

/* Up/down reorder arrow button for the inline edit table. */
function arrowBtn(disabled) {
  return {
    width: 20, height: 16, padding: 0, lineHeight: '14px',
    border: '1px solid rgba(91,33,182,0.25)', borderRadius: 5,
    background: disabled ? 'rgba(237,234,248,0.4)' : '#fff',
    color: disabled ? 'rgba(91,33,182,0.30)' : '#5B21B6',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.6rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
