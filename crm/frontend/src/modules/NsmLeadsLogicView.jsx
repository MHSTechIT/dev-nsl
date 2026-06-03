import { useState, useEffect, useCallback } from 'react';

/* NSM-Caller › Web Reminder › Leads Logic
   ---------------------------------------
   Per-batch roster: pick which NSM callers (nsm_users) receive that batch's
   leads, distributed round-robin in list order. Saving immediately assigns any
   still-unassigned leads, and the 30s sync keeps assigning new ones.

   Backend:
     GET /api/admin/nsm/batches
     GET /api/admin/nsm/batches/:id/share-config -> { callers, config }
     PUT /api/admin/nsm/batches/:id/share-config    { entries:[{caller_id,enabled,position}] }
*/

const PURPLE = '#5B21B6';
const roleLabel = r => String(r || '').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function BatchPicker({ batches, value, onChange }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const cur = batches.find(b => b.id === value);
  return (
    <div style={{ position: 'relative', minWidth: 220 }} onMouseDown={e => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, height: '2.5rem', padding: '0 14px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', fontWeight: 600, color: '#3B0764', cursor: 'pointer' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cur ? cur.batch_name : 'Select batch'}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', flexShrink: 0 }}><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, background: '#fff', borderRadius: 10, border: '1px solid rgba(209,196,240,0.7)', boxShadow: '0 12px 32px rgba(91,33,182,0.18)', padding: 4, maxHeight: 260, overflowY: 'auto' }}>
          {batches.length === 0 && <div style={{ padding: 10, fontSize: '0.82rem', color: 'rgba(91,33,182,0.6)' }}>No batches yet.</div>}
          {batches.map(b => (
            <button key={b.id} type="button" onClick={() => { onChange(b.id); setOpen(false); }}
              style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: b.id === value ? 'rgba(91,33,182,0.10)' : 'transparent', color: b.id === value ? PURPLE : '#3B0764', fontFamily: 'Outfit, sans-serif', fontWeight: b.id === value ? 700 : 500, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {b.batch_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NsmLeadsLogicView({ token }) {
  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState('');
  const [callers, setCallers] = useState([]);
  const [enabled, setEnabled] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState('');

  const authHeaders = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    fetch('/api/admin/nsm/batches', { headers: authHeaders })
      .then(r => r.ok ? r.json() : Promise.reject(new Error()))
      .then(d => { const bs = d.batches || []; setBatches(bs); if (bs[0]) setBatchId(bs[0].id); })
      .catch(() => {});
  }, [token]);

  const loadConfig = useCallback((id) => {
    if (!id) return;
    setLoading(true); setMsg('');
    fetch(`/api/admin/nsm/batches/${id}/share-config`, { headers: authHeaders })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Failed to load')))
      .then(d => {
        setCallers(d.callers || []);
        const on = new Set((d.config || []).filter(c => c.enabled).map(c => c.caller_id));
        setEnabled(on);
      })
      .catch(() => { setCallers([]); setEnabled(new Set()); })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { loadConfig(batchId); }, [batchId, loadConfig]);

  function toggle(id) {
    setEnabled(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function save() {
    if (!batchId) return;
    setSaving(true); setMsg('');
    const entries = callers.map((c, i) => ({ caller_id: c.id, enabled: enabled.has(c.id), position: i }));
    try {
      const res = await fetch(`/api/admin/nsm/batches/${batchId}/share-config`, {
        method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Save failed');
      setMsg(`Saved — ${d.assigned ?? 0} pending lead(s) just assigned.`);
    } catch (e) { setMsg(e.message); }
    finally { setSaving(false); }
  }

  const enabledCount = enabled.size;

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 14 }}>
        <BatchPicker batches={batches} value={batchId} onChange={setBatchId} />
        <div style={{ flex: 1 }} />
        <button type="button" onClick={save} disabled={saving || !batchId}
          style={{ height: '2.5rem', padding: '0 20px', borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', fontWeight: 700, fontSize: '0.88rem', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1, boxShadow: '0 3px 12px rgba(91,33,182,0.25)' }}>
          {saving ? 'Saving…' : 'Save roster'}
        </button>
      </div>

      <p style={{ fontSize: '0.82rem', color: 'rgba(91,33,182,0.6)', margin: '0 0 12px' }}>
        Enabled callers receive this batch's leads in <strong>round-robin</strong> (top-to-bottom order). {enabledCount} of {callers.length} enabled.
        {msg && <span style={{ color: PURPLE, fontWeight: 600, marginLeft: 8 }}>{msg}</span>}
      </p>

      <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'rgba(91,33,182,0.6)', fontSize: '0.9rem' }}>Loading…</div>
        ) : callers.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>
            No active callers. Add NSM callers on the <strong>Users</strong> page first.
          </div>
        ) : callers.map((c, i) => {
          const on = enabled.has(c.id);
          return (
            <div key={c.id} onClick={() => toggle(c.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderTop: i ? '1px solid rgba(139,92,246,0.08)' : 'none', cursor: 'pointer', background: on ? 'rgba(91,33,182,0.04)' : '#fff' }}>
              <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, border: on ? 'none' : '1.5px solid rgba(91,33,182,0.35)', background: on ? PURPLE : '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                {on && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: '0.92rem', color: '#3B0764', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.full_name}</div>
                <div style={{ fontSize: '0.76rem', color: 'rgba(91,33,182,0.55)' }}>{roleLabel(c.role)} · {c.email}</div>
              </div>
              {on && <span style={{ fontSize: '0.72rem', fontWeight: 700, color: PURPLE, background: 'rgba(91,33,182,0.10)', padding: '3px 9px', borderRadius: 999 }}>#{[...callers].slice(0, i + 1).filter(x => enabled.has(x.id)).length}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
