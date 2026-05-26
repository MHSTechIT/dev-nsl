import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

const ROLES = [
  { value: 'junior_caller', label: 'Junior Caller' },
  { value: 'senior_caller', label: 'Senior Caller' },
  { value: 'manager',       label: 'Manager' },
  { value: 'trainer',       label: 'Trainer' },
  { value: 'admin',         label: 'Admin' },
  { value: 'team_leader',   label: 'Team Leader' },
];

const ROLE_LABEL = ROLES.reduce((acc, r) => { acc[r.value] = r.label; return acc; }, {});

/* Known Tata Smartflo Account Types. Each entry maps to an env var
   on the backend named TATA_TELE_API_KEY_<value> (see tataClient.js:31).
   Add a new account here AND set the matching env var when onboarding
   a new Tata sub-account. */
const TATA_ACCOUNT_TYPES = [
  { value: '',          label: 'Default (global Tata API key)' },
  { value: 'OR165136',  label: 'OR165136 (Hari / Santhosh)' },
  { value: 'OR188610',  label: 'OR188610 (Deepika)' },
];

const ROLE_BADGE = {
  junior_caller: { bg: '#FEF9C3', fg: '#A16207' },
  senior_caller: { bg: '#FFEDD5', fg: '#C2410C' },
  manager:       { bg: '#DCFCE7', fg: '#166534' },
  trainer:       { bg: '#DBEAFE', fg: '#1E40AF' },
  admin:         { bg: '#FCE7F3', fg: '#9D174D' },
  team_leader:   { bg: '#EDE9FE', fg: '#5B21B6' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}

export default function UsersModule({
  token,
  lockedDepartment   = null,
  lockedManagerId    = null,
  // TL mode: pin team_leader_id on every create/edit to the logged-in TL,
  // lock department to theirs, and restrict the Role dropdown to caller-
  // level roles only (TLs can't promote anyone to manager / TL / admin).
  tlMode             = false,
  lockedTeamLeaderId = null,
  actionsSlotEl      = null,
}) {
  const [users, setUsers]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [showForm, setShowForm]     = useState(false);
  const [editingUser, setEditing]   = useState(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/crm-users', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load users.');
      const data = await res.json();
      setUsers(data.users || []);
    } catch (e) {
      setError(e.message || 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  /* id → user lookup so the table can resolve team_leader_id / manager_id
     UUIDs to display names without a second API roundtrip. Cheap because
     the users list is already in memory. */
  const usersById = useMemo(() => {
    const map = new Map();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  /* Toolbar state: free-text search across name/email/phone, plus a
     multi-select role filter popover. Both filter the in-memory list
     client-side — the dataset is small enough that paginating server-
     side isn't worth it yet. */
  const [query,       setQuery]       = useState('');
  const [roleFilter,  setRoleFilter]  = useState(() => new Set()); // empty = all roles
  const [showFilter,  setShowFilter]  = useState(false);
  const filterWrapRef = useRef(null);

  // Close the role-filter popover on outside click + Escape.
  useEffect(() => {
    if (!showFilter) return;
    function onDocDown(e) {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target)) {
        setShowFilter(false);
      }
    }
    function onKey(e) { if (e.key === 'Escape') setShowFilter(false); }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown',   onKey);
    };
  }, [showFilter]);

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter(u => {
      if (roleFilter.size > 0 && !roleFilter.has(u.role)) return false;
      if (q) {
        const hay = `${u.full_name || ''} ${u.email || ''} ${u.phone || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [users, query, roleFilter]);

  function toggleRole(value) {
    setRoleFilter(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  async function handleDelete(id, name) {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/admin/crm-users/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to delete.');
        return;
      }
      setUsers(prev => prev.filter(u => u.id !== id));
    } catch {
      alert('Network error. Please try again.');
    }
  }

  /* Toolbar — search + role filter + Create User, packaged together so
     they can be portaled as a unit into the dashboard tab-bar action slot
     when one is provided (manager dashboard), or rendered standalone
     above the table otherwise. */
  const toolbar = (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {/* Search box — searches name + email + phone */}
      <div style={{
        position: 'relative',
        display: 'inline-flex', alignItems: 'center',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.50)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, email, phone…"
          style={{
            height: 36,
            padding: '0 14px 0 34px',
            borderRadius: 50,
            border: '1px solid rgba(139,92,246,0.25)',
            background: '#fff',
            fontFamily: 'Outfit, sans-serif',
            fontSize: '0.82rem',
            color: '#3B0764',
            outline: 'none',
            width: 240,
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Role filter — popover with multi-select checkboxes */}
      <div ref={filterWrapRef} style={{ position: 'relative' }}>
        <button
          onClick={() => setShowFilter(o => !o)}
          style={{
            height: 36,
            padding: '0 14px',
            borderRadius: 50,
            border: '1px solid rgba(139,92,246,0.25)',
            background: roleFilter.size > 0 ? 'rgba(91,33,182,0.10)' : '#fff',
            color: '#5B21B6',
            fontFamily: 'Outfit, sans-serif',
            fontWeight: 700, fontSize: '0.82rem',
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
          Filter
          {roleFilter.size > 0 && (
            <span style={{
              background: '#5B21B6', color: '#fff',
              borderRadius: 50, padding: '1px 7px',
              fontSize: '0.66rem', fontWeight: 800,
              marginLeft: 2,
            }}>
              {roleFilter.size}
            </span>
          )}
        </button>

        {showFilter && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0,
            width: 220,
            background: '#fff',
            borderRadius: 14,
            border: '1px solid rgba(139,92,246,0.20)',
            boxShadow: '0 12px 36px rgba(91,33,182,0.18)',
            padding: 8,
            zIndex: 60,
          }}>
            <div style={{
              padding: '6px 10px 8px',
              fontFamily: 'Outfit, sans-serif', fontSize: '0.66rem',
              fontWeight: 800, letterSpacing: 0.6,
              color: 'rgba(91,33,182,0.60)', textTransform: 'uppercase',
            }}>
              Filter by role
            </div>
            {ROLES.map(r => {
              const checked = roleFilter.has(r.value);
              return (
                <label
                  key={r.value}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 10,
                    cursor: 'pointer',
                    background: checked ? 'rgba(91,33,182,0.10)' : 'transparent',
                    fontFamily: 'Outfit, sans-serif',
                    fontSize: '0.84rem', fontWeight: checked ? 700 : 500,
                    color: '#3B0764',
                  }}
                  onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = 'rgba(237,234,248,0.60)'; }}
                  onMouseLeave={(e) => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleRole(r.value)}
                    style={{ accentColor: '#5B21B6', width: 14, height: 14, cursor: 'pointer' }}
                  />
                  {r.label}
                </label>
              );
            })}
            {roleFilter.size > 0 && (
              <button
                onClick={() => setRoleFilter(new Set())}
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: '1px solid rgba(139,92,246,0.25)',
                  background: '#fff',
                  color: '#5B21B6',
                  fontFamily: 'Outfit, sans-serif',
                  fontWeight: 700, fontSize: '0.78rem',
                  cursor: 'pointer',
                }}
              >
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>

      {/* Create User */}
      <button
        onClick={() => setShowForm(true)}
        style={{
          height: 36,
          padding: '0 16px', borderRadius: 50, border: 'none',
          background: '#5B21B6', color: '#fff',
          fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
          cursor: 'pointer', boxShadow: '0 4px 16px rgba(91,33,182,0.30)',
          display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Create User
      </button>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {actionsSlotEl
        ? createPortal(toolbar, actionsSlotEl)
        : <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{toolbar}</div>}

      {/* Error banner */}
      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* Users table */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit,sans-serif', fontSize: '0.9rem' }}>Loading users…</div>
        ) : users.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>No users yet</div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem' }}>Click "Create User" above to add your first team member.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Manager</th>
                  <th style={thStyle}>Team Leader</th>
                  <th style={thStyle}>Department</th>
                  <th style={thStyle}>Smartflo</th>
                  <th style={thStyle}>Created</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length === 0 && (query || roleFilter.size > 0) && (
                  <tr>
                    <td colSpan={10} style={{
                      padding: '32px 16px', textAlign: 'center',
                      fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem',
                      color: 'rgba(91,33,182,0.55)',
                    }}>
                      No users match the current search / filter.
                      {' '}
                      <button
                        onClick={() => { setQuery(''); setRoleFilter(new Set()); }}
                        style={{
                          background: 'none', border: 'none',
                          color: '#5B21B6', fontWeight: 700, cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                      >
                        Reset
                      </button>
                    </td>
                  </tr>
                )}
                {filteredUsers.map(u => {
                  const badge = ROLE_BADGE[u.role] || { bg: '#F3F4F6', fg: '#4B5563' };
                  return (
                    <tr key={u.id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 600, color: '#3B0764' }}>{u.full_name}</span>
                      </td>
                      <td style={tdStyle}>{u.email}</td>
                      <td style={tdStyle}>{u.phone || '—'}</td>
                      <td style={tdStyle}>
                        <span style={{
                          display: 'inline-block', padding: '3px 10px', borderRadius: 50,
                          fontSize: '0.72rem', fontWeight: 700,
                          background: badge.bg, color: badge.fg,
                          whiteSpace: 'nowrap',
                        }}>
                          {ROLE_LABEL[u.role] || u.role}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <RefCell name={usersById.get(u.manager_id)?.full_name} />
                      </td>
                      <td style={tdStyle}>
                        <RefCell name={usersById.get(u.team_leader_id)?.full_name} />
                      </td>
                      <td style={tdStyle}>
                        <DeptCell dept={u.department} />
                      </td>
                      <td style={tdStyle}>
                        <SmartfloCell user={u} />
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)' }}>{fmtDate(u.created_at)}</span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <button
                            onClick={() => setEditing(u)}
                            title="Edit user"
                            aria-label={`Edit ${u.full_name}`}
                            style={{
                              padding: '6px', borderRadius: 8, border: '1px solid rgba(91,33,182,0.20)',
                              background: '#fff', color: '#5B21B6',
                              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9"/>
                              <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/>
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDelete(u.id, u.full_name)}
                            title="Delete user"
                            aria-label={`Delete ${u.full_name}`}
                            style={{
                              padding: '5px 10px', borderRadius: 8, border: '1px solid rgba(220,38,38,0.25)',
                              background: '#fff', color: '#DC2626',
                              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.75rem',
                              cursor: 'pointer',
                            }}
                          >
                            Delete
                          </button>
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

      {/* Create / Edit form modal */}
      {(showForm || editingUser) && (
        <UserFormModal
          token={token}
          existing={editingUser}
          allUsers={users}
          lockedDepartment={lockedDepartment}
          lockedManagerId={lockedManagerId}
          tlMode={tlMode}
          lockedTeamLeaderId={lockedTeamLeaderId}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={(u, isEdit) => {
            if (isEdit) {
              setUsers(prev => prev.map(x => x.id === u.id ? u : x));
            } else {
              setUsers(prev => [u, ...prev]);
            }
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const thStyle = {
  padding: '12px 16px',
  fontSize: '0.74rem',
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
  whiteSpace: 'nowrap',
};

/* Resolved name cell — Manager / Team Leader columns. Shows an em-dash
   for users whose role doesn't have that relationship or whose ref
   points at a user no longer in the loaded list. */
function RefCell({ name }) {
  if (!name) {
    return <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.40)' }}>—</span>;
  }
  return <span style={{ fontWeight: 600 }}>{name}</span>;
}

/* Department pill — soft purple background, capitalized text. */
function DeptCell({ dept }) {
  if (!dept) {
    return <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.40)' }}>—</span>;
  }
  const palette = dept === 'sales'
    ? { bg: 'rgba(91,33,182,0.10)',  fg: '#5B21B6' }
    : { bg: 'rgba(245,158,11,0.12)', fg: '#B45309' };
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 50,
      fontSize: '0.7rem', fontWeight: 700, letterSpacing: 0.3,
      textTransform: 'capitalize',
      background: palette.bg, color: palette.fg,
      whiteSpace: 'nowrap',
    }}>
      {dept}
    </span>
  );
}

/* Compact summary of a user's Smartflo settings for the users table */
function SmartfloCell({ user }) {
  const isCaller = user.role === 'junior_caller' || user.role === 'senior_caller';
  if (!isCaller) {
    return <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.40)' }}>—</span>;
  }
  const fields = [
    { label: 'Route',  value: user.tata_outbound_route },
    { label: 'Ext',    value: user.tata_extension },
    { label: 'Agent',  value: user.tata_agent_number },
    { label: 'Caller', value: user.tata_caller_id },
  ].filter(f => f.value);
  if (fields.length === 0) {
    return <span style={{ fontSize: '0.74rem', color: '#B91C1C', fontWeight: 600 }}>not set</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {fields.map(f => (
        <span key={f.label} style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.85)', fontFamily: 'ui-monospace, monospace' }}>
          <span style={{ color: 'rgba(91,33,182,0.55)' }}>{f.label}:</span> {f.value}
        </span>
      ))}
    </div>
  );
}

/* ── User Form Modal (create + edit) ── */
function UserFormModal({
  token,
  existing,
  allUsers           = [],
  lockedDepartment   = null,
  lockedManagerId    = null,
  // TL mode props (mirror UsersModule). When set, the form pins
  // team_leader_id to the logged-in TL and limits the Role options.
  tlMode             = false,
  lockedTeamLeaderId = null,
  onClose,
  onSaved,
}) {
  const isEdit = !!existing;
  const [fullName, setFullName] = useState(existing?.full_name || '');
  const [email, setEmail]       = useState(existing?.email || '');
  const [phone, setPhone]       = useState(existing?.phone || '');
  const [role, setRole]         = useState(existing?.role || 'junior_caller');
  const [department, setDepartment]     = useState(existing?.department || lockedDepartment || '');
  const [managerId, setManagerId]       = useState(existing?.manager_id || lockedManagerId || '');
  const [teamLeaderId, setTeamLeaderId] = useState(existing?.team_leader_id || lockedTeamLeaderId || '');
  const [tataExtension, setTataExtension]     = useState(existing?.tata_extension || '');
  const [tataAccountType, setTataAccountType] = useState(existing?.tata_account_type || '');
  const [tataAgentNumber, setTataAgentNumber] = useState(existing?.tata_agent_number || '');
  const [tataCallerId, setTataCallerId]       = useState(existing?.tata_caller_id || '');
  // Outbound Route + API Key override no longer have UI fields — the values
  // are still carried through on save so existing data is preserved (route
  // defaults to 'extension', API key falls back to the global env value).
  const [tataApiKey]       = useState(existing?.tata_smartflo_api_key || '');
  const [tataOutboundRoute] = useState(existing?.tata_outbound_route || 'extension');
  const [password, setPassword]               = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  /* Team leaders pickable for the selected department — only team_leader-role
     users in that department, excluding the user currently being edited. */
  const teamLeaders = useMemo(
    () => allUsers.filter(u =>
      u.role === 'team_leader' &&
      u.department === department &&
      u.id !== existing?.id
    ),
    [allUsers, department, existing]
  );

  /* Managers pickable for the selected department — only manager-role users
     in that department, excluding the user being edited. */
  const managers = useMemo(
    () => allUsers.filter(u =>
      u.role === 'manager' &&
      u.department === department &&
      u.id !== existing?.id
    ),
    [allUsers, department, existing]
  );

  /* Field visibility by role:
       Manager field     — shown for every role EXCEPT manager / admin
                           (they sit at the top — no manager above them).
       Team Leader field — shown ONLY for caller roles (jr/sr caller). */
  const showTeamLeader = role === 'junior_caller' || role === 'senior_caller';
  const showManager    = role !== 'manager' && role !== 'admin';

  function handleDepartmentChange(d) {
    setDepartment(d);
    // Drop a team-leader pick that no longer belongs to the new department.
    if (teamLeaderId && !allUsers.some(u =>
      u.id === teamLeaderId && u.role === 'team_leader' && u.department === d
    )) {
      setTeamLeaderId('');
    }
    // Drop a manager pick that no longer belongs to the new department.
    if (managerId && !allUsers.some(u =>
      u.id === managerId && u.role === 'manager' && u.department === d
    )) {
      setManagerId('');
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!fullName.trim()) { setError('Full name is required.'); return; }
    if (!email.trim()) { setError('Email is required.'); return; }
    // Create always needs a password; Edit needs one only if changing it.
    if (!isEdit || password.length > 0) {
      if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
      if (password !== confirmPassword) { setError('New password and confirm password do not match.'); return; }
    }

    setLoading(true);
    try {
      const isCaller = role === 'junior_caller' || role === 'senior_caller';
      const body = {
        full_name: fullName.trim(),
        email:     email.trim(),
        phone:     phone.trim() || (isEdit ? '' : undefined),
        role,
        department:     department || null,
        manager_id:     showManager ? (managerId || null) : null,
        team_leader_id: showTeamLeader ? (teamLeaderId || null) : null,
      };
      // Smartflo settings only apply to callers; clear them on other roles.
      if (isCaller) {
        body.tata_extension        = tataExtension.trim();
        body.tata_account_type     = tataAccountType.trim();
        body.tata_agent_number     = tataAgentNumber.trim();
        body.tata_caller_id        = tataCallerId.trim();
        body.tata_smartflo_api_key = tataApiKey.trim();
        body.tata_outbound_route   = (tataOutboundRoute === 'agent' || tataOutboundRoute === 'did')
          ? tataOutboundRoute
          : 'extension';
      } else if (isEdit) {
        body.tata_extension        = '';
        body.tata_account_type     = '';
        body.tata_agent_number     = '';
        body.tata_caller_id        = '';
        body.tata_smartflo_api_key = '';
        body.tata_outbound_route   = 'extension';
      }
      if (password.length > 0) body.password = password;

      const url    = isEdit ? `/api/admin/crm-users/${existing.id}` : '/api/admin/crm-users';
      const method = isEdit ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || (isEdit ? 'Failed to update user.' : 'Failed to create user.'));
        setLoading(false);
        return;
      }
      onSaved(data.user, isEdit);
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(15,0,40,0.45)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
      }}
    >
      <div className="uf-modal" style={{
        width: '100%', maxWidth: 680,
        background: '#fff', borderRadius: 20,
        border: '1px solid rgba(147,51,234,0.15)',
        boxShadow: '0 24px 64px rgba(91,33,182,0.22)',
        padding: '28px 30px 24px',
        fontFamily: 'Outfit, sans-serif',
        maxHeight: '92vh', overflowY: 'auto',
      }}>
        <style>{`
          .uf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
          @media (max-width: 600px) { .uf-grid { grid-template-columns: 1fr !important; } }
          .uf-full { grid-column: 1 / -1; }
          /* Hide the scroll bar — the modal still scrolls via wheel/trackpad. */
          .uf-modal { scrollbar-width: none; -ms-overflow-style: none; }
          .uf-modal::-webkit-scrollbar { width: 0; height: 0; display: none; }
        `}</style>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: 'linear-gradient(135deg,#5B21B6,#9333EA)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/>
              <line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
          </div>
          <div>
            <h2 style={{ fontWeight: 700, fontSize: '1.1rem', color: '#3B0764', margin: 0 }}>{isEdit ? 'Edit User' : 'Create User'}</h2>
            <p style={{ fontSize: '0.75rem', color: 'rgba(91,33,182,0.50)', margin: 0, marginTop: 2 }}>{isEdit ? 'Update team member details' : 'Add a new team member'}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="uf-grid">
            {/* Full name */}
            <div>
              <label style={fieldLabelStyle}>Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                style={inputStyle}
                autoFocus
                maxLength={120}
              />
            </div>

            {/* Email */}
            <div>
              <label style={fieldLabelStyle}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="name@example.com"
                style={inputStyle}
                maxLength={200}
              />
            </div>

            {/* Phone */}
            <div>
              <label style={fieldLabelStyle}>Phone <span style={{ color: 'rgba(91,33,182,0.40)', fontWeight: 500 }}>(optional)</span></label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="+91 …"
                style={inputStyle}
                maxLength={30}
              />
            </div>

            {/* Role — TL mode restricts to caller-level roles only.
                A TL cannot create a peer/superior (no team_leader /
                manager / admin / trainer through this form). Backend
                enforces this independently via the team_leader role
                gate on the POST/PATCH endpoints. */}
            <div>
              <label style={fieldLabelStyle}>Role</label>
              <BrandSelect
                value={role}
                onChange={setRole}
                options={tlMode
                  ? ROLES.filter(r => r.value === 'junior_caller' || r.value === 'senior_caller')
                  : ROLES}
              />
            </div>

            {/* Department */}
            <div>
              <label style={fieldLabelStyle}>Department</label>
              <BrandSelect
                value={department}
                onChange={handleDepartmentChange}
                disabled={!!lockedDepartment}
                options={[
                  { value: '',          label: 'Select department…' },
                  { value: 'sales',     label: 'Sales' },
                  { value: 'marketing', label: 'Marketing' },
                ]}
              />
            </div>

            {/* Manager — manager-role users within the chosen department.
                Hidden for manager / admin roles (top of the hierarchy). */}
            {showManager && (
              <div>
                <label style={fieldLabelStyle}>Manager</label>
                <BrandSelect
                  value={managerId}
                  onChange={setManagerId}
                  disabled={!department || !!lockedManagerId}
                  options={[
                    { value: '', label: !department
                        ? 'Select a department first'
                        : managers.length === 0
                          ? 'No managers in this department'
                          : 'Select manager…' },
                    ...managers.map(m => ({ value: m.id, label: m.full_name })),
                  ]}
                />
              </div>
            )}

            {/* Team Leader — team_leader-role users within the chosen
                department. Shown only for caller roles. In TL mode the
                select is locked to the logged-in TL: callers created
                from a TL's Users tab automatically join that TL's team. */}
            {showTeamLeader && (
              <div>
                <label style={fieldLabelStyle}>Team Leader</label>
                <BrandSelect
                  value={teamLeaderId}
                  onChange={setTeamLeaderId}
                  disabled={!department || !!lockedTeamLeaderId}
                  options={[
                    { value: '', label: !department
                        ? 'Select a department first'
                        : teamLeaders.length === 0
                          ? 'No team leaders in this department'
                          : 'Select team leader…' },
                    ...teamLeaders.map(tl => ({ value: tl.id, label: tl.full_name })),
                  ]}
                />
              </div>
            )}

            {/* Smartflo settings — only for caller roles. Spans both columns
                with its own internal 2-column grid. */}
            {(role === 'junior_caller' || role === 'senior_caller') && (
              <div className="uf-full" style={{
                marginTop: 4,
                padding: 16,
                borderRadius: 12,
                background: 'rgba(237,234,248,0.35)',
                border: '1px solid rgba(209,196,240,0.6)',
              }}>
                <div style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.92rem', color: '#3B0764', marginBottom: 12 }}>
                  Smartflo Settings <span style={{ fontWeight: 500, fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)' }}>(Tata Tele)</span>
                </div>
                <div className="uf-grid">
                  <div>
                    <label style={fieldLabelStyle}>Account Type</label>
                    {/* Known Tata Smartflo Account Types (top of file).
                        Each value maps to TATA_TELE_API_KEY_<value> on
                        the backend so the click-to-call resolver picks
                        the right JWT for each sub-account. When you add
                        a new Tata account, add a row to
                        TATA_ACCOUNT_TYPES + set the matching env var. */}
                    <BrandSelect
                      value={TATA_ACCOUNT_TYPES.some(o => o.value === tataAccountType) ? tataAccountType : ''}
                      onChange={setTataAccountType}
                      options={TATA_ACCOUNT_TYPES}
                    />
                  </div>
                  <div>
                    <label style={fieldLabelStyle}>Extension</label>
                    <input
                      type="text"
                      value={tataExtension}
                      onChange={e => setTataExtension(e.target.value)}
                      placeholder="e.g. 0605875010009"
                      style={inputStyle}
                      maxLength={60}
                      inputMode="numeric"
                    />
                  </div>
                  <div>
                    <label style={fieldLabelStyle}># Agent Number</label>
                    <input
                      type="tel"
                      value={tataAgentNumber}
                      onChange={e => setTataAgentNumber(e.target.value)}
                      placeholder="e.g. 919000000000"
                      style={inputStyle}
                      maxLength={30}
                      inputMode="tel"
                    />
                  </div>
                  <div>
                    <label style={fieldLabelStyle}>Caller ID</label>
                    <input
                      type="tel"
                      value={tataCallerId}
                      onChange={e => setTataCallerId(e.target.value)}
                      placeholder="e.g. 919240257287"
                      style={inputStyle}
                      maxLength={30}
                      inputMode="tel"
                    />
                  </div>
                </div>
                <p style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)', margin: '10px 2px 0' }}>
                  Used by the Call button to route through Smartflo. Leave blank if you don't have these from Tata Tele yet.
                </p>
              </div>
            )}

            {/* Password — Edit shows the current password (view-only) plus
                New + Confirm; Create shows Password + Confirm. */}
            {isEdit && (
              <PasswordField
                label="Current Password"
                value={existing?.password_plain || ''}
                readOnly
                placeholder={existing?.password_plain ? '' : 'Not recorded — set a new one below'}
              />
            )}
            <PasswordField
              label={isEdit ? 'New Password' : 'Password'}
              hint={isEdit ? '(optional)' : ''}
              value={password}
              onChange={setPassword}
              placeholder={isEdit ? 'Leave blank to keep current' : 'Min. 6 characters'}
            />
            <PasswordField
              label="Confirm Password"
              hint={isEdit ? '(optional)' : ''}
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder={isEdit ? 'Re-type new password' : 'Re-type password'}
            />
          </div>

          {error && (
            <p style={{ fontSize: '0.80rem', color: '#EF4444', fontWeight: 500, margin: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span>⚠</span> {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              style={{ flex: 1, height: '2.7rem', borderRadius: 50, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.50)', fontFamily: 'Outfit,sans-serif', fontWeight: 600, fontSize: '0.88rem', color: '#5B21B6', cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{ flex: 1, height: '2.7rem', borderRadius: 50, border: 'none', background: loading ? 'rgba(91,33,182,0.55)' : '#5B21B6', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.88rem', color: '#fff', cursor: loading ? 'not-allowed' : 'pointer', boxShadow: '0 4px 16px rgba(91,33,182,0.30)' }}
            >
              {loading ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create User')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const fieldLabelStyle = {
  fontSize: '0.76rem',
  fontWeight: 600,
  color: '#4A1A94',
  display: 'block',
  marginBottom: 5,
};

const inputStyle = {
  width: '100%',
  height: '2.8rem',
  padding: '0 12px',
  borderRadius: 10,
  border: '1px solid rgba(209,196,240,0.8)',
  background: 'rgba(237,234,248,0.30)',
  fontFamily: 'Outfit,sans-serif',
  fontSize: '0.9rem',
  color: '#3B0764',
  outline: 'none',
  boxSizing: 'border-box',
};

/* Password input with a show/hide eye toggle. `readOnly` mode powers the
   "Current Password" field — the admin can reveal a user's stored password. */
function PasswordField({ label, hint, value, onChange, placeholder, readOnly = false }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label style={fieldLabelStyle}>
        {label}
        {hint && <span style={{ color: 'rgba(91,33,182,0.40)', fontWeight: 500 }}> {hint}</span>}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={readOnly || !onChange ? undefined : (e => onChange(e.target.value))}
          readOnly={readOnly}
          placeholder={placeholder}
          maxLength={128}
          autoComplete="new-password"
          style={{
            ...inputStyle,
            paddingRight: '2.8rem',
            ...(readOnly ? { background: 'rgba(237,234,248,0.65)', cursor: 'default' } : {}),
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShow(v => !v)}
          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(91,33,182,0.45)', padding: 4 }}
          aria-label={show ? 'Hide password' : 'Show password'}
        >
          {show
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
        </button>
      </div>
    </div>
  );
}

/* Brand-styled single-select dropdown — a drop-in replacement for a native
   <select> so the Create User form's dropdowns match the rest of the CRM UI.
   The option panel is portaled to <body> with fixed positioning so the
   modal's scroll container can't clip it.
   Props: value, onChange(value), options:[{value,label}], disabled. */
function BrandSelect({ value, onChange, options = [], disabled = false }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState({ top: 0, left: 0, width: 0, maxH: 280 });
  const wrapRef    = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onScroll() { setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  function toggle() {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const maxH = Math.min(280, Math.max(140, spaceBelow));
      const top  = spaceBelow >= 160 ? r.bottom + 4 : Math.max(8, r.top - maxH - 4);
      setPos({ top, left: r.left, width: r.width, maxH });
    }
    setOpen(o => !o);
  }

  function pick(v) { onChange(v); setOpen(false); }

  const selected = options.find(o => String(o.value) === String(value));
  const label    = selected ? selected.label : '';
  const isPlaceholder = !value;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        style={{
          ...inputStyle,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          opacity: disabled ? 0.6 : 1,
          fontWeight: isPlaceholder ? 400 : 600,
          color: isPlaceholder ? 'rgba(91,33,182,0.50)' : '#3B0764',
          border: open ? '1px solid rgba(91,33,182,0.55)' : inputStyle.border,
          boxShadow: open ? '0 0 0 3px rgba(91,33,182,0.10)' : 'none',
          transition: 'border 160ms, box-shadow 160ms',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 180ms' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: pos.width,
            background: '#fff',
            border: '1px solid rgba(139,92,246,0.18)',
            borderRadius: 10,
            boxShadow: '0 14px 44px rgba(91,33,182,0.20)',
            zIndex: 10000, overflow: 'hidden',
            fontFamily: 'Outfit, sans-serif',
          }}
        >
          <div style={{ maxHeight: pos.maxH, overflowY: 'auto' }}>
            {options.map(o => {
              const isSel = String(o.value) === String(value);
              return (
                <div
                  key={String(o.value)}
                  onClick={() => pick(o.value)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '9px 12px', cursor: 'pointer',
                    fontSize: '0.88rem', color: '#3B0764',
                    fontWeight: isSel ? 700 : 500,
                    background: isSel ? 'rgba(91,33,182,0.07)' : 'transparent',
                    borderBottom: '1px solid rgba(139,92,246,0.07)',
                    transition: 'background 120ms',
                  }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'rgba(139,92,246,0.06)'; }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ width: 14, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                    {isSel && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
                        strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
