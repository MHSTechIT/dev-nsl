import { useState, useRef } from 'react';
import BrandSelect from '../components/BrandSelect';

// 12-hour clock: hours 1–12 + an AM/PM selector. send_time is stored as
// "h:mm AM/PM" (e.g. "5:30 PM"); the scheduler parses 12h fine.
const HOURS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
const MINUTES = Array.from({ length: 60 }, (_, i) => ({ value: String(i).padStart(2, '0'), label: String(i).padStart(2, '0') }));
const AMPM_OPTS = [{ value: 'AM', label: 'AM' }, { value: 'PM', label: 'PM' }];
const MAX_UPLOAD_MB = 25;

/* Parse a send_time (12h "5:30 PM" OR legacy 24h "17:30") → { h12, mm, ap }. */
function parse12(t) {
  if (!t) return { h12: '', mm: '', ap: 'AM' };
  let m = String(t).match(/(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]/);
  if (m) return { h12: String(Number(m[1])), mm: m[2], ap: m[3].toUpperCase() + 'M' };
  m = String(t).match(/(\d{1,2}):(\d{2})/);
  if (m) {
    let h = Number(m[1]); const ap = h >= 12 ? 'PM' : 'AM'; let h12 = h % 12; if (h12 === 0) h12 = 12;
    return { h12: String(h12), mm: m[2], ap };
  }
  return { h12: '', mm: '', ap: 'AM' };
}

/* Create-template popup for the Meta Temp WhatsApp Links card. Builds a
   scheduled WhatsApp message template (name, time, day-relative-to-webinar,
   content type, media, body) and persists it to wa_templates. Auto-sending
   to the group is a separate job. */

const DAY_OPTS = [
  { value: 'webinar_day', label: 'Webinar day' },
  { value: '3_before',    label: '3 days before' },
  { value: '2_before',    label: '2 days before' },
  { value: '1_before',    label: '1 day before' },
  { value: '1_after',     label: '1 day after' },
  { value: '2_after',     label: '2 days after' },
];

const TYPE_OPTS = [
  { value: 'text',     label: 'Text' },
  { value: 'image',    label: 'Image' },
  { value: 'video',    label: 'Video' },
  { value: 'document', label: 'Document' },
];

const PURPLE = '#5B21B6';
const fieldBg = 'rgba(91,33,182,0.10)';

