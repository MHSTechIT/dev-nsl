import { useState, useEffect, useCallback } from 'react';
import Toast from '../components/Toast';

/* ──────────────────────────────────────────────────────────────────────────
   Notifications — the auto-pause feed for the Sales dashboard.

   Lists every caller the SYSTEM paused (robot-nudge self-pause or the
   SmartFlow retry-cap). Admin pauses are excluded by the backend — they
   leave auto_paused_at NULL. Each card shows the pause reason + a Resume
   button; Resume calls PATCH /api/admin/nsm/users/:id { is_active: true },
   which clears the auto-pause bookkeeping so the caller drops off the feed.
   ────────────────────────────────────────────────────────────────────────── */

const ROLE_LABEL = {
  junior_caller: 'Junior Caller',
  senior_caller: 'Senior Caller',
  manager:       'Manager',
  trainer:       'Trainer',
  team_leader:   'Team Leader',
  admin:         'Admin',
};

/* Machine-code reasons get a friendlier label; the robot-nudge reasons are
   already free-text and human-readable, so they fall through as-is. */
const REASON_LABEL = {
  smartflow_cap_exceeded: 'SmartFlow retry cap exceeded — agent leg unanswered 5 times',
  'robot nudge ignored':  'Ignored repeated robot nudges',
};
function prettyReason(r) {
  if (!r) return 'Auto-paused — no reason recorded';
  return REASON_LABEL[r] || r;
}

function timeAgo(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function NsmSalesNotificationsView({ token }) {
  const [callers, setCallers]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [updatedAt, setUpdatedAt]   = useState(null);
  const [resumingId, setResumingId] = useState(null);
  const [toast, setToast]           = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/nsm/auto-paused-callers', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load notifications.');
      const data = await res.json();
      setCallers(data.callers || []);
      setError('');
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  /* Initial fetch + 30 s poll so a fresh auto-pause surfaces on its own. */
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  async function resume(caller) {
    setResumingId(caller.id);
    try {
      const res = await fetch(`/api/admin/nsm/users/${caller.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_active: true }),
      });
      if (!res.ok) throw new Error('Resume failed — please try again.');
      setCallers(prev => prev.filter(c => c.id !== caller.id));
      setToast(`${caller.full_name} resumed`);
    } catch (e) {
      setError(e.message);
    } finally {
      setResumingId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header — title + count on the left, last-updated + Refresh on the right */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1rem', color: '#3B0764' }}>
            Auto-pause notifications
          </h3>
          {callers.length > 0 && (
            <span style={{
              background: '#DC2626', color: '#fff', borderRadius: 50,
              padding: '2px 9px', fontSize: '0.72rem', fontWeight: 800,
              fontFamily: 'Outfit, sans-serif',
            }}>
              {callers.length}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {updatedAt && (
            <span style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.5)', fontFamily: 'Outfit, sans-serif' }}>
              Last updated: {updatedAt.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={load}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 50,
              border: '1px solid rgba(139,92,246,0.35)', background: '#fff',
              color: '#5B21B6', fontFamily: 'Outfit, sans-serif',
              fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>{error}</p>
        </div>
      )}

      {loading && callers.length === 0 ? (
        <div className="bg-white rounded-card shadow-card" style={{ padding: 40, textAlign: 'center', fontFamily: 'Outfit, sans-serif', color: 'rgba(91,33,182,0.55)', fontSize: '0.88rem' }}>
          Loading notifications…
        </div>
      ) : callers.length === 0 ? (
        <div className="bg-white rounded-card shadow-card" style={{ padding: 44, textAlign: 'center', fontFamily: 'Outfit, sans-serif' }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(34,197,94,0.12)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.95rem' }}>All clear</div>
          <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem', marginTop: 2 }}>
            No callers are auto-paused right now.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {callers.map(c => (
            <div
              key={c.id}
              className="bg-white rounded-card shadow-card"
              style={{
                display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                padding: '15px 18px', borderLeft: '4px solid #F59E0B',
              }}
            >
              {/* Pause icon */}
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(245,158,11,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="4" width="4" height="16" rx="1"/>
                  <rect x="14" y="4" width="4" height="16" rx="1"/>
                </svg>
              </div>

              {/* Identity + reason */}
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, color: '#3B0764', fontSize: '0.95rem' }}>
                    {c.full_name}
                  </span>
                  <span style={{
                    display: 'inline-block', padding: '3px 10px', borderRadius: 50,
                    fontSize: '0.68rem', fontWeight: 700, background: '#EDE9FE', color: '#5B21B6',
                    fontFamily: 'Outfit, sans-serif',
                  }}>
                    {ROLE_LABEL[c.role] || c.role}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.5)', fontFamily: 'Outfit, sans-serif' }}>
                    auto-paused {timeAgo(c.auto_paused_at)}
                  </span>
                </div>
                <div style={{ marginTop: 5, fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: 'rgba(59,7,100,0.78)' }}>
                  <span style={{ fontWeight: 700 }}>Reason: </span>
                  {prettyReason(c.auto_pause_reason)}
                </div>
              </div>

              {/* Resume */}
              <button
                onClick={() => resume(c)}
                disabled={resumingId === c.id}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '9px 20px', borderRadius: 50, border: 'none',
                  background: resumingId === c.id ? 'rgba(22,163,74,0.55)' : '#16A34A',
                  color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 700,
                  fontSize: '0.84rem', cursor: resumingId === c.id ? 'default' : 'pointer',
                  flexShrink: 0, boxShadow: '0 4px 14px rgba(22,163,74,0.30)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="6 4 20 12 6 20 6 4"/>
                </svg>
                {resumingId === c.id ? 'Resuming…' : 'Resume'}
              </button>
            </div>
          ))}
        </div>
      )}

      {toast && <Toast message={toast} kind="success" onDone={() => setToast('')} />}
    </div>
  );
}
