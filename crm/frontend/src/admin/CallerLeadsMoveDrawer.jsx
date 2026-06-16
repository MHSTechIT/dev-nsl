import { useEffect, useMemo, useState } from 'react';
import { PreviewSelectionContext } from '../components/PreviewSelectionContext';
import BrandSelect from '../components/BrandSelect';
import AssignedLeadsModule  from '../modules/AssignedLeadsModule';
import UntouchedLeadsModule from '../modules/UntouchedLeadsModule';
import CompletedLeadsModule from '../modules/CompletedLeadsModule';
import NotPickedLeadsModule from '../modules/NotPickedLeadsModule';
import MissedCallsModule    from '../modules/MissedCallsModule';
import NextBatchModule      from '../modules/NextBatchModule';

/* CallerLeadsMoveDrawer — read-only preview of a caller's EXACT login pages.
   The admin opens a caller (from the New Page list) and sees the same UI that
   caller sees: Assigned / Untouched / Completed / Not Picked / Missed Calls /
   Next Batch — minus the Call page (telephony, excluded from preview). Rendered
   via a short-lived read-only "preview" caller token; every write/call is
   blocked server-side (see routes/caller.js), so a preview can never touch the
   caller's live session. */

const VIOLET = '#5B21B6';

const CALLER_PAGES = [
  { id: 'assigned',     label: 'Assigned Leads',  Comp: AssignedLeadsModule  },
  { id: 'untouched',    label: 'Untouched',       Comp: UntouchedLeadsModule },
  { id: 'completed',    label: 'Completed Leads', Comp: CompletedLeadsModule },
  { id: 'not_picked',   label: 'Not Picked',      Comp: NotPickedLeadsModule },
  { id: 'missed_calls', label: 'Missed Calls',    Comp: MissedCallsModule    },
  { id: 'next_batch',   label: 'Next Batch',      Comp: NextBatchModule      },
];

// Buckets a selection can be moved INTO. "Missed Calls" aren't leads, so that's
// excluded. "Untouched" resets the lead to a fresh, no-outcome state (it lands
// in Untouched when on a past webinar, else Assigned).
const MOVE_TARGETS = [
  { id: 'assigned',   label: 'Assigned'   },
  { id: 'completed',  label: 'Completed'  },
  { id: 'not_picked', label: 'Not Picked' },
  { id: 'next_batch', label: 'Next Batch' },
  { id: 'untouched',  label: 'Untouched'  },
];