export default function TemplateModal({ token, source, onClose, onSaved, existing }) {
  const isEdit = !!existing;
  const [name, setName]       = useState(existing?.name || '');
  const [time, setTime]       = useState(existing?.send_time || '');
  const [day, setDay]         = useState(existing?.day_offset || 'webinar_day');
  const [type, setType]       = useState(existing?.msg_type || 'text');
  const [mediaUrl, setMedia]  = useState(existing?.media_url || '');
  const [body, setBody]       = useState(existing?.body || '');
  const [active, setActive]   = useState(existing ? !!existing.is_active : true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState(existing?.media_url ? existing.media_url.split('/').pop() : '');
  const fileRef = useRef(null);

  const isMedia = type !== 'text';
  const { h12, mm, ap } = parse12(time);
  const build = (h, m, a) => (h && m) ? `${h}:${m} ${a}` : '';
  const setHour = (h) => setTime(build(h, mm || '00', ap));
  const setMin  = (m) => setTime(build(h12 || '12', m, ap));
  const setAmpm = (a) => setTime(build(h12 || '12', mm || '00', a));

  async function handleFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(`File too large (max ${MAX_UPLOAD_MB} MB).`);
      e.target.value = '';
      return;
    }
    setUploading(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/admin/wa-templates/upload', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Upload failed.'); setUploading(false); return; }
      setMedia(data.url);
      setUploadName(data.name || f.name);
    } catch { setError('Upload failed.'); }
    finally { setUploading(false); }
  }

  async function save() {
    if (!name.trim()) { setError('Template name is required.'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        source,
        name: name.trim(),
        send_time: time,
        day_offset: day,
        msg_type: type,
        media_url: isMedia ? mediaUrl.trim() : '',
        body,
        is_active: active,
      };
      const res = await fetch(
        isEdit ? `/api/admin/wa-templates/${existing.id}` : '/api/admin/wa-templates',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Failed to save.'); setSaving(false); return; }
      onSaved && onSaved(data.template);
      onClose && onClose();
    } catch {
      setError('Network error. Please try again.');
      setSaving(false);
    }
  }

  const pill = {
    height: 34, borderRadius: 10, border: 'none', background: fieldBg,
    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.8rem',
    color: PURPLE, padding: '0 12px', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(30,8,60,0.45)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{
        width: 'min(1000px, 96vw)', maxHeight: '92vh', overflowY: 'auto',
        background: '#fff', borderRadius: 22, padding: 22,
        boxShadow: '0 24px 64px rgba(30,8,60,0.4)', fontFamily: 'Outfit, sans-serif',
      }}>
        {/* Row 1: name + toggle + save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="template name"
            style={{ ...pill, flex: 1, minWidth: 220 }}
          />
          {/* Active toggle */}
          <button
            type="button"
            onClick={() => setActive(a => !a)}
            title={active ? 'Active' : 'Inactive'}
            style={{
              width: 42, height: 23, borderRadius: 999, border: 'none', cursor: 'pointer',
              background: active ? PURPLE : 'rgba(91,33,182,0.25)',
              position: 'relative', transition: 'background 160ms', flexShrink: 0,
            }}
          >
            <span style={{
              position: 'absolute', top: 3, left: active ? 22 : 3,
              width: 17, height: 17, borderRadius: '50%', background: '#fff',
              transition: 'left 160ms', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
          <button
            type="button" onClick={save} disabled={saving}
            style={{
              height: 34, padding: '0 20px', borderRadius: 999, border: 'none',
              background: PURPLE, color: '#fff', fontFamily: 'Outfit, sans-serif',
              fontWeight: 800, fontSize: '0.78rem', letterSpacing: '0.04em',
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, flexShrink: 0,
              boxShadow: '0 2px 12px rgba(91,33,182,0.3)',
            }}
          >
            {saving ? 'SAVING…' : 'SAVE'}
          </button>
        </div>

        {/* Row 2: time | day | type | upload */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Branded 12-hour time picker (h : mm AM/PM) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: 190 }}>
            <div style={{ flex: 1 }}>
              <BrandSelect compact value={h12 || ''} onChange={setHour} options={HOURS} placeholder="HH" />
            </div>
            <span style={{ fontWeight: 800, color: PURPLE, fontSize: '0.8rem' }}>:</span>
            <div style={{ flex: 1 }}>
              <BrandSelect compact value={mm || ''} onChange={setMin} options={MINUTES} placeholder="MM" />
            </div>
            <div style={{ flex: 1 }}>
              <BrandSelect compact value={ap} onChange={setAmpm} options={AMPM_OPTS} placeholder="AM" />
            </div>
          </div>
          <div style={{ width: 150 }}>
            <BrandSelect compact value={day} onChange={setDay} options={DAY_OPTS} placeholder="day" />
          </div>
          <div style={{ width: 150 }}>
            <BrandSelect compact value={type} onChange={setType} options={TYPE_OPTS} placeholder="type" />
          </div>
          {/* Upload control (image/video/document up to 25 MB) */}
          <div style={{ flex: 1, minWidth: 240 }}>
            <input ref={fileRef} type="file" accept="image/*,video/*,.pdf,.doc,.docx" style={{ display: 'none' }} onChange={handleFile} />
            <button
              type="button"
              onClick={() => isMedia && fileRef.current && fileRef.current.click()}
              disabled={!isMedia || uploading}
              title={isMedia ? `Upload image / video (max ${MAX_UPLOAD_MB} MB)` : 'Pick a media content type to enable upload'}
              style={{
                ...pill, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                cursor: (!isMedia || uploading) ? 'not-allowed' : 'pointer',
                opacity: isMedia ? 1 : 0.55,
                color: uploadName ? PURPLE : 'rgba(91,33,182,0.55)',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {uploading ? 'Uploading…' : (uploadName || (isMedia ? 'Upload image / video' : 'upload image / video'))}
            </button>
          </div>
        </div>

        {/* Row 3: body */}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="text for template here"
          rows={10}
          style={{
            width: '100%', borderRadius: 14, border: 'none', background: fieldBg,
            padding: 18, fontFamily: 'Outfit, sans-serif', fontSize: '0.95rem',
            color: PURPLE, outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            fontWeight: 600,
          }}
        />

        {error && (
          <p style={{ color: '#DC2626', fontSize: '0.82rem', fontWeight: 600, margin: '10px 2px 0' }}>⚠ {error}</p>
        )}
      </div>
    </div>
  );
}
