import { useState, useEffect, useCallback, useMemo } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
   Lead Share Logic Modal
   ──────────────────────────────────────────────────────────────────────────
   - Loads webinars (active + most recent backup) and per-webinar share config.
   - Each webinar tab keeps its own state (callers Map).
   - Save persists the active tab's config; round-robin cursor resets server-side.
   - Filters callers to junior_caller / senior_caller only (via /lead-share-config
     which already restricts the role list).
   - Default state when a caller has no saved config: enabled=true, types=['all'].
   ────────────────────────────────────────────────────────────────────────── */

const LEAD_TYPES = [
  { value: '250+',    label: '250+',    bg: '#FEE2E2', fg: '#B91C1C' },
  { value: '150-250', label: '150-250', bg: '#FEF9C3', fg: '#A16207' },
  { value: 'all',     label: 'all',     bg: '#EDE9FE', fg: '#5B21B6' },
];

const ROLE_BADGE = {
  junior_caller: { bg: '#FEF9C3', fg: '#A16207', label: 'Junior Caller' },
  senior_caller: { bg: '#FFEDD5', fg: '#C2410C', label: 'Senior Caller' },
};

export default function LeadShareLogicModal({ token, onClose, onSaved }) {
  const [webinars, setWebinars]   = useState([]);
  const [activeTab, setActiveTab] = useState(null);  // webinar id
  /* state per webinar: { [webinarId]: { byCaller: Map<id, { enabled, types: Set }>, callers: [] } } */
  const [tabs, setTabs]           = useState({});
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  /* 1. Load webinars and pick current + upcoming */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/webinars', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error('Failed to load webinars.');
        const data = await res.json();
        const all  = data.webinars || [];
        // current = active; upcoming = most recent inactive with zero leads,
        // fallback to most recently created inactive
        const current  = all.find(w => w.is_active);
        const upcoming = all.find(w => !w.is_active && (w.lead_count ?? 0) === 0)
                      || all.find(w => !w.is_active);
        const picked = [current, upcoming].filter(Boolean);
        if (cancelled) return;
        if (picked.length === 0) {
          setError('No webinars found. Create one in the Timer tab first.');
          setLoading(false);
          return;
        }
        setWebinars(picked);
        setActiveTab(picked[0].id);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load webinars.');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  /* 2. Lazy-load each tab's config when first opened */
  useEffect(() => {
    if (!activeTab || tabs[activeTab]) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/lead-share-config?webinar_id=${encodeURIComponent(activeTab)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Failed to load configuration.');
        const data = await res.json();
        if (cancelled) return;
        const callers = data.callers || [];
        const byCaller = new Map();
        for (const c of callers) {
          byCaller.set(c.caller_id, {
            enabled: c.enabled,
            types:   new Set(c.allowed_lead_types || ['all']),
            position: c.position,
          });
        }
        setTabs(prev => ({ ...prev, [activeTab]: { callers, byCaller } }));
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e.message || 'Failed to load.'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, tabs, token]);

  const tab = tabs[activeTab];

  const filteredCallers = useMemo(() => {
    if (!tab) return [];
    const q = search.trim().toLowerCase();
    if (!q) return tab.callers;
    return tab.callers.filter(c => (c.full_name || '').toLowerCase().includes(q));
  }, [tab, search]);

  function updateCaller(callerId, partial) {
    setTabs(prev => {
      const t = prev[activeTab];
      if (!t) return prev;
      const next = new Map(t.byCaller);
      const cur  = next.get(callerId) || { enabled: true, types: new Set(['all']), position: 0 };
      const merged = {
        ...cur,
        ...partial,
        types: partial.types ? new Set(partial.types) : cur.types,
      };
      next.set(callerId, merged);
      return { ...prev, [activeTab]: { ...t, byCaller: next } };
    });
  }

  function toggleEnabled(callerId, value) {
    updateCaller(callerId, { enabled: value });
  }

  function toggleType(callerId, type, checked) {
    setTabs(prev => {
      const t = prev[activeTab];
      if (!t) return prev;
      const next = new Map(t.byCaller);
      const cur  = next.get(callerId) || { enabled: true, types: new Set(['all']), position: 0 };
      const newTypes = new Set(cur.types);
      if (checked) {
        if (type === 'all') {
          newTypes.clear(); newTypes.add('all');
        } else {
          newTypes.delete('all');
          newTypes.add(type);
        }
      } else {
        newTypes.delete(type);
        if (newTypes.size === 0) newTypes.add('all');   // never let row become unchecked
      }
      next.set(callerId, { ...cur, types: newTypes });
      return { ...prev, [activeTab]: { ...t, byCaller: next } };
    });
  }

  const allEnabled = tab && tab.callers.length > 0
    && tab.callers.every(c => tab.byCaller.get(c.caller_id)?.enabled);

  function toggleSelectAll(value) {
    setTabs(prev => {
      const t = prev[activeTab];
      if (!t) return prev;
      const next = new Map(t.byCaller);
      for (const c of t.callers) {
        const cur = next.get(c.caller_id) || { enabled: true, types: new Set(['all']), position: 0 };
        next.set(c.caller_id, { ...cur, enabled: value });
      }
      return { ...prev, [activeTab]: { ...t, byCaller: next } };
    });
  }

  const handleSave = useCallback(async () => {
    if (!tab) return;
    setSaving(true);
    setError('');
    const payload = {
      webinar_id: activeTab,
      callers: tab.callers.map((c, idx) => {
        const state = tab.byCaller.get(c.caller_id) || { enabled: true, types: new Set(['all']), position: idx };
        return {
          caller_id:          c.caller_id,
          enabled:            !!state.enabled,
          allowed_lead_types: Array.from(state.types).filter(Boolean),
          position:           idx,
        };
      }),
    };
    try {
      const res = await fetch('/api/admin/lead-share-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed.');
      onSaved?.();
    } catch (e) {
      setError(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [tab, activeTab, token, onSaved]);

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(15,0,40,0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
        animation: 'fadeIn 200ms ease',
      }}
    >
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
        @media (max-width: 720px) {
          .lsl-types { flex-direction: column !important; gap: 4px !important; align-items: stretch !important; }
          .lsl-row   { flex-wrap: wrap !important; }
        }
      `}</style>

      <div style={{
        width: '100%', maxWidth: 760, maxHeight: '90vh',
        background: 'rgba(255,255,255,0.96)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderRadius: 22,
        border: '1px solid rgba(147,51,234,0.18)',
        boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
        padding: '24px 22px 20px',
        fontFamily: 'Outfit, sans-serif',
        animation: 'scaleIn 200ms ease',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10 }}>
          <div>
            <h2 style={{ fontWeight: 700, fontSize: '1.05rem', color: '#3B0764', margin: 0 }}>Leads Share Logic</h2>
            <p style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)', margin: '2px 0 0' }}>
              Pick callers and lead types per webinar — assignments cycle in round-robin.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'rgba(91,33,182,0.08)', color: '#5B21B6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, background: 'rgba(237,234,248,0.55)', borderRadius: 14, padding: 4, marginBottom: 14, alignSelf: 'flex-start' }}>
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
                  fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.78rem',
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  boxShadow: active ? '0 2px 10px rgba(91,33,182,0.30)' : 'none',
                }}
              >
                {role} ({(w.name || '').toLowerCase()})
              </button>
            );
          })}
        </div>

        {/* Toolbar: Select all + Search + SAVE */}
        <div className="lsl-row" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.86rem', color: '#3B0764', fontWeight: 600 }}>
            <input
              type="checkbox"
              checked={!!allEnabled}
              onChange={e => toggleSelectAll(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: '#5B21B6', cursor: 'pointer' }}
            />
            select all users
          </label>

          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search callers…"
              style={{
                width: '100%', height: '2.2rem', padding: '0 12px 0 32px',
                borderRadius: 50,
                border: '1px solid rgba(209,196,240,0.7)',
                background: 'rgba(237,234,248,0.40)',
                fontFamily: 'Outfit,sans-serif', fontSize: '0.82rem', color: '#3B0764',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          <button
            onClick={handleSave}
            disabled={saving || !tab}
            style={{
              padding: '8px 18px', borderRadius: 50, border: 'none',
              background: saving ? 'rgba(91,33,182,0.55)' : '#5B21B6',
              color: '#fff',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
              letterSpacing: '0.04em', textTransform: 'uppercase',
              cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: '0 4px 16px rgba(91,33,182,0.25)',
              flexShrink: 0,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {error && (
          <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '10px 14px', marginBottom: 12 }}>
            <p style={{ fontSize: '0.82rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
          </div>
        )}

        {/* Caller rows */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>
          {!tab && !error ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.88rem' }}>
              Loading callers…
            </div>
          ) : filteredCallers.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
              <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.95rem', marginBottom: 6 }}>
                {tab.callers.length === 0 ? 'No junior or senior callers found' : 'No matches'}
              </div>
              <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>
                {tab.callers.length === 0 ? 'Create one in the Users module first.' : 'Try clearing the search.'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {filteredCallers.map(c => {
                const state = tab.byCaller.get(c.caller_id) || { enabled: true, types: new Set(['all']) };
                const role  = ROLE_BADGE[c.role] || { bg: '#F3F4F6', fg: '#4B5563', label: c.role };
                return (
                  <div key={c.caller_id} style={{
                    display: 'grid', gap: 12,
                    gridTemplateColumns: '24px 1fr auto',
                    alignItems: 'center',
                    padding: '10px 12px', borderRadius: 12,
                    background: state.enabled ? 'rgba(91,33,182,0.04)' : 'transparent',
                    border: '1px solid rgba(209,196,240,0.40)',
                    transition: 'background 150ms',
                  }}>
                    <input
                      type="checkbox"
                      checked={!!state.enabled}
                      onChange={e => toggleEnabled(c.caller_id, e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: '#5B21B6', cursor: 'pointer' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.full_name}
                      </span>
                      <span style={{
                        display: 'inline-block', padding: '3px 10px', borderRadius: 50,
                        background: role.bg, color: role.fg,
                        fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap',
                      }}>
                        {role.label}
                      </span>
                      {!c.is_active && (
                        <span style={{
                          display: 'inline-block', padding: '3px 8px', borderRadius: 50,
                          background: 'rgba(107,114,128,0.15)', color: '#6B7280',
                          fontSize: '0.65rem', fontWeight: 700, whiteSpace: 'nowrap',
                        }}>
                          inactive
                        </span>
                      )}
                    </div>
                    <div className="lsl-types" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      {LEAD_TYPES.map(lt => {
                        const checked = state.types.has(lt.value);
                        return (
                          <label key={lt.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: state.enabled ? 'pointer' : 'not-allowed', opacity: state.enabled ? 1 : 0.5 }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!state.enabled}
                              onChange={e => toggleType(c.caller_id, lt.value, e.target.checked)}
                              style={{ width: 14, height: 14, accentColor: '#5B21B6', cursor: state.enabled ? 'pointer' : 'not-allowed' }}
                            />
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: 50,
                              background: lt.bg, color: lt.fg,
                              fontSize: '0.7rem', fontWeight: 700,
                            }}>
                              {lt.label}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
