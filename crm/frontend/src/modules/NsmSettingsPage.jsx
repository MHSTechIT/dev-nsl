import { useState, useEffect, useCallback } from 'react';

/* NSM-Caller › Marketing › Settings
   ---------------------------------
   Edits the WhatsApp reminder templates (from the client doc) stored in
   nsm_settings. Each template: enabled, label, send-offset relative to the
   batch's webinar date/time, type (text/image/video/poll), media URL, content,
   and poll options. Backend: GET/PUT /api/admin/nsm/settings,
   GET /api/admin/nsm/whatsapp/status. */

const PURPLE = '#5B21B6';
const PLACEHOLDERS = ['{batch_name}', '{webinar_date}', '{webinar_time}', '{webinar_link}', '{meeting_id}'];

function fromOffset(min) {
  const m = Number(min) || 0;
  const abs = Math.abs(m);
  const dir = m <= 0 ? 'before' : 'after';
  if (abs !== 0 && abs % 1440 === 0) return { value: abs / 1440, unit: 'days', dir };
  if (abs !== 0 && abs % 60 === 0)   return { value: abs / 60, unit: 'hours', dir };
  return { value: abs, unit: 'minutes', dir };
}
function toOffset({ value, unit, dir }) {
  const mult = unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1;
  const m = (Number(value) || 0) * mult;
  return dir === 'before' ? -m : m;
}

