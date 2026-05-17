import { useState, useEffect, useCallback } from 'react';

const ROLES = [
  { value: 'junior_caller', label: 'Junior Caller' },
  { value: 'senior_caller', label: 'Senior Caller' },
  { value: 'manager',       label: 'Manager' },
  { value: 'trainer',       label: 'Trainer' },
  { value: 'admin',         label: 'Admin' },
  { value: 'team_leader',   label: 'Team Leader' },
];

const ROLE_LABEL = ROLES.reduce((acc, r) => { acc[r.value] = r.label; return acc; }, {});

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

export default function UsersModule({ token }) {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Toolbar */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.05rem', color: '#3B0764', margin: 0 }}>
            Team Members
          </h2>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)', margin: '2px 0 0' }}>
            {loading ? 'Loading…' : `${users.length} user${users.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={fetchUsers}
            disabled={loading}
            style={{
              padding: '8px 14px', borderRadius: 50, border: '1px solid rgba(91,33,182,0.20)',
              background: '#fff', color: '#5B21B6',
              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.82rem',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            ↻ Refresh
          </button>
          <button
            onClick={() => setShowForm(true)}
            style={{
              padding: '8px 16px', borderRadius: 50, border: 'none',
              background: '#5B21B6', color: '#fff',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
              cursor: 'pointer', boxShadow: '0 4px 16px rgba(91,33,182,0.30)',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Create User
          </button>
        </div>
      </div>

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
                  <th style={thStyle}>Smartflo</th>
                  <th style={thStyle}>Created</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
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
                        }}>
                          {ROLE_LABEL[u.role] || u.role}
                        </span>
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
};

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
function UserFormModal({ token, existing, onClose, onSaved }) {
  const isEdit = !!existing;
  const [fullName, setFullName] = useState(existing?.full_name || '');
  const [email, setEmail]       = useState(existing?.email || '');
  const [phone, setPhone]       = useState(existing?.phone || '');
  const [role, setRole]         = useState(existing?.role || 'junior_caller');
  const [tataExtension, setTataExtension]     = useState(existing?.tata_extension || '');
  const [tataAccountType, setTataAccountType] = useState(existing?.tata_account_type || '');
  const [tataAgentNumber, setTataAgentNumber] = useState(existing?.tata_agent_number || '');
  const [tataCallerId, setTataCallerId]       = useState(existing?.tata_caller_id || '');
  const [tataApiKey, setTataApiKey]           = useState(existing?.tata_smartflo_api_key || '');
  const [tataOutboundRoute, setTataOutboundRoute] = useState(existing?.tata_outbound_route || 'extension');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!fullName.trim()) { setError('Full name is required.'); return; }
    if (!email.trim()) { setError('Email is required.'); return; }
    if (!isEdit && password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (isEdit && password.length > 0 && password.length < 6) { setError('Password must be at least 6 characters.'); return; }

    setLoading(true);
    try {
      const isCaller = role === 'junior_caller' || role === 'senior_caller';
      const body = {
        full_name: fullName.trim(),
        email:     email.trim(),
        phone:     phone.trim() || (isEdit ? '' : undefined),
        role,
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
      <div style={{
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

            {/* Role */}
            <div>
              <label style={fieldLabelStyle}>Role</label>
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                style={{ ...inputStyle, appearance: 'auto' }}
              >
                {ROLES.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>

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
                  <div className="uf-full">
                    <label style={fieldLabelStyle}>Outbound Route</label>
                    <select
                      value={tataOutboundRoute}
                      onChange={e => setTataOutboundRoute(e.target.value)}
                      style={{ ...inputStyle, appearance: 'auto' }}
                    >
                      <option value="extension">Extension (SmartFlow window) — default</option>
                      <option value="agent">Agent Number (mobile)</option>
                      <option value="did">DID / Caller ID</option>
                    </select>
                    <p style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)', margin: '6px 2px 0' }}>
                      Which Smartflo identifier to send as <code>agent_number</code>. Default <em>Extension</em> makes the call ring inside the SmartFlow softphone window (the agent picks up there, then Tata bridges to the customer). Pick <em>Agent Number</em> to ring the agent's mobile, or <em>DID</em> if your Smartflo campaign originates the call directly from the DID.
                    </p>
                  </div>
                  <div>
                    <label style={fieldLabelStyle}>Account Type</label>
                    <input
                      type="text"
                      value={tataAccountType}
                      onChange={e => setTataAccountType(e.target.value)}
                      placeholder="e.g. OR165136"
                      style={inputStyle}
                      maxLength={60}
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
                <div style={{ marginTop: 12 }}>
                  <label style={fieldLabelStyle}>API Key <span style={{ color: 'rgba(91,33,182,0.45)', fontWeight: 500 }}>(optional override)</span></label>
                  <input
                    type="password"
                    value={tataApiKey}
                    onChange={e => setTataApiKey(e.target.value)}
                    placeholder="Leave blank to use the global TATA_TELE_API_KEY env value"
                    style={inputStyle}
                    maxLength={1000}
                    autoComplete="off"
                  />
                </div>
                <p style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)', margin: '10px 2px 0' }}>
                  Used by the Call button to route through Smartflo. Leave blank if you don't have these from Tata Tele yet.
                </p>
              </div>
            )}

            {/* Password */}
            <div>
              <label style={fieldLabelStyle}>
                Password
                {isEdit && <span style={{ color: 'rgba(91,33,182,0.40)', fontWeight: 500 }}> (optional)</span>}
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={isEdit ? 'Leave blank to keep current' : 'Min. 6 characters'}
                  style={{ ...inputStyle, paddingRight: '2.8rem' }}
                  maxLength={128}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw(v => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(91,33,182,0.45)', padding: 4 }}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                </button>
              </div>
            </div>
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
