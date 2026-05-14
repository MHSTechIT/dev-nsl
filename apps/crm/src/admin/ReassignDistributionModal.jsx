import { useState, useMemo } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
   ReassignDistributionModal — shared modal for bulk-redistributing one
   caller's open leads (or that caller's follow-ups for a specific date)
   across a custom list of teammates with custom counts per destination.

   Used by:
     - CallerWorkloadView   (admin -> Caller Workload)
     - SalesPerformanceView (admin -> Sales Performance, kebab > Move leads)

   Backend it calls: POST /api/admin/leads/reassign
     body: { from_caller_id, scope, date?, distribution: [{to_caller_id, count}] }

   Props:
     fromCaller       — { id, full_name }
     scope            — 'all_open' | 'followups_for_date'
     date             — YYYY-MM-DD (required when scope is followups_for_date)
     total            — number of leads being distributed
     eligibleCallers  — [{ id, full_name, role, total_open, is_active }]
     token            — admin JWT
     onClose()        — caller closes the modal
     onMoved(result)  — { moved, distribution, breakdown, remaining,
                          fromName, scope, date } on success
   ────────────────────────────────────────────────────────────────────────── */

const ROLE_BADGE = {
  junior_caller: { bg: '#FEF9C3', fg: '#A16207', label: 'Junior' },
  senior_caller: { bg: '#FFEDD5', fg: '#C2410C', label: 'Senior' },
};

