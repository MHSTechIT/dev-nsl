import { useState, useEffect, useCallback, useRef } from 'react';
import Toast from '../components/Toast';

/* ──────────────────────────────────────────────────────────────────────
   Sales → Alerts tab.

   CRUD over telegram_alert_recipients. Two recipient kinds:
     • team_leader → a TL who receives alerts about callers reporting to
       them (junior + senior callers under a specific team_leader_id).
     • manager    → receives alerts about all callers in a department
       (NULL department = subscribes to everything).

   Each row exposes a TEST button that pings the recipient's Telegram
   chat so the admin can confirm the chat_id is correct before saving.

   Visual language matches WhatsAppLinksEditor / SalesNotificationsView —
   white cards, labeled inputs, soft purple accents, no garish dirty-state
   backgrounds (we use a small "Unsaved" pill instead).
   ────────────────────────────────────────────────────────────────────── */

const FONT       = 'Outfit, sans-serif';
const PURPLE_DK  = '#3B0764';
const PURPLE     = '#5B21B6';
const PURPLE_BG  = 'rgba(237,234,248,0.55)';
const PURPLE_BR  = 'rgba(139,92,246,0.20)';

export default function SalesAlertsView({ token, source = 'all' }) {
  const [recipients,  setRecipients]  = useState([]);
  const [teamLeaders, setTeamLeaders] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [testingId,   setTestingId]   = useState(null);
  const [error,       setError]       = useState('');
  const [toast,       setToast]       = useState({ msg: '', kind: 'success' });
  const [rows,        setRows]        = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [alertsRes, usersRes] = await Promise.all([
        fetch(`/api/admin/telegram-alerts?source=${encodeURIComponent(source)}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/crm-users?workspace=${encodeURIComponent(source)}`,    { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (!alertsRes.ok) throw new Error('Failed to load alert recipients.');
      const alertsData = await alertsRes.json();
      setRecipients(alertsData.recipients || []);
      setRows((alertsData.recipients || []).map(r => ({ ...r, _persisted: true })));

      if (usersRes.ok) {
        const u = await usersRes.json();
        setTeamLeaders((u.users || []).filter(x => x.role === 'team_leader'));
      }
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, source]);

  useEffect(() => { load(); }, [load]);

  function addBlankRow() {
    setRows(prev => [
      ...prev,
      {
        _draft:           true,
        _localId:         `draft-${Date.now()}-${Math.random()}`,
        telegram_chat_id: '',
        target_type:      'team_leader',
        team_leader_id:   '',
        department:       '',
        label:            '',
      },
    ]);
  }

  function patchRow(idx, patch) {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch, _dirty: !r._draft } : r)));
  }

  async function removeRow(idx) {
    const row = rows[idx];
    if (row._draft) {
      setRows(prev => prev.filter((_, i) => i !== idx));
      return;
    }
    if (!confirm('Remove this Telegram recipient?')) return;
    try {
      const res = await fetch(`/api/admin/telegram-alerts/${row.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Delete failed.');
      setToast({ msg: 'Recipient removed.', kind: 'success' });
      load();
    } catch (e) {
      setToast({ msg: e.message, kind: 'error' });
    }
  }

  async function saveAll() {
    setSaving(true);
    setError('');
    try {
      for (const row of rows) {
        if (row._draft) {
          if (!row.telegram_chat_id || !String(row.telegram_chat_id).trim()) continue;
          const body = {
            telegram_chat_id: row.telegram_chat_id,
            target_type:      row.target_type,
            team_leader_id:   row.target_type === 'team_leader' ? row.team_leader_id || null : null,
            department:       row.target_type === 'manager'     ? row.department || null     : null,
            label:            row.label || null,
          };
          if (row.target_type === 'team_leader' && !body.team_leader_id) {
            throw new Error('Pick a Team Leader for the new row before saving.');
          }
          const res = await fetch('/api/admin/telegram-alerts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Create failed.');
          }
        } else if (row._dirty) {
          const body = {
            telegram_chat_id: row.telegram_chat_id,
            target_type:      row.target_type,
            team_leader_id:   row.target_type === 'team_leader' ? row.team_leader_id || null : null,
            department:       row.target_type === 'manager'     ? row.department || null     : null,
            label:            row.label || null,
          };
          const res = await fetch(`/api/admin/telegram-alerts/${row.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error('Update failed.');
        }
      }
      setToast({ msg: 'All recipients saved.', kind: 'success' });
      load();
    } catch (e) {
      setToast({ msg: e.message, kind: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function sendTest(row) {
    if (row._draft || row._dirty) {
      setToast({ msg: 'Save the row first, then test.', kind: 'info' });
      return;
    }
    setTestingId(row.id);
    try {
      const res = await fetch(`/api/admin/telegram-alerts/${row.id}/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Test send failed.');
      }
      setToast({ msg: 'Test message sent.', kind: 'success' });
    } catch (e) {
      setToast({ msg: e.message, kind: 'error' });
    } finally {
      setTestingId(null);
    }
  }

  const dirtyCount = rows.filter(r => r._draft || r._dirty).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && (
        <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: FONT, fontSize: '0.82rem', color: '#DC2626', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Body: list of recipient rows, plus ADD/SAVE actions. */}
      <div className="bg-white rounded-card" style={{
        padding: 18,
        boxShadow: '0 2px 12px rgba(91,33,182,0.08)',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', fontFamily: FONT, color: 'rgba(91,33,182,0.55)', fontSize: '0.86rem' }}>
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div style={{
            padding: 36, textAlign: 'center', fontFamily: FONT,
            borderRadius: 14, border: `1.5px dashed ${PURPLE_BR}`,
            background: PURPLE_BG,
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: '50%',
              background: 'rgba(91,33,182,0.10)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8,
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 4.5 2.5 12.5l6 2 2 6 11-16Z"/>
              </svg>
            </div>
            <div style={{ fontWeight: 700, color: PURPLE_DK, fontSize: '0.95rem' }}>No recipients yet</div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem', marginTop: 2 }}>
              Click "+ Add recipient" to register a Telegram chat.
            </div>
          </div>
        ) : (
          rows.map((row, idx) => (
            <AlertRow
              key={row.id || row._localId}
              row={row}
              teamLeaders={teamLeaders}
              testing={testingId === row.id}
              onChange={(patch) => patchRow(idx, patch)}
              onTest={() => sendTest(row)}
              onRemove={() => removeRow(idx)}
            />
          ))
        )}

        {/* Action bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          marginTop: 6, paddingTop: 14, borderTop: `1px solid ${PURPLE_BR}`,
        }}>
          <button onClick={addBlankRow} style={ghostBtn()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add recipient
          </button>
          <button
            onClick={saveAll}
            disabled={saving || dirtyCount === 0}
            style={primaryBtn(saving || dirtyCount === 0)}
          >
            {saving ? 'Saving…' : dirtyCount > 0 ? `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}` : 'Save'}
          </button>
        </div>
      </div>

      {toast.msg && <Toast message={toast.msg} kind={toast.kind} onDone={() => setToast({ msg: '', kind: 'success' })} />}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   AlertRow — one recipient, displayed as a labeled-input card.
   Left edge accent matches Notifications: amber when unsaved, purple
   when persisted, green when target is a manager (whole-dept).
   ────────────────────────────────────────────────────────────────────── */
function AlertRow({ row, teamLeaders, testing, onChange, onTest, onRemove }) {
  const isManager = row.target_type === 'manager';
  const isDirty   = row._draft || row._dirty;

  const dropdownValue = isManager
    ? `manager:${row.department || ''}`
    : `tl:${row.team_leader_id || ''}`;

  function onDropdownChange(e) {
    const v = e.target.value;
    if (v.startsWith('manager:')) {
      onChange({ target_type: 'manager', team_leader_id: '', department: v.slice('manager:'.length) });
    } else if (v.startsWith('tl:')) {
      onChange({ target_type: 'team_leader', department: '', team_leader_id: v.slice('tl:'.length) });
    }
  }

  const accent = isDirty
    ? '#F59E0B'                       // amber — unsaved
    : isManager ? '#16A34A' : PURPLE;  // green for managers, purple for TL

  // What this recipient covers, in plain words. Shown as a subtitle so
  // the admin doesn't have to re-read the dropdown to see the scope.
  const scopeLabel = (() => {
    if (isManager) {
      if (!row.department) return 'Manager — all departments';
      return `Manager — ${row.department}`;
    }
    const tl = teamLeaders.find(t => t.id === row.team_leader_id);
    if (!tl) return 'Team Leader (none selected)';
    return `Team Leader — ${tl.full_name}${tl.department ? ` · ${tl.department}` : ''}`;
  })();

  return (
    <div style={{
      borderRadius: 14,
      border: `1px solid ${PURPLE_BR}`,
      borderLeft: `4px solid ${accent}`,
      background: '#fff',
      padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 12,
      transition: 'border-color 200ms',
    }}>
      {/* Top row: scope label + status pill + remove button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: FONT, fontWeight: 700, fontSize: '0.88rem', color: PURPLE_DK,
        }}>
          {scopeLabel}
        </span>

        {isDirty && (
          <span style={{
            fontFamily: FONT, fontSize: '0.66rem', fontWeight: 800, letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: '#B45309', background: 'rgba(245,158,11,0.12)',
            padding: '2px 8px', borderRadius: 50,
            border: '1px solid rgba(245,158,11,0.30)',
          }}>
            {row._draft ? 'New' : 'Unsaved'}
          </span>
        )}

        <button
          onClick={onRemove}
          title="Remove recipient"
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: 'none',
            color: 'rgba(220,38,38,0.85)',
            cursor: 'pointer',
            padding: 4, borderRadius: 8,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>

      {/* Field grid — Telegram User ID + Scope dropdown + Label, all
          three with a label on top in the WhatsAppLinksEditor style. */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'flex-end',
      }}>
        <Field label="Telegram User ID" style={{ flex: '1 1 160px' }}>
          <input
            value={row.telegram_chat_id || ''}
            onChange={(e) => onChange({ telegram_chat_id: e.target.value })}
            placeholder="e.g. 123456789"
            style={inputStyle()}
          />
        </Field>

        <Field label="Recipient role" style={{ flex: '1 1 200px' }}>
          <RoleDropdown
            value={dropdownValue}
            teamLeaders={teamLeaders}
            onChange={(v) => onDropdownChange({ target: { value: v } })}
          />
        </Field>

        <Field label="Label (optional)" style={{ flex: '1 1 160px' }}>
          <input
            value={row.label || ''}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder="e.g. Mani's phone"
            style={inputStyle()}
          />
        </Field>

        <button
          onClick={onTest}
          disabled={testing || isDirty}
          style={{ ...testBtn(testing || isDirty), flex: '0 0 auto' }}
          title={isDirty ? 'Save the row first, then test' : 'Send a test message to this chat'}
        >
          {testing ? (
            <>
              <Spinner /> Sending…
            </>
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2 11 13"/>
                <path d="M22 2l-7 20-4-9-9-4 20-7Z"/>
              </svg>
              Test
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   RoleDropdown — custom select that replaces the native <select> so it
   matches the rest of the CRM. Values are the same encoded strings the
   native version used ("tl:<uuid>" / "manager:<dept>"), so the parent
   handler is unchanged.
   ────────────────────────────────────────────────────────────────────── */
function RoleDropdown({ value, teamLeaders, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close on outside click + Escape, so the popover behaves like a real
  // dropdown rather than something that gets stuck open behind other UI.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);

  // Resolve current value to a friendly label for the trigger button.
  const triggerLabel = (() => {
    if (!value || value === 'tl:') return '— Pick TL or Manager —';
    if (value.startsWith('manager:')) {
      const d = value.slice('manager:'.length);
      if (!d) return 'Manager — All departments';
      return `Manager — ${d[0].toUpperCase()}${d.slice(1)}`;
    }
    if (value.startsWith('tl:')) {
      const tl = teamLeaders.find(t => t.id === value.slice('tl:'.length));
      if (!tl) return '— Pick TL or Manager —';
      return `${tl.full_name}${tl.department ? ` (${tl.department})` : ''}`;
    }
    return '— Pick TL or Manager —';
  })();

  const isPlaceholder = !value || value === 'tl:';

  function pick(v) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {/* Trigger — styled identically to inputStyle() so the three
          form fields visually line up in the row. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          ...inputStyle(),
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, cursor: 'pointer', textAlign: 'left',
          color: isPlaceholder ? 'rgba(91,33,182,0.50)' : PURPLE_DK,
          borderColor: open ? 'rgba(91,33,182,0.50)' : PURPLE_BR,
          background: open ? '#fff' : 'rgba(237,234,248,0.30)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerLabel}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0, color: PURPLE }}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Popover panel */}
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
            background: '#fff',
            borderRadius: 14,
            border: `1px solid ${PURPLE_BR}`,
            boxShadow: '0 12px 36px rgba(91,33,182,0.18)',
            padding: 6,
            zIndex: 50,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          <DropdownItem
            label="— Pick TL or Manager —"
            selected={isPlaceholder}
            muted
            onClick={() => pick('tl:')}
          />

          <SectionLabel>Team Leaders</SectionLabel>
          {teamLeaders.length === 0 ? (
            <div style={{
              padding: '8px 12px', fontFamily: FONT, fontSize: '0.78rem',
              color: 'rgba(91,33,182,0.45)', fontStyle: 'italic',
            }}>
              No team leaders configured
            </div>
          ) : (
            teamLeaders.map(tl => {
              const v = `tl:${tl.id}`;
              return (
                <DropdownItem
                  key={tl.id}
                  label={`${tl.full_name}${tl.department ? ` (${tl.department})` : ''}`}
                  icon={<PersonIcon />}
                  selected={value === v}
                  onClick={() => pick(v)}
                />
              );
            })
          )}

          <SectionLabel>Manager</SectionLabel>
          <DropdownItem
            label="Manager — Sales"
            icon={<BadgeIcon />}
            selected={value === 'manager:sales'}
            onClick={() => pick('manager:sales')}
          />
          <DropdownItem
            label="Manager — Marketing"
            icon={<BadgeIcon />}
            selected={value === 'manager:marketing'}
            onClick={() => pick('manager:marketing')}
          />
          <DropdownItem
            label="Manager — All departments"
            icon={<BadgeIcon />}
            selected={value === 'manager:'}
            onClick={() => pick('manager:')}
          />
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      padding: '8px 12px 4px',
      fontFamily: FONT, fontSize: '0.65rem', fontWeight: 800,
      color: 'rgba(91,33,182,0.55)', textTransform: 'uppercase', letterSpacing: 0.6,
    }}>
      {children}
    </div>
  );
}

function DropdownItem({ label, icon, selected, muted, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 12px',
        borderRadius: 10,
        border: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: FONT,
        fontSize: '0.85rem',
        fontWeight: selected ? 700 : 500,
        color: muted ? 'rgba(91,33,182,0.55)' : PURPLE_DK,
        background: selected
          ? 'rgba(91,33,182,0.10)'
          : hover
            ? 'rgba(237,234,248,0.60)'
            : 'transparent',
        transition: 'background 150ms',
      }}
    >
      {icon && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, borderRadius: 7,
          background: 'rgba(91,33,182,0.10)', color: PURPLE,
          flexShrink: 0,
        }}>
          {icon}
        </span>
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {selected && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
    </button>
  );
}

function PersonIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  );
}

function BadgeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/>
      <path d="m8.5 14-1.5 7L12 18l5 3-1.5-7"/>
    </svg>
  );
}

/* ── Small bits ────────────────────────────────────────────────────── */
function Field({ label, children, style }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, ...style }}>
      <span style={{
        fontFamily: FONT, fontSize: '0.7rem', fontWeight: 700,
        color: '#4A1A94', textTransform: 'uppercase', letterSpacing: 0.4,
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Spinner() {
  return (
    <span style={{
      width: 12, height: 12, borderRadius: '50%',
      border: '2px solid currentColor', borderRightColor: 'transparent',
      animation: 'mhs-spin 700ms linear infinite',
      display: 'inline-block',
    }}>
      <style>{`@keyframes mhs-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

/* ── styling helpers ───────────────────────────────────────────────── */
function inputStyle() {
  return {
    width: '100%',
    height: '2.4rem',
    padding: '0 12px',
    borderRadius: 10,
    border: `1px solid ${PURPLE_BR}`,
    background: 'rgba(237,234,248,0.30)',
    color: PURPLE_DK,
    fontFamily: FONT,
    fontWeight: 500,
    fontSize: '0.85rem',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 200ms, background 200ms',
  };
}

function primaryBtn(disabled) {
  return {
    padding: '9px 22px',
    borderRadius: 50,
    border: 'none',
    background: disabled ? 'rgba(91,33,182,0.30)' : PURPLE,
    color: '#fff',
    fontFamily: FONT,
    fontWeight: 700,
    fontSize: '0.82rem',
    letterSpacing: 0.2,
    cursor: disabled ? 'default' : 'pointer',
    boxShadow: disabled ? 'none' : '0 4px 14px rgba(91,33,182,0.30)',
    transition: 'all 200ms',
  };
}

function ghostBtn() {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 16px',
    borderRadius: 50,
    border: `1.5px solid ${PURPLE}`,
    background: '#fff',
    color: PURPLE,
    fontFamily: FONT,
    fontWeight: 700,
    fontSize: '0.8rem',
    cursor: 'pointer',
    transition: 'all 200ms',
  };
}

function testBtn(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '9px 18px',
    height: '2.4rem',
    borderRadius: 50,
    border: `1px solid ${disabled ? 'rgba(91,33,182,0.20)' : PURPLE_BR}`,
    background: disabled ? 'rgba(91,33,182,0.06)' : '#fff',
    color: disabled ? 'rgba(91,33,182,0.40)' : PURPLE_DK,
    fontFamily: FONT,
    fontWeight: 700,
    fontSize: '0.8rem',
    cursor: disabled ? 'default' : 'pointer',
    transition: 'all 200ms',
    whiteSpace: 'nowrap',
  };
}
