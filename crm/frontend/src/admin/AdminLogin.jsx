import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

/* Where to send each role after a successful user login */
const ROLE_ROUTE = {
  junior_caller: '/caller/junior',
  senior_caller: '/caller/senior',
  manager:       '/caller/senior',  // placeholder until manager dashboard exists
  trainer:       '/caller/senior',  // placeholder
  admin:         '/caller/senior',  // placeholder
  team_leader:   '/caller/senior',  // placeholder
};

export default function AdminLogin({ onLogin }) {
  const navigate = useNavigate();

  /* mode: 'user' (default) or 'super_admin' */
  const [mode, setMode]           = useState('user');

  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [showPw, setShowPw]       = useState(false);
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);

  /* forgot-password state (super-admin only) */
  const [fpLoading, setFpLoading] = useState(false);
  const [fpSent, setFpSent]       = useState(false);
  const [fpError, setFpError]     = useState('');

  function switchMode(next) {
    setMode(next);
    setError('');
    setFpError('');
    setFpSent(false);
  }

  async function handleSuperAdminSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/leads', {
        headers: { Authorization: `Bearer ${password}` },
      });
      if (res.ok) {
        sessionStorage.setItem('mhs_admin_token', password);
        sessionStorage.removeItem('mhs_crm_user');
        if (onLogin) onLogin(password);
        else navigate('/');
      } else if (res.status === 401) {
        setError('Incorrect password. Please try again.');
      } else {
        setError(`Server error (${res.status}). Try again.`);
      }
    } catch {
      setError('Cannot reach server. Make sure the server is running.');
    }
    setLoading(false);
  }

  async function handleUserSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/crm-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.user) {
        sessionStorage.setItem('mhs_crm_user', JSON.stringify(data.user));
        if (data.token) sessionStorage.setItem('mhs_crm_token', data.token);
        sessionStorage.removeItem('mhs_admin_token');
        const dest = ROLE_ROUTE[data.user.role] || '/caller/junior';
        navigate(dest);
      } else if (res.status === 401) {
        setError(data.error || 'Invalid credentials. Please try again.');
      } else {
        setError(data.error || `Server error (${res.status}). Try again.`);
      }
    } catch {
      setError('Cannot reach server. Make sure the server is running.');
    }
    setLoading(false);
  }

  async function handleForgotPassword() {
    setFpLoading(true);
    setFpError('');
    try {
      const res  = await fetch('/api/auth/forgot-password', { method: 'POST' });
      let data = {};
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) {
        setFpError(data.error || `Server error (${res.status}). Check server logs.`);
      } else {
        setFpSent(true);
      }
    } catch {
      setFpError('Cannot reach server. Is it running?');
    }
    setFpLoading(false);
  }

  const isSuper = mode === 'super_admin';

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ maxWidth: 'none', background: '#EDEAF8' }}
    >
      <div className="w-full max-w-sm">

        {/* Logo — click to switch to Super Admin sign-in */}
        <div className="text-center mb-8">
          <button
            type="button"
            onClick={() => switchMode(isSuper ? 'user' : 'super_admin')}
            title={isSuper ? 'Back to user login' : 'Super Admin sign in'}
            aria-label={isSuper ? 'Back to user login' : 'Super Admin sign in'}
            style={{
              background: 'none', border: 'none', padding: 4, cursor: 'pointer',
              borderRadius: 16, transition: 'transform 200ms, opacity 200ms',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.05)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
          >
            <img
              src="/favicon.png"
              alt="MHS"
              style={{ width: 64, height: 64, objectFit: 'contain', display: 'inline-block' }}
            />
          </button>
        </div>

        {/* Card */}
        <div className="bg-white rounded-card shadow-card p-6">

          {/* Mode header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 10 }}>
            <h2 className="font-sans font-semibold text-gray-700 text-sm" style={{ margin: 0 }}>
              {isSuper ? 'Super Admin Sign In' : 'Sign in to continue'}
            </h2>
            {isSuper && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', borderRadius: 50,
                fontFamily: 'Outfit, sans-serif', fontSize: '0.66rem', fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'rgba(91,33,182,0.10)', color: '#5B21B6',
              }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                Admin
              </span>
            )}
          </div>

          {isSuper ? (
            /* ── Super Admin: password only ── */
            <form onSubmit={handleSuperAdminSubmit} className="space-y-4">
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Admin password"
                  className="field-input"
                  style={{ paddingRight: '2.8rem' }}
                  autoFocus
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw(v => !v)}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(91,33,182,0.40)', padding: 4 }}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                </button>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 font-sans text-red-600 text-sm">
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading || !password} className="btn-primary">
                {loading ? 'Verifying…' : 'Sign In →'}
              </button>

              {/* Forgot + back-to-user links */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 4 }}>
                {fpSent ? (
                  <span style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.78rem', color: '#059669' }}>✓ Reset email sent</span>
                ) : (
                  <button type="button" onClick={handleForgotPassword} disabled={fpLoading}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'Outfit,sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)', textDecoration: 'underline' }}>
                    {fpLoading ? 'Sending…' : 'Forgot password?'}
                  </button>
                )}
                <button type="button" onClick={() => switchMode('user')}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'Outfit,sans-serif', fontSize: '0.78rem', color: '#5B21B6', fontWeight: 600 }}>
                  ← Back to user login
                </button>
              </div>
              {fpError && (
                <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.78rem', color: '#DC2626', margin: 0 }}>{fpError}</p>
              )}
            </form>
          ) : (
            /* ── User: email + password ── */
            <form onSubmit={handleUserSubmit} className="space-y-4">
              {/* Email */}
              <input
                type="email"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Email address"
                className="field-input"
                autoFocus
                autoComplete="username"
                maxLength={200}
                inputMode="email"
              />

              {/* Password */}
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Password"
                  className="field-input"
                  style={{ paddingRight: '2.8rem' }}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw(v => !v)}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(91,33,182,0.40)', padding: 4 }}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                </button>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 font-sans text-red-600 text-sm">
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading || !username || !password} className="btn-primary">
                {loading ? 'Signing in…' : 'Sign In →'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