export default function ReassignDistributionModal({
  fromCaller, scope, date, total, eligibleCallers, token, onClose, onMoved,
}) {
  /* Per-destination allocations: { [callerId]: { ticked: bool, count: number } } */
  const [allocs, setAllocs] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  function toggleDest(callerId) {
    setAllocs(prev => {
      const cur = prev[callerId];
      if (cur?.ticked) {
        const { [callerId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [callerId]: { ticked: true, count: 0 } };
    });
  }
  function setCount(callerId, raw) {
    const n = Math.max(0, Math.min(total, parseInt(raw, 10) || 0));
    setAllocs(prev => ({ ...prev, [callerId]: { ticked: true, count: n } }));
  }
  // Even split across all ticked teammates; remainder distributed to first rows.
  function autoAssign() {
    const tickedIds = Object.entries(allocs).filter(([_, a]) => a.ticked).map(([id]) => id);
    if (tickedIds.length === 0) return;
    const base = Math.floor(total / tickedIds.length);
    const remainder = total % tickedIds.length;
    const next = { ...allocs };
    tickedIds.forEach((id, i) => {
      next[id] = { ticked: true, count: base + (i < remainder ? 1 : 0) };
    });
    setAllocs(next);
  }

  const activeOthers = useMemo(
    () => (eligibleCallers || []).filter(c => c.is_active !== false && c.id !== fromCaller?.id),
    [eligibleCallers, fromCaller?.id]
  );
  const allocatedTotal = Object.values(allocs).reduce((s, a) => s + (a.count || 0), 0);
  const remaining = total - allocatedTotal;
  const tickedCount = Object.values(allocs).filter(a => a.ticked).length;
  const allTickedHaveCount = Object.values(allocs).every(a => !a.ticked || a.count >= 1);
  const canSubmit = tickedCount > 0
    && allocatedTotal >= 1
    && allocatedTotal <= total
    && allTickedHaveCount;

  async function confirmReassign() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const distribution = Object.entries(allocs)
        .filter(([_, a]) => a.ticked && a.count >= 1)
        .map(([to_caller_id, a]) => ({ to_caller_id, count: a.count }));
      const body = {
        from_caller_id: fromCaller.id,
        scope,
        distribution,
      };
      if (scope === 'followups_for_date') body.date = date;
      const res = await fetch('/api/admin/leads/reassign', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed.');
      const nameById = Object.fromEntries((eligibleCallers || []).map(c => [c.id, c.full_name]));
      const breakdown = distribution.map(d => `${nameById[d.to_caller_id] || '?'} ${d.count}`).join(', ');
      onMoved?.({
        moved:     data.moved,
        remaining: data.remaining,
        distribution,
        breakdown,
        fromName:  fromCaller.full_name,
        scope,
        date:      scope === 'followups_for_date' ? date : null,
      });
    } catch (e) {
      setError(e.message || 'Reassign failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,0,40,0.45)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 9500,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 16, padding: 24, maxWidth: 560, width: '100%',
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        fontFamily: 'Outfit,sans-serif', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
          <h3 style={{ margin: 0, color: '#3B0764', fontSize: '1.05rem', fontWeight: 700 }}>
            {scope === 'all_open' ? 'Move all open leads' : 'Move date follow-ups'}
          </h3>
          <button
            onClick={autoAssign}
            disabled={tickedCount === 0}
            title={tickedCount === 0
              ? 'Tick at least one teammate first'
              : `Split ${total} evenly across ${tickedCount} teammate${tickedCount === 1 ? '' : 's'}`}
            style={{
              padding: '6px 12px', borderRadius: 8, border: 'none',
              background: tickedCount === 0 ? 'rgba(91,33,182,0.15)' : 'linear-gradient(135deg,#7C3AED,#5B21B6)',
              color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.78rem',
              cursor: tickedCount === 0 ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              boxShadow: tickedCount === 0 ? 'none' : '0 2px 8px rgba(91,33,182,0.30)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <polyline points="7.5 4.21 12 6.81 16.5 4.21"/><polyline points="7.5 19.79 7.5 14.6 3 12"/><polyline points="21 12 16.5 14.6 16.5 19.79"/>
            </svg>
            Auto Assign
          </button>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: '0.84rem', color: 'rgba(91,33,182,0.70)' }}>
          Distributing <strong>{total} lead{total === 1 ? '' : 's'}</strong>
          {' '}from <strong>{fromCaller?.full_name}</strong>
          {scope === 'followups_for_date' && <> scheduled for <strong>{date}</strong></>}.
          Tick teammates, then either type counts or click <strong>Auto Assign</strong> to split evenly.
        </p>

        {error && (
          <div style={{
            margin: '0 0 12px', padding: '8px 12px', borderRadius: 8,
            background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)',
            color: '#B91C1C', fontSize: '0.82rem', fontWeight: 600,
          }}>
            ⚠ {error}
          </div>
        )}

        {/* Destination list */}
        <div style={{
          flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
          border: '1px solid rgba(209,196,240,0.6)', borderRadius: 10,
          padding: 4, marginBottom: 14,
        }}>
          {activeOthers.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem' }}>
              No other active callers available.
            </div>
          ) : activeOthers.map(c => {
            const a = allocs[c.id];
            const ticked = !!a?.ticked;
            const roleB = ROLE_BADGE[c.role] || { bg: '#EDE9FE', fg: '#5B21B6', label: c.role };
            return (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 8,
                background: ticked ? 'rgba(91,33,182,0.06)' : 'transparent',
              }}>
                <input
                  type="checkbox"
                  checked={ticked}
                  onChange={() => toggleDest(c.id)}
                  style={{ width: 16, height: 16, accentColor: '#5B21B6', cursor: 'pointer' }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.88rem' }}>{c.full_name}</span>
                    <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 50, fontSize: '0.62rem', fontWeight: 700, background: roleB.bg, color: roleB.fg }}>{roleB.label}</span>
                  </div>
                  <div style={{ fontSize: '0.70rem', color: 'rgba(91,33,182,0.55)' }}>
                    {c.total_open ?? 0} currently open
                  </div>
                </div>
                <input
                  type="number"
                  min="0"
                  max={total}
                  value={ticked ? (a.count || 0) : ''}
                  placeholder="0"
                  disabled={!ticked}
                  onChange={e => setCount(c.id, e.target.value)}
                  onFocus={e => e.target.select()}
                  style={{
                    width: 80, height: 32, padding: '0 8px',
                    borderRadius: 8, border: '1px solid rgba(209,196,240,0.7)',
                    background: ticked ? '#fff' : 'rgba(237,234,248,0.5)',
                    fontFamily: 'ui-monospace, monospace', fontSize: '0.86rem',
                    textAlign: 'right', color: '#3B0764',
                    cursor: ticked ? 'text' : 'not-allowed',
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Live total */}
        <div style={{
          padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: canSubmit ? 'rgba(5,150,105,0.10)' : 'rgba(220,38,38,0.08)',
          border: `1px solid ${canSubmit ? 'rgba(5,150,105,0.30)' : 'rgba(220,38,38,0.25)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          fontSize: '0.84rem', fontWeight: 600,
        }}>
          <span style={{ color: canSubmit ? '#047857' : '#B91C1C' }}>
            {canSubmit
              ? remaining > 0
                ? `✓ Distributing ${allocatedTotal} / ${total} — ${remaining} will stay with ${fromCaller?.full_name}`
                : `✓ Distributing ${allocatedTotal} / ${total} leads`
              : tickedCount === 0
                ? `Pick at least one teammate (${total} leads available)`
                : allocatedTotal === 0
                  ? `Enter a count for at least one teammate`
                  : remaining < 0
                    ? `${allocatedTotal} / ${total} — over by ${-remaining}`
                    : `${allocatedTotal} / ${total}`
            }
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={submitting} style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(91,33,182,0.20)',
            background: '#fff', color: '#5B21B6', fontWeight: 600, fontSize: '0.84rem',
            cursor: submitting ? 'not-allowed' : 'pointer',
          }}>Cancel</button>
          <button onClick={confirmReassign} disabled={!canSubmit || submitting} style={{
            padding: '8px 14px', borderRadius: 8, border: 'none',
            background: canSubmit ? '#5B21B6' : 'rgba(91,33,182,0.30)', color: '#fff',
            fontWeight: 700, fontSize: '0.84rem',
            cursor: (canSubmit && !submitting) ? 'pointer' : 'not-allowed',
          }}>{submitting ? 'Moving…' : 'Reassign'}</button>
        </div>
      </div>
    </div>
  );
}
