import { useState, useEffect, useCallback, useRef } from 'react';
import LeadCallNoteModal from './LeadCallNoteModal';
import CallerLeadsTable from '../components/CallerLeadsTable';
import SourceBadge from '../components/SourceBadge';

/* ──────────────────────────────────────────────────────────────────────────
   Untouched Leads — leads still assigned to this caller but tied to an OLDER
   webinar (older than the current + previous webinar). They drop off the
   Assigned queue so the caller focuses on the latest two webinars, but stay
   fully callable here: click "Call" → the same LeadCallNoteModal flow as
   Assigned. Once a lead gets a note it leaves this list.
   Backed by GET /api/caller/leads/untouched.
   ────────────────────────────────────────────────────────────────────────── */

const SUGAR_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}

function fmtPhone(num) {
  if (!num) return '—';
  return `+91 ${num}`;
}

export default function UntouchedLeadsModule({ jwt, onCount, previewMode = false }) {
  const [leads, setLeads]       = useState([]);
  // Bubble the count up to CallerShell for the header chip.
  useEffect(() => { if (typeof onCount === 'function') onCount(leads.length); }, [leads.length, onCount]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [editLead, setEditLead] = useState(null);  // lead whose call modal is open
  const sseRef = useRef(null);

  const fetchLeads = useCallback(async () => {
    if (!jwt) { setLeads([]); setLoading(false); setError(''); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/caller/leads/untouched', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) throw new Error('Failed to load untouched leads.');
      const data = await res.json();
      setLeads(data.leads || []);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  /* SSE — refresh when this caller saves a note (a saved note moves the lead
     out of the untouched bucket) or gets a new assignment. */
  useEffect(() => {
    if (!jwt || previewMode) return;   // preview: no live stream (read-only)
    const es = new EventSource(`/api/caller/leads/events?token=${encodeURIComponent(jwt)}`);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'lead.note_saved' || msg?.type === 'lead.assigned') fetchLeads();
      } catch (_) {}
    };
    return () => { es.close(); sseRef.current = null; };
  }, [jwt, fetchLeads]);

  /* Trigger a Tata call then open the note modal — mirrors AssignedLeadsModule's
     triggerCallAndOpen. The modal reflects the in-flight call straight away via
     last_call_id. A failed call still opens the modal (idle) so the caller can
     retry from inside it. */
  async function handleCall(lead) {
    if (previewMode) return;   // admin preview is read-only — no real calls
    setError('');
    try {
      const res = await fetch('/api/caller/calls/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to start call');
      setEditLead({ ...lead, last_call_id: data?.call_id || null });
    } catch (e) {
      setError(e.message || 'Call failed');
      setEditLead({ ...lead, last_call_id: null });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', fontFamily: 'Outfit,sans-serif', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>
            Loading…
          </div>
        ) : leads.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
            <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 16, background: 'rgba(245,197,24,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#A16207" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>No untouched leads</div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem', maxWidth: 400, margin: '0 auto' }}>
              Leads from older webinars (older than the current + previous webinar) land here.
              You can still call them — they just don't clutter your Assigned queue.
            </div>
          </div>
        ) : (
          <CallerLeadsTable
            leads={leads}
            onRowClick={previewMode ? undefined : (l) => setEditLead({ ...l, last_call_id: null })}
          />
        )}
      </div>

      {editLead && (
        <LeadCallNoteModal
          key={editLead.id}
          jwt={jwt}
          lead={editLead}
          onClose={() => setEditLead(null)}
          onSaved={() => {
            // A saved note moves the lead out of the untouched bucket — drop it
            // from the local list immediately, then refetch to be safe.
            const finishedId = editLead.id;
            setEditLead(null);
            setLeads(prev => prev.filter(x => x.id !== finishedId));
            fetchLeads();
          }}
        />
      )}
    </div>
  );
}

function Th({ children }) {
  return (
    <th style={{
      padding: '12px 16px', fontSize: '0.72rem', fontWeight: 700,
      letterSpacing: '0.04em', textTransform: 'uppercase',
      color: 'rgba(91,33,182,0.55)',
    }}>{children}</th>
  );
}
function Td({ children, mono, bold, muted }) {
  return (
    <td style={{
      padding: '12px 16px',
      fontSize: mono ? '0.80rem' : muted ? '0.78rem' : '0.86rem',
      fontFamily: mono ? 'ui-monospace, monospace' : 'Outfit,sans-serif',
      color: muted ? 'rgba(91,33,182,0.65)' : '#3B0764',
      fontWeight: bold ? 600 : 'inherit',
    }}>{children}</td>
  );
}
