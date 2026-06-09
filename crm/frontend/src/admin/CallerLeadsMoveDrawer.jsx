import { useEffect, useMemo, useState, useCallback } from 'react';
import AssignedLeadsModule  from '../modules/AssignedLeadsModule';
import UntouchedLeadsModule from '../modules/UntouchedLeadsModule';
import CompletedLeadsModule from '../modules/CompletedLeadsModule';
import NotPickedLeadsModule from '../modules/NotPickedLeadsModule';
import MissedCallsModule    from '../modules/MissedCallsModule';
import NextBatchModule      from '../modules/NextBatchModule';

/* The caller's real login pages, in the same order as CallerShell — minus the
   Call page (telephony, excluded from the admin preview). Rendered with a
   read-only "preview" caller token so the admin sees the EXACT caller UI. */
const CALLER_PAGES = [
  { id: 'assigned',     label: 'Assigned Leads',  Comp: AssignedLeadsModule  },
  { id: 'untouched',    label: 'Untouched',       Comp: UntouchedLeadsModule },
  { id: 'completed',    label: 'Completed Leads', Comp: CompletedLeadsModule },
  { id: 'not_picked',   label: 'Not Picked',      Comp: NotPickedLeadsModule },
  { id: 'missed_calls', label: 'Missed Calls',    Comp: MissedCallsModule    },
  { id: 'next_batch',   label: 'Next Batch',      Comp: NextBatchModule      },
];

/* CallerLeadsMoveDrawer — admin lead-mover for the New Page → "Caller page".
   Shows every lead of one caller, bucketed into the same pages the caller has
   (Assigned / Untouched / Completed / Not Picked / Next Batch), plus a read-only
   Missed Calls page. Lead tabs have a checkbox on every row; the admin selects
   leads and moves them to another page (bucket) or to another caller via
   POST /api/admin/leads/move. This ONLY edits lead data — it never touches the
   caller's actual interface. Missed Calls are inbound call records (not leads),
   so that tab is read-only. */

const VIOLET = '#5B21B6';
const INK    = '#3B0764';

// Lead buckets (have movable leads). "Untouched" is derived from webinar age, so
// you can move leads OUT of it but you can't move leads INTO it (not a settable
// state) — hence it's excluded from MOVE_TARGETS below.
const LEAD_BUCKETS = [
  { id: 'assigned',   label: 'Assigned'   },
  { id: 'untouched',  label: 'Untouched'  },
  { id: 'completed',  label: 'Completed'  },
  { id: 'not_picked', label: 'Not Picked' },
  { id: 'next_batch', label: 'Next Batch' },
];
const MOVE_TARGETS = [
  { id: 'assigned',   label: 'Assigned'   },
  { id: 'completed',  label: 'Completed'  },
  { id: 'not_picked', label: 'Not Picked' },
  { id: 'next_batch', label: 'Next Batch' },
];
/* Tag filter chips (multi-select). '2ND_CALL' is a pseudo-tag = leads worth a
   second call (follow_up scheduled, or interested = yes). Mirrors the caller's
   Completed Calls page + the original CallerPageDrawer. */
const TAGS = [
  { v: 'ALL',      l: 'All'      },
  { v: 'HOT',      l: 'HOT'      },
  { v: 'WARM',     l: 'WARM'     },
  { v: 'COLD',     l: 'COLD'     },
  { v: 'JUNK',     l: 'JUNK'     },
  { v: '2ND_CALL', l: '2nd Call' },
];

function bucketFor(l) {
  if (l.next_batch_parked) return 'next_batch';
  const o = l.last_note_outcome;
  if (o === 'completed' || o === 'not_interested' || o === 'incomplete') return 'completed';
  if (o === 'not_picked' || o === 'auto_paused') return 'not_picked';
  if (!o && l.on_recent_webinar === false) return 'untouched';
  return 'assigned';
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}
const sugarStyle = (s) => s === '250+'
  ? { bg: '#FEE2E2', fg: '#B91C1C' }
  : s === '150-250' || s === '200-250'
  ? { bg: '#FEF3C7', fg: '#B45309' }
  : { bg: '#EDE9FE', fg: '#5B21B6' };

