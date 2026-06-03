import { useState, useEffect, useCallback } from 'react';
import CreateWebinarModal from './CreateWebinarModal';
import { api } from './api';

/* ──────────────────────────────────────────────────────────────────────────
   WebinarDashboard — lists webinars as cards under a purple header bar and
   drives the "+" create flow. Each card shows Webinar / Batch / Category /
   live Time-Remaining countdown, the Zoom join link + status, and an
   expandable attendees panel (name · phone · time-in-meeting · chat) pulled
   from /api/webinars/:id after a meeting is synced from Zoom.
   ────────────────────────────────────────────────────────────────────────── */

const VIOLET      = '#5B21B6';
const VIOLET_DARK = '#3B0764';
const LAVENDER    = '#EDEAF8';
const PANEL       = '#E4DBF4';

const GRID_COLS = 'minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 0.9fr)';
const COLUMNS = ['WEBINAR', 'BATCH NAME', 'CATEGORY', 'TIME REMAINING'];

function fmtRemaining(startAt, now) {
  const ms = new Date(startAt).getTime() - now;
  if (ms <= 0) return { text: 'Started', color: '#047857' };
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const text = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
  return { text, color: VIOLET };
}

function fmtDuration(sec) {
  if (sec == null) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const ZOOM_BADGE = {
  created: { label: 'Zoom ready',   bg: '#DCFCE7', fg: '#047857' },
  pending: { label: 'Zoom pending', bg: '#FEF3C7', fg: '#B45309' },
  failed:  { label: 'Zoom failed',  bg: '#FEE2E2', fg: '#B91C1C' },
};

export default function WebinarDashboard({ user, onLogout }) {
  const [webinars, setWebinars] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [now, setNow]           = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await api('/api/webinars');
      if (!res.ok) throw new Error('Failed to load webinars.');
      const d = await res.json();
      setWebinars(d.webinars || []);
      setError('');
      setLoading(false);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }, []);

  // Initial load with a short retry so the page self-heals if the backend
  // (:3005) isn't up yet — dev startup order, or a prod cold start.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 5; i++) {
        if (cancelled) return;
        if (await load()) return;
        await new Promise((r) => setTimeout(r, 1500));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [load]);

  // 1s tick drives the live countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  function handleCreated(w) {
    setWebinars((prev) => [...prev, w].sort((a, b) => new Date(a.start_at) - new Date(b.start_at)));
  }

  return (
    <div style={{ minHeight: '100vh', background: LAVENDER, padding: '28px 20px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        <section style={{ background: PANEL, borderRadius: 22, padding: '22px 24px 40px', boxShadow: '0 10px 40px rgba(91,33,182,0.10)', minHeight: 520 }}>
          {/* Header */}
          <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 22 }}>
            <h1 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '1.4rem', letterSpacing: '0.04em', color: VIOLET, textTransform: 'uppercase' }}>
              Webinar Creation Dashboard
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {user?.full_name && (
                <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', fontWeight: 600, color: 'rgba(59,7,100,0.7)' }}>{user.full_name}</span>
              )}
              <button type="button" onClick={onLogout} title="Sign out"
                style={{ border: '1px solid rgba(124,58,237,0.3)', background: '#fff', color: VIOLET, borderRadius: 10, padding: '9px 13px', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.78rem' }}>
                Sign out
              </button>
              <button
                type="button" onClick={() => setModalOpen(true)} aria-label="Add webinar" title="Add webinar"
                style={{ width: 46, height: 46, flexShrink: 0, borderRadius: '50%', border: 'none', cursor: 'pointer', background: `linear-gradient(135deg, ${VIOLET}, ${VIOLET_DARK})`, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 18px rgba(59,7,100,0.35)', transition: 'transform 120ms ease' }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.06)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
          </header>

          {/* Column header bar */}
          <div style={{ display: 'grid', gridTemplateColumns: GRID_COLS, alignItems: 'center', gap: 12, background: `linear-gradient(120deg, ${VIOLET_DARK}, ${VIOLET})`, borderRadius: 28, padding: '24px 28px', boxShadow: '0 8px 24px rgba(59,7,100,0.25)' }}>
            {COLUMNS.map((c) => (
              <span key={c} style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: c === 'TIME REMAINING' ? '0.74rem' : '0.92rem', letterSpacing: '0.03em', color: '#fff', textAlign: 'center', lineHeight: 1.2 }}>{c}</span>
            ))}
          </div>

          {/* Rows */}
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {loading ? (
              <Empty>Loading…</Empty>
            ) : error ? (
              <Empty><span style={{ color: '#B91C1C' }}>{error}</span></Empty>
            ) : webinars.length === 0 ? (
              <Empty>No webinars yet — click <strong style={{ color: VIOLET }}>+</strong> to add one.</Empty>
            ) : (
              webinars.map((w) => <WebinarCard key={w.id} w={w} now={now} onChanged={load} />)
            )}
          </div>
        </section>
      </div>

      {modalOpen && <CreateWebinarModal onClose={() => setModalOpen(false)} onCreated={handleCreated} />}
    </div>
  );
}

