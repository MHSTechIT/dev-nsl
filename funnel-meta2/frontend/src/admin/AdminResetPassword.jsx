import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function AdminResetPassword() {
  const navigate = useNavigate();

  const token    = new URLSearchParams(window.location.search).get('token') || '';

  const [newPw, setNewPw]       = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [success, setSuccess]   = useState(false);

  useEffect(() => {
    if (!token) {
      setError('Invalid or missing reset token. Please request a new reset link.');
    }
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (newPw.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (newPw !== confirmPw) { setError('Passwords do not match.'); return; }

    setLoading(true);
    try {
      const res  = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: newPw }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
      } else {
        setSuccess(true);
        /* store new password so the user is auto-logged-in after redirect */
        sessionStorage.setItem('mhs_admin_token', newPw);
        setTimeout(() => navigate('/admin'), 2000);
      }
    } catch {
      setError('Network error. Is the server running?');
    }
    setLoading(false);
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ maxWidth: 'none', background: '#EDEAF8' }}
    >
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
            style={{ background: 'linear-gradient(135deg,#5B21B6,#8B6FEA)' }}
          >
            <span className="font-sans font-bold text-white text-2xl">M</span>
          </div>
          <h1 className="font-sans text-3xl font-bold text-purple-900">Reset Password</h1>
          <p className="font-sans text-sm text-purple-400 mt-1">My Health School · Admin Panel</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-card shadow-card p-6">

          {success ? (
            /* ── Success ── */
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '12px 0 8px' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'linear-gradient(135deg,#5B21B6,#9333EA)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 24px rgba(91,33,182,0.35)' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>
              </div>
              <p style={{ fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '1.1rem', color: '#3B0764', margin: 0 }}>
                Password updated!
              </p>
              <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.82rem', color: 'rgba(91,33,182,0.55)', margin: 0, textAlign: 'center' }}>
                Redirecting you to the admin panel…
              </p>
              <div style={{ display: 'flex', gap: 5 }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#8B5CF6', opacity: 0.5, animation: `pulse 1.2s ${i * 0.2}s infinite` }} />
                ))}
              </div>
            </div>
          ) : (
            /* ── Form ── */
            <>
              {/* Token missing / expired error shown as banner */}
              {!token ? (
                <div style={{ background: 'rgba(254,242,242,0.8)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '14px 16px', marginBottom: 16 }}>
                  <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0, fontWeight: 600 }}>
                    ⚠ Invalid reset link
                  </p>
                  <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.78rem', color: '#ef4444', margin: '4px 0 0' }}>
                    Please go to the login page and click "Forgot password?" again.
                  </p>
                </div>
              ) : (
                <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.83rem', color: 'rgba(91,33,182,0.55)', marginBottom: 18 }}>
                  Enter your new admin password below.
                </p>
              )}

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

                {/* New password */}
                <div>
                  <label style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.76rem', fontWeight: 600, color: '#4A1A94', display: 'block', marginBottom: 5 }}>
                    New Password
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={newPw}
                      onChange={e => setNewPw(e.target.value)}
                      placeholder="Min. 6 characters"
                      disabled={!token}
                      className="field-input"
                      style={{ paddingRight: '2.8rem' }}
                      autoFocus
                    />
                    <button type="button" tabIndex={-1} onClick={() => setShowPw(v => !v)}
                      style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(91,33,182,0.40)', padding: 4 }}>
                      {showPw
                        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                    </button>
                  </div>
                </div>

                {/* Confirm password */}
                <div>
                  <label style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.76rem', fontWeight: 600, color: '#4A1A94', display: 'block', marginBottom: 5 }}>
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    placeholder="Re-enter new password"
                    disabled={!token}
                    className="field-input"
                    style={{ borderColor: confirmPw && confirmPw !== newPw ? 'rgba(248,113,113,0.7)' : undefined }}
                  />
                  {confirmPw && confirmPw !== newPw && (
                    <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.72rem', color: '#EF4444', marginTop: 4 }}>
                      Passwords don't match
                    </p>
                  )}
                </div>

                {error && (
                  <div style={{ background: 'rgba(254,242,242,0.8)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 10, padding: '10px 14px' }}>
                    <p style={{ fontFamily: 'Outfit,sans-serif', fontSize: '0.80rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !token || !newPw || !confirmPw}
                  className="btn-primary"
                  style={{ marginTop: 4 }}
                >
                  {loading
                    ? <span className="flex items-center gap-2">
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                        Saving…
                      </span>
                    : 'Set New Password →'}
                </button>

                <button
                  type="button"
                  onClick={() => navigate('/admin')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'Outfit,sans-serif', fontSize: '0.80rem', color: 'rgba(91,33,182,0.45)', textDecoration: 'underline', marginTop: 2 }}
                >
                  ← Back to login
                </button>
              </form>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
