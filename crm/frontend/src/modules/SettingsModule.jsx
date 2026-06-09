import { useState, useEffect } from 'react';
import BrandSelect from '../components/BrandSelect';

/* SettingsModule — "Edit / Create User" form configuration.
   Click the card → per-role cards. Each role card lists the Create-User
   columns (built-in + custom) with their type and an on/off switch, and lets
   you add / delete custom columns. Saved to /api/admin/user-form-config and
   honored by the Users page Create/Edit form. */

const ROLES = [
  { value: 'junior_caller', label: 'Junior Caller' },
  { value: 'senior_caller', label: 'Senior Caller' },
  { value: 'team_leader',   label: 'Team Leader' },
  { value: 'manager',       label: 'Manager' },
  { value: 'trainer',       label: 'Trainer' },
  { value: 'admin',         label: 'Admin' },
  { value: 'webinar',       label: 'Webinar' },
  { value: 'l1_sales',      label: 'L1 Sales' },
];

/* Built-in Create-User fields. `required` ones can't be turned off. */
const BUILTIN_FIELDS = [
  { key: 'full_name',         label: 'Full Name',          type: 'Text',     required: true },
  { key: 'email',             label: 'Email',              type: 'Email',    required: true },
  { key: 'password',          label: 'Password',           type: 'Password', required: true },
  { key: 'phone',             label: 'Phone',              type: 'Phone' },
  { key: 'department',        label: 'Department',         type: 'Select' },
  { key: 'workspace',         label: 'Workspace',          type: 'Select' },
  { key: 'manager_id',        label: 'Manager',            type: 'Select' },
  { key: 'team_leader_id',    label: 'Team Leader',        type: 'Select' },
  { key: 'tata_account_type', label: 'Smartflo Account',   type: 'Select' },
  { key: 'tata_extension',    label: 'Smartflo Extension', type: 'Text' },
  { key: 'tata_agent_number', label: 'Smartflo Agent #',   type: 'Phone' },
  { key: 'tata_caller_id',    label: 'Smartflo Caller ID', type: 'Phone' },
];

const CUSTOM_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'date', label: 'Date' },
];

const PURPLE = '#5B21B6';