function Empty({ children }) {
  return <p style={{ textAlign: 'center', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', color: 'rgba(91,33,182,0.55)', padding: '48px 0', margin: 0 }}>{children}</p>;
}

function WebinarCard({ w, now, onChanged }) {
  const [open, setOpen]       = useState(false);
  const [detail, setDetail]   = useState(null);
  const [busy, setBusy]       = useState(false);
  const [msg, setMsg]         = useState('');
  const rem = fmtRemaining(w.start_at, now);
  const badge = ZOOM_BADGE[w.zoom_status] || ZOOM_BADGE.pending;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      try {
        const res = await api(`/api/webinars/${w.id}`);
        const d = await res.json();
        setDetail(d);
      } catch { setDetail({ participants: [], chat: [] }); }
    }
  }

  async function sync() {
    setBusy(true); setMsg('');
    try {
      const res = await api(`/api/webinars/${w.id}/sync`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Sync failed.');
      setMsg(`Synced ${d.synced} attendee(s).`);
      setDetail(null); setOpen(true);
      const r2 = await api(`/api/webinars/${w.id}`); setDetail(await r2.json());
      onChanged?.();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', overflow: 'hidden' }}>
      {/* main row, aligned to the header columns */}
      <div style={{ display: 'grid', gridTemplateColumns: GRID_COLS, alignItems: 'center', gap: 12, padding: '16px 28px' }}>
        <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, color: VIOLET_DARK, fontSize: '0.95rem' }}>{w.name}</span>
        <span style={{ fontFamily: 'Outfit, sans-serif', color: '#52456b', fontSize: '0.86rem', textAlign: 'center' }}>{w.batch_name || '—'}</span>
        <span style={{ textAlign: 'center' }}>
          {w.category
            ? <span style={{ background: '#EDE9FE', color: VIOLET, borderRadius: 999, padding: '3px 11px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.74rem' }}>{w.category}</span>
            : <span style={{ color: '#9b8bc0' }}>—</span>}
        </span>
        <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '0.92rem', color: rem.color, textAlign: 'center' }}>{rem.text}</span>
      </div>

      {/* action sub-row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '0 28px 14px', fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem' }}>
        <span style={{ background: badge.bg, color: badge.fg, borderRadius: 999, padding: '3px 10px', fontWeight: 700 }}>{badge.label}</span>
        {w.zoom_join_url && <a href={w.zoom_join_url} target="_blank" rel="noreferrer" style={{ color: VIOLET, fontWeight: 700, textDecoration: 'none' }}>↗ Join link</a>}
        {w.host_id && <span style={{ color: '#7a6aa0' }}>Host: {w.host_id}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={toggle} style={ghost}>{open ? 'Hide attendees' : `Attendees (${w.participant_count ?? 0})`}</button>
        <button onClick={sync} disabled={busy} style={ghost}>{busy ? 'Syncing…' : 'Sync from Zoom'}</button>
      </div>

      {msg && <div style={{ padding: '0 28px 12px', fontFamily: 'Outfit, sans-serif', fontSize: '0.76rem', color: '#6b5a93' }}>{msg}</div>}

      {open && (
        <div style={{ borderTop: '1px solid rgba(124,58,237,0.12)', background: '#FAF8FE', padding: '14px 28px 18px' }}>
          <Attendees detail={detail} />
        </div>
      )}
    </div>
  );
}

function Attendees({ detail }) {
  if (!detail) return <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#7a6aa0', margin: 0 }}>Loading…</p>;
  const parts = detail.participants || [];
  const chat = detail.chat || [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h4 style={hLabel}>Attendees ({parts.length})</h4>
        {parts.length === 0 ? (
          <p style={hint}>No attendee data yet. After the meeting ends, click <strong>Sync from Zoom</strong> to pull name, phone &amp; time-in-meeting.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#7a6aa0' }}>
                <th style={th}>Name</th><th style={th}>Phone</th><th style={th}>Time in meeting</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.id} style={{ borderTop: '1px solid rgba(124,58,237,0.10)' }}>
                  <td style={td}>{p.name || '—'}</td>
                  <td style={td}>{p.phone || '—'}</td>
                  <td style={td}>{fmtDuration(p.duration_sec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <h4 style={hLabel}>Chat messages ({chat.length})</h4>
        {chat.length === 0
          ? <p style={hint}>No chat captured. (Chat needs Zoom cloud-recording “save chat” enabled — wired in a later step.)</p>
          : chat.map((c) => <div key={c.id} style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#52456b', padding: '2px 0' }}><strong>{c.sender_name || 'Guest'}:</strong> {c.message}</div>)}
      </div>
    </div>
  );
}

const ghost   = { border: `1px solid ${VIOLET}`, background: '#fff', color: VIOLET, borderRadius: 9, padding: '6px 12px', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.76rem' };
const hLabel  = { margin: '0 0 6px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.78rem', color: VIOLET_DARK };
const hint    = { margin: 0, fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: '#7a6aa0' };
const th      = { padding: '4px 8px', fontWeight: 700, fontSize: '0.72rem' };
const td      = { padding: '6px 8px', color: '#3B0764' };
