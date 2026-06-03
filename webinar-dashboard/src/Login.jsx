import { useState } from 'react';
import { api, setSession } from './api';

/* Login — split layout (illustrated white panel + curved edge on the left,
   form on the right over a deep-purple background), styled to match the app's
   brand. CRM staff sign in with their CRM email/username + password; the
   backend (:3005) validates against the shared crm_users table. */

const PURPLE      = '#5B21B6';
const PURPLE_DARK = '#2D1065';
const INK         = '#3B0764';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [showForgot, setShowForgot] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) { setError('Username and password are required.'); return; }
    setLoading(true);
    try {
      const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: username.trim(), password }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Login failed.');
      setSession(d.token, d.user);
      onLogin?.(d.user);
    } catch (e2) {
      setError(e2.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={page}>
      <style>{`
        @media (max-width: 880px) {
          .wd-left { display: none !important; }
          .wd-right { flex: 1 1 100% !important; }
        }
      `}</style>

      {/* ── Left: white panel with illustration + organic curved right edge ── */}
      <div className="wd-left" style={leftPanel}>
        <div style={logoRow}>
          <img src="/favicon.png" alt="MHS" style={{ width: 34, height: 34, objectFit: 'contain' }} />
          <div style={{ lineHeight: 1.1 }}>
            <div style={{ fontWeight: 800, fontSize: '0.95rem', color: INK, letterSpacing: '0.02em' }}>MY HEALTH SCHOOL</div>
            <div style={{ fontWeight: 600, fontSize: '0.72rem', color: 'rgba(91,33,182,0.6)', letterSpacing: '0.14em' }}>WEBINAR DASHBOARD</div>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px 40px' }}>
          <Illustration />
        </div>

        <div style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', color: 'rgba(91,33,182,0.45)' }}>
          © 2026 My Health School &nbsp;·&nbsp; Powered by MHS
        </div>
      </div>

      {/* ── Right: form over deep-purple background ── */}
      <div className="wd-right" style={rightPanel}>
        {/* decorative bubbles */}
        <span style={bubble(420, -60, 220, 0.06)} />
        <span style={bubble(-80, 380, 180, 0.05)} />
        <span style={bubble(260, 460, 90, 0.08)} />

        <form onSubmit={submit} style={formWrap}>
          <h1 style={{ margin: '0 0 22px', fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '2.6rem', color: '#fff', letterSpacing: '0.01em' }}>Login</h1>

          <label style={lbl}>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter your username" autoFocus style={inp} />

          <label style={{ ...lbl, marginTop: 16 }}>Password</label>
          <div style={{ position: 'relative' }}>
            <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" style={{ ...inp, paddingRight: 60 }} />
            <button type="button" onClick={() => setShowPw((s) => !s)} style={showBtn}>{showPw ? 'Hide' : 'Show'}</button>
          </div>

          <div style={{ textAlign: 'right', marginTop: 8 }}>
            <button type="button" onClick={() => setShowForgot((s) => !s)} style={linkBtn}>Forgot Password?</button>
          </div>
          {showForgot && (
            <div style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.76rem', color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>
              Password resets are managed in the CRM — contact your admin.
            </div>
          )}

          {error && <div style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#FCA5A5', marginTop: 12 }}>{error}</div>}

          <button type="submit" disabled={loading} style={{ ...submitBtn, opacity: loading ? 0.6 : 1 }}>
            {loading ? 'Signing in…' : 'Login to Dashboard'}
          </button>

          <div style={{ textAlign: 'center', marginTop: 18, fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)' }}>
            Need an account? <span style={{ color: '#C4B5FD', fontWeight: 600 }}>Ask your CRM admin</span>
          </div>
        </form>

        <div style={rightFooter}>Have a problem? Contact your admin.</div>
      </div>
    </div>
  );
}

/* Purple webinar-themed illustration (stands in for the reference artwork). */
function Illustration() {
  return (
    <svg viewBox="0 0 440 380" width="100%" style={{ maxWidth: 440 }} role="img" aria-label="Webinar illustration">
      {/* soft background blobs */}
      <ellipse cx="220" cy="210" rx="200" ry="160" fill="#F1ECFB" />
      <ellipse cx="160" cy="250" rx="140" ry="100" fill="#E7DEFA" />
      <ellipse cx="300" cy="150" rx="90" ry="80" fill="#EDE6FB" />

      {/* floating attendee bubbles */}
      <circle cx="360" cy="120" r="20" fill="#C4B5FD" />
      <circle cx="360" cy="120" r="20" fill="none" stroke="#8B5CF6" strokeWidth="2" />
      <path d="M352 120 a8 8 0 0 1 16 0 q0 6 -8 10 q-8 -4 -8 -10z" fill="#fff" opacity="0.9" />
      <circle cx="86" cy="120" r="14" fill="#DDD6FE" />
      <circle cx="395" cy="250" r="10" fill="#A78BFA" />
      <circle cx="70" cy="250" r="8" fill="#A78BFA" />

      {/* presentation screen */}
      <g>
        <rect x="120" y="96" width="200" height="132" rx="14" fill="#6D28D9" />
        <rect x="120" y="96" width="200" height="26" rx="13" fill="#5B21B6" />
        <circle cx="135" cy="109" r="3.5" fill="#fff" opacity="0.55" />
        <circle cx="147" cy="109" r="3.5" fill="#fff" opacity="0.4" />
        <circle cx="159" cy="109" r="3.5" fill="#fff" opacity="0.3" />
        {/* play triangle */}
        <circle cx="220" cy="170" r="30" fill="#fff" opacity="0.16" />
        <polygon points="211,156 211,184 236,170" fill="#fff" />
        {/* stand */}
        <rect x="208" y="228" width="24" height="16" fill="#5B21B6" />
        <rect x="178" y="244" width="84" height="8" rx="4" fill="#5B21B6" />
      </g>

      {/* presenter figure */}
      <g>
        <circle cx="96" cy="196" r="16" fill="#3B0764" />
        <path d="M72 252 q0 -28 24 -28 q24 0 24 28 z" fill="#4C1D95" />
        <rect x="118" y="206" width="34" height="6" rx="3" fill="#3B0764" transform="rotate(-18 118 206)" />
      </g>

      {/* sparkles */}
      <path d="M330 290 l3 7 l7 3 l-7 3 l-3 7 l-3 -7 l-7 -3 l7 -3z" fill="#8B5CF6" />
      <path d="M120 300 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 l5 -2z" fill="#A78BFA" />
    </svg>
  );
}

/* ── styles ───────────────────────────────────────────────────────────────── */
const page = { minHeight: '100vh', display: 'flex', background: `linear-gradient(160deg, ${PURPLE_DARK} 0%, #25104f 55%, #1c0c3d 100%)`, fontFamily: 'Outfit, sans-serif', overflow: 'hidden' };
const leftPanel = {
  flex: '0 0 56%', background: '#fff', position: 'relative', display: 'flex', flexDirection: 'column',
  padding: '30px 34px', boxSizing: 'border-box',
  borderRadius: '0 42% 42% 0 / 0 50% 50% 0',
  boxShadow: '40px 0 80px rgba(20,4,50,0.35)',
};
const logoRow = { display: 'flex', alignItems: 'center', gap: 11, fontFamily: 'Outfit, sans-serif' };
const rightPanel = { flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px clamp(28px, 6vw, 80px)', boxSizing: 'border-box' };
const formWrap = { width: '100%', maxWidth: 340, position: 'relative', zIndex: 2 };
const lbl = { display: 'block', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.9rem', color: '#fff', marginBottom: 7 };
const inp = {
  width: '100%', boxSizing: 'border-box', borderRadius: 9, padding: '13px 14px',
  background: 'rgba(20,6,45,0.55)', border: '1px solid rgba(255,255,255,0.14)',
  color: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem', outline: 'none',
};
const showBtn = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', color: '#C4B5FD', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontSize: '0.74rem', fontWeight: 700 };
const linkBtn = { border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.65)', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', textDecoration: 'underline', padding: 0 };
const submitBtn = { width: '100%', marginTop: 22, border: 'none', borderRadius: 10, padding: '14px', cursor: 'pointer', color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.95rem', background: 'linear-gradient(135deg, #8B5CF6, #6D28D9)', boxShadow: '0 10px 26px rgba(109,40,217,0.5)' };
const rightFooter = { position: 'absolute', bottom: 22, right: 'clamp(28px, 6vw, 80px)', fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)' };
const bubble = (top, left, size, op) => ({ position: 'absolute', top, left, width: size, height: size, borderRadius: '50%', background: `rgba(255,255,255,${op})`, pointerEvents: 'none' });
