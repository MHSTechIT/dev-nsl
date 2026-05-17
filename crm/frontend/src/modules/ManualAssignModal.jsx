import { useState, useEffect, useMemo } from 'react';
import DateTimePicker from '../admin/DateTimePicker';

/* Manual Lead Assignment modal — opens from the Sales → Leads toolbar.

   Flow:
     1. Admin picks a From/To datetime range.
     2. We hit GET /api/admin/leads/assignment-pool?from=…&to=… to learn how
        many UNASSIGNED leads sit in that window AND fetch the active caller
        list.
     3. Admin types a count per caller, or clicks "Auto Assign" to spread
        the available pool evenly across all active callers (the remainder
        from an uneven divide is sprinkled across the first N rows).
     4. "Assign Leads" POSTs to /api/admin/leads/manual-assign which slices
        the oldest unassigned leads in created_at ASC order and updates
        assigned_user_id + assigned_at per the distribution.

   The endpoint and the modal share the same payload shape so any future
   changes (e.g. role-based prioritisation, source filter) only need one
   round-trip update. */

function toIsoOrEmpty(local) {
  // DateTimePicker emits "YYYY-MM-DDTHH:mm:ss" interpreted as IST local.
  if (!local) return '';
  if (local.includes('T')) {
    // Append IST offset so the backend gets a precise instant.
    return new Date(`${local}+05:30`).toISOString();
  }
  return new Date(`${local}T00:00:00+05:30`).toISOString();
}