export default function CallerLeadsMoveDrawer({ token, caller, callers = [], onClose, onAfterMove }) {
  const callerId   = caller?.caller_id;
  const callerName = caller?.name || '';

  const [pageTab, setPageTab]       = useState('assigned');
  const [previewJwt, setPreviewJwt] = useState('');
  const [previewErr, setPreviewErr] = useState('');

  // Admin selection (preview-only) — drives the checkbox column + the move bar.
  const [selected, setSelected]     = useState(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [moving, setMoving]         = useState(false);
  const [moveErr, setMoveErr]       = useState('');
  const [toCaller, setToCaller]     = useState('');

  // Webinar-batch filter (header). Built from EVERY lead this caller owns, so
  // the dropdown lists all batches their leads belong to across all pages.
  const [webinarFilter, setWebinarFilter] = useState('');     // '' = all batches
  const [callerWebinars, setCallerWebinars] = useState([]);   // [{ id, name }]

  const auth = { Authorization: `Bearer ${token}` };

  const selectPage = (id) => { setPageTab(id); setSelected(new Set()); setToCaller(''); setMoveErr(''); };
  const toggle = (id) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = (ids) => setSelected((p) => {
    const allOn = ids.length > 0 && ids.every((i) => p.has(i));
    const n = new Set(p);
    if (allOn) ids.forEach((i) => n.delete(i)); else ids.forEach((i) => n.add(i));
    return n;
  });
  const selectionCtx = useMemo(() => ({ selectable: true, selectedIds: selected, toggle, toggleAll, webinarFilter }), [selected, webinarFilter]);
  const otherCallers = (callers || []).filter((c) => c.caller_id !== callerId);

  async function doMove(payload) {
    if (!selected.size || moving) return;
    setMoving(true); setMoveErr('');
    try {
      const res = await fetch('/api/admin/leads/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ lead_ids: [...selected], ...payload }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || 'Move failed.');
      setSelected(new Set()); setToCaller('');
      setRefreshKey((k) => k + 1);   // remount the preview module → refetch its leads
      onAfterMove && onAfterMove();
    } catch (e) { setMoveErr(e.message || 'Move failed.'); }
    finally { setMoving(false); }
  }

  /* Mint a read-only preview caller token so the embedded caller modules can
     authenticate as this caller for GET reads (all writes blocked server-side).
     Re-fetched whenever the caller changes. */
  useEffect(() => {
    if (!token || !callerId) return undefined;
    let alive = true;
    setPreviewJwt(''); setPreviewErr('');
    fetch(`/api/admin/callers/${callerId}/preview-token?writable=true`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => { if (!alive) return; if (d.token) setPreviewJwt(d.token); else setPreviewErr(d.error || 'Could not open caller view.'); })
      .catch(() => { if (alive) setPreviewErr('Could not open caller view.'); });
    return () => { alive = false; };
  }, [token, callerId]);

  /* Distinct webinar batches across ALL of this caller's leads → header filter.
     Re-fetched after a move (refreshKey) so the list stays accurate. */
  useEffect(() => {
    if (!token || !callerId) return undefined;
    let alive = true;
    fetch(`/api/admin/caller-leads/${callerId}`, { headers: auth })
      .then(r => r.json())
      .then(d => {
        if (!alive) return;
        const seen = new Map();
        for (const l of (d.leads || [])) {
          if (l.webinar_id && !seen.has(l.webinar_id)) seen.set(l.webinar_id, l.webinar_name || `Batch ${l.webinar_id}`);
        }
        setCallerWebinars([...seen].map(([id, name]) => ({ id: String(id), name })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [token, callerId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const Active = CALLER_PAGES.find((p) => p.id === pageTab)?.Comp;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(30,8,60,0.45)', zIndex: 80 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(940px, 96vw)', background: '#fff', zIndex: 81, display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 40px rgba(30,8,60,0.3)' }}>
        {/* header */}
        <div style={{ background: `linear-gradient(120deg, ${VIOLET}, #7C3AED)`, color: '#fff', padding: '16px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.12em', opacity: 0.85 }}>
              CALLER PAGE · PREVIEW (READ-ONLY)
            </div>
            <div style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '1.5rem', marginTop: 2 }}>{callerName}</div>
          </div>

          {/* Webinar-batch filter — all batches this caller's leads belong to */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.66rem', letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.8 }}>Webinar</span>
            <div style={{ width: 200 }}>
              <BrandSelect
                value={webinarFilter}
                onChange={setWebinarFilter}
                placeholder="All batches"
                options={[
                  { value: '', label: 'All batches' },
                  ...callerWebinars.map((w) => ({ value: w.id, label: (w.name || '').replace(/^AWS-/, 'AWS - ') })),
                ]}
              />
            </div>
          </div>

          <button onClick={onClose} style={{ border: 'none', background: 'rgba(255,255,255,0.18)', color: '#fff', width: 40, height: 40, borderRadius: 12, cursor: 'pointer', fontSize: '1.1rem', fontWeight: 800, flexShrink: 0 }}>✕</button>
        </div>

        {/* the caller's exact login pages (Call excluded), rendered read-only */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* page tabs — same set & order as CallerShell, minus Call */}
          <div style={{ display: 'flex', gap: 6, padding: '12px 18px 0', flexWrap: 'wrap' }}>
            {CALLER_PAGES.map((p) => (
              <button key={p.id} onClick={() => selectPage(p.id)} style={tabBtn(pageTab === p.id)}>{p.label}</button>
            ))}
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px 18px', minHeight: 0, background: '#F6F3FC' }}>
            {previewErr ? (
              <div style={{ color: '#B91C1C', fontFamily: 'Outfit, sans-serif', padding: 16 }}>{previewErr}</div>
            ) : !previewJwt ? (
              <div style={{ color: 'rgba(91,33,182,0.5)', fontFamily: 'Outfit, sans-serif', padding: 16 }}>Opening caller view…</div>
            ) : Active ? (
              <PreviewSelectionContext.Provider value={selectionCtx}>
                <Active
                  key={`${callerId}:${pageTab}:${refreshKey}`}
                  jwt={previewJwt}
                  previewMode
                  isActive={false}
                  onCount={() => {}}
                  setMood={() => {}}
                  pendingAutoStart={false}
                  clearPendingAutoStart={() => {}}
                  externalHighlightId={null}
                />
              </PreviewSelectionContext.Provider>
            ) : null}
          </div>
        </div>

        {/* move action bar — admin-only, appears when leads are selected */}
        {selected.size > 0 && (
          <div style={{ borderTop: '1px solid rgba(124,58,237,0.2)', background: '#FAF7FF', padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 800, color: VIOLET, fontSize: '0.9rem' }}>{selected.size} selected</span>
            {moveErr && <span style={{ color: '#B91C1C', fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif' }}>{moveErr}</span>}

            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.6)' }}>Move to page:</span>
            {MOVE_TARGETS.filter((b) => b.id !== pageTab).map((b) => (
              <button key={b.id} disabled={moving} onClick={() => doMove({ target_bucket: b.id })} style={pageBtn}>{b.label}</button>
            ))}

            <span style={{ width: 1, height: 22, background: 'rgba(124,58,237,0.2)' }} />

            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.6)' }}>Move to caller:</span>
            <div style={{ width: 190 }}>
              <BrandSelect
                value={toCaller}
                onChange={setToCaller}
                placeholder="Select caller…"
                searchable
                searchPlaceholder="Search callers…"
                options={otherCallers.map((c) => ({ value: c.caller_id, label: c.name }))}
              />
            </div>
            <button disabled={moving || !toCaller} onClick={() => doMove({ target_caller_id: toCaller })}
              style={{ ...pageBtn, background: VIOLET, color: '#fff', border: 'none', opacity: (moving || !toCaller) ? 0.5 : 1 }}>
              {moving ? 'Moving…' : 'Move'}
            </button>

            <div style={{ flex: 1 }} />
            <button onClick={() => setSelected(new Set())} style={{ ...pageBtn, border: 'none', color: 'rgba(91,33,182,0.6)' }}>Clear</button>
          </div>
        )}
      </div>
    </>
  );
}

const tabBtn = (active) => ({ border: 'none', cursor: 'pointer', borderRadius: 10, padding: '8px 14px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.84rem', background: active ? VIOLET : '#F3F0FD', color: active ? '#fff' : 'rgba(91,33,182,0.7)' });
const pageBtn = { border: '1px solid rgba(124,58,237,0.35)', background: '#fff', color: VIOLET, borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.8rem' };
