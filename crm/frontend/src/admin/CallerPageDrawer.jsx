import { useEffect, useState, useMemo } from 'react';

/* CallerPageDrawer — admin-side "what does this caller see" view.
   Opens from the per-caller kebab menu's "Caller page" item in the
   Sales Performance grid. Lists every lead currently sitting in the
   caller's buckets (Assigned / Completed / Not Picked) and lets the
   admin bulk-reopen any Completed lead back to Assigned via a single
   POST /api/admin/leads/reopen call. */

const TAB_LABELS = {
  assigned:   'Assigned',
  completed:  'Completed',
  not_picked: 'Not Picked',
};

// Outcome → bucket. Anything else (NULL, follow_up before today, etc.)
// lands in 'assigned' so leads in flight stay visible to the admin.
function bucketFor(lead) {
  const o = lead.last_note_outcome;
  if (o === 'completed' || o === 'not_interested') return 'completed';
  if (o === 'not_picked' || o === 'auto_paused')   return 'not_picked';
  return 'assigned';
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

const OUTCOME_LABELS = {
  completed:       'Completed',
  not_interested:  'Not interested',
  follow_up:       'Follow-up',
  not_picked:      'Not picked',
  auto_paused:     'Auto-paused',
};

const TAG_PILL = {
  HOT:  { bg: '#FEE2E2', fg: '#B91C1C' },
  WARM: { bg: '#FEF3C7', fg: '#92400E' },
  COLD: { bg: '#DBEAFE', fg: '#1E40AF' },
  JUNK: { bg: '#F3F4F6', fg: '#6B7280' },
};

export default function CallerPageDrawer({ token, callerId, callerName, onClose, onAfterReopen }) {
  const [leads,    setLeads]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [tab,      setTab]      = useState('assigned');
  const [selected, setSelected] = useState(() => new Set());
  const [busy,     setBusy]     = useState(false);
  const [toast,    setToast]    = useState('');
  /* Filter state — applied AFTER bucketing so the tab counts always
     reflect the unfiltered totals (admin still sees how many completed
     leads exist; the visible list shrinks but the badge stays honest). */
  const [search,   setSearch]   = useState('');           // free text — name / phone / email
  const [sugarF,   setSugarF]   = useState('all');        // 'all' | '150-250' | '250+'
  // Tags are MULTI-SELECT — admin can combine e.g. HOT + WARM to view
  // both classifications together. Stored as a Set of tag strings; an
  // empty Set means "no tag filter" (show every tag).
  // The pseudo-tag '2ND_CALL' matches `last_note_outcome === 'follow_up'`
  // — leads scheduled for a second call. It lives alongside HOT/WARM/
  // COLD/JUNK in the pill row even though it's a different DB field,
  // because admins think of "needs a second call" as just another tag.
  const [tagSet,   setTagSet]   = useState(() => new Set());

  useEffect(() => {
    if (!callerId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/admin/caller-leads/${callerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        else setLeads(d.leads || []);
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, callerId]);

  /* Esc closes the drawer. */
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Group leads into the three buckets once and reuse the counts in the
  // tab strip without re-iterating on every render.
  const grouped = useMemo(() => {
    const out = { assigned: [], completed: [], not_picked: [] };
    for (const l of leads) {
      const b = bucketFor(l);
      if (out[b]) out[b].push(l);
    }
    return out;
  }, [leads]);

  // Clear selection whenever the user switches tabs — selection only
  // makes sense within one bucket at a time (we only support reopening
  // Completed back to Assigned for now).
  useEffect(() => { setSelected(new Set()); }, [tab]);

  // Apply filters AFTER bucketing. Search is case-insensitive across
  // name / phone / email; chips narrow by sugar level + lead tag. All
  // three combine with AND — empty search/chip-set means "ignore that
  // filter". Multiple tags combine with OR (lead matches if its tag
  // appears in tagSet, OR if 2ND_CALL is selected and it's a follow-up).
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (grouped[tab] || []).filter(l => {
      if (sugarF !== 'all' && l.sugar_level !== sugarF) return false;
      if (tagSet.size > 0) {
        const tagMatch     = l.lead_tag && tagSet.has(l.lead_tag);
        const isSecondCall = tagSet.has('2ND_CALL') && l.last_note_outcome === 'follow_up';
        if (!tagMatch && !isSecondCall) return false;
      }
      if (!q) return true;
      const hay = `${l.full_name || ''} ${l.whatsapp_number || ''} ${l.email || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [grouped, tab, search, sugarF, tagSet]);
  const allSelected = visible.length > 0 && visible.every(l => selected.has(l.id));
  // True when any filter is narrowing the view — used to render a clear
  // hint + "Clear filters" button so the admin never wonders why their
  // list is empty.
  const isFiltered = search.trim() !== '' || sugarF !== 'all' || tagSet.size > 0;

  // Toggle a tag in/out of the multi-select Set. Returns a new Set so
  // React picks up the state change.
  function toggleTag(tag) {
    setTagSet(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }

  function toggleOne(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visible.map(l => l.id)));
  }

  async function handleReopen() {
    if (selected.size === 0 || busy) return;
    if (!confirm(`Move ${selected.size} lead(s) back to Assigned?`)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/leads/reopen', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ lead_ids: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reopen.');
      setToast(`Moved ${data.reopened} lead(s) back to Assigned.`);
      // Optimistic local update — clear the outcome so the row shifts
      // to the Assigned tab without waiting for a refetch.
      setLeads(prev => prev.map(l => selected.has(l.id)
        ? { ...l, last_note_outcome: null, completed_at: null, last_note_at: null }
        : l));
      setSelected(new Set());
      if (typeof onAfterReopen === 'function') onAfterReopen();
      setTimeout(() => setToast(''), 2400);
    } catch (e) {
      setToast(e.message || 'Reopen failed.');
      setTimeout(() => setToast(''), 3000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <style>{`
        @keyframes cpd-slide-in {
          from { transform: translateX(20px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        .cpd-row:hover { background: rgba(91,33,182,0.04); }
      `}</style>
      {/* Scrim */}
      <div onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 9000, backdropFilter: 'blur(2px)' }} />
      {/* Drawer */}
      <div role="dialog" aria-modal="true"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(720px, 100vw)', background: '#fff',
          zIndex: 9001, boxShadow: '-12px 0 40px rgba(15,23,42,0.20)',
          display: 'flex', flexDirection: 'column',
          fontFamily: 'Outfit, sans-serif',
          animation: 'cpd-slide-in 220ms ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '18px 22px 14px', borderBottom: '1px solid rgba(209,196,240,0.45)',
          background: 'linear-gradient(180deg,#7C3AED,#5B21B6)', color: '#fff',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.10em' }}>
                Caller page
              </div>
              <div style={{ fontSize: '1.20rem', fontWeight: 800, marginTop: 2 }}>
                {callerName || `Caller #${callerId}`}
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" style={{
              width: 34, height: 34, borderRadius: 10, border: 'none',
              background: 'rgba(255,255,255,0.18)', color: '#fff',
              cursor: 'pointer', display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: '1.10rem', fontWeight: 800,
            }}>×</button>
          </div>
        </div>

        {/* Tab strip */}
        <div style={{
          display: 'flex', gap: 4, padding: '12px 16px 0',
          borderBottom: '1px solid rgba(209,196,240,0.45)',
          background: '#FAF7FF',
        }}>
          {Object.entries(TAB_LABELS).map(([key, label]) => {
            const active = tab === key;
            const count = grouped[key]?.length || 0;
            return (
              <button key={key} type="button" onClick={() => setTab(key)} style={{
                padding: '8px 14px', borderRadius: 8, border: 'none',
                background: active ? '#5B21B6' : 'transparent',
                color:      active ? '#fff'    : 'rgba(91,33,182,0.65)',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                {label}
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 22, height: 18, padding: '0 6px', borderRadius: 999,
                  background: active ? 'rgba(255,255,255,0.20)' : 'rgba(91,33,182,0.10)',
                  color: active ? '#fff' : 'rgba(91,33,182,0.75)',
                  fontSize: '0.70rem', fontWeight: 800,
                }}>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Filter bar — works on every tab. Search narrows by
            name/phone/email; chips narrow by sugar level + lead tag.
            All three combine with AND. */}
        <div style={{
          padding: '10px 16px', borderBottom: '1px solid rgba(209,196,240,0.45)',
          background: '#fff', display: 'flex', alignItems: 'center',
          gap: 10, flexWrap: 'wrap',
        }}>
          {/* Search input */}
          <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 200 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="rgba(91,33,182,0.45)" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }}>
              <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name / phone / email"
              style={{
                width: '100%', height: 32, padding: '0 32px 0 30px',
                borderRadius: 8, border: '1px solid rgba(139,92,246,0.25)',
                background: '#fff', fontFamily: 'Outfit, sans-serif',
                fontSize: '0.82rem', color: '#3B0764', outline: 'none',
              }}
            />
            {search && (
              <button type="button" onClick={() => setSearch('')}
                aria-label="Clear search"
                style={{
                  position: 'absolute', right: 6, top: '50%',
                  transform: 'translateY(-50%)',
                  width: 22, height: 22, borderRadius: 6, border: 'none',
                  background: 'transparent', color: 'rgba(91,33,182,0.55)',
                  cursor: 'pointer', fontSize: '1.05rem', fontWeight: 700,
                }}>×</button>
            )}
          </div>

          {/* Sugar level pills */}
          <Chips label="Sugar"
            options={[
              { v: 'all',     l: 'All'    },
              { v: '150-250', l: '150–250'},
              { v: '250+',    l: '250+'   },
            ]}
            value={sugarF} onChange={setSugarF}
          />

          {/* Lead tag — MULTI-SELECT. Click "All" to clear; click each
              pill to toggle it in/out of the active filter set. Includes
              a "2nd Call" pseudo-tag that matches leads with
              last_note_outcome='follow_up' (scheduled for a second call). */}
          <MultiChips
            label="Tag"
            options={[
              { v: 'HOT',      l: 'HOT'      },
              { v: 'WARM',     l: 'WARM'     },
              { v: 'COLD',     l: 'COLD'     },
              { v: 'JUNK',     l: 'JUNK'     },
              { v: '2ND_CALL', l: '2nd Call' },
            ]}
            valueSet={tagSet}
            onToggle={toggleTag}
            onClearAll={() => setTagSet(new Set())}
          />

          {isFiltered && (
            <button type="button"
              onClick={() => { setSearch(''); setSugarF('all'); setTagSet(new Set()); }}
              style={{
                height: 26, padding: '0 10px', borderRadius: 6, border: 'none',
                background: 'rgba(220,38,38,0.10)', color: '#B91C1C',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.72rem',
                cursor: 'pointer',
              }}>
              Clear filters
            </button>
          )}
        </div>

        {/* Reopen action bar — only meaningful on the Completed tab */}
        {tab === 'completed' && (
          <div style={{
            padding: '10px 16px', borderBottom: '1px solid rgba(209,196,240,0.45)',
            background: '#fff', display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.80rem', color: '#3B0764', fontWeight: 600, cursor: 'pointer' }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={visible.length === 0}
                style={{ width: 14, height: 14, accentColor: '#5B21B6', cursor: 'pointer' }} />
              Select all ({visible.length})
            </label>
            <span style={{ flex: 1, fontSize: '0.75rem', color: 'rgba(91,33,182,0.55)' }}>
              {selected.size > 0
                ? `${selected.size} selected — will be moved back to Assigned and re-pinned.`
                : 'Pick the completed leads to send back to Assigned.'}
            </span>
            <button type="button" onClick={handleReopen} disabled={selected.size === 0 || busy} style={{
              height: 32, padding: '0 14px', borderRadius: 8, border: 'none',
              background: (selected.size === 0 || busy) ? 'rgba(91,33,182,0.25)' : '#5B21B6',
              color: '#fff', fontFamily: 'Outfit, sans-serif',
              fontWeight: 700, fontSize: '0.80rem',
              cursor: (selected.size === 0 || busy) ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}>
              {busy ? 'Moving…' : `Move to Assigned${selected.size ? ` (${selected.size})` : ''}`}
            </button>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.88rem' }}>
              Loading leads…
            </div>
          ) : error ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#DC2626', fontSize: '0.88rem' }}>
              {error}
            </div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.88rem' }}>
              {isFiltered
                ? 'No leads match the current filters.'
                : 'No leads in this bucket.'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  {tab === 'completed' && <th style={thStyle}> </th>}
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>Sugar</th>
                  <th style={thStyle}>Tag</th>
                  <th style={thStyle}>Outcome</th>
                  <th style={thStyle}>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(l => {
                  const tag = TAG_PILL[l.lead_tag] || null;
                  return (
                    <tr key={l.id} className="cpd-row"
                      style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
                      {tab === 'completed' && (
                        <td style={tdStyle}>
                          <input type="checkbox" checked={selected.has(l.id)}
                            onChange={() => toggleOne(l.id)}
                            style={{ width: 14, height: 14, accentColor: '#5B21B6', cursor: 'pointer' }} />
                        </td>
                      )}
                      <td style={{ ...tdStyle, fontWeight: 700, color: '#3B0764' }}>{l.full_name}</td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', color: '#6B7280' }}>
                        +91 {l.whatsapp_number}
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                          fontSize: '0.72rem', fontWeight: 700,
                          background: l.sugar_level === '250+' ? '#FEE2E2' : '#FEF3C7',
                          color:      l.sugar_level === '250+' ? '#B91C1C' : '#A16207',
                        }}>{l.sugar_level}</span>
                      </td>
                      <td style={tdStyle}>
                        {tag ? (
                          <span style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                            fontSize: '0.72rem', fontWeight: 700,
                            background: tag.bg, color: tag.fg,
                          }}>{l.lead_tag}</span>
                        ) : <span style={{ color: '#D1D5DB' }}>—</span>}
                      </td>
                      <td style={{ ...tdStyle, fontSize: '0.78rem', color: '#6B7280' }}>
                        {OUTCOME_LABELS[l.last_note_outcome] || '—'}
                      </td>
                      <td style={{ ...tdStyle, fontSize: '0.74rem', color: '#9CA3AF', whiteSpace: 'nowrap' }}>
                        {fmtDate(l.last_note_at || l.assigned_at || l.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Inline toast — pops above the action bar for ~2.5s */}
        {toast && (
          <div style={{
            position: 'absolute', bottom: 14, left: 14, right: 14,
            padding: '10px 14px', borderRadius: 10, background: '#5B21B6',
            color: '#fff', fontSize: '0.82rem', fontWeight: 600,
            boxShadow: '0 12px 32px rgba(91,33,182,0.30)',
            textAlign: 'center',
          }}>{toast}</div>
        )}
      </div>
    </>
  );
}

const thStyle = {
  padding: '10px 14px',
  fontSize: '0.70rem', fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'rgba(91,33,182,0.60)', whiteSpace: 'nowrap',
};
const tdStyle = {
  padding: '10px 14px', fontSize: '0.84rem', color: '#3B0764',
  verticalAlign: 'middle',
};

/* Multi-select pill row — label + a leading "All" pill that clears
   the selection, followed by toggleable option pills. Active pills get
   the filled-violet treatment; inactive pills get the soft-lavender
   one. Used for the Tag filter where admins want to combine HOT +
   WARM (or any other combination) at once. */
function MultiChips({ label, options, valueSet, onToggle, onClearAll }) {
  const noneSelected = valueSet.size === 0;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{
        fontSize: '0.70rem', fontWeight: 700,
        color: 'rgba(91,33,182,0.55)',
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        {label}
      </span>
      <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
        {/* Leading "All" pill — active only when nothing else is */}
        <button type="button" onClick={onClearAll} style={{
          height: 26, padding: '0 10px', borderRadius: 6, border: 'none',
          background: noneSelected ? '#5B21B6' : 'rgba(237,234,248,0.60)',
          color:      noneSelected ? '#fff'    : 'rgba(91,33,182,0.70)',
          fontFamily: 'Outfit, sans-serif', fontWeight: 700,
          fontSize: '0.72rem', cursor: 'pointer', whiteSpace: 'nowrap',
        }}>All</button>
        {options.map(o => {
          const active = valueSet.has(o.v);
          return (
            <button key={o.v} type="button" onClick={() => onToggle(o.v)} style={{
              height: 26, padding: '0 10px', borderRadius: 6, border: 'none',
              background: active ? '#5B21B6' : 'rgba(237,234,248,0.60)',
              color:      active ? '#fff'    : 'rgba(91,33,182,0.70)',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700,
              fontSize: '0.72rem', cursor: 'pointer', whiteSpace: 'nowrap',
            }}>{o.l}</button>
          );
        })}
      </div>
    </div>
  );
}

/* Tiny chip-row helper (single-select). Renders a label + pill group;
   clicking a pill sets the value via onChange. Used by the filter bar
   for filters that only support one value at a time (sugar level). */
function Chips({ label, options, value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{
        fontSize: '0.70rem', fontWeight: 700,
        color: 'rgba(91,33,182,0.55)',
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        {label}
      </span>
      <div style={{ display: 'inline-flex', gap: 4 }}>
        {options.map(o => {
          const active = value === o.v;
          return (
            <button key={o.v} type="button" onClick={() => onChange(o.v)} style={{
              height: 26, padding: '0 10px', borderRadius: 6, border: 'none',
              background: active ? '#5B21B6' : 'rgba(237,234,248,0.60)',
              color:      active ? '#fff'    : 'rgba(91,33,182,0.70)',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700,
              fontSize: '0.72rem', cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}>{o.l}</button>
          );
        })}
      </div>
    </div>
  );
}