function Toggle({ on, disabled, onClick }) {
  return (
    <button
      type="button" onClick={disabled ? undefined : onClick} disabled={disabled}
      title={disabled ? 'Required — always on' : (on ? 'On' : 'Off')}
      style={{
        width: 38, height: 21, borderRadius: 999, border: 'none',
        cursor: disabled ? 'default' : 'pointer', position: 'relative', flexShrink: 0,
        background: on ? '#059669' : 'rgba(91,33,182,0.25)', opacity: disabled ? 0.55 : 1,
        transition: 'background 160ms',
      }}
    >
      <span style={{ position: 'absolute', top: 3, left: on ? 20 : 3, width: 15, height: 15, borderRadius: '50%', background: '#fff', transition: 'left 160ms', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

export default function SettingsModule({ token }) {
  const [view, setView]     = useState('home'); // 'home' | 'roles'
  const [config, setConfig] = useState({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast]   = useState('');
  // Inline composers (instead of browser prompts)
  const [showAddRole, setShowAddRole]   = useState(false);
  const [newRoleName, setNewRoleName]   = useState('');
  const [showFieldsModal, setShowFieldsModal] = useState(false);
  const [showAddInModal, setShowAddInModal]   = useState(false);
  const [confirmKey, setConfirmKey]     = useState(null);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState('text');

  useEffect(() => {
    fetch('/api/admin/user-form-config', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setConfig(d.config || {}))
      .catch(() => {});
  }, [token]);

  // Helpers reading/writing the per-role config (immutably).
  const roleCfg = (role) => config[role] || {};
  const builtinOn = (role, key) => roleCfg(role).builtins?.[key] !== false; // default ON
  const customList = (role) => roleCfg(role).custom || [];

  function mutateRole(role, fn) {
    setConfig(prev => {
      const cur = prev[role] || {};
      const next = fn({ builtins: { ...(cur.builtins || {}) }, custom: [...(cur.custom || [])] });
      return { ...prev, [role]: next };
    });
  }
  const toggleBuiltin = (role, key) => mutateRole(role, c => ({ ...c, builtins: { ...c.builtins, [key]: !(c.builtins[key] !== false) } }));
  const toggleCustom  = (role, idx) => mutateRole(role, c => { const cs = [...c.custom]; cs[idx] = { ...cs[idx], enabled: !cs[idx].enabled }; return { ...c, custom: cs }; });
  const deleteCustom  = (role, idx) => mutateRole(role, c => ({ ...c, custom: c.custom.filter((_, i) => i !== idx) }));
  function addCustom(role, label, type) {
    const lbl = (label || '').trim();
    if (!lbl) return;
    const key = 'cf_' + lbl.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Math.random().toString(36).slice(2, 5);
    mutateRole(role, c => ({ ...c, custom: [...c.custom, { key, label: lbl, type, enabled: true }] }));
  }

  // Built-in roles + any custom roles added here (stored under config.__roles).
  const allRoles = [...ROLES, ...((config.__roles) || [])];

  function addRole(name) {
    const nm = (name || '').trim();
    if (!nm) return;
    const value = 'role_' + nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Math.random().toString(36).slice(2, 4);
    setConfig(prev => ({
      ...prev,
      __roles: [...(prev.__roles || []), { value, label: nm }],
      [value]: prev[value] || { builtins: {}, custom: [] },
    }));
  }

  function addFieldAll(name, type) {
    const nm = (name || '').trim();
    if (!nm) return;
    const key = 'cf_' + nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Math.random().toString(36).slice(2, 5);
    setConfig(prev => {
      const roles = [...ROLES, ...((prev.__roles) || [])];
      const next = { ...prev };
      for (const r of roles) {
        const cur = next[r.value] || {};
        next[r.value] = {
          builtins: { ...(cur.builtins || {}) },
          custom: [...(cur.custom || []), { key, label: nm, type: type || 'text', enabled: true }],
        };
      }
      return next;
    });
  }

  function deleteFieldEverywhere(key) {
    setConfig(prev => {
      const roles = [...ROLES, ...((prev.__roles) || [])];
      const next = { ...prev };
      for (const r of roles) {
        const cur = next[r.value];
        if (cur && cur.custom) next[r.value] = { ...cur, custom: cur.custom.filter(c => c.key !== key) };
      }
      return next;
    });
    setConfirmKey(null);
  }

  // Distinct custom fields across all roles (for the Fields modal list).
  const allCustomFields = (() => {
    const map = new Map();
    for (const r of allRoles) {
      for (const cf of (config[r.value]?.custom || [])) {
        if (cf && cf.key && !map.has(cf.key)) map.set(cf.key, { key: cf.key, label: cf.label, type: cf.type });
      }
    }
    return Array.from(map.values());
  })();

  async function save() {
    setSaving(true); setToast('');
    try {
      const res = await fetch('/api/admin/user-form-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ config }),
      });
      setToast(res.ok ? 'Saved!' : 'Failed to save.');
    } catch { setToast('Network error.'); }
    finally { setSaving(false); setTimeout(() => setToast(''), 3000); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'Outfit, sans-serif' }}>
      {view === 'home' ? (
        /* Clickable entry card */
        <button
          type="button"
          onClick={() => setView('roles')}
          className="bg-white rounded-card shadow-card"
          style={{ textAlign: 'left', border: 'none', cursor: 'pointer', padding: 0, overflow: 'hidden', width: '100%' }}
        >
          <div style={{ padding: '22px 24px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(91,33,182,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
            </div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, color: '#3B0764', fontWeight: 800, fontSize: '1.1rem' }}>Edit / Create User</h2>
              <p style={{ margin: '3px 0 0', color: 'rgba(91,33,182,0.6)', fontSize: '0.85rem' }}>
                Configure which columns appear in the Create User form for each role — toggle fields on/off and add custom fields.
              </p>
            </div>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.5)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </button>
      ) : (
        <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Header with back + save */}
          <div style={{ padding: '16px 22px', borderBottom: '1px solid rgba(209,196,240,0.35)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button onClick={() => setView('home')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid rgba(124,58,237,0.3)', background: '#fff', borderRadius: 50, padding: '6px 14px', cursor: 'pointer', fontWeight: 700, fontSize: '0.8rem', color: PURPLE, fontFamily: 'Outfit, sans-serif' }}>← Back</button>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, color: '#3B0764', fontWeight: 800, fontSize: '1.05rem' }}>Create-User fields by role</h2>
            </div>
            {toast && <span style={{ fontSize: '0.8rem', fontWeight: 600, color: toast === 'Saved!' ? '#059669' : '#DC2626' }}>{toast}</span>}
            <button onClick={() => { setShowAddRole(s => !s); setShowAddField(false); }} style={{ height: 36, padding: '0 16px', borderRadius: 50, border: '1px solid rgba(91,33,182,0.30)', background: showAddRole ? 'rgba(91,33,182,0.10)' : '#fff', color: PURPLE, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add Role
            </button>
            <button onClick={() => { setShowFieldsModal(true); setShowAddInModal(false); setConfirmKey(null); }} style={{ height: 36, padding: '0 16px', borderRadius: 50, border: '1px solid rgba(91,33,182,0.30)', background: '#fff', color: PURPLE, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              Fields
            </button>
            <button onClick={save} disabled={saving} style={{ height: 36, padding: '0 22px', borderRadius: 50, border: 'none', background: PURPLE, color: '#fff', fontWeight: 800, fontSize: '0.82rem', cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, boxShadow: '0 2px 12px rgba(91,33,182,0.3)' }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>

          {/* Inline composer (Add Role) */}
          {showAddRole && (
            <div style={{ padding: '14px 22px', borderBottom: '1px solid rgba(209,196,240,0.35)', background: 'rgba(237,234,248,0.30)', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {showAddRole && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 280 }}>
                  <input
                    autoFocus
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { addRole(newRoleName); setNewRoleName(''); setShowAddRole(false); } }}
                    placeholder="New role name"
                    style={{ flex: 1, minWidth: 0, height: 40, padding: '0 14px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.8)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
                  />
                  <button type="button" onClick={() => { addRole(newRoleName); setNewRoleName(''); setShowAddRole(false); }} title="Create role"
                    style={{ width: 40, height: 40, borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Role cards */}
          <div style={{ padding: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
            {allRoles.map(r => (
              <RoleCard
                key={r.value}
                role={r}
                builtinOn={builtinOn}
                customList={customList}
                toggleBuiltin={toggleBuiltin}
                toggleCustom={toggleCustom}
                deleteCustom={deleteCustom}
                addCustom={addCustom}
              />
            ))}
          </div>

          {/* Fields modal — list of created custom fields + add + delete */}
          {showFieldsModal && (
            <div
              onClick={(e) => e.target === e.currentTarget && setShowFieldsModal(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(30,8,60,0.45)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
            >
              <div style={{ width: 'min(580px, 96vw)', maxHeight: '88vh', overflowY: 'auto', background: '#fff', borderRadius: 18, padding: 22, boxShadow: '0 24px 64px rgba(30,8,60,0.4)', fontFamily: 'Outfit, sans-serif' }}>
                {/* Header: title + Add Field + close */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 16 }}>
                  <h3 style={{ margin: 0, color: '#3B0764', fontWeight: 800, fontSize: '1.1rem' }}>Fields</h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => setShowAddInModal(s => !s)} style={{ height: 34, padding: '0 14px', borderRadius: 50, border: 'none', background: PURPLE, color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                      Add Field
                    </button>
                    <button onClick={() => setShowFieldsModal(false)} style={{ border: 'none', background: 'rgba(91,33,182,0.08)', color: PURPLE, width: 34, height: 34, borderRadius: 9, cursor: 'pointer', fontWeight: 800 }}>✕</button>
                  </div>
                </div>

                {/* Inline add row */}
                {showAddInModal && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <input
                      autoFocus
                      value={newFieldName}
                      onChange={(e) => setNewFieldName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { addFieldAll(newFieldName, newFieldType); setNewFieldName(''); setNewFieldType('text'); setShowAddInModal(false); } }}
                      placeholder="New field name (added to all roles)"
                      style={{ flex: 1, minWidth: 0, height: 40, padding: '0 14px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.8)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
                    />
                    <div style={{ width: 120 }}>
                      <BrandSelect compact value={newFieldType} onChange={setNewFieldType} options={CUSTOM_TYPES} />
                    </div>
                    <button type="button" onClick={() => { addFieldAll(newFieldName, newFieldType); setNewFieldName(''); setNewFieldType('text'); setShowAddInModal(false); }} title="Add field to all roles"
                      style={{ width: 40, height: 40, borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                  </div>
                )}

                {/* List of fields — built-in (read-only) + custom (deletable) */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: 'rgba(91,33,182,0.55)', margin: '2px 0' }}>Built-in fields</div>
                  {BUILTIN_FIELDS.map(f => (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid rgba(91,33,182,0.12)', borderRadius: 10, background: 'rgba(237,234,248,0.30)' }}>
                      <span style={{ flex: 1, fontWeight: 700, fontSize: '0.88rem', color: '#3B0764', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: PURPLE, background: 'rgba(91,33,182,0.08)', borderRadius: 50, padding: '2px 9px', flexShrink: 0 }}>{f.type}</span>
                      <span style={{ fontSize: '0.66rem', fontWeight: 700, color: 'rgba(91,33,182,0.5)', flexShrink: 0 }}>{f.required ? 'Required' : 'Built-in'}</span>
                    </div>
                  ))}

                  <div style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: 'rgba(91,33,182,0.55)', margin: '10px 0 2px' }}>Custom fields</div>
                  {allCustomFields.length === 0 ? (
                    <div style={{ padding: '18px 16px', textAlign: 'center', fontSize: '0.82rem', color: 'rgba(91,33,182,0.5)', border: '1px dashed rgba(91,33,182,0.2)', borderRadius: 12 }}>
                      No custom fields yet. Click "Add Field" to create one.
                    </div>
                  ) : allCustomFields.map(f => (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid rgba(91,33,182,0.15)', borderRadius: 10 }}>
                      <span style={{ flex: 1, fontWeight: 700, fontSize: '0.88rem', color: '#3B0764', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: PURPLE, background: 'rgba(91,33,182,0.08)', borderRadius: 50, padding: '2px 9px', flexShrink: 0 }}>{(CUSTOM_TYPES.find(t => t.value === f.type) || {}).label || f.type}</span>
                      {confirmKey === f.key ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#3B0764' }}>Delete?</span>
                          <button onClick={() => deleteFieldEverywhere(f.key)} style={{ border: 'none', background: '#DC2626', color: '#fff', borderRadius: 7, padding: '5px 12px', fontWeight: 700, fontSize: '0.76rem', cursor: 'pointer' }}>Yes</button>
                          <button onClick={() => setConfirmKey(null)} style={{ border: '1px solid rgba(91,33,182,0.25)', background: '#fff', color: PURPLE, borderRadius: 7, padding: '5px 12px', fontWeight: 700, fontSize: '0.76rem', cursor: 'pointer' }}>No</button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmKey(f.key)} title="Delete field" style={{ border: 'none', background: 'none', color: '#DC2626', cursor: 'pointer', padding: 4, display: 'inline-flex', flexShrink: 0 }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoleCard({ role, builtinOn, customList, toggleBuiltin, toggleCustom, deleteCustom, addCustom }) {
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType]   = useState('text');
  const custom = customList(role.value);

  const row = (label, type, on, disabled, onToggle, onDelete) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid rgba(139,92,246,0.07)' }}>
      <span style={{ flex: 1, fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', color: '#3B0764', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.68rem', fontWeight: 700, color: '#5B21B6', background: 'rgba(91,33,182,0.08)', borderRadius: 50, padding: '2px 8px', flexShrink: 0 }}>{type}</span>
      <Toggle on={on} disabled={disabled} onClick={onToggle} />
      {onDelete && (
        <button type="button" onClick={onDelete} title="Delete field" style={{ border: 'none', background: 'none', color: '#DC2626', cursor: 'pointer', padding: 2, display: 'inline-flex' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      )}
    </div>
  );

  return (
    <div style={{ border: '1px solid rgba(91,33,182,0.18)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '0.95rem', color: '#3B0764', marginBottom: 8 }}>{role.label}</div>

      {BUILTIN_FIELDS.map(f => row(
        f.label, f.type, f.required ? true : builtinOn(role.value, f.key), f.required,
        () => toggleBuiltin(role.value, f.key), null,
      ))}

      {custom.map((cf, i) => row(
        cf.label, (CUSTOM_TYPES.find(t => t.value === cf.type) || {}).label || cf.type, cf.enabled, false,
        () => toggleCustom(role.value, i), () => deleteCustom(role.value, i),
      ))}

      {/* Add custom field */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="New field name"
          style={{ flex: 1, minWidth: 0, height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid rgba(209,196,240,0.8)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
        />
        <div style={{ width: 96 }}>
          <BrandSelect compact value={newType} onChange={setNewType} options={CUSTOM_TYPES} />
        </div>
        <button
          type="button"
          onClick={() => { addCustom(role.value, newLabel, newType); setNewLabel(''); setNewType('text'); }}
          title="Add field"
          style={{ width: 34, height: 34, borderRadius: 8, border: 'none', background: PURPLE, color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
    </div>
  );
}
