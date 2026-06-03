import { useState, useEffect, useCallback } from 'react';
import NsmManualAssignModal from './NsmManualAssignModal';

/* NSM-Caller › Marketing › Leads
   ------------------------------
   Reads leads synced from Meta (utils/nsmLeadsSync.js → nsm_leads) and shows
   every batch's leads in one table with a batch filter + search. Columns are
   derived dynamically from each form's field_data, so it shows all the
   information captured on the Meta lead form. "Sync from Meta" pulls fresh.

   Backend:
     GET  /api/admin/nsm/batches            (for the filter + names)
     GET  /api/admin/nsm/leads[?batch_id=]  -> { leads, columns, total }
     POST /api/admin/nsm/sync               -> pull from Meta into nsm_leads
*/

const PURPLE = '#5B21B6';
const MAX_RENDER = 500;

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/* IVR per-campaign call-status pill. No row for a (lead,campaign) = not triggered yet. */
function IvrStatus({ status }) {
  const map = {
    called:  { t: 'Triggered', c: '#15803D', bg: 'rgba(22,163,74,0.12)' },
    failed:  { t: 'Failed',    c: '#DC2626', bg: 'rgba(220,38,38,0.10)' },
    pending: { t: 'Dialing…',  c: '#B45309', bg: 'rgba(245,158,11,0.14)' },
  };
  const s = map[status];
  if (!s) return <span style={{ color: 'rgba(91,33,182,0.35)', fontWeight: 600 }}>— Not yet</span>;
  return (
    <span style={{ display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: '0.72rem', fontWeight: 700, color: s.c, background: s.bg, whiteSpace: 'nowrap' }}>
      {s.t}
    </span>
  );
}

