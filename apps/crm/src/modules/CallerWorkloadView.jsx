import { useState, useEffect, useCallback } from 'react';
import Toast from '../components/Toast';

/* ──────────────────────────────────────────────────────────────────────────
   Caller Workload — admin view of how many leads each caller has on their
   plate, including follow-ups scheduled for the chosen date. Supports bulk
   reassignment so leads can be redistributed when a caller is absent.
   ────────────────────────────────────────────────────────────────────────── */

const ROLE_BADGE = {
  junior_caller: { bg: '#FEF9C3', fg: '#A16207', label: 'Junior' },
  senior_caller: { bg: '#FFEDD5', fg: '#C2410C', label: 'Senior' },
};

function todayIST() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export default function CallerWorkloadView({ token }) {
  const [date, setDate]         = useState(todayIST());
  const [callers, setCallers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [toast, setToast]       = useState('');
  const [reassigning, setReassigning] = useState(null);   // { fromCaller, scope, total }
  // Per-destination allocations: { [callerId]: { ticked: bool, count: number } }
  const [allocs, setAllocs]     = useState({});
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/caller-workload?date=${encodeURIComponent(date)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load workload.');
      const data = await res.json();
      setCallers(data.callers || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, date]);

  useEffect(() => { load(); }, [load]);

  function openReassign(fromCaller, scope) {
    const total = scope === 'followups_for_date' ? fromCaller.followups_for_date : fromCaller.total_open;
    setReassigning({ fromCaller, scope, total });
    setAllocs({});
  }
  function closeReassign() { setReassigning(null); setAllocs({}); }

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
    const n = Math.max(0, Math.min(reassigning?.total ?? 0, parseInt(raw, 10) || 0));
    setAllocs(prev => ({ ...prev, [callerId]: { ticked: true, count: n } }));
  }
  // Even split across all ticked teammates, with remainder distributed to the
  // first few rows so totals always sum to the source total.
  function autoAssign() {
    if (!reassigning) return;
    const tickedIds = Object.entries(allocs).filter(([_, a]) => a.ticked).map(([id]) => id);
    if (tickedIds.length === 0) return;
    const total = reassigning.total;
    const base = Math.floor(total / tickedIds.length);
    const remainder = total % tickedIds.length;
    const next = { ...allocs };
    tickedIds.forEach((id, i) => {
      next[id] = { ticked: true, count: base + (i < remainder ? 1 : 0) };
    });
    setAllocs(next);
  }

  const activeOthers = callers.filter(c => c.is_active && c.id !== reassigning?.fromCaller?.id);
  const allocatedTotal = Object.values(allocs).reduce((s, a) => s + (a.count || 0), 0);
  const remaining = (reassigning?.total ?? 0) - allocatedTotal;
  const tickedCount = Object.values(allocs).filter(a => a.ticked).length;
  const allTickedHaveCount = Object.values(allocs).every(a => !a.ticked || a.count >= 1);
  const canSubmit = !!reassigning
    && tickedCount > 0
    && allocatedTotal >= 1
    && allocatedTotal <= reassigning.total
    && allTickedHaveCount;

  async function confirmReassign() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const distribution = Object.entries(allocs)
        .filter(([_, a]) => a.ticked && a.count >= 1)
        .map(([to_caller_id, a]) => ({ to_caller_id, count: a.count }));
      const body = {
        from_caller_id: reassigning.fromCaller.id,
        scope: reassigning.scope,
        distribution,
      };
      if (reassigning.scope === 'followups_for_date') body.date = date;
      const res = await fetch('/api/admin/leads/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed.');
      // Build toast like "Moved 99 leads → dhana 50, keerthi 30, prasana 19"
      const nameById = Object.fromEntries(callers.map(c => [c.id, c.full_name]));
      const breakdown = distribution.map(d => `${nameById[d.to_caller_id] || '?'} ${d.count}`).join(', ');
      const stayed = data.remaining > 0
        ? ` (${data.remaining} stay with ${reassigning.fromCaller.full_name})`
        : '';
      setToast(`Moved ${data.moved} lead${data.moved === 1 ? '' : 's'} → ${breakdown}${stayed}`);
      closeReassign();
      load();
    } catch (e) {
      setToast(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Toast message={toast} onDone={() => setToast('')} />

      {/* Date filter */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.82rem', fontWeight: 600, color: 'rgba(91,33,182,0.70)' }}>
          Follow-ups & completions for date:
        </span>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{
            height: '2.2rem', padding: '0 12px', borderRadius: 8,
            border: '1px solid rgba(209,196,240,0.7)', background: '#fff',
            fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764',
          }}
        />
        <button
          onClick={() => setDate(todayIST())}
          style={{
            padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(91,33,182,0.20)',
            background: '#fff', color: '#5B21B6',
            fontFamily: 'Outfit,sans-serif', fontWeight: 600, fontSize: '0.78rem',
            cursor: 'pointer',
          }}
        >
          Today
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* Caller table */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit,sans-serif', fontSize: '0.9rem' }}>
            Loading…
          </div>
        ) : callers.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit,sans-serif', fontSize: '0.9rem' }}>
            No callers found.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit,sans-serif' }}>
            <thead>
              <tr style={{ background: 'rgba(237,234,248,0.40)' }}>
                <Th>Caller</Th>
                <Th align="right">Pending</Th>
                <Th align="right">Follow-ups (date)</Th>
                <Th align="right">Completed (date)</Th>
                <Th align="right">Total open</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {callers.map(c => {
                const roleB = ROLE_BADGE[c.role] || { bg: '#EDE9FE', fg: '#5B21B6', label: c.role };
                return (
                  <tr key={c.id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)', opacity: c.is_active ? 1 : 0.55 }}>
                    <Td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.92rem' }}>{c.full_name}</span>
                        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 50, fontSize: '0.66rem', fontWeight: 700, background: roleB.bg, color: roleB.fg }}>{roleB.label}</span>
                        {!c.is_active && (
                          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 50, fontSize: '0.66rem', fontWeight: 700, background: 'rgba(220,38,38,0.12)', color: '#B91C1C' }}>Inactive</span>
                        )}
                      </div>
                    </Td>
                    <Td align="right"><Pill value={c.pending_count} accent="#B45309" /></Td>
                    <Td align="right"><Pill value={c.followups_for_date} accent="#5B21B6" /></Td>
                    <Td align="right"><Pill value={c.completed_for_date} accent="#047857" /></Td>
                    <Td align="right"><Pill value={c.total_open} accent="#1E40AF" strong /></Td>
                    <Td align="right">
                      <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <ActionBtn disabled={c.total_open === 0} onClick={() => openReassign(c, 'all_open')}>
                          Move all open
                        </ActionBtn>
                        <ActionBtn disabled={c.followups_for_date === 0} onClick={() => openReassign(c, 'followups_for_date')}>
                          Move date follow-ups
                        </ActionBtn>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Reassign modal — distribute custom counts across multiple callers */}
      {reassigning && (
        <div onClick={closeReassign} style={{
          position: 'fixed', inset: 0, background: 'rgba(15,0,40,0.45)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 16, padding: 24, maxWidth: 560, width: '100%',
            maxHeight: '90vh', display: 'flex', flexDirection: 'column',
            fontFamily: 'Outfit,sans-serif', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
              <h3 style={{ margin: 0, color: '#3B0764', fontSize: '1.05rem', fontWeight: 700 }}>
                {reassigning.scope === 'all_open' ? 'Move all open leads' : 'Move date follow-ups'}
              </h3>
              <button
                onClick={autoAssign}
                disabled={tickedCount === 0}
                title={tickedCount === 0 ? 'Tick at least one teammate first' : `Split ${reassigning.total} evenly across ${tickedCount} teammate${tickedCount === 1 ? '' : 's'}`}
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
              Distributing <strong>{reassigning.total} lead{reassigning.total === 1 ? '' : 's'}</strong>
              {' '}from <strong>{reassigning.fromCaller.full_name}</strong>
              {reassigning.scope === 'followups_for_date' && <> scheduled for <strong>{date}</strong></>}.
              Tick teammates, then either type counts or click <strong>Auto Assign</strong> to split evenly.
            </p>

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
                        {c.total_open} currently open
                      </div>
                    </div>
                    <input
                      type="number"
                      min="0"
                      max={reassigning.total}
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
                    ? `✓ Distributing ${allocatedTotal} / ${reassigning.total} — ${remaining} will stay with ${reassigning.fromCaller.full_name}`
                    : `✓ Distributing ${allocatedTotal} / ${reassigning.total} leads`
                  : tickedCount === 0
                    ? `Pick at least one teammate (${reassigning.total} leads available)`
                    : allocatedTotal === 0
                      ? `Enter a count for at least one teammate`
                      : remaining < 0
                        ? `${allocatedTotal} / ${reassigning.total} — over by ${-remaining}`
                        : `${allocatedTotal} / ${reassigning.total}`
                }
              </span>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={closeReassign} disabled={submitting} style={{
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
      )}
    </div>
  );
}

function Th({ children, align }) {
  return (
    <th style={{
      textAlign: align || 'left', padding: '12px 16px',
      fontSize: '0.70rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
      color: 'rgba(91,33,182,0.55)',
    }}>{children}</th>
  );
}
function Td({ children, align }) {
  return <td style={{ textAlign: align || 'left', padding: '12px 16px', fontSize: '0.86rem' }}>{children}</td>;
}
function Pill({ value, accent, strong }) {
  return (
    <span style={{
      display: 'inline-block', minWidth: 28, padding: '4px 10px', borderRadius: 50,
      background: `${accent}1A`, color: accent,
      fontSize: strong ? '0.86rem' : '0.78rem', fontWeight: strong ? 800 : 700,
      fontFamily: 'ui-monospace, monospace',
    }}>{value}</span>
  );
}
function ActionBtn({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '6px 10px', borderRadius: 8,
      border: '1px solid rgba(91,33,182,0.20)', background: disabled ? 'rgba(237,234,248,0.50)' : '#fff',
      color: disabled ? 'rgba(91,33,182,0.35)' : '#5B21B6',
      fontFamily: 'Outfit,sans-serif', fontSize: '0.75rem', fontWeight: 600,
      cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
    }}>{children}</button>
  );
}
