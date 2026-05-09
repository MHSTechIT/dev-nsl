import { useState, useEffect, useCallback, useRef } from 'react';

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

export default function CompletedLeadsModule({ jwt }) {
  const [leads, setLeads]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState('all');     // all | hot | warm | cold | junk | second_call
  const [search, setSearch]   = useState('');
  const [expandedId, setExpandedId] = useState(null);
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
      const res = await fetch('/api/caller/leads/completed', { headers: { Authorization: `Bearer ${jwt}` } });
      if (!res.ok) throw new Error('Failed to load completed leads.');
      const data = await res.json();
      setLeads(data.leads || []);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  /* Auto-refetch every 60 s — follow-ups whose time arrives leave this list. */
  useEffect(() => {
    if (!jwt) return;
    const t = setInterval(() => fetchLeads(), 60000);
    return () => clearInterval(t);
  }, [jwt, fetchLeads]);

  /* SSE — refresh when this caller's notes change */
  useEffect(() => {
    if (!jwt) return;
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
      <div className="compl-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
        {[
          { value: 'hot',         label: 'Hot',       count: stats.hot,        accent: '#B91C1C', tint: 'rgba(220,38,38,0.10)' },
          { value: 'warm',        label: 'Warm',      count: stats.warm,       accent: '#B45309', tint: 'rgba(245,158,11,0.12)' },
          { value: 'cold',        label: 'Cold',      count: stats.cold,       accent: '#1E40AF', tint: 'rgba(30,64,175,0.10)' },
          { value: 'junk',        label: 'Junk',      count: stats.junk,       accent: '#374151', tint: 'rgba(107,114,128,0.14)' },
          { value: 'follow_up',   label: 'Follow Up', count: stats.followUp,   accent: '#047857', tint: 'rgba(5,150,105,0.12)' },
          { value: 'second_call', label: '2nd Call',  count: stats.secondCall, accent: '#5B21B6', tint: 'rgba(91,33,182,0.10)' },
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
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {filtered.map(l => (
              <LeadRow
                key={l.id}
                lead={l}
                jwt={jwt}
                expanded={expandedId === l.id}
                onToggle={() => setExpandedId(expandedId === l.id ? null : l.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Subcomponents ── */

function LeadRow({ lead, jwt, expanded, onToggle }) {
  const isFollowUp     = lead.last_note_outcome === 'follow_up';
  const isNotInterested = lead.last_note_outcome === 'not_interested';
  const tag = isFollowUp
    ? { bg: 'rgba(245,158,11,0.15)', fg: '#B45309', label: `Follow-up · ${fmtDate(lead.follow_up_at)}` }
    : isNotInterested
      ? { bg: 'rgba(220,38,38,0.12)',  fg: '#B91C1C', label: `Not Interested · ${fmtDate(lead.last_note_at)}` }
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
            {qBadge && (
              <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 50, fontSize: '0.68rem', fontWeight: 700, background: qBadge.bg, color: qBadge.fg, whiteSpace: 'nowrap' }}>
                {qBadge.label}
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
        <div style={{ padding: '6px 18px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontFamily: 'Outfit, sans-serif', background: 'rgba(237,234,248,0.30)' }}>
          <DetailGroup title="Call notes">
            <Detail label="Range confirmed" value={
              lead.last_note_sugar_confirmation === 'same'
                ? `Same as registered (${lead.sugar_level || '—'})`
                : (RANGE_LABEL[lead.last_note_confirmed_range] || '—')
            } />
            <Detail label="For"           value={lead.last_note_range_for === 'family' ? 'Family' : (lead.last_note_range_for ? 'Personal' : '—')} />
            <Detail label="Patient age"   value={AGE_LABEL[lead.last_note_patient_age] || '—'} />
            <Detail label="Diet"          value={DIET_LABEL[lead.last_note_diet_status] || '—'} />
            <Detail label="On medicine"   value={MEDICINE_LABEL[lead.last_note_takes_medicine] || '—'} />
            {lead.last_note_text && (
              <div style={{ marginTop: 6, padding: '8px 10px', background: '#fff', borderRadius: 8, fontSize: '0.82rem', color: '#3B0764', whiteSpace: 'pre-wrap' }}>
                {lead.last_note_text}
              </div>
            )}
          </DetailGroup>
          <DetailGroup title="Last call">
            <Detail label="Status"    value={lead.last_call_status || '—'} />
            <Detail label="Duration"  value={dur || '—'} />
            <Detail label="Started"   value={fmtDate(lead.last_call_started_at)} />
          </DetailGroup>
        </div>
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
