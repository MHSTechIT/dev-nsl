import { useState, useEffect } from 'react';
import Loading from '../components/Loading';

/* AccessView — "Access" tab in the Marketing module. Lists users in the
   marketing department as expandable cards; expanding shows every Marketing
   page (+ the Users page) with an on/off toggle. Access is stored per user in
   crm_users.page_access ({ pageId: bool }; default ON). */

/* Pages a marketing user can be granted/denied — the Marketing tabs + Users. */
const PAGES = [
  { id: 'funnel',    label: 'Funnel' },
  { id: 'dashboard', label: 'Page Performance' },
  { id: 'leads',     label: 'Leads' },
  { id: 'whatsapp',  label: 'WhatsApp Links' },
  { id: 'timer',     label: 'Timer & Controls' },
  { id: 'settings',  label: 'Alerts' },
  { id: 'access',    label: 'Access' },
  { id: 'users',     label: 'Users' },
];

function Toggle({ on, onClick }) {
  return (
    <button
      type="button" onClick={onClick} title={on ? 'On — click to turn off' : 'Off — click to turn on'}
      style={{
        width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
        position: 'relative', flexShrink: 0, transition: 'background 160ms',
        background: on ? '#059669' : 'rgba(91,33,182,0.28)',
      }}
    >
      <span style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 160ms', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

export default function AccessView({ token, department = 'marketing', pages = PAGES, pagesForUser }) {
  const deptLabel = department.charAt(0).toUpperCase() + department.slice(1);
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId]   = useState(null);

  useEffect(() => {
    fetch('/api/admin/crm-users', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setUsers((d.users || []).filter(u => u.department === department)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, department]);

  const isOn = (u, pid) => (u.page_access || {})[pid] !== false; // default ON

  async function toggle(u, pid) {
    const pa = { ...(u.page_access || {}) };
    pa[pid] = !isOn(u, pid);
    setUsers(prev => prev.map(x => (x.id === u.id ? { ...x, page_access: pa } : x))); // optimistic
    try {
      await fetch(`/api/admin/crm-users/${u.id}/page-access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ page_access: pa }),
      });
    } catch { /* keep optimistic state; will reconcile on reload */ }
  }

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <div style={{ marginBottom: 18 }}>
        <h3 className="font-sans text-xl font-bold text-purple-900">Access</h3>
        <p className="font-sans text-sm text-purple-400 mt-1">
          {deptLabel}-department users · expand a user to control which pages they can access.
        </p>
      </div>

      {loading ? (
        <Loading label="Loading users…" />
      ) : users.length === 0 ? (
        <div style={{ border: '1px dashed rgba(139,92,246,0.35)', borderRadius: 14, padding: '36px 24px', textAlign: 'center', background: 'rgba(237,234,248,0.30)' }}>
          <p style={{ fontWeight: 700, fontSize: '0.95rem', color: '#3B0764', margin: 0 }}>No {department} users yet</p>
          <p style={{ fontSize: '0.84rem', color: 'rgba(91,33,182,0.55)', margin: '6px 0 0' }}>
            Create a user with Department = “{deptLabel}” (Users tab) and they’ll appear here.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {users.map(u => {
            const open = openId === u.id;
            const userPages = pagesForUser ? pagesForUser(u) : pages;
            const onCount = userPages.filter(p => isOn(u, p.id)).length;
            return (
              <div key={u.id} style={{ background: '#fff', border: '1px solid rgba(91,33,182,0.18)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 2px 12px rgba(91,33,182,0.05)' }}>
                {/* Card header — name + down arrow */}
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : u.id)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                    padding: '14px 18px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <span style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, background: 'rgba(91,33,182,0.10)', color: '#5B21B6', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.9rem' }}>
                    {(u.full_name || '?').charAt(0).toUpperCase()}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 800, fontSize: '0.95rem', color: '#3B0764', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {u.full_name || 'Unnamed'}
                    </span>
                    <span style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>{onCount} of {userPages.length} pages on</span>
                  </span>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 180ms' }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {/* Expanded — page list with on/off toggles */}
                {open && (
                  <div style={{ borderTop: '1px solid rgba(91,33,182,0.10)', padding: '14px 18px 16px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                    {userPages.map(p => (
                      <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', background: '#fff', border: '1px solid rgba(91,33,182,0.14)', borderRadius: 12, boxShadow: '0 2px 10px rgba(91,33,182,0.05)' }}>
                        <span style={{ fontSize: '0.86rem', fontWeight: 600, color: '#3B0764' }}>{p.label}</span>
                        <Toggle on={isOn(u, p.id)} onClick={() => toggle(u, p.id)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
