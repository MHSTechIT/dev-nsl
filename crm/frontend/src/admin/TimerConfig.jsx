import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import DateTimePicker from './DateTimePicker';
import { isMetaTempLike } from '../utils/workspaceFlags';

function toLocalDatetimeValue(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 16);
}

/* Parse the stored form-ids column (JSON array string) into an array. Tolerates
   legacy single-id strings and nulls. */
function parseFormIds(v) {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(String);
    return [String(parsed)];
  } catch {
    return [String(v)];
  }
}

function fromLocalDatetimeValue(localVal) {
  if (!localVal) return null;
  const [date, time] = localVal.split('T');
  const [y, mo, d]  = date.split('-').map(Number);
  const [h, m]      = time.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - 5.5 * 60 * 60 * 1000).toISOString();
}

/* Multi-select dropdown for linking a webinar to Meta lead forms (Meta Temp)
   or TagMango memberships (TagMango). Defined at MODULE scope — not inside
   TimerConfig — so it does NOT remount on every parent re-render; otherwise the
   panel would snap shut after each pick. `scope` = 'current' | 'next'. */
function MetaFormSelect({ scope, value, onChange, options = [], isTagmango = false }) {
  const noun  = isTagmango ? 'TagMango membership' : 'Meta lead forms';
  const label = `${noun} (${scope === 'next' ? 'next' : 'current'} webinar)`;
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
      <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>
        {label}
        <span style={{ color: 'rgba(91,33,182,0.45)', fontWeight: 500 }}> · {value.length} selected of {options.length}{isTagmango ? '' : ' active'}</span>
      </p>
      <BrandSelect
        multiple
        value={value}
        onChange={onChange}
        options={options}
        searchable
        searchPlaceholder={isTagmango ? 'Search memberships…' : 'Search forms…'}
        placeholder={isTagmango ? 'Select membership…' : 'Select forms…'}
      />
    </div>
  );
}

/* Inline editable display-name for a webinar slot.
   - When the slot already has a saved name → shows "(AWS - 101)" + a pencil to
     rename it.
   - When the slot has NO name yet (unnamed or not-yet-created webinar) → shows a
     blank input so a name can be typed.
   `existing` is the persisted name (drives read vs. blank mode); `value`/`onChange`
   bind to the parent's editable state; `onCommit` persists the name immediately. */
function WebinarNameEditor({ existing, value, onChange, onCommit, accent }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy]       = useState(false);
  const fmt = (n) => (n ? n.replace(/^AWS-/, 'AWS - ') : '');
  const showInput = editing || !existing;

  async function commit() {
    setBusy(true);
    try { await onCommit(); } finally { setBusy(false); setEditing(false); }
  }
  function cancel() { onChange(existing || ''); setEditing(false); }

  const iconBtn = (extra = {}) => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, borderRadius: 6, border: 'none', cursor: 'pointer',
    background: 'transparent', color: accent, padding: 0, ...extra,
  });

  if (!showInput) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 6, verticalAlign: 'middle' }}>
        <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700, color: accent }}>
          ({fmt(existing)})
        </span>
        <button type="button" title="Rename webinar" onClick={(e) => { e.preventDefault(); setEditing(true); }} style={iconBtn()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
          </svg>
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 6, verticalAlign: 'middle' }}>
      <input
        type="text"
        value={value}
        autoFocus={editing}
        maxLength={80}
        placeholder="Name e.g. AWS - 101"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') cancel(); }}
        style={{ width: 140, padding: '3px 8px', borderRadius: 6, border: `1px solid ${accent}66`, fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: '#3B0764', outline: 'none' }}
      />
      <button type="button" title="Save name" onClick={(e) => { e.preventDefault(); commit(); }} disabled={busy} style={iconBtn({ opacity: busy ? 0.5 : 1 })}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
      {editing && existing && (
        <button type="button" title="Cancel" onClick={(e) => { e.preventDefault(); cancel(); }} style={iconBtn({ color: 'rgba(91,33,182,0.45)' })}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      )}
    </span>
  );
}

