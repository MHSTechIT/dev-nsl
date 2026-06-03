import { useState, useEffect, useCallback } from 'react';

/* NSM-Caller caller page (route: /nsm-caller)
   -------------------------------------------
   Independent of the Meta caller page (/caller). Logs in against nsm_users via
   /api/nsm-caller/login (scoped JWT) and shows the leads assigned to that
   caller from nsm_leads. The call workflow (dial, notes, robot-nudge) comes in
   later phases. */

const PURPLE = '#5B21B6';
const TOKEN_KEY = 'nsm_caller_token';
const USER_KEY  = 'nsm_caller_user';

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/nsm-caller/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email.trim(), password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Login failed');
      sessionStorage.setItem(TOKEN_KEY, d.token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(d.user));
      onLogin(d.token, d.user);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const input = { width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(139,92,246,0.30)', fontFamily: 'Outfit, sans-serif', fontSize: '0.95rem', color: '#3B0764', outline: 'none', marginBottom: 12 };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#EDEAF8', fontFamily: 'Outfit, sans-serif', padding: 16 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 380, background: '#fff', borderRadius: 20, boxShadow: '0 12px 48px rgba(91,33,182,0.14)', padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <img src="/favicon.png" alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: '1rem', color: '#3B0764' }}>NSM-Caller</div>
            <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>Caller sign in</div>
          </div>
        </div>
        <input style={input} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
        <input style={input} type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
        {error && <div style={{ color: '#DC2626', fontSize: '0.82rem', fontWeight: 600, marginBottom: 12 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ width: '100%', padding: '12px', borderRadius: 12, border: 'none', background: PURPLE, color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.95rem', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function LeadCard({ lead }) {
  const fields = lead.field_data || {};
  const extra = Object.entries(fields).filter(([k]) => {
    const l = k.toLowerCase();
    return !(l.includes('name') || l.includes('phone') || l.includes('email') || l.includes('city'));
  });
  return (
    <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(91,33,182,0.08)', padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '1rem', color: '#3B0764' }}>{lead.full_name || '(no name)'}</div>
          <div style={{ fontSize: '0.85rem', color: PURPLE, fontWeight: 600, marginTop: 2 }}>{lead.phone || '—'}</div>
        </div>
        {lead.phone && (
          <a href={`tel:${lead.phone}`} style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 10, background: PURPLE, color: '#fff', textDecoration: 'none', fontWeight: 700, fontSize: '0.82rem' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            Call
          </a>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 10, fontSize: '0.8rem', color: 'rgba(59,7,100,0.8)' }}>
        {lead.email && <span>✉ {lead.email}</span>}
        {lead.city && <span>📍 {lead.city}</span>}
        {lead.batch_name && <span style={{ color: 'rgba(91,33,182,0.6)' }}>🗂 {lead.batch_name}</span>}
        {lead.created_time && <span style={{ color: 'rgba(91,33,182,0.5)' }}>🕑 {fmtDate(lead.created_time)}</span>}
      </div>
      {extra.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(139,92,246,0.10)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {extra.map(([k, v]) => (
            <div key={k} style={{ fontSize: '0.78rem', color: 'rgba(59,7,100,0.75)' }}>
              <span style={{ color: 'rgba(91,33,182,0.55)', fontWeight: 600 }}>{k.replace(/_/g, ' ').replace(/\?\s*$/, '').trim()}:</span> {v}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NsmCallerShell() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [user, setUser]   = useState(() => { try { return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null'); } catch { return null; } });
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadLeads = useCallback((silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    fetch('/api/nsm-caller/leads', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.status === 401) { logout(); return Promise.reject(new Error('expired')); } return r.ok ? r.json() : Promise.reject(new Error()); })
      .then(d => setLeads(d.leads || []))
      .catch(() => {})
      .finally(() => { if (!silent) setLoading(false); });
  }, [token]);

  useEffect(() => { if (token) loadLeads(); }, [token, loadLeads]);
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => loadLeads(true), 30000);
    return () => clearInterval(t);
  }, [token, loadLeads]);

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    setToken(''); setUser(null);
  }

  if (!token) return <Login onLogin={(t, u) => { setToken(t); setUser(u); }} />;

  return (
    <div style={{ minHeight: '100vh', background: '#EDEAF8', fontFamily: 'Outfit, sans-serif' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 20, background: '#fff', boxShadow: '0 2px 12px rgba(91,33,182,0.08)', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src="/favicon.png" alt="" style={{ width: 34, height: 34, objectFit: 'contain' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: '0.95rem', color: '#3B0764' }}>{user?.full_name || 'Caller'}</div>
          <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>NSM-Caller · {leads.length} assigned lead{leads.length === 1 ? '' : 's'}</div>
        </div>
        <button onClick={logout} style={{ border: 'none', background: 'transparent', color: '#DC2626', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.84rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign Out
        </button>
      </header>

      <main style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.6)' }}>Loading…</div>
        ) : leads.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', background: '#fff', borderRadius: 16 }}>
            No leads assigned to you yet. New leads appear here automatically.
          </div>
        ) : leads.map(l => <LeadCard key={l.id} lead={l} />)}
      </main>
    </div>
  );
}