export default function CallerLeadsMoveDrawer({ token, caller, callers = [], onClose, onAfterMove }) {
  const callerId   = caller?.caller_id;
  const callerName = caller?.name || '';

  /* View toggle: 'caller' renders the caller's EXACT login pages (read-only
     preview), 'move' is the original checkbox table for moving leads. */
  const [view, setView] = useState('caller');
  const [pageTab, setPageTab]       = useState('assigned');
  const [previewJwt, setPreviewJwt] = useState('');
  const [previewErr, setPreviewErr] = useState('');

  const [leads, setLeads]       = useState([]);
  const [missed, setMissed]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [tab, setTab]           = useState('assigned');
  const [search, setSearch]     = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [moving, setMoving]     = useState(false);
  const [toCaller, setToCaller] = useState('');
  const [webinarF, setWebinarF] = useState('all');
  const [webinars, setWebinars] = useState([]);
  const [tagSet, setTagSet]     = useState(() => new Set());

  const auth = { Authorization: `Bearer ${token}` };

  /* Mint a read-only preview caller token so the embedded caller modules can
     authenticate as this caller for GET reads (all writes are blocked server
     side — see routes/caller.js). Re-fetched whenever the caller changes. */
  useEffect(() => {
    if (!token || !callerId) return;
    let alive = true;
    setPreviewJwt(''); setPreviewErr('');
    fetch(`/api/admin/callers/${callerId}/preview-token`, { method: 'POST', headers: auth })
      .then(r => r.json())
      .then(d => { if (!alive) return; if (d.token) setPreviewJwt(d.token); else setPreviewErr(d.error || 'Could not open caller view.'); })
      .catch(() => { if (alive) setPreviewErr('Could not open caller view.'); });
    return () => { alive = false; };
  }, [token, callerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!token || !callerId) return;
    setLoading(true); setError('');
    try {
      const [lr, mr] = await Promise.all([
        fetch(`/api/admin/caller-leads/${callerId}`, { headers: auth }).then(r => r.json()),
        fetch(`/api/admin/caller-missed-calls/${callerId}`, { headers: auth }).then(r => r.json()),
      ]);
      if (lr.error) throw new Error(lr.error);
      setLeads(lr.leads || []);
      setMissed(mr.calls || []);
    } catch (e) { setError(e.message || 'Failed to load.'); }
    finally { setLoading(false); }
  }, [token, callerId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  // Webinars for the filter dropdown (once).
  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/webinars', { headers: auth })
      .then((r) => (r.ok ? r.json() : { webinars: [] }))
      .then((d) => setWebinars(d.webinars || []))
      .catch(() => {});
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTab = (id) => { setTab(id); setSelected(new Set()); };
  const toggleTag = (t) => setTagSet((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });

  const counts = useMemo(() => {
    const c = { assigned: 0, untouched: 0, completed: 0, not_picked: 0, next_batch: 0 };
    for (const l of leads) c[bucketFor(l)]++;
    return c;
  }, [leads]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => bucketFor(l) === tab).filter((l) => {
      if (webinarF !== 'all' && String(l.webinar_id || '') !== webinarF) return false;
      // Tag filter only applies on the Completed tab (tags are set after a call).
      if (tab === 'completed' && tagSet.size > 0) {
        const tagMatch = l.lead_tag && tagSet.has(l.lead_tag);
        const isSecondCall = tagSet.has('2ND_CALL') && (l.last_note_outcome === 'follow_up' || l.last_note_interested === 'yes');
        if (!tagMatch && !isSecondCall) return false;
      }
      if (!q) return true;
      return (l.full_name || '').toLowerCase().includes(q)
        || (l.whatsapp_number || '').includes(q)
        || (l.email || '').toLowerCase().includes(q);
    });
  }, [leads, tab, search, webinarF, tagSet]);

  const isMissedTab = tab === 'missed';
  const allChecked = rows.length > 0 && rows.every((l) => selected.has(l.id));
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allChecked) rows.forEach((l) => next.delete(l.id));
    else rows.forEach((l) => next.add(l.id));
    return next;
  });
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  async function doMove(payload) {
    if (!selected.size || moving) return;
    setMoving(true); setError('');
    try {
      const res = await fetch('/api/admin/leads/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ lead_ids: [...selected], ...payload }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || 'Move failed.');
      setSelected(new Set()); setToCaller('');
      await load();
      onAfterMove && onAfterMove();
    } catch (e) { setError(e.message || 'Move failed.'); }
    finally { setMoving(false); }
  }

  const otherCallers = callers.filter((c) => c.caller_id !== callerId);
  const missedFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? missed.filter((m) => (m.full_name || '').toLowerCase().includes(q) || (m.phone || '').includes(q)) : missed;
  }, [missed, search]);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(30,8,60,0.45)', zIndex: 80 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(940px, 96vw)', background: '#fff', zIndex: 81, display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 40px rgba(30,8,60,0.3)' }}>
        {/* header */}
        <div style={{ background: `linear-gradient(120deg, ${VIOLET}, #7C3AED)`, color: '#fff', padding: '16px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.12em', opacity: 0.85 }}>
              {view === 'caller' ? 'CALLER PAGE · PREVIEW (READ-ONLY)' : 'CALLER PAGE · MOVE LEADS'}
            </div>
            <div style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '1.5rem', marginTop: 2 }}>{callerName}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* View toggle: exact caller UI (preview) vs the move-leads table */}
            <div style={{ display: 'inline-flex', background: 'rgba(255,255,255,0.16)', borderRadius: 10, padding: 3 }}>
              {[{ v: 'caller', l: 'Caller view' }, { v: 'move', l: 'Move leads' }].map((o) => (
                <button key={o.v} onClick={() => setView(o.v)}
                  style={{ border: 'none', cursor: 'pointer', borderRadius: 8, padding: '7px 14px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.8rem',
                    background: view === o.v ? '#fff' : 'transparent', color: view === o.v ? VIOLET : '#fff' }}>
                  {o.l}
                </button>
              ))}
            </div>
            <button onClick={onClose} style={{ border: 'none', background: 'rgba(255,255,255,0.18)', color: '#fff', width: 40, height: 40, borderRadius: 12, cursor: 'pointer', fontSize: '1.1rem', fontWeight: 800 }}>✕</button>
          </div>
        </div>

        {/* ── CALLER VIEW — the caller's exact login pages (Call excluded), ──
            rendered read-only via a preview token. */}
        {view === 'caller' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* page tabs — same set & order as CallerShell, minus Call */}
            <div style={{ display: 'flex', gap: 6, padding: '12px 18px 0', flexWrap: 'wrap' }}>
              {CALLER_PAGES.map((p) => (
                <button key={p.id} onClick={() => setPageTab(p.id)} style={tabBtn(pageTab === p.id)}>{p.label}</button>
              ))}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px 18px', minHeight: 0, background: '#F6F3FC' }}>
              {previewErr ? (
                <div style={{ color: '#B91C1C', fontFamily: 'Outfit, sans-serif', padding: 16 }}>{previewErr}</div>
              ) : !previewJwt ? (
                <div style={{ color: 'rgba(91,33,182,0.5)', fontFamily: 'Outfit, sans-serif', padding: 16 }}>Opening caller view…</div>
              ) : (
                (() => {
                  const Active = CALLER_PAGES.find((p) => p.id === pageTab)?.Comp;
                  return Active ? (
                    <Active
                      key={`${callerId}:${pageTab}`}
                      jwt={previewJwt}
                      previewMode
                      isActive={false}
                      onCount={() => {}}
                      setMood={() => {}}
                      pendingAutoStart={false}
                      clearPendingAutoStart={() => {}}
                      externalHighlightId={null}
                    />
                  ) : null;
                })()
              )}
            </div>
          </div>
        )}

        {/* ── MOVE VIEW — original checkbox table for moving leads ── */}
        {view === 'move' && (<>
        {/* tabs */}
        <div style={{ display: 'flex', gap: 6, padding: '12px 18px 0', flexWrap: 'wrap' }}>
          {LEAD_BUCKETS.map((b) => (
            <button key={b.id} onClick={() => switchTab(b.id)} style={tabBtn(tab === b.id)}>
              {b.label} <span style={{ opacity: 0.8 }}>{counts[b.id]}</span>
            </button>
          ))}
          <button onClick={() => switchTab('missed')} style={tabBtn(tab === 'missed')}>
            Missed Calls <span style={{ opacity: 0.8 }}>{missed.length}</span>
          </button>
        </div>

        {/* search */}
        <div style={{ padding: '12px 18px 6px' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / phone / email"
            style={{ width: '100%', boxSizing: 'border-box', border: '1px solid rgba(124,58,237,0.25)', borderRadius: 10, padding: '9px 12px', fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: INK }} />
        </div>

        {/* WEBINAR filter on all lead tabs; TAG chips only on Completed (same as the caller's Completed Calls page) */}
        {!isMissedTab && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', padding: '0 18px 8px' }}>
            {tab === 'completed' && (
              <>
                <span style={filtLabel}>TAG</span>
                {TAGS.map((t) => {
                  const active = t.v === 'ALL' ? tagSet.size === 0 : tagSet.has(t.v);
                  return (
                    <button key={t.v} onClick={() => (t.v === 'ALL' ? setTagSet(new Set()) : toggleTag(t.v))} style={chip(active)}>{t.l}</button>
                  );
                })}
              </>
            )}
            <span style={{ flex: 1 }} />
            <span style={filtLabel}>WEBINAR</span>
            <select value={webinarF} onChange={(e) => setWebinarF(e.target.value)} style={{ border: '1px solid rgba(124,58,237,0.3)', borderRadius: 9, padding: '6px 10px', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: INK }}>
              <option value="all">All webinars</option>
              {webinars.map((w) => <option key={w.id} value={String(w.id)}>{w.name}{w.is_active ? '' : ' (inactive)'}</option>)}
            </select>
          </div>
        )}

        {/* list */}
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 18px 18px' }}>
          {error && <div style={{ color: '#B91C1C', fontFamily: 'Outfit, sans-serif', padding: 12 }}>{error}</div>}

          {isMissedTab ? (
            /* ── Missed Calls — read-only (inbound call records, not leads) ── */
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: '#F8F5FF', zIndex: 1 }}>
                  <th style={{ ...thS, textAlign: 'left' }}>Name</th>
                  <th style={thS}>Phone</th>
                  <th style={thS}>Sugar</th>
                  <th style={thS}>Status</th>
                  <th style={thS}>When</th>
                  <th style={thS}>Recording</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} style={{ ...tdS, padding: 24, color: 'rgba(91,33,182,0.5)' }}>Loading…</td></tr>
                ) : !missedFiltered.length ? (
                  <tr><td colSpan={6} style={{ ...tdS, padding: 24, color: 'rgba(91,33,182,0.5)' }}>No missed calls.</td></tr>
                ) : missedFiltered.map((m) => (
                  <tr key={m.id}>
                    <td style={{ ...tdS, textAlign: 'left', fontWeight: 700, color: m.is_known ? INK : 'rgba(91,33,182,0.55)' }}>{m.full_name}</td>
                    <td style={tdS}>{m.phone ? `+91 ${m.phone}` : '—'}</td>
                    <td style={tdS}>{m.sugar_level || '—'}</td>
                    <td style={tdS}>{m.status || '—'}</td>
                    <td style={{ ...tdS, color: 'rgba(91,33,182,0.6)', fontSize: '0.76rem' }}>{fmtDate(m.started_at)}</td>
                    <td style={tdS}>{m.recording_url ? <a href={m.recording_url} target="_blank" rel="noreferrer" style={{ color: VIOLET, fontWeight: 700 }}>▶ Play</a> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            /* ── Lead bucket — checkboxes + movable ── */
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: '#F8F5FF', zIndex: 1 }}>
                  <th style={{ ...thS, width: 36 }}><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
                  <th style={{ ...thS, textAlign: 'left' }}>Name</th>
                  <th style={thS}>Phone</th>
                  <th style={thS}>Sugar</th>
                  <th style={thS}>Tag</th>
                  <th style={thS}>Outcome</th>
                  <th style={thS}>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} style={{ ...tdS, padding: 24, color: 'rgba(91,33,182,0.5)' }}>Loading…</td></tr>
                ) : !rows.length ? (
                  <tr><td colSpan={7} style={{ ...tdS, padding: 24, color: 'rgba(91,33,182,0.5)' }}>No leads in this page.</td></tr>
                ) : rows.map((l) => {
                  const sel = selected.has(l.id);
                  const ss = sugarStyle(l.sugar_level);
                  return (
                    <tr key={l.id} onClick={() => toggleOne(l.id)} style={{ cursor: 'pointer', background: sel ? '#F3EEFE' : '#fff' }}>
                      <td style={tdS}><input type="checkbox" checked={sel} onChange={() => toggleOne(l.id)} onClick={(e) => e.stopPropagation()} /></td>
                      <td style={{ ...tdS, textAlign: 'left', fontWeight: 700, color: INK }}>{l.full_name || '—'}</td>
                      <td style={tdS}>{l.whatsapp_number ? `+91 ${l.whatsapp_number}` : '—'}</td>
                      <td style={tdS}>{l.sugar_level
                        ? <span style={{ background: ss.bg, color: ss.fg, borderRadius: 999, padding: '2px 9px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.72rem' }}>{l.sugar_level}</span>
                        : '—'}</td>
                      <td style={tdS}>{l.lead_tag || '—'}</td>
                      <td style={tdS}>{l.last_note_outcome || '—'}</td>
                      <td style={{ ...tdS, color: 'rgba(91,33,182,0.6)', fontSize: '0.76rem' }}>{fmtDate(l.last_note_at || l.assigned_at || l.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* move action bar — lead tabs only, when leads are selected */}
        {!isMissedTab && selected.size > 0 && (
          <div style={{ borderTop: '1px solid rgba(124,58,237,0.2)', background: '#FAF7FF', padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 800, color: VIOLET, fontSize: '0.9rem' }}>{selected.size} selected</span>

            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.6)' }}>Move to page:</span>
            {MOVE_TARGETS.filter((b) => b.id !== tab).map((b) => (
              <button key={b.id} disabled={moving} onClick={() => doMove({ target_bucket: b.id })} style={pageBtn}>{b.label}</button>
            ))}

            <span style={{ width: 1, height: 22, background: 'rgba(124,58,237,0.2)' }} />

            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.6)' }}>Move to caller:</span>
            <select value={toCaller} onChange={(e) => setToCaller(e.target.value)} style={{ border: '1px solid rgba(124,58,237,0.3)', borderRadius: 9, padding: '7px 10px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK }}>
              <option value="">Select caller…</option>
              {otherCallers.map((c) => <option key={c.caller_id} value={c.caller_id}>{c.name}</option>)}
            </select>
            <button disabled={moving || !toCaller} onClick={() => doMove({ target_caller_id: toCaller })}
              style={{ ...pageBtn, background: VIOLET, color: '#fff', border: 'none', opacity: (moving || !toCaller) ? 0.5 : 1 }}>
              {moving ? 'Moving…' : 'Move'}
            </button>

            <div style={{ flex: 1 }} />
            <button onClick={() => setSelected(new Set())} style={{ ...pageBtn, border: 'none', color: 'rgba(91,33,182,0.6)' }}>Clear</button>
          </div>
        )}
        </>)}
      </div>
    </>
  );
}

const tabBtn = (active) => ({ border: 'none', cursor: 'pointer', borderRadius: 10, padding: '8px 14px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.84rem', background: active ? VIOLET : '#F3F0FD', color: active ? '#fff' : 'rgba(91,33,182,0.7)' });
const thS = { padding: '9px 8px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.7rem', color: 'rgba(91,33,182,0.7)', textAlign: 'center', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(124,58,237,0.15)' };
const tdS = { padding: '9px 8px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK, textAlign: 'center', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(209,196,240,0.35)' };
const pageBtn = { border: '1px solid rgba(124,58,237,0.35)', background: '#fff', color: VIOLET, borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.8rem' };
const filtLabel = { fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.68rem', letterSpacing: '0.08em', color: 'rgba(91,33,182,0.5)' };
const chip = (active) => ({ border: 'none', cursor: 'pointer', borderRadius: 999, padding: '5px 12px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.76rem', background: active ? VIOLET : '#F0EBFB', color: active ? '#fff' : 'rgba(91,33,182,0.7)' });
