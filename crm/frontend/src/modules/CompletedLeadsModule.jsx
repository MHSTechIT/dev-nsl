import { useState, useEffect, useCallback, useRef } from 'react';
import CallerLeadsTable from '../components/CallerLeadsTable';
import EditCallNoteModal from './EditCallNoteModal';
import SourceBadge from '../components/SourceBadge';
import { useTimerSettings } from '../context/TimerSettingsContext';

/* ──────────────────────────────────────────────────────────────────────────
   Completed Leads — leads the caller has marked done OR follow-up-scheduled
   for a future time. Auto-refetches every 60 s so a follow-up that becomes
   due silently moves back to the Assigned tab.
   ────────────────────────────────────────────────────────────────────────── */

const SUGAR_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
};

/* Lead-quality classifier — first match wins.
   Junk is intentionally first so "interested = no" / "no diabetes" overrides
   any sugar/medicine signal that would otherwise look promising. */
function classifyLead(lead) {
  const r   = lead.last_note_confirmed_range;
  const med = lead.last_note_takes_medicine;
  const intd = lead.last_note_interested;

  if (r === 'no_diabetes' || intd === 'no')                 return 'junk';
  if (r === '250+'    && med === 'yes' && intd === 'yes')   return 'hot';
  if (r === '200-250' && intd === 'yes')                    return 'warm';
  if (r === '100-200' && med === 'no')                      return 'cold';
  return null;
}

const QUALITY_BADGE = {
  hot:  { bg: 'rgba(220,38,38,0.12)',   fg: '#B91C1C', label: 'Hot'  },
  warm: { bg: 'rgba(245,158,11,0.15)',  fg: '#B45309', label: 'Warm' },
  cold: { bg: 'rgba(30,64,175,0.12)',   fg: '#1E40AF', label: 'Cold' },
  junk: { bg: 'rgba(107,114,128,0.18)', fg: '#374151', label: 'Junk' },
};

/* Outcome subtag → human label. Kept in sync with
   ALLOWED_OUTCOME_SUBTAGS in backend/routes/caller.js and the option
   arrays in LeadCallNoteModal.jsx. Unknown values fall back to a
   titlecased version of the snake_case key. */
