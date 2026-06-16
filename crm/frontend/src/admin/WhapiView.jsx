import { useState, useEffect, useRef, useCallback } from 'react';
import Lottie from 'lottie-react';
import BrandSelect from '../components/BrandSelect';
import Loading from '../components/Loading';
import connectedAnim from '../assets/whapi-connected.json';

/* WhapiView — "Whapi" tab (Meta Temp). Connection manager for WhatsApp
   channels:
     1. Pick a channel from the dropdown and press Save.
     2. If the channel's WhatsApp is DISCONNECTED → show a live QR (auto-
        reloads) + instructions, so it can be linked. If the number can't be
        linked (WhatsApp linking limit), "Use another number" unlinks the
        session so a different number can scan.
     3. If CONNECTED → play the connected animation with "CONNECTED…" below.
   All Whapi calls go through our backend proxy; the partner/channel tokens
   never reach the browser. */

const PURPLE = '#5B21B6';
// Per-workspace cache key — each source pins its own channel.
const lsKeyFor = (source) => `mhs_whapi_channel_${source}`;

export default function WhapiView({ token, source = 'meta' }) {
  const auth = { Authorization: `Bearer ${token}` };
  const lsKey = lsKeyFor(source);

  const [channels, setChannels] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [selected, setSelected] = useState('');                   // dropdown (uncommitted)
  const [active, setActive]     = useState(() => sessionStorage.getItem(lsKeyFor(source)) || ''); // committed (pinned), hydrated from server below
  const [status, setStatus]     = useState(null);                 // { connected, statusText, user }
  const [qr, setQr]             = useState(null);                 // { base64, expire }
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy]         = useState(false);                // logout in progress
  const [toast, setToast]       = useState(null);

  const flash = (ok, msg) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 3500); };

  /* ── Load channel list for the dropdown ── */
  useEffect(() => {
    fetch('/api/admin/whapi/overview', { headers: auth })
      .then(r => r.json())
      .then(d => {
        const list = d.channels || [];
        setChannels(list);
        // default the dropdown to the active channel, else the first one
        setSelected(prev => prev || active || (list[0] && list[0].id) || '');
      })
      .catch(() => {})
      .finally(() => setListLoading(false));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Hydrate the pinned channel for this workspace from the server ──
     This is the source of truth: the chosen channel stays fixed across
     navigation / reload until the user explicitly changes it and Saves. */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/whapi/selected?source=${encodeURIComponent(source)}`, { headers: auth })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const id = d.channel_id || '';
        setActive(id);
        if (id) {
          setSelected(id);
          sessionStorage.setItem(lsKey, id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [source, token]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Status + QR loaders ── */
  /* Gate's first /users/login after a channel wakes often returns an empty
     base64 ("QR not painted yet"), then fills in a second or two later. So we
     poll it ourselves until the image arrives. A single-flight ref stops the
     status poll + countdown reload from stacking concurrent QR fetches. */
  const qrLoading = useRef(false);
  const loadQr = useCallback(async (id) => {
    if (qrLoading.current) return;
    qrLoading.current = true;
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const r = await fetch(`/api/admin/whapi/channels/${encodeURIComponent(id)}/qr`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.base64) { setQr(d); setCountdown(d.expire || 20); return; }
        await new Promise(s => setTimeout(s, 1800));
      }
    } finally {
      qrLoading.current = false;
    }
  }, [token]);

  const loadStatus = useCallback(async (id) => {
    try {
      const r = await fetch(`/api/admin/whapi/channels/${encodeURIComponent(id)}/status`, { headers: auth });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'status failed');
      setStatus(d);
      if (d.connected) setQr(null);
      return d;
    } catch {
      setStatus({ connected: false, statusText: 'ERROR' });
      return null;
    }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Poll status while a channel is active ── */
  useEffect(() => {
    if (!active) return undefined;
    setStatus(null); setQr(null);
    loadStatus(active);
    const t = setInterval(() => loadStatus(active), 4000);
    return () => clearInterval(t);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── First QR fetch once we know the channel is disconnected ── */
  useEffect(() => {
    if (active && status && !status.connected && !qr) loadQr(active);
  }, [status, active, qr, loadQr]);

  /* ── QR reload countdown (only while disconnected) ── */
  useEffect(() => {
    if (!active || !qr || status?.connected) return undefined;
    if (countdown <= 0) { loadQr(active); return undefined; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, qr, active, status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!selected) return;
    try {
      const r = await fetch('/api/admin/whapi/selected', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ source, channel_id: selected }),
      });
      if (!r.ok) throw new Error();
      setActive(selected);
      sessionStorage.setItem(lsKey, selected);
      flash(true, `Channel pinned for ${source}. It stays until you change it.`);
    } catch {
      flash(false, 'Could not save the channel. Try again.');
    }
  }

  async function doLogout(confirmMsg, okMsg) {
    if (!active) return;
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/whapi/channels/${encodeURIComponent(active)}/logout`, { method: 'POST', headers: auth });
      const d = await r.json();
      if (r.ok) { flash(true, okMsg); setStatus({ connected: false, statusText: 'QR' }); setQr(null); setTimeout(() => loadStatus(active), 1200); }
      else flash(false, d.message || 'Could not disconnect.');
    } catch { flash(false, 'Disconnect request failed.'); }
    finally { setBusy(false); }
  }
  const useAnotherNumber = () => doLogout('Unlink the current WhatsApp number from this channel? You can then scan with a different number.', 'Unlinked. Scan the new QR with another number.');
  const disconnect = () => doLogout('Disconnect this channel’s WhatsApp? The channel will go offline until a number is linked again.', 'Disconnected. Scan a QR to reconnect.');

  const mmss = (s) => `0:${String(Math.max(0, s)).padStart(2, '0')}`;
  const channelName = (id) => (channels.find(c => c.id === id) || {}).name || id;

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      {/* Header: title + channel dropdown + Save + Refresh */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ flex: '1 1 200px' }}>
          <h3 className="font-sans text-xl font-bold text-purple-900">Whapi</h3>
          <p className="font-sans text-sm text-purple-400 mt-1">Connect &amp; manage WhatsApp channels.</p>
        </div>
        <div style={{ width: 240 }}>
          <BrandSelect
            value={selected}
            onChange={setSelected}
            placeholder={listLoading ? 'Loading channels…' : 'Select a channel'}
            options={channels.map(c => ({ value: c.id, label: c.name || c.id }))}
            searchable
          />
        </div>
        <button
          type="button" onClick={save} disabled={!selected || selected === active}
          style={{ padding: '9px 22px', borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem', cursor: (!selected || selected === active) ? 'default' : 'pointer', opacity: (!selected || selected === active) ? 0.5 : 1 }}
        >Save</button>
        {active && (
          <button
            type="button" onClick={() => loadStatus(active)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10, border: '1px solid rgba(91,33,182,0.25)', background: '#fff', color: PURPLE, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
        )}
        {active && status?.connected && (
          <button
            type="button" onClick={disconnect} disabled={busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 10, border: '1px solid rgba(220,38,38,0.35)', background: '#fff', color: '#DC2626', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
      </div>

      {toast && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, fontSize: '0.84rem', fontWeight: 600, background: toast.ok ? 'rgba(5,150,105,0.10)' : 'rgba(220,38,38,0.08)', color: toast.ok ? '#059669' : '#DC2626' }}>{toast.msg}</div>
      )}

      <div className="bg-white rounded-card" style={{ border: '1px solid rgba(91,33,182,0.12)', borderRadius: 16, minHeight: 360, padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!active ? (
          <div style={{ textAlign: 'center', color: 'rgba(91,33,182,0.55)' }}>
            <p style={{ fontWeight: 700, color: '#3B0764', margin: 0 }}>Pick a channel and press Save</p>
            <p style={{ fontSize: '0.84rem', margin: '6px 0 0' }}>You’ll see its WhatsApp connection status here.</p>
          </div>
        ) : !status ? (
          <Loading />
        ) : status.connected ? (
          /* ── CONNECTED ── */
          <div style={{ textAlign: 'center', marginTop: 'clamp(-150px, -18vw, -90px)' }}>
            <Lottie animationData={connectedAnim} loop={false} autoplay style={{ width: 'min(560px, 70vw)', height: 'min(560px, 70vw)', margin: '0 auto', marginBottom: 'clamp(-150px, -18vw, -90px)' }} />
            <div style={{ fontWeight: 800, fontSize: '1.7rem', color: PURPLE, letterSpacing: '0.02em' }}>CONNECTED…</div>
            <div style={{ fontSize: '0.86rem', color: 'rgba(91,33,182,0.6)', marginTop: 4 }}>
              {channelName(active)}{status.user?.id ? ` · ${status.user.id.split('@')[0]}` : ''}
            </div>
          </div>
        ) : (
          /* ── DISCONNECTED → QR ── */
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
            <div style={{ textAlign: 'center' }}>
              {qr?.base64 ? (
                <img src={qr.base64} alt="WhatsApp QR" style={{ width: 248, height: 248, borderRadius: 12, border: '1px solid rgba(91,33,182,0.15)' }} />
              ) : (
                <div style={{ width: 248, height: 248, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Loading size={120} /></div>
              )}
              <div style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.6)', marginTop: 8 }}>
                {countdown > 0 ? <>QR reloads in {mmss(countdown)}</> : 'Refreshing QR…'}
              </div>
              <div style={{ fontWeight: 700, color: '#3B0764', marginTop: 4 }}>Please scan the QR code</div>
            </div>

            <div style={{ maxWidth: 320, minWidth: 240 }}>
              <ol style={{ margin: 0, paddingLeft: 20, color: 'rgba(59,7,100,0.85)', fontSize: '0.88rem', lineHeight: 1.9 }}>
                <li>Open <b>WhatsApp</b> on your phone</li>
                <li>Tap <b>Menu</b> or <b>Settings</b> → <b>Linked devices</b></li>
                <li>Tap <b>Link a device</b></li>
                <li>Point your phone at this screen to scan</li>
              </ol>
              <button
                type="button" onClick={useAnotherNumber} disabled={busy}
                style={{ marginTop: 18, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 10, border: '1px solid rgba(91,33,182,0.25)', background: '#fff', color: PURPLE, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                {busy ? 'Unlinking…' : 'Use another number'}
              </button>
              <p style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.5)', marginTop: 8 }}>
                Use this if the current number can’t be linked (WhatsApp linking limit) — it unlinks the session so a different number can scan.
              </p>
              <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.45)', marginTop: 10 }}>Status: {status.statusText}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