const lbl = { display: 'block', fontSize: '0.72rem', fontWeight: 700, color: PURPLE, marginBottom: 5, letterSpacing: '0.01em' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1px solid rgba(139,92,246,0.30)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#3B0764', outline: 'none' };

export default function NsmSettingsPage({ token, apiBase = '/api/admin/nsm' }) {
  const [settings, setSettings] = useState(null);
  const [status, setStatus]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState('');
  const [uploading, setUploading] = useState(null);   // template index currently uploading
  const authHeaders = { Authorization: `Bearer ${token}` };

  const MAX_MEDIA = 15 * 1024 * 1024;
  // Upload always goes to the shared NSM media endpoint (works for both the
  // nsm and nsm-ivr settings pages); the file is stored server-side and we
  // keep only the returned public URL on the template.
  async function uploadMedia(i, file) {
    if (!file) return;
    if (file.size > MAX_MEDIA) { setMsg('File too large — max 15 MB.'); return; }
    if (!/^(image|video)\//.test(file.type)) { setMsg('Only image or video files are allowed.'); return; }
    setUploading(i); setMsg('');
    try {
      const res = await fetch('/api/admin/nsm/media-upload', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': file.type },
        body: file,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Upload failed');
      patchTpl(i, { media_url: d.url, type: d.type, media_name: file.name });
    } catch (e) { setMsg(e.message); }
    finally { setUploading(null); }
  }

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`${apiBase}/settings`, { headers: authHeaders }).then(r => r.json()),
      fetch(`${apiBase}/whatsapp/status`, { headers: authHeaders }).then(r => r.json()).catch(() => ({})),
    ]).then(([s, st]) => { setSettings(s.settings || null); setStatus(st || null); })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function patchTpl(i, patch) {
    setSettings(s => {
      const templates = s.whatsapp.templates.map((t, idx) => idx === i ? { ...t, ...patch } : t);
      return { ...s, whatsapp: { ...s.whatsapp, templates } };
    });
  }

  async function save() {
    setSaving(true); setMsg('');
    try {
      const res = await fetch(`${apiBase}/settings`, {
        method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      setSettings(d.settings); setMsg('Saved.');
    } catch (e) { setMsg(e.message); }
    finally { setSaving(false); }
  }

  if (loading || !settings) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.6)', fontFamily: 'Outfit, sans-serif' }}>Loading…</div>;
  }

  const wa = settings.whatsapp;

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header: status + master toggle + save */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', padding: '14px 18px' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: '#3B0764' }}>WhatsApp automation</div>
          <div style={{ fontSize: '0.78rem', marginTop: 3 }}>
            {!status?.configured ? <span style={{ color: '#DC2626' }}>● Not configured (WHAPI_TOKEN missing)</span>
              : status.connected ? <span style={{ color: '#16A34A' }}>● Connected{status.account ? ` — ${status.account.name}` : ''}</span>
              : <span style={{ color: '#D97706' }}>● Configured but channel not connected</span>}
          </div>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', fontWeight: 600, color: '#3B0764', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!wa.enabled} onChange={e => setSettings(s => ({ ...s, whatsapp: { ...s.whatsapp, enabled: e.target.checked } }))} />
          Enabled
        </label>
        <button type="button" onClick={save} disabled={saving}
          style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', fontWeight: 700, fontSize: '0.88rem', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && <span style={{ fontSize: '0.82rem', color: PURPLE, fontWeight: 600 }}>{msg}</span>}
      </div>

      {/* Placeholder cheat-sheet */}
      <div style={{ background: 'rgba(91,33,182,0.05)', borderRadius: 12, padding: '10px 14px', fontSize: '0.78rem', color: 'rgba(59,7,100,0.8)' }}>
        Placeholders (filled per batch): {PLACEHOLDERS.map(p => <code key={p} style={{ background: '#fff', borderRadius: 5, padding: '1px 6px', margin: '0 4px', color: PURPLE, fontWeight: 600 }}>{p}</code>)}
      </div>

      {/* Templates */}
      {wa.templates.map((t, i) => {
        const off = fromOffset(t.offset_minutes);
        return (
          <div key={t.key || i} style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', padding: 18, opacity: t.enabled ? 1 : 0.6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!t.enabled} onChange={e => patchTpl(i, { enabled: e.target.checked })} />
                <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#3B0764' }}>{t.label}</span>
              </label>
              <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'rgba(91,33,182,0.5)', fontWeight: 600 }}>{t.key}</span>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
              {/* Offset */}
              <div>
                <label style={lbl}>Send</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="number" style={{ ...inp, width: 64 }} value={off.value}
                    onChange={e => patchTpl(i, { offset_minutes: toOffset({ ...off, value: e.target.value }) })} />
                  <select style={{ ...inp, width: 'auto' }} value={off.unit}
                    onChange={e => patchTpl(i, { offset_minutes: toOffset({ ...off, unit: e.target.value }) })}>
                    <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
                  </select>
                  <select style={{ ...inp, width: 'auto' }} value={off.dir}
                    onChange={e => patchTpl(i, { offset_minutes: toOffset({ ...off, dir: e.target.value }) })}>
                    <option value="before">before webinar</option><option value="after">after webinar</option>
                  </select>
                </div>
              </div>
              {/* Type */}
              <div>
                <label style={lbl}>Type</label>
                <select style={{ ...inp, width: 'auto' }} value={t.type} onChange={e => patchTpl(i, { type: e.target.value })}>
                  <option value="text">Text</option><option value="image">Image</option><option value="video">Video</option><option value="poll">Poll</option>
                </select>
              </div>
              {/* Media upload (image/video, max 15 MB) */}
              {(t.type === 'image' || t.type === 'video') && (
                <div style={{ flex: 1, minWidth: 240 }}>
                  <label style={lbl}>Media (upload · max 15 MB)</label>
                  {t.media_url ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      {t.type === 'video'
                        ? <video src={t.media_url} muted style={{ width: 46, height: 46, objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(139,92,246,0.3)' }} />
                        : <img src={t.media_url} alt="" style={{ width: 46, height: 46, objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(139,92,246,0.3)' }} />}
                      <span style={{ fontSize: '0.8rem', color: '#16A34A', fontWeight: 600, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✓ {t.media_name || 'Media attached'}</span>
                      <label style={{ padding: '7px 12px', borderRadius: 9, border: `1px solid ${PURPLE}`, color: PURPLE, fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' }}>
                        {uploading === i ? 'Uploading…' : 'Replace'}
                        <input type="file" accept="image/*,video/*" hidden disabled={uploading === i} onChange={e => uploadMedia(i, e.target.files[0])} />
                      </label>
                      <button type="button" onClick={() => patchTpl(i, { media_url: '', media_name: '' })}
                        style={{ padding: '7px 12px', borderRadius: 9, border: '1px solid rgba(220,38,38,0.3)', background: '#fff', color: '#DC2626', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' }}>Remove</button>
                    </div>
                  ) : (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 10, border: `1.5px dashed ${PURPLE}`, background: 'rgba(91,33,182,0.05)', color: PURPLE, fontWeight: 700, fontSize: '0.82rem', cursor: uploading === i ? 'default' : 'pointer' }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      {uploading === i ? 'Uploading…' : 'Upload image / video'}
                      <input type="file" accept="image/*,video/*" hidden disabled={uploading === i} onChange={e => uploadMedia(i, e.target.files[0])} />
                    </label>
                  )}
                  <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.5)', marginTop: 5 }}>Sent as a single message — the text below becomes the caption.</div>
                </div>
              )}
            </div>

            <label style={lbl}>Message</label>
            <textarea value={t.content || ''} onChange={e => patchTpl(i, { content: e.target.value })}
              style={{ ...inp, minHeight: 130, resize: 'vertical', lineHeight: 1.5, fontFamily: 'Outfit, sans-serif' }} />

            {t.type === 'poll' && (
              <div style={{ marginTop: 12 }}>
                <label style={lbl}>Poll question</label>
                <input style={inp} value={t.poll?.title || ''} onChange={e => patchTpl(i, { poll: { ...(t.poll || {}), title: e.target.value } })} />
                <label style={{ ...lbl, marginTop: 10 }}>Poll options (one per line)</label>
                <textarea value={(t.poll?.options || []).join('\n')} onChange={e => patchTpl(i, { poll: { ...(t.poll || {}), options: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) } })}
                  style={{ ...inp, minHeight: 80, resize: 'vertical' }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
