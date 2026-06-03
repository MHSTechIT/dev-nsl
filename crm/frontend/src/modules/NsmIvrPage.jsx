import { useState, useEffect, useCallback } from 'react';

/* NSM-IVR › Marketing › IVR
   -------------------------
   Dynamic Cloudshope reminder campaigns. Admins add/remove their own calls;
   each campaign has a trigger type, timing, a voice file ID and an on/off.
   Saved to nsm_ivr_call_config; the schedulers apply changes within ~30s
   (no restart). Backend: GET/PUT {apiBase}/ivr-config. */

const PURPLE = '#5B21B6';

const TRIGGERS = [
  { value: 'immediate',      label: 'On lead arrival (immediate)' },
  { value: 'days_before_at', label: 'Days before webinar, at time' },
  { value: 'on_day_at',      label: 'On webinar day, at time' },
  { value: 'offset_minutes', label: 'Minutes before/after webinar' },
];

const inp = { boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1px solid rgba(139,92,246,0.30)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#3B0764', outline: 'none' };
const card = { background: '#fff', borderRadius: 14, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', padding: '14px 16px' };
const lbl = { fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'rgba(91,33,182,0.55)', marginBottom: 4, display: 'block' };

function newCampaign() {
  return { id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: 'New reminder', trigger_type: 'on_day_at', time: '10:00', voice_id: '', enabled: false };
}

export default function NsmIvrPage({ token, apiBase = '/api/admin/nsm-ivr' }) {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const authHeaders = { Authorization: `Bearer ${token}` };

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${apiBase}/ivr-config`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error())))
      .then(d => setCfg(d.config || { max_attempts: 10, campaigns: [] }))
      .catch(() => setCfg({ max_attempts: 10, campaigns: [] }))
      .finally(() => setLoading(false));
  }, [token, apiBase]);

  useEffect(() => { load(); }, [load]);

  const patch    = (i, p) => setCfg(c => ({ ...c, campaigns: c.campaigns.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
  const remove   = i      => setCfg(c => ({ ...c, campaigns: c.campaigns.filter((_, j) => j !== i) }));
  const add      = ()     => setCfg(c => ({ ...c, campaigns: [...c.campaigns, newCampaign()] }));

  async function save() {
    setSaving(true); setMsg('');
    try {
      const res = await fetch(`${apiBase}/ivr-config`, {
        method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      setCfg(d.config); setMsg('Saved.');
      setTimeout(() => setMsg(''), 2500);
    } catch (e) { setMsg(e.message); }
    finally { setSaving(false); }
  }

  if (loading || !cfg) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.6)', fontFamily: 'Outfit, sans-serif' }}>Loading…</div>;
  }

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: '#3B0764' }}>IVR voice-call reminders</div>
          <div style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)', marginTop: 2 }}>
            Add your own Cloudshope campaigns. Changes apply within ~30s. Each trigger is independent and fires
            <strong> once per lead</strong> for <strong>every lead in the running batch</strong> (eligible = not opted out · has phone).
          </div>
        </div>
        <button type="button" onClick={save} disabled={saving}
          style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', fontWeight: 700, fontSize: '0.88rem', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1, alignSelf: 'flex-end' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && <span style={{ fontSize: '0.82rem', color: PURPLE, fontWeight: 600, alignSelf: 'flex-end' }}>{msg}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {cfg.campaigns.map((c, i) => (
          <div key={c.id} style={{ ...card, display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 150, flex: 1 }}>
              <label style={lbl}>Name</label>
              <input style={{ ...inp, width: '100%' }} value={c.name} onChange={e => patch(i, { name: e.target.value })} />
            </div>
            <div style={{ minWidth: 200 }}>
              <label style={lbl}>Trigger</label>
              <select style={{ ...inp, width: '100%', cursor: 'pointer' }} value={c.trigger_type} onChange={e => patch(i, { trigger_type: e.target.value })}>
                {TRIGGERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            {/* trigger-specific fields */}
            {c.trigger_type === 'days_before_at' && (
              <>
                <div style={{ width: 80 }}>
                  <label style={lbl}>Days before</label>
                  <input type="number" min="0" max="30" style={{ ...inp, width: '100%' }} value={c.days_before ?? 1} onChange={e => patch(i, { days_before: e.target.value })} />
                </div>
                <div style={{ width: 110 }}>
                  <label style={lbl}>Time (IST)</label>
                  <input type="time" style={{ ...inp, width: '100%' }} value={c.time || '19:00'} onChange={e => patch(i, { time: e.target.value })} />
                </div>
              </>
            )}
            {c.trigger_type === 'on_day_at' && (
              <div style={{ width: 110 }}>
                <label style={lbl}>Time (IST)</label>
                <input type="time" style={{ ...inp, width: '100%' }} value={c.time || '13:30'} onChange={e => patch(i, { time: e.target.value })} />
              </div>
            )}
            {c.trigger_type === 'offset_minutes' && (
              <div style={{ width: 130 }}>
                <label style={lbl}>Minutes (− before)</label>
                <input type="number" style={{ ...inp, width: '100%' }} value={c.offset_minutes ?? -30} onChange={e => patch(i, { offset_minutes: e.target.value })} />
              </div>
            )}

            <div style={{ width: 130 }}>
              <label style={lbl}>Voice file ID</label>
              <input style={{ ...inp, width: '100%' }} placeholder="e.g. 103182" value={c.voice_id || ''} onChange={e => patch(i, { voice_id: e.target.value })} />
            </div>
            <button type="button" onClick={() => patch(i, { enabled: !c.enabled })}
              style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem', background: c.enabled ? PURPLE : 'rgba(91,33,182,0.12)', color: c.enabled ? '#fff' : '#5B21B6' }}>
              {c.enabled ? 'On' : 'Off'}
            </button>
            <button type="button" onClick={() => remove(i)} title="Delete campaign"
              style={{ padding: '8px 12px', borderRadius: 9, border: '1px solid rgba(220,38,38,0.3)', background: '#fff', color: '#DC2626', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem' }}>
              Delete
            </button>
          </div>
        ))}
        {cfg.campaigns.length === 0 && (
          <div style={{ ...card, textAlign: 'center', color: 'rgba(91,33,182,0.5)' }}>No campaigns yet — add one below.</div>
        )}
      </div>

      <button type="button" onClick={add}
        style={{ alignSelf: 'flex-start', padding: '10px 18px', borderRadius: 10, border: `1.5px dashed ${PURPLE}`, background: 'rgba(91,33,182,0.05)', color: PURPLE, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>
        + Add campaign
      </button>
    </div>
  );
}
