import { useState, useEffect, useCallback, useRef } from 'react';
import CallerLeadsTable from '../components/CallerLeadsTable';
import SourceBadge from '../components/SourceBadge';

/* ──────────────────────────────────────────────────────────────────────────
   Next Batch — leads the caller parked by answering Q14 "Next Batch Joining"
   with Yes. They stay here until admin starts a new batch (updates
   next_webinar_at in Timer & Controls), at which point the backend flips
   next_batch_parked=false and adds them back to Assigned as follow-ups.
   The list refreshes via SSE the moment that happens.
   ────────────────────────────────────────────────────────────────────────── */

const SUGAR_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
    });
  } catch { return '—'; }
}

function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60)      return 'just now';
  if (secs < 3600)    return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)   return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function NextBatchModule({ jwt, onCount, previewMode = false }) {
  const [leads, setLeads]     = useState([]);
  // Bubble the count up to CallerShell for the header chip.
  useEffect(() => { if (typeof onCount === 'function') onCount(leads.length); }, [leads.length, onCount]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const sseRef = useRef(null);

  const fetchLeads = useCallback(async () => {
    if (!jwt) { setLeads([]); setLoading(false); setError(''); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/caller/leads/next-batch', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) throw new Error('Failed to load Next-Batch leads.');
      const data = await res.json();
      setLeads(data.leads || []);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // SSE — refresh on note saves (a Q14=Yes adds a row here) and on
  // lead.assigned with promoted_from=next_batch (admin started a new
  // batch → rows leave this page).
  useEffect(() => {
    if (!jwt || previewMode) return;   // preview: no live stream (read-only)
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwt)}`;
    const es  = new EventSource(url);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'lead.note_saved') fetchLeads();
        if (msg?.type === 'lead.assigned')   fetchLeads();
      } catch (_) { /* ignore parse errors */ }
    };
    return () => { es.close(); sseRef.current = null; };
  }, [jwt, fetchLeads]);

  const filtered = leads.filter(l => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const blob = `${l.full_name || ''} ${l.email || ''} ${l.whatsapp_number || ''}`.toLowerCase();
    return blob.includes(q);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Info banner */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 16, display: 'flex', alignItems: 'flex-start', gap: 12, fontFamily: 'Outfit, sans-serif' }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          background: 'rgba(91,33,182,0.10)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.92rem', marginBottom: 2 }}>
            {leads.length} lead{leads.length === 1 ? '' : 's'} waiting for the next batch
          </div>
          <div style={{ color: 'rgba(91,33,182,0.65)', fontSize: '0.80rem', lineHeight: 1.45 }}>
            These leads said <strong>Yes</strong> to "Joining next batch". They'll appear at the top of your <strong>Assigned Leads</strong> as follow-ups the moment admin schedules a new batch in Timer &amp; Controls.
          </div>
        </div>
      </div>

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
            placeholder="Search Next-Batch leads…"
            style={{
              width: '100%', height: '2.4rem', padding: '0 12px 0 34px', borderRadius: 10,
              border: '1px solid rgba(209,196,240,0.7)', background: 'rgba(237,234,248,0.30)',
              fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764',
              outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Loading Next-Batch leads…</Empty>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
            <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 16, background: 'rgba(91,33,182,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            </div>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>
              {leads.length === 0 ? 'No Next-Batch leads yet' : 'No matches'}
            </div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem', maxWidth: 360, margin: '0 auto' }}>
              {leads.length === 0
                ? <>When you save a call note with <strong>Q14 = Yes</strong>, the lead is parked here automatically.</>
                : 'Try a different search.'}
            </div>
          </div>
        ) : (
          <CallerLeadsTable leads={filtered} emptyText="No Next-Batch leads." />
        )}
      </div>
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem', color: 'rgba(91,33,182,0.55)' }}>
      {children}
    </div>
  );
}
