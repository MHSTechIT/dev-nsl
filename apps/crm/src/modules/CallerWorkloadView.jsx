import { useState, useEffect, useCallback } from 'react';
import Toast from '../components/Toast';
import ReassignDistributionModal from '../admin/ReassignDistributionModal';

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
  }
  function closeReassign() { setReassigning(null); }

  function handleMoved({ moved, remaining, breakdown, fromName }) {
    const stayed = remaining > 0 ? ` (${remaining} stay with ${fromName})` : '';
    setToast(`Moved ${moved} lead${moved === 1 ? '' : 's'} → ${breakdown}${stayed}`);
    closeReassign();
    load();
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

      {/* Reassign modal — shared component (also used by Sales Performance) */}
      {reassigning && (
        <ReassignDistributionModal
          fromCaller={reassigning.fromCaller}
          scope={reassigning.scope}
          date={date}
          total={reassigning.total}
          eligibleCallers={callers}
          token={token}
          onClose={closeReassign}
          onMoved={handleMoved}
        />
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