/* ══════════════════════════════════════════ */
export default function TimerConfig({ token, source = 'meta' }) {
  /* ── Left-side state ── */
  const [currentWebinar, setCurrentWebinar] = useState('');         // registration deadline (next_webinar_at)
  const [currentWebinarDate, setCurrentWebinarDate] = useState(''); // actual webinar date (current_webinar_date)
  const [nextWebinar, setNextWebinar] = useState('');               // upcoming registration deadline (backup_webinar_at)
  const [nextWebinarDate, setNextWebinarDate] = useState('');       // upcoming actual webinar date (next_webinar_date)
  const [currentName, setCurrentName] = useState('');               // editable display name for the active webinar
  const [nextName, setNextName] = useState('');                     // editable display name for the upcoming webinar
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false); // Meta lead pull in progress
  const [toast, setToast] = useState(null);

  /* Meta lead-gen form linkage — only shown/used in the Meta Temp workspace.
     Multiple forms can be linked per webinar; stored as a JSON array string in
     the current_form_id / next_form_id columns. */
  const showForms = isMetaTempLike(source);
  const isTagmango = source === 'tagmango';
  const [currentFormIds, setCurrentFormIds] = useState([]);
  const [nextFormIds, setNextFormIds]       = useState([]);
  const [forms, setForms]                   = useState([]);
  const [memberships, setMemberships]       = useState([]); // TagMango "mangos"
  // Meta Temp extras: actual webinar date/time + webinar (Zoom) link, per webinar.
  const [currentWebinarDT, setCurrentWebinarDT]     = useState('');
  const [currentWebinarLink, setCurrentWebinarLink] = useState('');
  const [nextWebinarDT, setNextWebinarDT]           = useState('');
  const [nextWebinarLink, setNextWebinarLink]       = useState('');

  useEffect(() => {
    fetch(`/api/webinar-config?source=${source}`)
      .then(r => r.json())
      .then(d => {
        setCurrentWebinar(toLocalDatetimeValue(d.next_webinar_at));
        setCurrentWebinarDate(toLocalDatetimeValue(d.current_webinar_date));
        setNextWebinar(toLocalDatetimeValue(d.backup_webinar_at));
        setNextWebinarDate(toLocalDatetimeValue(d.next_webinar_date));
        setCurrentFormIds(parseFormIds(d.current_form_id));
        setNextFormIds(parseFormIds(d.next_form_id));
        setCurrentWebinarDT(toLocalDatetimeValue(d.current_webinar_datetime));
        setCurrentWebinarLink(d.current_webinar_link || '');
        setNextWebinarDT(toLocalDatetimeValue(d.next_webinar_datetime));
        setNextWebinarLink(d.next_webinar_link || '');
      });
  }, [source]);

  /* Load the linkable list for the dropdowns: Meta lead-gen forms for Meta
     Temp, or TagMango memberships ("mangos") for the TagMango workspace. */
  useEffect(() => {
    if (!showForms) { setForms([]); setMemberships([]); return; }
    if (isTagmango) {
      fetch('/api/admin/tagmango-memberships', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => setMemberships(d.memberships || []))
        .catch(() => setMemberships([]));
    } else {
      fetch('/api/admin/meta-leadgen-forms', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => setForms(d.forms || []))
        .catch(() => setForms([]));
    }
  }, [showForms, isTagmango, token]);

  /* Only ACTIVE Meta forms are offered for linking. */
  const activeForms = forms.filter(f => String(f.status || '').toUpperCase() === 'ACTIVE');

  /* Options for the linkable dropdown — Meta lead forms (Meta Temp) or TagMango
     memberships (TagMango). Computed once and passed to each card's picker. */
  const linkOptions = isTagmango
    ? memberships.map((m) => ({ value: String(m.id), label: m.title || m.id }))
    : activeForms.map((f) => ({ value: String(f.id), label: `${f.name || f.id}${f.page_name ? ` · ${f.page_name}` : ''}` }));

  /* ── Right-side state ── */
  const [webinars, setWebinars]           = useState([]);
  const [webinarsLoading, setWebinarsLoading] = useState(true);

  const fetchWebinars = useCallback(async () => {
    setWebinarsLoading(true);
    try {
      const res = await fetch(`/api/admin/webinars?source=${source}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      const ws = data.webinars || [];
      setWebinars(ws);
      // Seed the editable name fields from the active / upcoming webinar rows.
      const active = ws.find(w => w.is_active);
      const upcoming = ws
        .filter(w => !w.is_active && w.webinar_at && new Date(w.webinar_at) > new Date())
        .sort((a, b) => new Date(a.webinar_at) - new Date(b.webinar_at))[0];
      setCurrentName(active?.name || '');
      setNextName(upcoming?.name || '');
    } catch (_) {
      setWebinars([]);
    } finally {
      setWebinarsLoading(false);
    }
  }, [token, source]);

  useEffect(() => { fetchWebinars(); }, [fetchWebinars]);

  /* ── Derived: which webinar maps to "Current" / "Next" labels ── */
  const activeWebinar = webinars.find(w => w.is_active);
  const upcomingWebinar = webinars
    .filter(w => !w.is_active && w.webinar_at && new Date(w.webinar_at) > new Date())
    .sort((a, b) => new Date(a.webinar_at) - new Date(b.webinar_at))[0];
  const fmtName = n => n ? n.replace(/^AWS-/, 'AWS - ') : '';

  /* Persist a single webinar name immediately (inline pencil-rename). `field`
     is 'current_webinar_name' or 'next_webinar_name'. */
  async function saveWebinarName(field, name) {
    const res = await fetch('/api/admin/webinar-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ source, [field]: name.trim() }),
    });
    if (res.ok) {
      await fetchWebinars();
      setToast({ ok: true, msg: 'Webinar name saved.' });
    } else {
      setToast({ ok: false, msg: 'Failed to save webinar name.' });
    }
    setTimeout(() => setToast(null), 3000);
  }

  /* ── Save handler ── */
  async function handleSave() {
    setSaving(true);
    setToast(null);
    const body = {};
    if (currentWebinar)     body.next_webinar_at      = fromLocalDatetimeValue(currentWebinar);
    if (currentWebinarDate) body.current_webinar_date = fromLocalDatetimeValue(currentWebinarDate);
    if (nextWebinar)        body.backup_webinar_at    = fromLocalDatetimeValue(nextWebinar);
    if (nextWebinarDate)    body.next_webinar_date    = fromLocalDatetimeValue(nextWebinarDate);
    // Custom display names — applied to the active / upcoming webinar rows. Sent
    // alongside dates so naming a not-yet-created webinar works in one save.
    body.current_webinar_name = currentName.trim();
    body.next_webinar_name    = nextName.trim();
    // Persist Meta form linkage (Meta Temp only) as a JSON array of form ids.
    if (showForms) {
      body.current_form_id = JSON.stringify(currentFormIds);
      body.next_form_id    = JSON.stringify(nextFormIds);
      body.current_webinar_datetime = fromLocalDatetimeValue(currentWebinarDT);
      body.current_webinar_link     = currentWebinarLink.trim();
      body.next_webinar_datetime    = fromLocalDatetimeValue(nextWebinarDT);
      body.next_webinar_link        = nextWebinarLink.trim();
    }

    const res = await fetch('/api/admin/webinar-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, source }),
    });
    setSaving(false);
    setToast({ ok: res.ok, msg: res.ok ? 'Settings saved! Countdown timer updated.' : 'Failed to save settings.' });
    setTimeout(() => setToast(null), 3500);

    // Refresh webinar list after save
    if (res.ok) fetchWebinars();

    // Meta Temp: after saving the window + forms, pull the matching leads from
    // Meta right away (the user's "select dates + forms → fetch" flow).
    if (res.ok && source === 'metatemp' && currentFormIds.length) {
      await fetchMetaLeads();
    }
  }

  /* Pull lead-gen leads from Meta for the current forms within [Start, End].
     Meta-Temp (Meta lead forms) only — TagMango memberships aren't lead forms.
     Runs on Save and from the explicit "Fetch from Meta" button. */
  async function fetchMetaLeads() {
    if (isTagmango) return;
    if (!currentFormIds.length) {
      setToast({ ok: false, msg: 'Select at least one Meta lead form first.' });
      setTimeout(() => setToast(null), 3500);
      return;
    }
    setFetching(true);
    try {
      const res = await fetch('/api/admin/leads/fetch-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          source,
          form_ids: currentFormIds,
          since: currentWebinar ? fromLocalDatetimeValue(currentWebinar) : undefined,
          until: currentWebinarDate ? fromLocalDatetimeValue(currentWebinarDate) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const dup = data.skipped_duplicates ? ` · ${data.skipped_duplicates} already imported` : '';
        const errs = (data.errors && data.errors.length) ? ` · ${data.errors.length} form(s) had errors` : '';
        setToast({ ok: true, msg: `Fetched ${data.inserted} new lead${data.inserted !== 1 ? 's' : ''} from Meta${dup}${errs}.` });
      } else {
        setToast({ ok: false, msg: data.error || 'Failed to fetch leads from Meta.' });
      }
    } catch {
      setToast({ ok: false, msg: 'Network error while fetching leads.' });
    } finally {
      setFetching(false);
      setTimeout(() => setToast(null), 6000);
    }
  }

  /* ── Layout pieces (rendered in different arrangements per workspace) ── */
  const timerHeader = (
    <div>
      <h3 className="font-sans text-xl font-bold text-purple-900">Webinar Timer</h3>
      <p className="font-sans text-sm text-purple-400 mt-1">
        All times in IST (India Standard Time). Changes update the countdown timer instantly for all visitors.
      </p>
    </div>
  );

  const currentCard = (
    <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors" style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', whiteSpace: 'nowrap', marginBottom: 4 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 20,
          fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: 'rgba(5,150,105,0.10)', color: '#059669',
          flexShrink: 0,
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#059669', display: 'inline-block' }} />
          Live
        </span>
        <label className="font-sans font-semibold text-purple-900 text-sm" style={{ margin: 0 }}>
          Current Webinar
          <WebinarNameEditor
            existing={activeWebinar?.name || ''}
            value={currentName}
            onChange={setCurrentName}
            onCommit={() => saveWebinarName('current_webinar_name', currentName)}
            accent="#059669"
          />
        </label>
      </div>
      <p className="font-sans text-xs text-purple-400 mb-3">{showForms ? 'Start Date' : 'Registration countdown ends in'}</p>
      <DateTimePicker value={currentWebinar} onChange={setCurrentWebinar} />
      {currentWebinar && (
        <p className="font-sans text-xs text-purple-400 mt-2">
          {new Date(fromLocalDatetimeValue(currentWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
        </p>
      )}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
        <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>{showForms ? 'End Date' : 'Webinar date (when this session actually happens)'}</p>
        <DateTimePicker value={currentWebinarDate} onChange={setCurrentWebinarDate} />
        {currentWebinarDate && (
          <p className="font-sans text-xs text-purple-400 mt-2">
            {new Date(fromLocalDatetimeValue(currentWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
          </p>
        )}
      </div>
      {showForms && (
        <MetaFormSelect scope="current" value={currentFormIds} onChange={setCurrentFormIds} options={linkOptions} isTagmango={isTagmango} />
      )}
    </div>
  );

  const nextCard = (
    <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors" style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 20,
          fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: 'rgba(37,99,235,0.10)', color: '#2563EB',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#2563EB', display: 'inline-block' }} />
          Upcoming
        </span>
      </div>
      <label className="block font-sans font-semibold text-purple-900 text-sm mb-1">
        Next Webinar
        <WebinarNameEditor
          existing={upcomingWebinar?.name || ''}
          value={nextName}
          onChange={setNextName}
          onCommit={() => saveWebinarName('next_webinar_name', nextName)}
          accent="#2563EB"
        />
      </label>
      <p className="font-sans text-xs text-purple-400 mb-3">{showForms ? 'Start Date' : 'Auto-switches when current webinar ends'}</p>
      <DateTimePicker value={nextWebinar} onChange={setNextWebinar} />
      {nextWebinar && (
        <p className="font-sans text-xs text-purple-400 mt-2">
          {new Date(fromLocalDatetimeValue(nextWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
        </p>
      )}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
        <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>{showForms ? 'End Date' : 'Webinar date (when next session actually happens)'}</p>
        <DateTimePicker value={nextWebinarDate} onChange={setNextWebinarDate} />
        {nextWebinarDate && (
          <p className="font-sans text-xs text-purple-400 mt-2">
            {new Date(fromLocalDatetimeValue(nextWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
          </p>
        )}
      </div>
      {showForms && (
        <MetaFormSelect scope="next" value={nextFormIds} onChange={setNextFormIds} options={linkOptions} isTagmango={isTagmango} />
      )}
    </div>
  );

  const saveRow = (
    <div className="flex items-center gap-4 pt-1">
      <button
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center gap-2 bg-purple text-white font-sans font-semibold px-6 py-2.5 rounded-pill disabled:opacity-50 hover:bg-purple-700 transition-colors shadow-[0_2px_12px_rgba(91,33,182,0.25)]"
      >
        {saving ? (
          <>
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Saving...
          </>
        ) : 'Save Settings'}
      </button>
      {toast && (
        <span className={`font-sans text-sm font-medium ${toast.ok ? 'text-brand-green' : 'text-red-500'}`}>
          {toast.ok
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1"><polyline points="20 6 9 17 4 12"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          }{toast.msg}
        </span>
      )}
    </div>
  );

  return (
    <>
      <style>{`
        @keyframes timerPulse { 0%,100%{opacity:1} 50%{opacity:0.45} }
        @media (max-width: 640px) {
          .timer-layout { flex-direction: column !important; gap: 20px !important; }
          .timer-left { flex: 1 1 auto !important; min-width: 0 !important; max-width: 100% !important; }
          .timer-right { min-width: 0 !important; }
          .timer-session-card { padding: 12px 14px !important; }
        }
      `}</style>
      {showForms ? (
      /* ══ META TEMP layout — Current top-left, Upcoming top-right, Sessions bottom ══ */
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Full-width header so both webinar cards top-align in one row */}
        {timerHeader}
      <div className="timer-layout" style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ══ TOP-LEFT — Current Webinar ══ */}
        <div className="timer-left" style={{ flex: '1 1 360px', minWidth: 280 }}>
          <div className="space-y-5">
            {/* Current Webinar */}
            <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors" style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', whiteSpace: 'nowrap', marginBottom: 4 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 20,
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'rgba(5,150,105,0.10)', color: '#059669',
                  flexShrink: 0,
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#059669', display: 'inline-block' }} />
                  Live
                </span>
                <label className="font-sans font-semibold text-purple-900 text-sm" style={{ margin: 0 }}>
                  Current Webinar
                  <WebinarNameEditor
                    existing={activeWebinar?.name || ''}
                    value={currentName}
                    onChange={setCurrentName}
                    onCommit={() => saveWebinarName('current_webinar_name', currentName)}
                    accent="#059669"
                  />
                </label>
              </div>
              <p className="font-sans text-xs text-purple-400 mb-3">{showForms ? 'Start Date' : 'Registration countdown ends in'}</p>
              <DateTimePicker value={currentWebinar} onChange={setCurrentWebinar} />
              {currentWebinar && (
                <p className="font-sans text-xs text-purple-400 mt-2">
                  {new Date(fromLocalDatetimeValue(currentWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                </p>
              )}

              {/* Actual webinar date — separate from the registration deadline */}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
                <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>{showForms ? 'End Date' : 'Webinar date (when this session actually happens)'}</p>
                <DateTimePicker value={currentWebinarDate} onChange={setCurrentWebinarDate} />
                {currentWebinarDate && (
                  <p className="font-sans text-xs text-purple-400 mt-2">
                    {new Date(fromLocalDatetimeValue(currentWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                  </p>
                )}
              </div>

              {showForms && (
                <MetaFormSelect scope="current" value={currentFormIds} onChange={setCurrentFormIds} options={linkOptions} isTagmango={isTagmango} />
              )}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
                <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar Date &amp; Time</p>
                <DateTimePicker value={currentWebinarDT} onChange={setCurrentWebinarDT} />
              </div>
              <div style={{ marginTop: 14 }}>
                <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar Link</p>
                <input
                  type="text"
                  value={currentWebinarLink}
                  onChange={(e) => setCurrentWebinarLink(e.target.value)}
                  placeholder="https://zoom.us/j/…"
                  style={{ width: '100%', height: '2.6rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            </div>

            {/* Save */}
            <div className="flex items-center gap-4 pt-1">
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-purple text-white font-sans font-semibold px-6 py-2.5 rounded-pill disabled:opacity-50 hover:bg-purple-700 transition-colors shadow-[0_2px_12px_rgba(91,33,182,0.25)]"
              >
                {saving ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                    Saving...
                  </>
                ) : 'Save Settings'}
              </button>
              {!isTagmango && (
                <button
                  onClick={fetchMetaLeads}
                  disabled={fetching || saving}
                  title="Pull leads from the selected Meta forms within the Start–End window"
                  className="inline-flex items-center gap-2 font-sans font-semibold px-5 py-2.5 rounded-pill disabled:opacity-50 transition-colors"
                  style={{ border: '1.5px solid rgba(5,150,105,0.45)', background: 'rgba(236,253,245,0.85)', color: '#059669' }}
                >
                  {fetching ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                      Fetching…
                    </>
                  ) : (
                    <>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><polyline points="21 3 21 9 15 9"/></svg>
                      Fetch from Meta
                    </>
                  )}
                </button>
              )}
              {toast && (
                <span className={`font-sans text-sm font-medium ${toast.ok ? 'text-brand-green' : 'text-red-500'}`}>
                  {toast.ok
                    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1"><polyline points="20 6 9 17 4 12"/></svg>
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  }{toast.msg}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ══ TOP-RIGHT — Upcoming Webinar ══ */}
        <div className="timer-right" style={{ flex: '1 1 360px', minWidth: 280 }}>
          {/* Next Webinar */}
          <div className="bg-white rounded-card border border-purple-100 p-5 hover:border-purple-300 transition-colors" style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 20,
                fontFamily: 'Outfit, sans-serif', fontSize: '0.65rem', fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'rgba(37,99,235,0.10)', color: '#2563EB',
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#2563EB', display: 'inline-block' }} />
                Upcoming
              </span>
            </div>
            <label className="block font-sans font-semibold text-purple-900 text-sm mb-1">
              Next Webinar
              <WebinarNameEditor
                existing={upcomingWebinar?.name || ''}
                value={nextName}
                onChange={setNextName}
                onCommit={() => saveWebinarName('next_webinar_name', nextName)}
                accent="#2563EB"
              />
            </label>
            <p className="font-sans text-xs text-purple-400 mb-3">{showForms ? 'Start Date' : 'Auto-switches when current webinar ends'}</p>
            <DateTimePicker value={nextWebinar} onChange={setNextWebinar} />
            {nextWebinar && (
              <p className="font-sans text-xs text-purple-400 mt-2">
                {new Date(fromLocalDatetimeValue(nextWebinar)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
              </p>
            )}

            {/* Actual next-webinar date */}
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
              <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>{showForms ? 'End Date' : 'Webinar date (when next session actually happens)'}</p>
              <DateTimePicker value={nextWebinarDate} onChange={setNextWebinarDate} />
              {nextWebinarDate && (
                <p className="font-sans text-xs text-purple-400 mt-2">
                  {new Date(fromLocalDatetimeValue(nextWebinarDate)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
                </p>
              )}
            </div>

            {showForms && (
              <MetaFormSelect scope="next" value={nextFormIds} onChange={setNextFormIds} options={linkOptions} isTagmango={isTagmango} />
            )}
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.45)' }}>
              <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar Date &amp; Time</p>
              <DateTimePicker value={nextWebinarDT} onChange={setNextWebinarDT} />
            </div>
            <div style={{ marginTop: 14 }}>
              <p className="font-sans text-xs text-purple-400 mb-2" style={{ fontWeight: 600 }}>Webinar Link</p>
              <input
                type="text"
                value={nextWebinarLink}
                onChange={(e) => setNextWebinarLink(e.target.value)}
                placeholder="https://zoom.us/j/…"
                style={{ width: '100%', height: '2.6rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
        </div>
      </div>

      </div>
      ) : (
      /* ══ Other workspaces — Current + Upcoming + Save (Sessions moved to Zoom page) ══ */
        <div className="timer-layout" style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="timer-left" style={{ flex: '1 1 420px', minWidth: 280 }}>
            <div className="space-y-5">
              {timerHeader}
              {currentCard}
              {nextCard}
              {saveRow}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const bsInputStyle = {
  width: '100%', height: '2.8rem', padding: '0 12px', borderRadius: 10,
  border: '1px solid rgba(209,196,240,0.8)', background: 'rgba(237,234,248,0.30)',
  fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: '#3B0764',
  outline: 'none', boxSizing: 'border-box',
};

/* Brand-styled single-select dropdown — matches the CRM's BrandSelect
   (option panel portaled to <body> so it never gets clipped). Replaces the
   native <select> so the Meta-form list matches the rest of the UI. */
function BrandSelect({ value, onChange, options = [], disabled = false, searchable = false, searchPlaceholder = 'Search…', multiple = false, placeholder = 'Select…' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos]   = useState({ top: 0, left: 0, width: 0, maxH: 280 });
  const wrapRef    = useRef(null);
  const triggerRef = useRef(null);
  const panelRef   = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    // Close on page scroll — but NOT when the scroll happens inside the
    // dropdown's own option list (that was the bug that blocked scrolling).
    function onScroll(e) {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  function toggle() {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const maxH = Math.min(340, Math.max(180, spaceBelow));
      const top  = spaceBelow >= 200 ? r.bottom + 4 : Math.max(8, r.top - maxH - 4);
      setPos({ top, left: r.left, width: r.width, maxH });
      setQuery('');
    }
    setOpen(o => !o);
  }

  const valArr = multiple ? (Array.isArray(value) ? value.map(String) : []) : [];
  const isSelectedVal = (ov) => multiple ? valArr.includes(String(ov)) : String(ov) === String(value);

  function pick(v) {
    if (multiple) {
      const s = String(v);
      onChange(valArr.includes(s) ? valArr.filter(x => x !== s) : [...valArr, s]);
      // keep the panel open so several forms can be ticked in one go
    } else {
      onChange(v); setOpen(false);
    }
  }

  const selected = options.find(o => String(o.value) === String(value));
  const label    = multiple
    ? (valArr.length ? `${valArr.length} form${valArr.length === 1 ? '' : 's'} selected` : '')
    : (selected ? selected.label : '');
  const isPlaceholder = multiple ? valArr.length === 0 : !value;

  const placeholderOpt = options.find(o => o.value === '');
  const realOptions    = options.filter(o => o.value !== '');
  const q = query.trim().toLowerCase();
  const filtered = q ? realOptions.filter(o => String(o.label).toLowerCase().includes(q)) : realOptions;
  const visible  = placeholderOpt ? [placeholderOpt, ...filtered] : filtered;

  const rowFor = (o) => {
    const isSel = isSelectedVal(o.value);
    return (
      <div
        key={String(o.value) || '__none__'}
        onClick={() => pick(o.value)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 12px', cursor: 'pointer',
          fontSize: '0.88rem', color: '#3B0764',
          fontWeight: isSel ? 700 : 500,
          background: isSel ? 'rgba(91,33,182,0.07)' : 'transparent',
          borderBottom: '1px solid rgba(139,92,246,0.07)',
          transition: 'background 120ms',
        }}
        onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'rgba(139,92,246,0.06)'; }}
        onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
      >
        {multiple ? (
          /* Checkbox indicator */
          <span style={{
            width: 16, height: 16, flexShrink: 0, borderRadius: 4,
            border: isSel ? '1px solid #5B21B6' : '1px solid rgba(91,33,182,0.35)',
            background: isSel ? '#5B21B6' : '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {isSel && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff"
                strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        ) : (
          <span style={{ width: 14, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
            {isSel && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {o.label}
        </span>
      </div>
    );
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        style={{
          ...bsInputStyle,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
          opacity: disabled ? 0.6 : 1,
          fontWeight: isPlaceholder ? 400 : 600,
          color: isPlaceholder ? 'rgba(91,33,182,0.50)' : '#3B0764',
          border: open ? '1px solid rgba(91,33,182,0.55)' : bsInputStyle.border,
          boxShadow: open ? '0 0 0 3px rgba(91,33,182,0.10)' : 'none',
          transition: 'border 160ms, box-shadow 160ms',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || placeholder}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 180ms' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: pos.width,
            background: '#fff', border: '1px solid rgba(139,92,246,0.18)', borderRadius: 10,
            boxShadow: '0 14px 44px rgba(91,33,182,0.20)',
            zIndex: 10000, overflow: 'hidden', fontFamily: 'Outfit, sans-serif',
            display: 'flex', flexDirection: 'column', maxHeight: pos.maxH,
          }}
        >
          {searchable && (
            <div style={{ padding: 8, borderBottom: '1px solid rgba(139,92,246,0.12)', flexShrink: 0 }}>
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                style={{
                  width: '100%', height: 34, padding: '0 10px', borderRadius: 8,
                  border: '1px solid rgba(139,92,246,0.25)', outline: 'none',
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', color: '#3B0764',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.7rem', color: 'rgba(91,33,182,0.55)', padding: '6px 2px 0', fontWeight: 600 }}>
                {q ? `${filtered.length} of ${realOptions.length}` : realOptions.length} form{realOptions.length === 1 ? '' : 's'}
              </div>
            </div>
          )}
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {visible.length === 0
              ? <div style={{ padding: '14px 12px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: 'rgba(91,33,182,0.5)' }}>No matches.</div>
              : visible.map(rowFor)}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