/* Compact themed dropdown for the batch filter. */
function BatchFilter({ batches, value, onChange }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const current = value === 'all' ? 'All batches' : (batches.find(b => b.id === value)?.batch_name || 'Batch');
  const opts = [{ id: 'all', batch_name: 'All batches' }, ...batches];
  return (
    <div style={{ position: 'relative', minWidth: 200 }} onMouseDown={e => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, height: '2.4rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', fontWeight: 600, color: '#3B0764', cursor: 'pointer' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms', flexShrink: 0 }}><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      {open && (
        <div className="nsm-noscroll" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, background: '#fff', borderRadius: 10, border: '1px solid rgba(209,196,240,0.7)', boxShadow: '0 12px 32px rgba(91,33,182,0.18)', padding: 4, maxHeight: 260, overflowY: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {opts.map(o => {
            const sel = o.id === value;
            return (
              <button key={o.id} type="button" onClick={() => { onChange(o.id); setOpen(false); }}
                style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: sel ? 'rgba(91,33,182,0.10)' : 'transparent', color: sel ? PURPLE : '#3B0764', fontFamily: 'Outfit, sans-serif', fontWeight: sel ? 700 : 500, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.batch_name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function NsmLeadsPage({ token, apiBase = '/api/admin/nsm' }) {
  const [batches, setBatches] = useState([]);
  const [leads, setLeads]     = useState([]);
  const [columns, setColumns] = useState([]);
  const [campaigns, setCampaigns] = useState([]);   // IVR-only: per-campaign call status columns
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState('all');
  const [query, setQuery]     = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [dupOnly, setDupOnly]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  // Manual lead→caller assignment only applies to the caller workspace
  // (NSM-Caller, apiBase /api/admin/nsm). NSM-IVR has no callers.
  const canAssign = apiBase === '/api/admin/nsm';

  const authHeaders = { Authorization: `Bearer ${token}` };

  const loadBatches = useCallback(() => {
    fetch(`${apiBase}/batches`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error())))
      .then(d => setBatches(d.batches || []))
      .catch(() => {});
  }, [token]);

  const loadLeads = useCallback((batchId, silent = false) => {
    if (!silent) setLoading(true);
    const qs = batchId && batchId !== 'all' ? `?batch_id=${encodeURIComponent(batchId)}` : '';
    fetch(`${apiBase}/leads${qs}`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Failed to load leads'))))
      .then(d => { setLeads(d.leads || []); setColumns(d.columns || []); setCampaigns(d.campaigns || []); })
      .catch(() => { if (!silent) { setLeads([]); setColumns([]); setCampaigns([]); } })
      .finally(() => { if (!silent) setLoading(false); });
  }, [token]);

  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => { loadLeads(filter); }, [filter, loadLeads]);

  // The backend pulls fresh leads from Meta every 30s; mirror that here with a
  // silent re-read of the DB (no loading flash) so the table stays live.
  useEffect(() => {
    const t = setInterval(() => { loadLeads(filter, true); loadBatches(); }, 30000);
    return () => clearInterval(t);
  }, [filter, loadLeads, loadBatches]);

  const normPhone = p => (p || '').replace(/\D/g, '');
  const phoneCounts = {};
  for (const l of leads) { const p = normPhone(l.phone); if (p) phoneCounts[p] = (phoneCounts[p] || 0) + 1; }
  const isDup = l => { const p = normPhone(l.phone); return p && phoneCounts[p] > 1; };
  const dupCount = leads.reduce((n, l) => n + (isDup(l) ? 1 : 0), 0);

  const q = query.trim().toLowerCase();
  let filtered = q
    ? leads.filter(l => {
        const hay = [l.batch_name, l.form_name, l.full_name, l.phone, l.email, l.city,
          ...Object.values(l.field_data || {})].join(' ').toLowerCase();
        return hay.includes(q);
      })
    : leads;
  if (dupOnly) filtered = filtered.filter(isDup);
  const shown = filtered.slice(0, MAX_RENDER);

  const allShownSelected = shown.length > 0 && shown.every(l => selected.has(l.id));
  function toggleOne(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(prev => {
      const n = new Set(prev);
      if (allShownSelected) shown.forEach(l => n.delete(l.id));
      else shown.forEach(l => n.add(l.id));
      return n;
    });
  }
  function toggleDuplicates() {
    if (dupOnly) { setDupOnly(false); setSelected(new Set()); return; }
    setDupOnly(true);
    // Pre-select the redundant copies: keep the newest per phone, mark the rest.
    const seen = new Set(); const sel = new Set();
    for (const l of leads) { // leads come newest-first
      const p = normPhone(l.phone);
      if (!p || phoneCounts[p] <= 1) continue;
      if (seen.has(p)) sel.add(l.id); else seen.add(p);
    }
    setSelected(sel);
  }
  async function handleDelete() {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} lead(s)? They won't be re-synced from Meta.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`${apiBase}/leads/delete`, {
        method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] }),
      });
      if (!res.ok) throw new Error();
      setSelected(new Set()); setDupOnly(false);
      loadLeads(filter); loadBatches();
    } catch { /* ignore */ }
    finally { setDeleting(false); }
  }

  function exportCsv() {
    const head = ['Batch', 'Created', 'Form', 'Assigned', ...columns.map(c => c.label)];
    const rows = filtered.map(l => [
      l.batch_name || '', fmtDate(l.created_time), l.form_name || '', l.assigned_name || '',
      ...columns.map(c => (l.field_data || {})[c.key] ?? ''),
    ]);
    const csv = [head, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'nsm-leads.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const th = { padding: '12px 14px', textAlign: 'left', fontWeight: 700, fontSize: '0.78rem', color: '#fff', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: PURPLE };
  const td = { padding: '11px 14px', fontSize: '0.82rem', color: '#3B0764', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(139,92,246,0.08)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' };

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <style>{`.nsm-noscroll::-webkit-scrollbar{width:0;height:0;display:none}`}</style>
      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <BatchFilter batches={batches} value={filter} onChange={setFilter} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search name, phone, email, city…"
          style={{ flex: 1, minWidth: 180, height: '2.4rem', padding: '0 12px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#3B0764', outline: 'none' }}
        />
        <button type="button" onClick={toggleDuplicates} title="Show leads sharing a phone number and pre-select the extra copies"
          style={{ height: '2.4rem', padding: '0 14px', borderRadius: 10, border: dupOnly ? 'none' : '1px solid rgba(139,92,246,0.30)', background: dupOnly ? PURPLE : '#fff', color: dupOnly ? '#fff' : PURPLE, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          {dupOnly ? 'Show all' : `Duplicates${dupCount ? ` (${dupCount})` : ''}`}
        </button>
        <button type="button" onClick={handleDelete} disabled={selected.size === 0 || deleting}
          style={{ height: '2.4rem', padding: '0 16px', borderRadius: 10, border: 'none', background: selected.size ? '#DC2626' : 'rgba(220,38,38,0.30)', color: '#fff', fontWeight: 700, fontSize: '0.85rem', cursor: selected.size && !deleting ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
          {deleting ? 'Deleting…' : `Delete${selected.size ? ` (${selected.size})` : ''}`}
        </button>
        {canAssign && (
          <button type="button" onClick={() => setShowAssign(true)} title="Manually assign unassigned leads to callers"
            style={{ height: '2.4rem', padding: '0 16px', borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Manual Assign
          </button>
        )}
        <button type="button" onClick={exportCsv} disabled={filtered.length === 0}
          style={{ height: '2.4rem', padding: '0 16px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)', background: '#fff', color: PURPLE, fontWeight: 600, fontSize: '0.85rem', cursor: filtered.length ? 'pointer' : 'default', opacity: filtered.length ? 1 : 0.5 }}>
          Export CSV
        </button>
      </div>

      {showAssign && (
        <NsmManualAssignModal
          token={token}
          onClose={() => setShowAssign(false)}
          onAssigned={() => { loadLeads(filter); loadBatches(); }}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, minHeight: 18 }}>
        <span style={{ fontSize: '0.82rem', color: 'rgba(91,33,182,0.65)', fontWeight: 600 }}>
          {loading ? 'Loading…' : `${filtered.length} lead${filtered.length === 1 ? '' : 's'}${filtered.length > MAX_RENDER ? ` (showing first ${MAX_RENDER})` : ''}`}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)', fontWeight: 600 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16A34A' }} />
          Auto-updates from Meta every 30s
        </span>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', overflow: 'hidden' }}>
        {!loading && leads.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>
            No leads yet. Create a batch on the <strong>Webinar</strong> tab — matching leads sync automatically from Meta every 30s.
          </div>
        ) : (
          <div className="nsm-noscroll" style={{ overflowX: 'auto', maxHeight: '62vh', overflowY: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 700 }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 38, textAlign: 'center' }}>
                    <input type="checkbox" checked={allShownSelected} onChange={toggleAll} style={{ cursor: 'pointer' }} title="Select all shown" />
                  </th>
                  <th style={th}>Batch</th>
                  <th style={th}>Created</th>
                  <th style={th}>Form</th>
                  <th style={th}>Assigned</th>
                  {campaigns.map(c => <th key={c.id} style={{ ...th, textAlign: 'center' }} title={`IVR call: ${c.name}`}>{c.name}</th>)}
                  {columns.map(c => <th key={c.key} style={th} title={c.key}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map(l => (
                  <tr key={l.id} style={{ background: selected.has(l.id) ? 'rgba(220,38,38,0.06)' : (isDup(l) ? 'rgba(245,158,11,0.07)' : 'transparent') }}>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} style={{ cursor: 'pointer' }} />
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>{l.batch_name || '—'}</td>
                    <td style={td}>{fmtDate(l.created_time)}</td>
                    <td style={{ ...td, color: 'rgba(91,33,182,0.7)' }} title={l.form_name}>{l.form_name || '—'}</td>
                    <td style={{ ...td, fontWeight: 600, color: l.assigned_name ? '#5B21B6' : 'rgba(91,33,182,0.4)' }}>{l.assigned_name || 'Unassigned'}</td>
                    {campaigns.map(c => (
                      <td key={c.id} style={{ ...td, textAlign: 'center' }}>
                        <IvrStatus status={(l.ivr_calls || {})[c.id]} />
                      </td>
                    ))}
                    {columns.map(c => (
                      <td key={c.key} style={td} title={(l.field_data || {})[c.key] || ''}>{(l.field_data || {})[c.key] || ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
