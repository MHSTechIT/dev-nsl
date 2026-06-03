import { useState, useEffect, useCallback } from 'react';
import DateTimePicker from '../admin/DateTimePicker';

/* NSM-Caller › Marketing › Webinar
   --------------------------------
   Lists "webinar batches" (batch name · ends in · leads number) and lets the
   admin create one via a modal. The create form's Meta-pages dropdown is
   populated live from GET /api/admin/nsm/meta-pages (promote_pages union).

   Backend:
     GET    /api/admin/nsm/batches
     POST   /api/admin/nsm/batches      { batch_name, start_at, end_at, meta_pages:[{id,name}] }
     DELETE /api/admin/nsm/batches/:id
     GET    /api/admin/nsm/meta-pages   -> { pages:[{id,name}] }
*/

const PURPLE = '#5B21B6';

/* "ends in" — humanised countdown from now to end_at. */
function endsIn(endAt) {
  if (!endAt) return '—';
  const ms = new Date(endAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return 'Ended';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/* Human webinar date in IST for the list row. */
function fmtWebinar(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/* datetime-local value ("YYYY-MM-DDThh:mm", browser-local = IST) → ISO UTC. */
function toIso(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* Stored ISO (UTC) → the IST wall-clock "YYYY-MM-DDThh:mm:ss" the picker wants
   (inverse of toIso for an IST browser), so edit can prefill the date fields. */
function isoToLocal(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 19);
}

/* ── Meta lead-form multi-select (searchable) ────────────────────────── */
function MetaFormsSelect({ token, selected, onChange, apiBase = '/api/admin/nsm' }) {
  const [forms, setForms]   = useState([]);
  const [loading, setLoad]  = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]   = useState('');
  const [open, setOpen]     = useState(false);
  const [query, setQuery]   = useState('');

  const loadForms = useCallback((force = false) => {
    if (force) setRefreshing(true); else setLoad(true);
    fetch(`${apiBase}/lead-forms${force ? '?refresh=1' : ''}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Failed to load forms'))))
      .then(d => { setForms(d.forms || []); setError(''); })
      .catch(() => setError('Could not load Meta forms'))
      .finally(() => { setLoad(false); setRefreshing(false); });
  }, [token]);

  useEffect(() => { loadForms(false); }, [loadForms]);

  const selectedIds = new Set(selected.map(f => f.id));
  function toggle(form) {
    if (selectedIds.has(form.id)) onChange(selected.filter(f => f.id !== form.id));
    else onChange([...selected, { id: form.id, name: form.name }]);
  }

  const q = query.trim().toLowerCase();
  const filtered = q ? forms.filter(f => f.name.toLowerCase().includes(q)) : forms;

  const summary = loading
    ? 'Loading forms…'
    : selected.length === 0
      ? 'Select forms'
      : `${selected.length} form${selected.length > 1 ? 's' : ''} selected`;

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)',
          background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem',
          color: selected.length ? '#3B0764' : 'rgba(91,33,182,0.55)', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms', flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {selected.map(f => (
            <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 999, background: 'rgba(91,33,182,0.10)', color: PURPLE, fontSize: '0.76rem', fontWeight: 600, maxWidth: '100%' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <button type="button" onClick={() => toggle(f)} aria-label={`Remove ${f.name}`}
                style={{ border: 'none', background: 'transparent', color: PURPLE, cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: '0.9rem', flexShrink: 0 }}>×</button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div style={{
          marginTop: 8,
          background: '#fff', borderRadius: 12, border: '1px solid rgba(209,196,240,0.7)',
          boxShadow: '0 8px 24px rgba(91,33,182,0.12)', padding: 6, maxHeight: 280, display: 'flex', flexDirection: 'column',
        }}>
          {/* Search + refresh */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Search ${forms.length || ''} forms…`}
              autoFocus
              style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(139,92,246,0.25)', fontFamily: 'Outfit, sans-serif', fontSize: '0.83rem', color: '#3B0764', outline: 'none' }}
            />
            <button
              type="button"
              onClick={() => loadForms(true)}
              disabled={refreshing}
              title="Pull the latest forms from Meta (bypass cache)"
              style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 11px', borderRadius: 8, border: '1px solid rgba(139,92,246,0.30)', background: '#fff', color: PURPLE, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.78rem', cursor: refreshing ? 'default' : 'pointer', opacity: refreshing ? 0.6 : 1, whiteSpace: 'nowrap' }}
            >
              <span style={{ display: 'inline-block', transform: refreshing ? 'rotate(360deg)' : 'none', transition: 'transform 500ms' }}>↻</span>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <div className="nsm-modal-scroll" style={{ overflowY: 'auto', minHeight: 0, scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {loading && <div style={{ padding: 12, fontSize: '0.82rem', color: 'rgba(91,33,182,0.6)' }}>Loading…</div>}
            {!loading && error && <div style={{ padding: 12, fontSize: '0.82rem', color: '#DC2626' }}>{error}</div>}
            {!loading && !error && filtered.length === 0 && <div style={{ padding: 12, fontSize: '0.82rem', color: 'rgba(91,33,182,0.6)' }}>{forms.length === 0 ? 'No forms found.' : 'No matches.'}</div>}
            {!loading && !error && filtered.map(form => {
              const sel = selectedIds.has(form.id);
              return (
                <button
                  key={form.id}
                  type="button"
                  onClick={() => toggle(form)}
                  title={form.name}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
                    borderRadius: 8, border: 'none', cursor: 'pointer', textAlign: 'left',
                    background: sel ? 'rgba(91,33,182,0.08)' : 'transparent',
                    fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#3B0764', fontWeight: sel ? 700 : 500,
                  }}
                >
                  <span style={{
                    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                    border: sel ? 'none' : '1.5px solid rgba(91,33,182,0.35)',
                    background: sel ? PURPLE : '#fff',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {sel && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{form.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Create / Edit modal ─────────────────────────────────────────────── */
function CreateBatchModal({ token, onClose, onCreated, apiBase = '/api/admin/nsm', editBatch = null }) {
  const isEdit = !!editBatch;
  const [batchName, setBatchName] = useState(editBatch?.batch_name || '');
  const [webinarAt, setWebinarAt] = useState(isoToLocal(editBatch?.webinar_at));
  const [webinarLink, setWebinarLink] = useState(editBatch?.webinar_link || '');
  const [meetingId, setMeetingId]     = useState(editBatch?.webinar_meeting_id || '');
  const [startAt, setStartAt]     = useState(editBatch ? isoToLocal(editBatch.start_at) : isoToLocal(new Date().toISOString()));
  const [forms, setForms]         = useState(Array.isArray(editBatch?.meta_forms) ? editBatch.meta_forms : []);
  const [submitting, setSubmit]   = useState(false);
  const [error, setError]         = useState('');

  async function handleCreate() {
    if (!batchName.trim()) { setError('Batch name is required'); return; }
    if (!webinarAt)        { setError('Webinar date & time is required'); return; }

    setSubmit(true); setError('');
    try {
      const res = await fetch(isEdit ? `${apiBase}/batches/${editBatch.id}` : `${apiBase}/batches`, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_name: batchName.trim(),
          webinar_at: toIso(webinarAt),
          webinar_link: webinarLink.trim(),
          webinar_meeting_id: meetingId.trim(),
          start_at: toIso(startAt),
          meta_forms: forms,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Failed to ${isEdit ? 'update' : 'create'} batch`);
      }
      onCreated();
    } catch (e) {
      setError(e.message);
      setSubmit(false);
    }
  }

  const label = { display: 'block', fontSize: '0.78rem', fontWeight: 700, color: PURPLE, marginBottom: 6, letterSpacing: '0.01em' };
  const input = {
    width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)',
    background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', color: '#3B0764', outline: 'none',
  };

  return (
    <div
      onMouseDown={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(31,8,64,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        className="nsm-modal-scroll"
        style={{ width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none', background: '#fff', borderRadius: 20, boxShadow: '0 24px 64px rgba(31,8,64,0.35)', padding: 24, fontFamily: 'Outfit, sans-serif' }}
      >
        <style>{`.nsm-modal-scroll::-webkit-scrollbar{width:0;height:0;display:none}`}</style>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: '#3B0764' }}>{isEdit ? 'Edit Webinar Batch' : 'Create Webinar Batch'}</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(91,33,182,0.6)', fontSize: '1.4rem', lineHeight: 1, padding: 0 }}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={label}>Batch name</label>
            <input style={input} value={batchName} onChange={e => setBatchName(e.target.value)} placeholder="e.g. June Batch 1" autoFocus />
          </div>

          <div>
            <label style={label}>Webinar date &amp; time</label>
            <DateTimePicker value={webinarAt} onChange={setWebinarAt} placeholder="Select webinar date & time" />
          </div>

          <div>
            <label style={label}>Webinar link</label>
            <input style={input} type="url" value={webinarLink} onChange={e => setWebinarLink(e.target.value)} placeholder="https://… (Zoom / Meet link)" />
          </div>

          <div>
            <label style={label}>Meeting ID <span style={{ fontWeight: 400, color: 'rgba(91,33,182,0.45)' }}>(optional)</span></label>
            <input style={input} value={meetingId} onChange={e => setMeetingId(e.target.value)} placeholder="e.g. 873 1234 5678" />
          </div>

          <div>
            <label style={label}>Batch start time</label>
            <DateTimePicker value={startAt} onChange={setStartAt} placeholder="Select batch start time" />
          </div>

          <div style={{ fontSize: '0.76rem', color: 'rgba(91,33,182,0.6)', background: 'rgba(91,33,182,0.05)', borderRadius: 9, padding: '9px 12px', lineHeight: 1.4 }}>
            📥 Leads are collected from the <strong>batch start time</strong> up to the webinar. Use this start time to know when to swap the WhatsApp group link in your Meta ad.
          </div>

          <div>
            <label style={label}>Meta forms</label>
            <MetaFormsSelect token={token} selected={forms} onChange={setForms} apiBase={apiBase} />
          </div>

          {error && <div style={{ fontSize: '0.82rem', color: '#DC2626', fontWeight: 600 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
            <button type="button" onClick={onClose} disabled={submitting}
              style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.25)', background: '#fff', color: PURPLE, fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="button" onClick={handleCreate} disabled={submitting}
              style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.88rem', cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.7 : 1 }}>
              {submitting ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save' : 'Create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */
export default function NsmWebinarPage({ token, apiBase = '/api/admin/nsm' }) {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editBatch, setEditBatch] = useState(null);
  const [, setTick] = useState(0); // re-render so "ends in" stays fresh

  const loadBatches = useCallback(() => {
    setLoading(true);
    fetch(`${apiBase}/batches`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Failed to load'))))
      .then(d => setBatches(d.batches || []))
      .catch(() => setBatches([]))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 60000);
    return () => clearInterval(t);
  }, []);

  async function handleDelete(id) {
    setBatches(bs => bs.filter(b => b.id !== id)); // optimistic
    try {
      await fetch(`${apiBase}/batches/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    } catch { loadBatches(); }
  }

  async function handleRetryGroup(id) {
    try {
      await fetch(`${apiBase}/batches/${id}/whatsapp/retry`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch { /* ignore */ }
    loadBatches();
  }

  const GRID = '2fr 1fr 1fr 76px';

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      {/* + create */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 9, border: 'none', background: PURPLE, color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', boxShadow: '0 2px 8px rgba(91,33,182,0.25)' }}
        >
          + create
        </button>
      </div>

      {/* Rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {loading && <div style={{ padding: 24, textAlign: 'center', color: 'rgba(91,33,182,0.6)', fontSize: '0.9rem' }}>Loading…</div>}

        {!loading && batches.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem', background: '#fff', borderRadius: 16, border: '1px dashed rgba(139,92,246,0.3)' }}>
            No batches yet. Click <strong>“+ create”</strong> to add one.
          </div>
        )}

        {!loading && batches.map(b => {
          const ended = b.end_at && new Date(b.end_at).getTime() <= Date.now();
          return (
            <div key={b.id} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12, background: '#fff', borderRadius: 16, padding: '18px 28px', boxShadow: '0 2px 12px rgba(91,33,182,0.08)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.98rem', color: '#3B0764', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.batch_name}</div>
                {b.start_at && (
                  <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.6)', marginTop: 3, fontWeight: 600 }}>
                    ▶ Starts: {fmtWebinar(b.start_at)}
                  </div>
                )}
                {b.webinar_at && (
                  <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.75)', marginTop: 3, fontWeight: 600 }}>
                    🗓 Webinar: {fmtWebinar(b.webinar_at)}
                  </div>
                )}
                {b.webinar_link && (
                  <div style={{ fontSize: '0.74rem', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    🔗 <a href={b.webinar_link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: PURPLE, fontWeight: 600 }}>{b.webinar_link}</a>
                  </div>
                )}
                {b.whatsapp_group_id ? (
                  <div style={{ fontSize: '0.74rem', marginTop: 3, color: '#16A34A', fontWeight: 600 }}>
                    🟢 WhatsApp community{typeof b.whatsapp_group_count === 'number' && b.whatsapp_group_count > 0 ? ` · ${b.whatsapp_group_count} added` : ''}
                    {b.whatsapp_group_invite && <> · <a href={b.whatsapp_group_invite} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: PURPLE }}>open</a></>}
                  </div>
                ) : b.whatsapp_group_error ? (
                  <div style={{ fontSize: '0.74rem', marginTop: 3, color: '#DC2626', fontWeight: 600 }}>
                    🔴 WhatsApp community failed
                    <button type="button" onClick={() => handleRetryGroup(b.id)} style={{ marginLeft: 6, border: 'none', background: 'transparent', color: PURPLE, fontWeight: 700, cursor: 'pointer', fontSize: '0.74rem', textDecoration: 'underline' }}>retry</button>
                  </div>
                ) : null}
                {Array.isArray(b.meta_forms) && b.meta_forms.length > 0 && (
                  <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.meta_forms.length} form{b.meta_forms.length > 1 ? 's' : ''}: {b.meta_forms.map(f => f.name).join(', ')}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'center', fontWeight: 600, fontSize: '0.9rem', color: ended ? '#DC2626' : '#3B0764' }}>{endsIn(b.end_at)}</div>
              <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '0.95rem', color: PURPLE }}>{b.leads_number ?? 0}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setEditBatch(b)}
                  aria-label="Edit batch"
                  title="Edit batch"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(91,33,182,0.7)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 4 }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(b.id)}
                  aria-label="Delete batch"
                  title="Delete batch"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(220,38,38,0.65)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 4 }}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {(showCreate || editBatch) && (
        <CreateBatchModal
          token={token}
          apiBase={apiBase}
          editBatch={editBatch}
          onClose={() => { setShowCreate(false); setEditBatch(null); }}
          onCreated={() => { setShowCreate(false); setEditBatch(null); loadBatches(); }}
        />
      )}
    </div>
  );
}
