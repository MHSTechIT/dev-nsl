import { useState, useEffect, useCallback } from 'react';

/* NSM › Marketing › Tele
   ----------------------
   Telegram alert settings: the Bot token + the Chat/User ID alerts are sent to.
   Stored per workspace via GET/PUT {apiBase}/tele-config; the Test button posts
   to {apiBase}/tele-config/test which sends a message through the saved bot. */

const PURPLE = '#5B21B6';
const lbl = { display: 'block', fontSize: '0.72rem', fontWeight: 700, color: PURPLE, marginBottom: 5, letterSpacing: '0.01em' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764', outline: 'none' };

export default function NsmTelePage({ token, apiBase = '/api/admin/nsm' }) {
  const [cfg, setCfg]       = useState(null);
  const [loading, setLoad]  = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTest]  = useState(false);
  const [msg, setMsg]       = useState('');
  const authHeaders = { Authorization: `Bearer ${token}` };

  const load = useCallback(() => {
    setLoad(true);
    fetch(`${apiBase}/tele-config`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error())))
      .then(d => setCfg(d.config || { enabled: false, bot_token: '', chat_id: '' }))
      .catch(() => setCfg({ enabled: false, bot_token: '', chat_id: '' }))
      .finally(() => setLoad(false));
  }, [token, apiBase]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true); setMsg('');
    try {
      const res = await fetch(`${apiBase}/tele-config`, {
        method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      setCfg(d.config); setMsg('Saved.'); setTimeout(() => setMsg(''), 2500);
    } catch (e) { setMsg(e.message); }
    finally { setSaving(false); }
  }

  async function sendTest() {
    setTest(true); setMsg('');
    try {
      const res = await fetch(`${apiBase}/tele-config/test`, { method: 'POST', headers: authHeaders });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Test failed');
      setMsg('✓ Test message sent — check Telegram.');
    } catch (e) { setMsg('⚠ ' + e.message); }
    finally { setTest(false); }
  }

  if (loading || !cfg) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.6)', fontFamily: 'Outfit, sans-serif' }}>Loading…</div>;
  }

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: '#3B0764' }}>Telegram alerts</div>
          <div style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)', marginTop: 2 }}>
            Send alerts to a Telegram chat via your bot. Enter the Bot token and the Chat / User ID.
          </div>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.88rem', fontWeight: 600, color: '#3B0764', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!cfg.enabled} onChange={e => setCfg(c => ({ ...c, enabled: e.target.checked }))} />
          Enabled
        </label>

        <div>
          <label style={lbl}>Bot token</label>
          <input style={inp} value={cfg.bot_token || ''} placeholder="123456789:AAH…  (from @BotFather)"
            onChange={e => setCfg(c => ({ ...c, bot_token: e.target.value }))} />
        </div>

        <div>
          <label style={lbl}>Chat / User ID</label>
          <input style={inp} value={cfg.chat_id || ''} placeholder="e.g. 987654321  (or -100… for a group)"
            onChange={e => setCfg(c => ({ ...c, chat_id: e.target.value }))} />
          <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.5)', marginTop: 5 }}>
            Tip: message your bot, then open https://api.telegram.org/bot&lt;token&gt;/getUpdates to find your chat id.
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" onClick={save} disabled={saving}
            style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', fontWeight: 700, fontSize: '0.88rem', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={sendTest} disabled={testing || !cfg.bot_token || !cfg.chat_id}
            title={!cfg.bot_token || !cfg.chat_id ? 'Enter bot token + chat id first' : 'Send a test message'}
            style={{ padding: '10px 18px', borderRadius: 10, border: `1px solid ${PURPLE}`, background: '#fff', color: PURPLE, fontWeight: 700, fontSize: '0.88rem', cursor: (testing || !cfg.bot_token || !cfg.chat_id) ? 'default' : 'pointer', opacity: (!cfg.bot_token || !cfg.chat_id) ? 0.5 : 1 }}>
            {testing ? 'Sending…' : 'Send test'}
          </button>
          {msg && <span style={{ fontSize: '0.82rem', color: msg.startsWith('⚠') ? '#DC2626' : PURPLE, fontWeight: 600 }}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}
