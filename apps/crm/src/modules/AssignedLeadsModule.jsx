import { useState, useEffect, useCallback, useRef } from 'react';
import LeadCallNoteModal from './LeadCallNoteModal';

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

function fmtPhone(p) {
  if (!p) return '—';
  const digits = String(p).replace(/\D/g, '');
  return digits.startsWith('91') ? '+' + digits : '+91 ' + digits;
}

export default function AssignedLeadsModule({ jwt, externalHighlightId }) {
  const [leads, setLeads]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [highlightId, setHighlight] = useState(null);
  const [editLead, setEditLead]   = useState(null);   // which lead's note modal is open
  const sseRef = useRef(null);
  const rowRefs = useRef({});

  /* Always-on auto-advance: when the modal saves a note (Complete / DNP /
     auto-DNP), wait 5 s and dial the next lead in the current list. Toast
     if no leads remain. Independent of the legacy autoMode toggle. */
  const [advanceLeft, setAdvanceLeft] = useState(0);   // 5 → 0
  const [advanceToast, setAdvanceToast] = useState('');
  const advanceTimerRef = useRef(null);
  function clearAdvanceTimer() {
    if (advanceTimerRef.current) { clearInterval(advanceTimerRef.current); advanceTimerRef.current = null; }
  }

  /* ── Auto-dial state machine ────────────────────────────────────────────
     Modes:
       'off'      — manual mode, default
       'calling'  — current lead being called + note modal open
       'cooldown' — 5-second card showing between leads
     The queue is a list of LEAD OBJECTS captured when auto-mode starts;
     each entry is processed in order. Processing one lead = trigger
     click-to-call API → open note modal → wait for "Complete Call" →
     5s cooldown → next.                                                    */
  const [autoMode, setAutoMode]         = useState('off');
  const [autoQueue, setAutoQueue]       = useState([]);
  const [autoIndex, setAutoIndex]       = useState(0);
  const [autoTotal, setAutoTotal]       = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [autoError, setAutoError]       = useState('');
  const cooldownTimerRef = useRef(null);

  async function triggerCall(lead) {
    const res = await fetch('/api/caller/calls/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      body: JSON.stringify({ lead_id: lead.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to start call');
    return data;
  }

  /* Trigger a Tata call AND open the modal with the freshly-created
     last_call_id so the modal can immediately reflect the in-flight call
     (banner = "Your first call is triggered. Please pick the call.")
     instead of sitting at the idle "Ready to start auto call." banner.

     If the call POST fails, we still open the modal — the user can retry
     via the Start Auto Call button — but with last_call_id explicitly
     null so the modal stays at idle (no stale id leaking in). */
  async function triggerCallAndOpen(lead, errorSetter) {
    try {
      const data = await triggerCall(lead);
      setEditLead({ ...lead, last_call_id: data?.call_id || null });
    } catch (e) {
      (errorSetter || setError)(e.message || 'Call failed');
      setEditLead({ ...lead, last_call_id: null });
    }
  }

  function clearCooldownTimer() {
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }

  function stopAutoMode() {
    clearCooldownTimer();
    setAutoMode('off');
    setAutoQueue([]);
    setAutoIndex(0);
    setAutoTotal(0);
    setCooldownLeft(0);
    setAutoError('');
  }

  function startAutoMode() {
    if (!leads.length) return;
    const queue = [...leads];        // snapshot of current visible list
    setAutoQueue(queue);
    setAutoIndex(0);
    setAutoTotal(queue.length);
    setAutoError('');
    setAutoMode('calling');
    const first = queue[0];
    // FRESH START: open the modal at idle so the user sees the SmartFlow
    // extension confirmation overlay (ext_check) BEFORE the first Tata call
    // gets dialed. Auto-advance flows (advanceAutoCall, onSaved auto-advance)
    // keep using triggerCallAndOpen because the user has already confirmed
    // their extension is on for this session — re-prompting on every lead
    // would break the auto flow.
    setEditLead({ ...first, last_call_id: null });
  }

  /* Called after the "Complete Call" button submits the note OR when the
     5s "skip now" button is pressed. Drops the just-finished lead from the
     queue and dials the next one (or finishes auto-mode if queue is empty). */
  function advanceAutoCall() {
    clearCooldownTimer();
    setCooldownLeft(0);
    setAutoQueue(prev => {
      const remaining = prev.slice(1);
      if (remaining.length === 0) {
        // Reached the end of the queue
        setAutoMode('off');
        setAutoIndex(0);
        setAutoTotal(0);
        return [];
      }
      const next = remaining[0];
      setAutoIndex(i => i + 1);
      setAutoMode('calling');
      setAutoError('');
      triggerCallAndOpen(next, setAutoError);
      return remaining;
    });
  }

  /* Kick off the 5-second card after Complete Call. */
  function startCooldown() {
    setCooldownLeft(5);
    setAutoMode('cooldown');
    clearCooldownTimer();
    cooldownTimerRef.current = setInterval(() => {
      setCooldownLeft(prev => {
        if (prev <= 1) {
          clearCooldownTimer();
          // Defer to next tick so React commits state first
          setTimeout(advanceAutoCall, 0);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  // Clean up timer if module unmounts mid-cooldown
  useEffect(() => () => clearCooldownTimer(), []);

  /* When the shell asks us to highlight a lead (e.g. caller clicked an
     incoming-call toast), reflect it on the row and scroll into view. */
  useEffect(() => {
    if (!externalHighlightId) return;
    setHighlight(externalHighlightId);
    const el = rowRefs.current[externalHighlightId];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const t = setTimeout(() => setHighlight(h => h === externalHighlightId ? null : h), 3000);
    return () => clearTimeout(t);
  }, [externalHighlightId]);

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
      const res = await fetch('/api/caller/leads', { headers: { Authorization: `Bearer ${jwt}` } });
      if (!res.ok) throw new Error('Failed to load leads.');
      const data = await res.json();
      setLeads(data.leads || []);
    } catch (e) {
      setError(e.message || 'Failed to load leads.');
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  /* Auto-refetch every 60s so leads with `follow_up_at` due appear at the top
     without a manual refresh. */
  useEffect(() => {
    if (!jwt) return;
    const t = setInterval(() => fetchLeads(), 60000);
    return () => clearInterval(t);
  }, [jwt, fetchLeads]);

  /* Subscribe to SSE for instant lead push */
  useEffect(() => {
    if (!jwt) return;
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwt)}`;
    const es  = new EventSource(url);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'lead.assigned' && msg.lead) {
          setLeads(prev => {
            // Skip if we already have this lead (e.g. simultaneous fetch)
            if (prev.some(l => l.id === msg.lead.id)) return prev;
            return [msg.lead, ...prev];
          });
          setHighlight(msg.lead.id);
          setTimeout(() => setHighlight(h => h === msg.lead.id ? null : h), 2500);
        } else if (msg?.type === 'call.update' && msg.call) {
          // Merge call status/recording into the matching lead row
          setLeads(prev => prev.map(l => l.id === msg.call.lead_id ? {
            ...l,
            last_call_id:            msg.call.id,
            last_call_status:        msg.call.status,
            last_call_duration:      msg.call.duration_sec,
            last_call_recording_url: msg.call.recording_url,
          } : l));
        } else if (msg?.type === 'lead.note_saved' && msg.lead_id) {
          // Lead just got a note. If completed or future-scheduled follow-up,
          // it's no longer in our Assigned scope — drop it. If past follow-up,
          // a refetch will surface it at the top.
          fetchLeads();
        }
      } catch (_) { /* ignore malformed */ }
    };
    es.onerror = () => { /* auto-reconnect handled by EventSource */ };
    return () => { es.close(); sseRef.current = null; };
  }, [jwt]);

  const filtered = leads;

  const autoActive = autoMode !== 'off';
  const currentAutoLead = autoActive && autoQueue.length ? autoQueue[0] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Auto-dial control bar */}
      <div className="bg-white rounded-card shadow-card" style={{
        padding: '12px 16px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
        fontFamily: 'Outfit, sans-serif',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: autoActive ? 'rgba(16,185,129,0.12)' : 'rgba(91,33,182,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={autoActive ? '#059669' : '#5B21B6'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '0.92rem', color: '#3B0764' }}>
              {autoActive ? 'Auto-call running' : 'Auto-call mode'}
            </div>
            <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>
              {autoActive
                ? `Lead ${Math.min(autoIndex + 1, autoTotal)} of ${autoTotal}${currentAutoLead ? ` · ${currentAutoLead.full_name || '—'}` : ''}`
                : `Calls every lead in this list back-to-back, with a 5-second pause between calls`}
            </div>
            {autoError && (
              <div style={{ fontSize: '0.72rem', color: '#DC2626', marginTop: 2 }}>⚠ {autoError}</div>
            )}
          </div>
        </div>

        {!autoActive ? (
          <button
            onClick={startAutoMode}
            disabled={!leads.length}
            style={{
              padding: '10px 18px', borderRadius: 50, border: 'none',
              background: leads.length ? '#059669' : 'rgba(5,150,105,0.40)',
              color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.85rem',
              cursor: leads.length ? 'pointer' : 'not-allowed',
              boxShadow: leads.length ? '0 4px 14px rgba(5,150,105,0.30)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start Auto-Call
          </button>
        ) : (
          <button
            onClick={stopAutoMode}
            style={{
              padding: '10px 18px', borderRadius: 50, border: 'none',
              background: '#DC2626', color: '#fff',
              fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.85rem',
              cursor: 'pointer', boxShadow: '0 4px 14px rgba(220,38,38,0.30)',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            Stop Auto-Call
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <EmptyState>Loading assigned leads…</EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={leads.length === 0 ? 'No leads assigned yet' : 'No matches'}
            subtitle="Your manager will assign leads here. Check back soon."
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>Sugar</th>
                  <th style={thStyle}>Webinar</th>
                  <th style={thStyle}>Registered</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(l => {
                  const sugar = SUGAR_BADGE[l.sugar_level] || { bg: '#F3F4F6', fg: '#4B5563' };
                  const followUpDue = l.last_note_outcome === 'follow_up'
                                   && l.follow_up_at
                                   && new Date(l.follow_up_at) <= new Date();
                  return (
                    <tr key={l.id}
                      ref={el => { if (el) rowRefs.current[l.id] = el; else delete rowRefs.current[l.id]; }}
                      style={{
                      borderTop: '1px solid rgba(209,196,240,0.30)',
                      background: followUpDue
                        ? 'rgba(245,158,11,0.06)'
                        : highlightId === l.id
                          ? 'rgba(91,33,182,0.16)'
                          : 'transparent',
                      transition: 'background 800ms ease',
                    }}>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, color: '#3B0764' }}>{l.full_name || '—'}</span>
                          {followUpDue && (
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: 50,
                              background: 'rgba(245,158,11,0.18)', color: '#B45309',
                              fontSize: '0.66rem', fontWeight: 700,
                              textTransform: 'uppercase', letterSpacing: '0.04em',
                              whiteSpace: 'nowrap',
                            }}>
                              Follow-up due
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{l.email || '—'}</div>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.80rem' }}>
                        {fmtPhone(l.whatsapp_number)}
                      </td>
                      <td style={tdStyle}>
                        <span style={badgeStyle(sugar)}>{l.sugar_level || '—'}</span>
                      </td>
                      <td style={{ ...tdStyle, fontSize: '0.82rem', color: '#3B0764', fontWeight: 600 }}>
                        {l.webinar_name || '—'}
                      </td>
                      <td style={{ ...tdStyle, fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)' }}>
                        {fmtDate(l.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editLead && (
        <LeadCallNoteModal
          // Force a fresh modal instance per lead — without this React reuses
          // the same component when editLead changes, leaking phase / refs /
          // dedup history from the previous lead's call into the new one.
          key={editLead.id}
          jwt={jwt}
          lead={editLead}
          onClose={() => {
            const wasInAuto = autoMode === 'calling';
            setEditLead(null);
            // Closing modal mid auto-call without saving = caller bailed → exit auto.
            if (wasInAuto) stopAutoMode();
          }}
          onSaved={(_outcome, meta) => {
            const finishedLead = editLead;
            setEditLead(null);
            const remaining = leads.filter(x => x.id !== finishedLead.id);
            setLeads(remaining);
            if (autoMode === 'calling') {
              // Legacy autoMode keeps its own queue
              startCooldown();
              return;
            }
            // Always-on auto-advance after any save
            if (meta?.autoAdvance) {
              if (remaining.length === 0) {
                setAdvanceToast('Queue is empty');
                setTimeout(() => setAdvanceToast(''), 4000);
                return;
              }
              const nextLead = remaining[0];
              setAdvanceLeft(5);
              clearAdvanceTimer();
              advanceTimerRef.current = setInterval(() => {
                setAdvanceLeft(prev => {
                  if (prev <= 1) {
                    clearAdvanceTimer();
                    setTimeout(() => triggerCallAndOpen(nextLead), 0);
                    return 0;
                  }
                  return prev - 1;
                });
              }, 1000);
            }
          }}
        />
      )}

      {/* Always-on auto-advance: 5-sec countdown badge (top-right) */}
      {advanceLeft > 0 && (
        <div style={{
          position: 'fixed', top: 18, right: 18, zIndex: 9600,
          background: 'rgba(91,33,182,0.95)', color: '#fff',
          padding: '10px 16px', borderRadius: 50,
          fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.86rem',
          boxShadow: '0 8px 24px rgba(91,33,182,0.40)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>Next call in {advanceLeft}s</span>
          <button
            onClick={() => { clearAdvanceTimer(); setAdvanceLeft(0); }}
            style={{ border: 'none', background: 'rgba(255,255,255,0.20)', color: '#fff',
                     padding: '3px 10px', borderRadius: 50, cursor: 'pointer',
                     fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.74rem' }}>
            Stop
          </button>
        </div>
      )}

      {/* Empty-queue toast */}
      {advanceToast && (
        <div style={{
          position: 'fixed', top: 18, right: 18, zIndex: 9600,
          background: 'rgba(91,33,182,0.95)', color: '#fff',
          padding: '10px 16px', borderRadius: 12,
          fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.86rem',
          boxShadow: '0 8px 24px rgba(91,33,182,0.40)',
        }}>
          ✓ {advanceToast}
        </div>
      )}

      {/* 5-second cooldown card between auto-dialed leads */}
      {autoMode === 'cooldown' && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9500,
            background: 'rgba(15,0,40,0.55)',
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 16px',
            animation: 'cdFade 200ms ease',
          }}
        >
          <style>{`
            @keyframes cdFade   { from { opacity: 0; } to { opacity: 1; } }
            @keyframes cdScale  { from { transform: scale(0.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            @keyframes cdRing   { 0% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: 251.2; } }
          `}</style>
          <div style={{
            width: '100%', maxWidth: 380,
            background: '#fff', borderRadius: 22,
            padding: '28px 26px',
            fontFamily: 'Outfit, sans-serif',
            boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
            textAlign: 'center',
            animation: 'cdScale 220ms ease',
          }}>
            <div style={{ position: 'relative', width: 96, height: 96, margin: '0 auto 16px' }}>
              {/* Background ring */}
              <svg width="96" height="96" viewBox="0 0 96 96" style={{ position: 'absolute', inset: 0 }}>
                <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(91,33,182,0.10)" strokeWidth="6"/>
              </svg>
              {/* Animated countdown ring */}
              <svg width="96" height="96" viewBox="0 0 96 96" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
                <circle
                  cx="48" cy="48" r="40"
                  fill="none"
                  stroke="#5B21B6"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray="251.2"
                  style={{ animation: 'cdRing 5s linear forwards' }}
                />
              </svg>
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: '2.2rem', color: '#3B0764',
              }}>
                {cooldownLeft}
              </div>
            </div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', color: '#3B0764', marginBottom: 4 }}>
              Next call in {cooldownLeft}s
            </div>
            <div style={{ fontSize: '0.82rem', color: 'rgba(91,33,182,0.60)', marginBottom: 18 }}>
              {autoQueue.length > 1
                ? `Up next: ${autoQueue[1]?.full_name || '—'} (${autoTotal - (autoIndex + 1)} more after this)`
                : 'Last call in this batch'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={advanceAutoCall}
                style={{
                  flex: 1, height: '2.5rem', borderRadius: 50, border: 'none',
                  background: '#5B21B6', color: '#fff',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                  cursor: 'pointer', boxShadow: '0 2px 10px rgba(91,33,182,0.30)',
                }}
              >
                Skip wait
              </button>
              <button
                onClick={stopAutoMode}
                style={{
                  flex: 1, height: '2.5rem', borderRadius: 50,
                  border: '1px solid rgba(220,38,38,0.30)',
                  background: '#fff', color: '#DC2626',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                  cursor: 'pointer',
                }}
              >
                Stop
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Subcomponents ── */

const CALL_STATUS_BADGE = {
  initiated: { bg: '#EDE9FE', fg: '#5B21B6', label: 'Calling…' },
  ringing:   { bg: '#FEF3C7', fg: '#92400E', label: 'Ringing'  },
  answered:  { bg: '#DBEAFE', fg: '#1D4ED8', label: 'On call'  },
  ended:     { bg: '#DCFCE7', fg: '#166534', label: 'Ended'    },
  missed:    { bg: '#FEE2E2', fg: '#B91C1C', label: 'Missed'   },
  failed:    { bg: '#FEE2E2', fg: '#B91C1C', label: 'Failed'   },
};

function fmtDuration(sec) {
  if (sec == null) return null;
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

/* Renders the "Last Call" cell: status pill + recording link when available. */
function CallStatusCell({ lead, jwt }) {
  const status = lead.last_call_status;
  if (!status) {
    return <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.40)' }}>—</span>;
  }
  const badge = CALL_STATUS_BADGE[status] || { bg: '#F3F4F6', fg: '#4B5563', label: status };
  const dur = fmtDuration(lead.last_call_duration);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <span style={badgeStyle(badge)}>{badge.label}{dur ? ` · ${dur}` : ''}</span>
      {lead.last_call_recording_url && lead.last_call_id && (
        <a
          href={`/api/caller/recordings/${lead.last_call_id}?token=${encodeURIComponent(jwt)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: '0.74rem', color: '#5B21B6', textDecoration: 'none', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          Recording
        </a>
      )}
    </div>
  );
}

function RowActions({ lead, jwt, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  const startCall = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/caller/calls/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.message || data?.error || 'Failed to start call';
        throw new Error(msg);
      }
      if (data.stubbed) {
        setErr('Stub mode — Tata credentials not set');
        setTimeout(() => setErr(''), 4000);
      }
      // Real status arrives via SSE call.update; nothing else to do here.
    } catch (e) {
      setErr(e.message || 'Call failed');
      setTimeout(() => setErr(''), 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', position: 'relative' }}>
      <IconBtn
        onClick={lead.whatsapp_number ? startCall : null}
        color="#5B21B6"
        title={lead.whatsapp_number ? 'Call via Smartflo' : 'No phone number'}
        disabled={busy}
      >
        {busy ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" opacity="0.25" />
            <path d="M22 12a10 10 0 0 1-10 10">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/>
            </path>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z"/>
          </svg>
        )}
      </IconBtn>
      <IconBtn onClick={onEdit} color="#5B21B6" title="Fill call note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9"/>
          <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z"/>
        </svg>
      </IconBtn>
      {err && (
        <span style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4,
          background: '#FEE2E2', color: '#B91C1C', borderRadius: 6, padding: '2px 8px',
          fontSize: '0.70rem', fontWeight: 600, whiteSpace: 'nowrap',
        }}>{err}</span>
      )}
    </div>
  );
}

function IconBtn({ href, onClick, color, title, children, disabled }) {
  const interactive = !disabled && !!(href || onClick);
  const common = {
    width: 30, height: 30, borderRadius: 8,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: '#fff', border: `1px solid ${color}33`, color,
    cursor: interactive ? 'pointer' : 'not-allowed',
    opacity: interactive ? 1 : 0.4,
    textDecoration: 'none',
    padding: 0,
    font: 'inherit',
  };
  if (href && !disabled) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} style={common}>
        {children}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} style={common} disabled={!!disabled}>
        {children}
      </button>
    );
  }
  return <span style={common} title={title}>{children}</span>;
}

function EmptyState({ title, subtitle, children }) {
  return (
    <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
      {children
        ? <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>{children}</div>
        : <>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>{title}</div>
            {subtitle && <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem' }}>{subtitle}</div>}
          </>
      }
    </div>
  );
}

/* ── Styles ── */

const thStyle = {
  padding: '12px 16px',
  fontSize: '0.72rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'rgba(91,33,182,0.60)',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '14px 16px',
  fontSize: '0.86rem',
  color: '#3B0764',
  verticalAlign: 'middle',
};

function badgeStyle(badge) {
  return {
    display: 'inline-block', padding: '3px 10px', borderRadius: 50,
    fontSize: '0.72rem', fontWeight: 700,
    background: badge.bg, color: badge.fg,
    whiteSpace: 'nowrap',
  };
}