export default function ManualAssignModal({ token, onClose, onAssigned }) {
  /* Default range = last 7 days → now, in IST. */
  const [from, setFrom] = useState(() => {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000 - 7 * 24 * 3600 * 1000);
    return d.toISOString().slice(0, 19);
  });
  const [to, setTo] = useState(() => {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.toISOString().slice(0, 19);
  });

  const [pool, setPool]         = useState({ available: 0, callers: [] });
  const [counts, setCounts]     = useState({});   // user_id → number
  const [loadingPool, setLoadingPool] = useState(false);
  const [submitting, setSubmitting]   = useState(false);
  const [msg, setMsg]           = useState('');

  /* Fetch pool whenever the date range changes (after a short debounce so
     dragging the picker doesn't spam the API). */
  useEffect(() => {
    let cancelled = false;
    const fromIso = toIsoOrEmpty(from);
    const toIso   = toIsoOrEmpty(to);
    if (!fromIso || !toIso) { setPool({ available: 0, callers: pool.callers }); return; }
    setLoadingPool(true);
    setMsg('');
    const t = setTimeout(async () => {
      try {
        const url = `/api/admin/leads/assignment-pool?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Failed to load pool');
        if (!cancelled) setPool({ available: d.available || 0, callers: d.callers || [] });
      } catch (e) {
        if (!cancelled) setMsg('⚠ ' + (e.message || 'Failed to load assignment pool.'));
      } finally {
        if (!cancelled) setLoadingPool(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, token]);

  const totalRequested = useMemo(() => {
    return Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
  }, [counts]);

  /* Auto-distribute the available pool evenly across the visible callers.
     Remainder from an uneven divide is sprinkled across the first N rows. */
  function autoDistribute() {
    if (pool.callers.length === 0 || pool.available === 0) return;
    const base = Math.floor(pool.available / pool.callers.length);
    const remainder = pool.available - base * pool.callers.length;
    const next = {};
    pool.callers.forEach((c, i) => {
      next[c.id] = base + (i < remainder ? 1 : 0);
    });
    setCounts(next);
  }

  function clearAll() {
    setCounts({});
  }

  function setCount(userId, raw) {
    const digits = (raw || '').replace(/\D/g, '');
    const n = digits === '' ? '' : Math.min(Number(digits), pool.available);
    setCounts(prev => ({ ...prev, [userId]: n }));
  }

  async function submit() {
    const distribution = Object.entries(counts)
      .map(([user_id, count]) => ({ user_id, count: Number(count) || 0 }))
      .filter(r => r.count > 0);

    if (distribution.length === 0) {
      setMsg('⚠ Enter at least one count > 0 (or click Auto Assign).');
      return;
    }
    if (totalRequested > pool.available) {
      setMsg(`⚠ You're trying to assign ${totalRequested} leads but only ${pool.available} are available in this range.`);
      return;
    }

    setSubmitting(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/leads/manual-assign', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          from: toIsoOrEmpty(from),
          to:   toIsoOrEmpty(to),
          distribution,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);

      setMsg(`✓ Assigned ${d.total_assigned} of ${d.total_requested} leads (pool had ${d.available}).`);
      if (typeof onAssigned === 'function') onAssigned(d);
      setCounts({});
    } catch (e) {
      setMsg('⚠ ' + (e.message || 'Failed to assign leads.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9700,
        background: 'rgba(15,0,40,0.55)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px', fontFamily: 'Outfit, sans-serif',
      }}
    >
      <div style={{
        width: '100%', maxWidth: 720, maxHeight: '90vh',
        background: '#fff', borderRadius: 14,
        boxShadow: '0 32px 80px rgba(15,0,40,0.40)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid rgba(91,33,182,0.10)',
          background: 'linear-gradient(135deg, #5B21B6, #7C3AED)',
          color: '#fff',
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800 }}>Manual Lead Assignment</h2>
            <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: 'rgba(255,255,255,0.78)' }}>
              Hand-pick how many leads each caller receives from a date range.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 32, height: 32, borderRadius: 8,
              border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.20)', color: '#fff',
              fontSize: '1rem', fontWeight: 700,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px', overflowY: 'auto', flex: 1 }}>
          {/* Date range */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'rgba(91,33,182,0.65)' }}>FROM</span>
            <DateTimePicker value={from} onChange={setFrom} placeholder="From date & time" />
            <span style={{ fontSize: '0.78rem', color: 'rgba(91,33,182,0.45)', fontWeight: 600 }}>to</span>
            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'rgba(91,33,182,0.65)' }}>TO</span>
            <DateTimePicker value={to} onChange={setTo} placeholder="To date & time" />
          </div>

          {/* Availability + Auto button */}
          <div style={{
            marginTop: 14, padding: '10px 14px',
            background: 'rgba(237,234,248,0.50)', borderRadius: 10,
            border: '1px solid rgba(91,33,182,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: '0.84rem', color: '#3B0764' }}>
              {loadingPool
                ? 'Loading pool…'
                : (
                  <>
                    <strong>{pool.available}</strong> unassigned lead{pool.available === 1 ? '' : 's'} in this range
                    {totalRequested > 0 && (
                      <span style={{
                        marginLeft: 10, fontSize: '0.78rem',
                        color: totalRequested > pool.available ? '#B91C1C' : 'rgba(91,33,182,0.65)',
                        fontWeight: 700,
                      }}>
                        · {totalRequested} requested
                      </span>
                    )}
                  </>
                )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={autoDistribute}
                disabled={pool.callers.length === 0 || pool.available === 0}
                style={{
                  padding: '7px 14px', borderRadius: 8, border: 'none',
                  background: 'linear-gradient(135deg, #5B21B6, #7C3AED)',
                  color: '#fff', fontWeight: 700, fontSize: '0.80rem',
                  cursor: pool.callers.length === 0 || pool.available === 0 ? 'not-allowed' : 'pointer',
                  opacity: pool.callers.length === 0 || pool.available === 0 ? 0.5 : 1,
                  boxShadow: '0 2px 8px rgba(91,33,182,0.25)',
                }}
              >
                Auto Assign
              </button>
              <button
                onClick={clearAll}
                disabled={totalRequested === 0}
                style={{
                  padding: '7px 14px', borderRadius: 8,
                  border: '1px solid rgba(220,38,38,0.25)',
                  background: 'rgba(254,242,242,0.70)', color: '#B91C1C',
                  fontWeight: 700, fontSize: '0.78rem',
                  cursor: totalRequested === 0 ? 'not-allowed' : 'pointer',
                  opacity: totalRequested === 0 ? 0.4 : 1,
                }}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Caller list */}
          <div style={{ marginTop: 14 }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 90px 110px',
              gap: 8,
              padding: '8px 12px',
              fontSize: '0.68rem', fontWeight: 700,
              color: 'rgba(91,33,182,0.55)',
              textTransform: 'uppercase', letterSpacing: '0.05em',
              borderBottom: '1px solid rgba(91,33,182,0.12)',
            }}>
              <span>Caller</span>
              <span style={{ textAlign: 'right' }}>Open now</span>
              <span style={{ textAlign: 'right' }}>Assign</span>
            </div>

            {pool.callers.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.84rem' }}>
                {loadingPool ? 'Loading callers…' : 'No active callers found.'}
              </div>
            ) : pool.callers.map(c => (
              <div key={c.id} style={{
                display: 'grid',
                gridTemplateColumns: '1fr 90px 110px',
                gap: 8, alignItems: 'center',
                padding: '10px 12px',
                borderBottom: '1px solid rgba(91,33,182,0.06)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#3B0764', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.full_name}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.55)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {c.role === 'senior_caller' ? 'Senior' : 'Junior'} caller
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: '0.82rem', color: 'rgba(91,33,182,0.65)', fontVariantNumeric: 'tabular-nums' }}>
                  {c.open_count}
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={counts[c.id] === undefined ? '' : String(counts[c.id])}
                  onChange={e => setCount(c.id, e.target.value)}
                  placeholder="0"
                  style={{
                    height: '2rem', padding: '0 10px', borderRadius: 8,
                    border: '1px solid rgba(139,92,246,0.25)',
                    background: 'rgba(237,234,248,0.30)',
                    fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem',
                    color: '#3B0764', outline: 'none', textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                  }}
                />
              </div>
            ))}
          </div>

          {/* Status message */}
          {msg && (
            <div style={{
              marginTop: 14, padding: '10px 14px', borderRadius: 8,
              background: msg.startsWith('⚠') ? 'rgba(254,242,242,0.95)' : 'rgba(237,234,248,0.50)',
              border: '1px solid ' + (msg.startsWith('⚠') ? 'rgba(248,113,113,0.40)' : 'rgba(91,33,182,0.20)'),
              color: msg.startsWith('⚠') ? '#B91C1C' : '#3B0764',
              fontSize: '0.84rem',
            }}>
              {msg}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 20px',
          borderTop: '1px solid rgba(91,33,182,0.10)',
          background: 'rgba(237,234,248,0.30)',
          display: 'flex', justifyContent: 'flex-end', gap: 10,
        }}>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: '9px 16px', borderRadius: 8,
              border: '1px solid rgba(91,33,182,0.20)',
              background: '#fff', color: '#5B21B6',
              fontWeight: 700, fontSize: '0.84rem',
              cursor: submitting ? 'wait' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || totalRequested === 0 || totalRequested > pool.available}
            style={{
              padding: '9px 20px', borderRadius: 8, border: 'none',
              background: submitting || totalRequested === 0 || totalRequested > pool.available
                ? 'rgba(91,33,182,0.40)'
                : 'linear-gradient(135deg, #5B21B6, #7C3AED)',
              color: '#fff', fontWeight: 800, fontSize: '0.86rem',
              cursor: submitting || totalRequested === 0 || totalRequested > pool.available ? 'not-allowed' : 'pointer',
              boxShadow: '0 6px 20px rgba(91,33,182,0.30)',
            }}
          >
            {submitting ? 'Assigning…' : `Assign Leads${totalRequested ? ` (${totalRequested})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