const SUBTAG_LABEL = {
  // Not Interested dropdown
  wrong_number:              'Wrong Number',
  call_disconnected:         'Call Disconnected',
  other_languages:           'Other Languages',
  no_diabetes:               'No Diabetes',
  no_sugar_interested:       'No Sugar — Interested',
  no_sugar_not_interested:   'No Sugar — Not Interested',
  already_paid:              'Already Paid',
  already_attended:          'Already Attended',
  not_available_for_webinar: 'Not Available for Webinar',
  not_register:              'Not Registered',
  just_for_knowledge:        'Just for Knowledge',
  // Second-DNP choice card
  switch_off:                'Switch Off',
  out_of_service:            'Out of Service',
  no_ring:                   'No Ring',
};
function subtagLabel(v) {
  if (!v) return '';
  return SUBTAG_LABEL[v] || v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const RANGE_LABEL = {
  '250+':         '250+',
  '200-250':      '200–250',
  '100-200':      '100–200',
  'no_diabetes':  'No Diabetes',
  // Legacy values kept readable in case older notes reference them
  '<150':         '<150',
  '155-250':      '155–250',
  'no_sugar':     'No Sugar',
};

const AGE_LABEL = {
  '0-18': '0–18', '19-24': '19–24', '25-34': '25–34',
  '35-44': '35–44', '45-54': '45–54', 'above-54': 'Above 54',
};

const DIET_LABEL    = { yes: 'Yes', not_interested: 'Not Interested' };
const MEDICINE_LABEL = { yes: 'Yes', no: 'No' };
const YES_NO_LABEL  = { yes: 'Yes', no: 'No' };
const HBA1C_LABEL   = {
  'gt_7_5':     'HbA1c > 7.5',
  '6_5_to_7_5': 'HbA1c 6.5 – 7.5',
  '5_7_to_6_5': 'HbA1c 5.7 – 6.5',
};

// Resolve a stored value through an optional label map, falling back to '—' for
// missing / empty values so the expanded card has a consistent shape.
function valOrDash(v, map) {
  if (v === null || v === undefined || v === '') return '—';
  if (map && map[v]) return map[v];
  return v;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}

function fmtDuration(sec) {
  if (sec == null) return null;
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

export default function CompletedLeadsModule({ jwt, onCount, previewMode = false }) {
  // Bubble the count up to CallerShell for the header chip. Hook is
  // declared below right after the leads state — defined here just to
  // keep the prop visible at the top.
  const t = useTimerSettings();
  const [leads, setLeads]     = useState([]);
  useEffect(() => { if (typeof onCount === 'function') onCount(leads.length); }, [leads.length, onCount]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState('all');     // all | hot | warm | cold | junk | second_call
  const [search, setSearch]   = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [editLead, setEditLead] = useState(null); // tap a row → open its note
  const sseRef = useRef(null);

  const fetchLeads = useCallback(async () => {
    if (!jwt) {
      setLeads([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [completedRes, dnpRes] = await Promise.all([
        fetch('/api/caller/leads/completed', { headers: { Authorization: `Bearer ${jwt}` } }),
        fetch('/api/caller/leads/not-picked', { headers: { Authorization: `Bearer ${jwt}` } }),
      ]);
      if (!completedRes.ok) throw new Error('Failed to load completed leads.');
      const completed = (await completedRes.json()).leads || [];
      const dnp = dnpRes.ok ? ((await dnpRes.json()).leads || []) : [];
      const seen = new Set();
      const merged = [...completed, ...dnp].filter(l => {
        if (seen.has(l.id)) return false;
        seen.add(l.id);
        return true;
      });
      setLeads(merged);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  /* Auto-refetch on the configured interval — follow-ups whose time arrives
     leave this list. */
  useEffect(() => {
    if (!jwt) return;
    const id = setInterval(() => fetchLeads(), t.completedRefetchIntervalMs);
    return () => clearInterval(id);
  }, [jwt, fetchLeads, t.completedRefetchIntervalMs]);

  /* SSE — refresh when this caller's notes change */
  useEffect(() => {
    if (!jwt || previewMode) return;   // preview: no live stream (read-only)
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwt)}`;
    const es  = new EventSource(url);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'lead.note_saved') fetchLeads();
        if (msg?.type === 'call.update')      fetchLeads();
      } catch (_) {}
    };
    return () => { es.close(); sseRef.current = null; };
  }, [jwt, fetchLeads]);

  // 2nd-call: leads who answered "interested = yes" on the first call → caller should call back.
  function isSecondCall(l) {
    return l.last_note_interested === 'yes';
  }

  const filtered = leads.filter(l => {
    if (filter === 'hot' || filter === 'warm' || filter === 'cold' || filter === 'junk') {
      if (classifyLead(l) !== filter) return false;
    }
    if (filter === 'second_call' && !isSecondCall(l)) return false;
    if (filter === 'follow_up' && l.last_note_outcome !== 'follow_up') return false;
    if (filter === 'dnp' && l.last_note_outcome !== 'not_picked') return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const blob = `${l.full_name || ''} ${l.email || ''} ${l.whatsapp_number || ''}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  const stats = {
    hot:        leads.filter(l => classifyLead(l) === 'hot').length,
    warm:       leads.filter(l => classifyLead(l) === 'warm').length,
    cold:       leads.filter(l => classifyLead(l) === 'cold').length,
    junk:       leads.filter(l => classifyLead(l) === 'junk').length,
    secondCall: leads.filter(isSecondCall).length,
    followUp:   leads.filter(l => l.last_note_outcome === 'follow_up').length,
    dnp:        leads.filter(l => l.last_note_outcome === 'not_picked').length,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>{`
        @media (max-width: 1100px) {
          .compl-stat-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 560px) {
          .compl-stat-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

      {/* Search */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 16 }}>
        <div style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search completed leads…"
            style={{ width: '100%', height: '2.4rem', padding: '0 12px 0 34px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.7)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      {/* Filter cards: click to filter, click again to clear */}
      <div className="compl-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 12 }}>
        {[
          { value: 'hot',         label: 'Hot',       count: stats.hot,        accent: '#B91C1C', tint: 'rgba(220,38,38,0.10)' },
          { value: 'warm',        label: 'Warm',      count: stats.warm,       accent: '#B45309', tint: 'rgba(245,158,11,0.12)' },
          { value: 'cold',        label: 'Cold',      count: stats.cold,       accent: '#1E40AF', tint: 'rgba(30,64,175,0.10)' },
          { value: 'junk',        label: 'Junk',      count: stats.junk,       accent: '#374151', tint: 'rgba(107,114,128,0.14)' },
          { value: 'follow_up',   label: 'Follow Up', count: stats.followUp,   accent: '#047857', tint: 'rgba(5,150,105,0.12)' },
          { value: 'second_call', label: '2nd Call',  count: stats.secondCall, accent: '#5B21B6', tint: 'rgba(91,33,182,0.10)' },
          { value: 'dnp',         label: 'DNP',       count: stats.dnp,        accent: '#9333EA', tint: 'rgba(147,51,234,0.12)' },
        ].map(f => {
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              onClick={() => setFilter(active ? 'all' : f.value)}
              className="bg-white rounded-card shadow-card"
              style={{
                padding: 14, display: 'flex', alignItems: 'center', gap: 12,
                border: active ? `2px solid ${f.accent}` : '2px solid transparent',
                cursor: 'pointer', textAlign: 'left',
                transition: 'border-color 150ms, transform 150ms',
                fontFamily: 'Outfit, sans-serif',
              }}
            >
              <div style={{ width: 38, height: 38, borderRadius: 10, background: f.tint, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ color: f.accent, fontWeight: 800, fontSize: '0.95rem' }}>{f.count}</span>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(91,33,182,0.55)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{f.label}</div>
              </div>
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* List */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Loading completed leads…</Empty>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
            <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 16, background: 'rgba(5,150,105,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </div>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>
              {leads.length === 0 ? 'No completed leads yet' : 'No matches'}
            </div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem', maxWidth: 360, margin: '0 auto' }}>
              {leads.length === 0
                ? <>When you mark a lead as <strong>Done</strong> or schedule a <strong>Follow Up</strong> from your Assigned Leads, it will appear here.</>
                : 'Try clearing the search or filter.'}
            </div>
          </div>
        ) : (
          <CallerLeadsTable
            leads={filtered}
            onRowClick={(l) => setEditLead(l)}
          />
        )}
      </div>

      {editLead && (
        <EditCallNoteModal
          jwt={jwt}
          lead={editLead}
          previewMode={previewMode}
          onClose={() => setEditLead(null)}
          onSaved={() => { setEditLead(null); fetchLeads(); }}
        />
      )}
    </div>
  );
}

/* ── Subcomponents ── */

function LeadRow({ lead, jwt, expanded, onToggle, onSaved }) {
  const [editing, setEditing] = useState(false);
  const isFollowUp     = lead.last_note_outcome === 'follow_up';
  const isNotInterested = lead.last_note_outcome === 'not_interested';
  const isNotPicked    = lead.last_note_outcome === 'not_picked';
  const isIncomplete   = lead.last_note_outcome === 'incomplete';
  const tag = isFollowUp
    ? { bg: 'rgba(245,158,11,0.15)', fg: '#B45309', label: `Follow-up · ${fmtDate(lead.follow_up_at)}` }
    : isNotInterested
      ? { bg: 'rgba(220,38,38,0.12)',  fg: '#B91C1C', label: `Not Interested · ${fmtDate(lead.last_note_at)}` }
      : isNotPicked
        ? { bg: 'rgba(147,51,234,0.12)', fg: '#7E22CE', label: `DNP · ${fmtDate(lead.last_note_at)}` }
        : isIncomplete
          ? { bg: 'rgba(234,88,12,0.15)',  fg: '#C2410C', label: `Incomplete · ${fmtDate(lead.last_note_at)}` }
          : { bg: 'rgba(5,150,105,0.12)',  fg: '#047857', label: `Completed · ${fmtDate(lead.last_note_at)}` };

  const quality  = classifyLead(lead);
  const qBadge   = quality ? QUALITY_BADGE[quality] : null;

  const dur = fmtDuration(lead.last_call_duration);

  return (
    <div style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
      <div
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(180px,1.4fr) minmax(140px,1fr) minmax(180px,auto) minmax(220px,1fr) auto',
          alignItems: 'center', gap: 14,
          padding: '14px 18px', cursor: 'pointer',
          fontFamily: 'Outfit, sans-serif',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.92rem' }}>{lead.full_name || '—'}</span>
            <SourceBadge source={lead.source} />
            {qBadge && (
              <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 50, fontSize: '0.68rem', fontWeight: 700, background: qBadge.bg, color: qBadge.fg, whiteSpace: 'nowrap' }}>
                {qBadge.label}
              </span>
            )}
            {/* Subtag chip — the specific decline reason captured at
                save time (Not Interested dropdown OR second-DNP card).
                Renders only when present so pre-change rows stay clean. */}
            {lead.last_note_outcome_subtag && (
              <span
                title={`Reason: ${subtagLabel(lead.last_note_outcome_subtag)}`}
                style={{
                  display: 'inline-block', padding: '2px 8px', borderRadius: 50,
                  fontSize: '0.66rem', fontWeight: 700,
                  background: 'rgba(91,33,182,0.08)', color: '#5B21B6',
                  whiteSpace: 'nowrap',
                  border: '1px solid rgba(91,33,182,0.18)',
                }}
              >
                {subtagLabel(lead.last_note_outcome_subtag)}
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{lead.email || ''}</div>
        </div>
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.80rem', color: '#3B0764' }}>
          {lead.whatsapp_number ? `+91 ${lead.whatsapp_number}` : '—'}
        </div>
        <div>
          <span style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 50, fontSize: '0.72rem', fontWeight: 700, background: tag.bg, color: tag.fg, whiteSpace: 'nowrap' }}>
            {tag.label}
          </span>
        </div>
        <div onClick={e => e.stopPropagation()} style={{ minWidth: 0 }}>
          {lead.last_call_recording_url && lead.last_call_id ? (
            <audio
              controls
              preload="none"
              src={`/api/caller/recordings/${lead.last_call_id}?token=${encodeURIComponent(jwt)}`}
              style={{ width: '100%', maxWidth: 260, height: 32 }}
            />
          ) : (
            <span style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.45)', fontStyle: 'italic' }}>
              No recording
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {dur && (
            <span style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.65)', whiteSpace: 'nowrap' }}>
              {dur}
            </span>
          )}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.55)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '6px 18px 18px', fontFamily: 'Outfit, sans-serif', background: 'rgba(237,234,248,0.30)' }}>
          {/* Edit-button bar — top-right of the expanded panel */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Edit these call details"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 30, padding: '0 12px', borderRadius: 6, border: 'none',
                background: '#5B21B6', color: '#fff',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.78rem',
                cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(91,33,182,0.30)',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>
              </svg>
              Edit
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
          {/* LEFT — every form field, in the same order as the call-note form */}
          <DetailGroup title="Call details">
            <Detail label="3. Confirm Range" value={
              lead.last_note_sugar_confirmation === 'same'
                ? `Same as registered (${lead.sugar_level || '—'})`
                : valOrDash(lead.last_note_confirmed_range, RANGE_LABEL)
            } />
            <Detail label="4. This value is for" value={
              lead.last_note_range_for === 'family' ? 'Family'
              : lead.last_note_range_for === 'personal' ? 'Personal'
              : '—'
            } />
            <Detail label="5. Patient age"           value={valOrDash(lead.last_note_patient_age, AGE_LABEL)} />
            <Detail label="6. HbA1c"                 value={valOrDash(lead.last_note_hba1c, HBA1C_LABEL)} />
            <Detail label="7. Medicine"              value={valOrDash(lead.last_note_takes_medicine, MEDICINE_LABEL)} />
            <Detail label="8. Other Languages"       value={valOrDash(lead.last_note_other_languages, YES_NO_LABEL)} />
            <Detail label="9. Working Professional"  value={valOrDash(lead.last_note_working_professional)} />
            <Detail label="10. Location"             value={valOrDash(lead.last_note_location)} />
            <Detail label="11. Already Paid"         value={valOrDash(lead.last_note_already_paid, YES_NO_LABEL)} />
            <Detail label="12. Webinar Attended"     value={valOrDash(lead.last_note_webinar_attended, YES_NO_LABEL)} />
            <Detail label="13. Available for Webinar" value={valOrDash(lead.last_note_available_for_webinar, YES_NO_LABEL)} />
            <Detail label="14. Next Batch Joining"   value={valOrDash(lead.last_note_next_batch_joining, YES_NO_LABEL)} />

            {/* 15. Note */}
            <div style={{ marginTop: 8 }}>
              <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.70rem', fontWeight: 600, color: 'rgba(91,33,182,0.55)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                15. Note
              </span>
              <div style={{ marginTop: 4, padding: '8px 10px', background: '#fff', borderRadius: 6, fontSize: '0.82rem', color: '#3B0764', whiteSpace: 'pre-wrap', minHeight: 32 }}>
                {lead.last_note_text || <span style={{ color: 'rgba(91,33,182,0.40)', fontStyle: 'italic' }}>No note added.</span>}
              </div>
            </div>

            {/* Interested verdict — colored badge */}
            {(() => {
              const v = lead.last_note_interested_in_note || lead.last_note_interested;
              const badge = v === 'yes'
                ? { bg: 'rgba(16,185,129,0.15)', fg: '#047857', label: 'Interested · YES' }
                : v === 'no'
                  ? { bg: 'rgba(220,38,38,0.12)', fg: '#B91C1C', label: 'Interested · NO' }
                  : { bg: 'rgba(91,33,182,0.08)', fg: 'rgba(91,33,182,0.55)', label: 'Interested · —' };
              return (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 6, fontSize: '0.74rem', fontWeight: 700, background: badge.bg, color: badge.fg }}>
                    {badge.label}
                  </span>
                  {lead.last_note_follow_up_at && (
                    <span style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 6, fontSize: '0.74rem', fontWeight: 600, background: 'rgba(245,158,11,0.15)', color: '#B45309' }}>
                      Follow-up · {fmtDate(lead.last_note_follow_up_at)}
                    </span>
                  )}
                </div>
              );
            })()}
          </DetailGroup>

          {/* RIGHT — last-call summary */}
          <DetailGroup title="Call info">
            <Detail label="Status"   value={lead.last_call_status || '—'} />
            <Detail label="Duration" value={dur || '—'} />
            <Detail label="Started"  value={fmtDate(lead.last_call_started_at)} />
          </DetailGroup>
          </div>
        </div>
      )}

      {editing && (
        <EditCallNoteModal
          jwt={jwt}
          lead={lead}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onSaved?.(); }}
        />
      )}
    </div>
  );
}

function DetailGroup({ title, children }) {
  return (
    <div>
      <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(91,33,182,0.55)', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.82rem' }}>
      <span style={{ color: 'rgba(91,33,182,0.65)' }}>{label}</span>
      <span style={{ color: '#3B0764', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem' }}>
      {children}
    </div>
  );
}
