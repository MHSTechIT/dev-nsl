/* ──────────────────────────────────────────────────────────────────────────
   SettingsPage — CRM sidebar page sitting below "Zoom".

   First card: Workspace — an on/off toggle per workspace. Turning a workspace
   OFF hides it from every workspace switcher in the CRM (Marketing, Web
   Reminder, Users) by persisting the flags to /api/admin/workspace-flags.

   Receives:
     • token   — Bearer token for authed calls to the CRM backend (:3003)
     • source  — active workspace ('meta' | 'yt' | 'meta2' | …)
   ────────────────────────────────────────────────────────────────────────── */
import { useState, useEffect } from 'react';
import { ALL_WORKSPACES, fetchWorkspaceFlags, isWorkspaceEnabled } from '../utils/workspaceFlags';

const PURPLE = '#5B21B6';

function Toggle({ on, onClick }) {
  return (
    <button
      type="button" onClick={onClick}
      title={on ? 'On — visible in the CRM' : 'Off — hidden from the CRM'}
      style={{
        width: 42, height: 23, borderRadius: 999, border: 'none',
        cursor: 'pointer', position: 'relative', flexShrink: 0,
        background: on ? '#059669' : 'rgba(91,33,182,0.25)',
        transition: 'background 160ms',
      }}
    >
      <span style={{ position: 'absolute', top: 3, left: on ? 22 : 3, width: 17, height: 17, borderRadius: '50%', background: '#fff', transition: 'left 160ms', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

export default function SettingsPage({ token, source = 'meta' }) {
  const [flags, setFlags]   = useState({}); // { [id]: boolean } — false = hidden
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast]   = useState('');

  useEffect(() => {
    if (!token) return;
    fetchWorkspaceFlags(token).then((f) => { setFlags(f); setLoaded(true); });
  }, [token]);

  const enabled = (id) => isWorkspaceEnabled(flags, id);
  const toggle  = (id) => setFlags((prev) => ({ ...prev, [id]: prev[id] === false }));

  async function save() {
    setSaving(true); setToast('');
    // Persist an explicit boolean for every known workspace.
    const out = {};
    for (const w of ALL_WORKSPACES) out[w.id] = enabled(w.id);
    try {
      const res = await fetch('/api/admin/workspace-flags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ flags: out }),
      });
      setToast(res.ok ? 'Saved!' : 'Failed to save.');
    } catch { setToast('Network error.'); }
    finally { setSaving(false); setTimeout(() => setToast(''), 3000); }
  }

  const onCount = ALL_WORKSPACES.filter((w) => enabled(w.id)).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'Outfit, sans-serif' }}>
      {/* Workspace card */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(209,196,240,0.35)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(91,33,182,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, color: '#3B0764', fontWeight: 800, fontSize: '1.1rem' }}>Workspace</h2>
            <p style={{ margin: '3px 0 0', color: 'rgba(91,33,182,0.6)', fontSize: '0.85rem' }}>
              Turn a workspace off to hide it from every workspace switcher in the CRM. {onCount} of {ALL_WORKSPACES.length} on.
            </p>
          </div>
          {toast && <span style={{ fontSize: '0.8rem', fontWeight: 700, color: toast === 'Saved!' ? '#059669' : '#DC2626' }}>{toast}</span>}
          <button onClick={save} disabled={saving || !loaded} style={{ height: 36, padding: '0 22px', borderRadius: 50, border: 'none', background: PURPLE, color: '#fff', fontWeight: 800, fontSize: '0.82rem', cursor: (saving || !loaded) ? 'wait' : 'pointer', opacity: (saving || !loaded) ? 0.6 : 1, boxShadow: '0 2px 12px rgba(91,33,182,0.3)' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* Workspace rows */}
        <div style={{ padding: 14 }}>
          {ALL_WORKSPACES.map((w) => {
            const on = enabled(w.id);
            return (
              <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 12px', borderRadius: 12, transition: 'background 150ms' }}
                   onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(91,33,182,0.04)'}
                   onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <span style={{ flex: 1, fontWeight: 700, fontSize: '0.92rem', color: '#3B0764' }}>{w.label}</span>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: on ? '#059669' : 'rgba(91,33,182,0.45)', minWidth: 30, textAlign: 'right' }}>{on ? 'On' : 'Off'}</span>
                <Toggle on={on} onClick={() => toggle(w.id)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
