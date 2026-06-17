import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import Lottie from 'lottie-react';
import trophyAnim from '../assets/trophy.json';

/* CallStatsPanel — glossy status card for the LEFT of the Call page.
   Shows the caller's live status (break countdown / blocked reason), the real
   assigned-leads count, and per-tag call counts. Target / Touched stay as
   placeholders until their logic is wired. */

/* Format a count as a 3-digit padded string ("7" → "007"). */
const fmtCount = (v) => (v == null || v === '' ? '000' : String(v).padStart(3, '0'));

// Violet glow matching the robot's background halo (#A78BFA).
const VIOLET_GLOW = 'rgba(167,139,250,0.55)';
const SH_DARK     = 'rgba(124,58,237,0.18)';
// Card: ambient violet halo + soft violet depth shadow.
const cardGlow = `0 0 80px 6px rgba(167,139,250,0.40), 0 22px 50px rgba(91,33,182,0.22), -10px -10px 40px ${VIOLET_GLOW}`;
// Inner glossy elements: soft violet drop + inner top highlight.
const glossShadow = '0 10px 22px rgba(91,33,182,0.16), inset 0 1px 0 rgba(255,255,255,0.85)';

const INK   = '#3B0764';                 // primary number ink
const MUTED = 'rgba(91,33,182,0.55)';    // labels

/* ── Tile icons (inherit the tile's text colour via currentColor) ── */
function tileIcon(id) {
  const p = { width: 14, height: 14, viewBox: '0 0 24 24', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (id) {
    case 'hot': // flame
      return <svg {...p} fill="currentColor" stroke="none"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>;
    case 'warm': // sun
      return <svg {...p} fill="none" stroke="currentColor"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>;
    case 'cold': // snowflake
      return <svg {...p} fill="none" stroke="currentColor"><path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/></svg>;
    case 'junk': // trash
      return <svg {...p} fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>;
    case 'followup': // up arrow
      return <svg {...p} fill="none" stroke="currentColor"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>;
    case 'dnp': // banned / no
      return <svg {...p} fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>;
    default:
      return null;
  }
}

// Vivid glossy two-tone tiles.
const TILES = [
  { id: 'hot',      label: 'HOT',       from: '#FF7B7B', to: '#E03131', fg: '#fff',     glow: 'rgba(224,49,49,0.40)' },
  { id: 'warm',     label: 'WARM',      from: '#FFE066', to: '#F4B400', fg: '#5A3E00', glow: 'rgba(244,180,0,0.40)' },
  { id: 'cold',     label: 'COLD',      from: '#45E3D1', to: '#0FA89A', fg: '#fff',     glow: 'rgba(15,168,154,0.40)' },
  { id: 'junk',     label: 'JUNK',      from: '#BCC3CC', to: '#868E98', fg: '#fff',     glow: 'rgba(134,142,152,0.40)' },
  { id: 'followup', label: 'FOLLOW-UP', from: '#4DE3A6', to: '#0F9D63', fg: '#fff',     glow: 'rgba(15,157,99,0.40)' },
  { id: 'dnp',      label: 'DNP',       from: '#F6F8FA', to: '#D6DCE3', fg: '#475569', glow: 'rgba(148,163,184,0.35)' },
];

/* ── Stat-box icons ── */
const ICON_ASSIGNED = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
  </svg>
);
const ICON_TARGET = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
  </svg>
);

/* Glossy top-sheen overlay across the top of a chip. */
function Sheen({ radius = 16 }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '50%',
        borderTopLeftRadius: radius, borderTopRightRadius: radius,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.04) 100%)',
        pointerEvents: 'none',
      }}
    />
  );
}

/* Soft round icon badge (light violet bg). */
function IconBadge({ children, size = 42 }) {
  return (
    <span style={{
      flexShrink: 0, width: size, height: size, borderRadius: '50%',
      background: 'rgba(124,58,237,0.10)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      position: 'relative',
    }}>
      {children}
    </span>
  );
}

/* Glossy stat box (Assigned Leads / Target) — now with a leading icon. */
function StatBox({ label, value, icon }) {
  return (
    <div
      style={{
        position: 'relative', overflow: 'hidden',
        background: 'linear-gradient(160deg, #FBF8FF 0%, #E9DEFb 100%)',
        border: '1px solid rgba(255,255,255,0.7)',
        borderRadius: 20,
        padding: '11px 16px',
        display: 'flex', flexDirection: 'column', gap: 5,
        boxShadow: glossShadow,
      }}
    >
      <Sheen radius={20} />
      {/* Icon + heading in one row */}
      <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
        <IconBadge>{icon}</IconBadge>
        <span style={{ fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.10em', color: MUTED }}>{label}</span>
      </span>
      {/* Number below */}
      <span style={{ position: 'relative', fontSize: '1.8rem', fontWeight: 800, color: INK, letterSpacing: '0.06em' }}>{value}</span>
    </div>
  );
}

/* Outlined trophy that fills with purple "water" up to `percent` — a clean cup
   with side handles, a stem and a two-tier base (matches the reference icon).
   Only the BOWL fills; the % sits in the bowl, switching to white once covered. */
const BOWL_PATH = 'M30 26 H70 V46 C70 64 62 72 50 72 C38 72 30 64 30 46 Z';
const BOWL_TOP = 26, BOWL_BOT = 72;

function TrophyFill({ percent = 0, size = 190 }) {
  const target = Math.max(0, Math.min(100, percent));
  const [fillPct, setFillPct] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setFillPct(target), 90); // animate 0 → target on mount/change
    return () => clearTimeout(id);
  }, [target]);
  const fillY = BOWL_BOT - (BOWL_BOT - BOWL_TOP) * (fillPct / 100); // water surface (viewBox units)
  const overHalf = fillPct > 50;                                    // water covers the centre → white %
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 100 120" style={{ filter: 'drop-shadow(0 6px 10px rgba(124,58,237,0.30))' }}>
        <defs>
          <clipPath id="cs-trophy-clip"><path d={BOWL_PATH} /></clipPath>
          <linearGradient id="cs-trophy-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#A78BFA" />
            <stop offset="100%" stopColor="#6D28D9" />
          </linearGradient>
        </defs>
        {/* bowl: empty tint + rising water */}
        <g clipPath="url(#cs-trophy-clip)">
          <rect x="0" y="0" width="100" height="120" fill="rgba(124,58,237,0.12)" />
          <rect x="0" y={fillY} width="100" height="120" fill="url(#cs-trophy-grad)" style={{ transition: 'y 1100ms cubic-bezier(.22,1,.36,1)' }} />
          <rect x="0" y={fillY} width="100" height="2" fill="rgba(255,255,255,0.55)" style={{ transition: 'y 1100ms cubic-bezier(.22,1,.36,1)' }} />
        </g>
        {/* outline — rim, bowl, handles, stem, two-tier base */}
        <g fill="none" stroke="#7C3AED" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M26 26 H74" />
          <path d={BOWL_PATH} />
          <path d="M30 29 H20 Q13 29 13 36 V43 Q13 50 20 50 H30" />
          <path d="M70 29 H80 Q87 29 87 36 V43 Q87 50 80 50 H70" />
          <path d="M50 72 V84" />
          <path d="M42 84 H58 V94 H42 Z" />
          <path d="M33 94 H67 V106 H33 Z" />
        </g>
      </svg>
      <span style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transform: 'translateY(-18%)',   // sit inside the bowl, above the stem/base
        fontSize: Math.round(size * 0.15), fontWeight: 800,
        color: overHalf ? '#fff' : '#5B21B6',
        textShadow: overHalf ? '0 1px 3px rgba(0,0,0,0.30)' : 'none',
        transition: 'color 400ms',
      }}>
        {Math.round(target)}%
      </span>
    </div>
  );
}

export default function CallStatsPanel({
  jwt,
  assignedLeads,
  target = '001',
  touchedPercent = 70,
  counts = {},
  status = { kind: 'active' },
  onStartAutoCall,
}) {
  /* Daily target progress drives BOTH the TARGET box (the goal number) and the
     TOUCHED trophy (% fill → animates at 100%). Polled from the caller endpoint;
     replaces the separate target cup that used to sit on the Call page. */
  const [dt, setDt] = useState(null);   // { target, attempts_today, done }
  useEffect(() => {
    if (!jwt) return undefined;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/caller/daily-target', { headers: { Authorization: `Bearer ${jwt}` } });
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled) setDt(d);
      } catch { /* keep last value */ }
    }
    load();
    const id = setInterval(load, 15000);
    // Refetch the instant a call completes (note saved → mhs:activity:changed)
    // so the TOUCHED % updates right when the call finishes — that's what makes
    // the 100% trophy celebration fire after the call ends, within the
    // following 5-second cooldown, instead of lagging up to a poll interval.
    const onActivity = () => load();
    window.addEventListener('mhs:activity:changed', onActivity);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener('mhs:activity:changed', onActivity); };
  }, [jwt]);
  const tgtNum = dt && dt.target ? dt.target : 0;
  const effectiveTarget = tgtNum > 0 ? String(tgtNum).padStart(3, '0') : target;
  // Override touchedPercent with real progress (attempts / target). 0 when no
  // target is set, so the trophy just sits empty rather than celebrating.
  touchedPercent = tgtNum > 0 ? Math.min(100, Math.round(((dt.attempts_today || 0) / tgtNum) * 100)) : 0;
  // 1-second tick — only runs while on a break, to animate the countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status?.kind !== 'break') return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status?.kind, status?.endsAt]);

  /* ── 100% celebration ──────────────────────────────────────────────────
     When TOUCHED hits 100%, a trophy Lottie launches FROM the card's trophy
     icon, flies to screen-centre while growing large, and the page behind it
     blurs. Fires once per crossing into 100 (resets when it drops below). */
  const trophyRef = useRef(null);     // the in-card trophy icon
  const lottieRef = useRef(null);     // the flying trophy animation instance
  const cardTrophyRef = useRef(null); // the resting in-card trophy (frozen on last frame)
  const firedRef  = useRef(false);
  const [celebrate, setCelebrate] = useState(null); // { from:{top,left,width,height} } | null
  const [big, setBig] = useState(false);
  const [show, setShow] = useState(false);          // opacity: fade in at start, fade out at end

  useEffect(() => {
    const pct = Number(touchedPercent) || 0;
    if (pct < 100) { firedRef.current = false; return; }
    if (pct >= 100 && !firedRef.current) {
      firedRef.current = true;
      const el = trophyRef.current;
      const r = el ? el.getBoundingClientRect() : { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 104, height: 104 };
      setBig(false); setShow(false);
      setCelebrate({ from: { top: r.top, left: r.left, width: r.width, height: r.height } });
      // next frame → fade in + animate to centre + blur in
      requestAnimationFrame(() => requestAnimationFrame(() => { setBig(true); setShow(true); }));
    }
  }, [touchedPercent]);

  // Fade out (and drift back toward the icon), then remove.
  function dismissCelebrate() { setShow(false); setBig(false); setTimeout(() => setCelebrate(null), 700); }

  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const bigSize = Math.min(460, winW * 0.7, winH * 0.7);
  const flyStyle = celebrate && (big
    ? { top: winH / 2, left: winW / 2, width: bigSize, height: bigSize, transform: 'translate(-50%, -50%)' }
    : { top: celebrate.from.top, left: celebrate.from.left, width: celebrate.from.width, height: celebrate.from.height, transform: 'translate(0,0)' });

  // Banner appearance + text driven by the caller's current status.
  const banner = (() => {
    if (status?.kind === 'blocked') {
      return {
        bg: 'linear-gradient(160deg, #FFE2E2 0%, #FCA5A5 100%)',
        iconBg: 'linear-gradient(135deg, #EF4444 0%, #B91C1C 100%)',
        title: 'ACCOUNT BLOCKED',
        sub: status.reason || 'Contact admin',
      };
    }
    if (status?.kind === 'break' && status.endsAt) {
      const ms = status.endsAt - now;
      const over = ms < 0;
      const secs = Math.floor(Math.abs(ms) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      return {
        bg: over ? 'linear-gradient(160deg, #FFE0CC 0%, #FCA5A5 100%)'
                 : 'linear-gradient(160deg, #FEF3C7 0%, #FCD9A5 100%)',
        iconBg: over ? 'linear-gradient(135deg, #EF4444 0%, #B91C1C 100%)'
                     : 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
        title: (status.reason || 'On Break').toUpperCase(),
        sub: over ? `OVERRUN +${mm}:${ss}` : `${mm}:${ss} remaining`,
      };
    }
    return {
      bg: 'linear-gradient(160deg, #F3ECFF 0%, #DECFFb 100%)',
      iconBg: 'linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%)',
      title: 'STATUS OF THE CALLER',
      sub: 'Available — no break active',
    };
  })();
  return (
    <div
      style={{
        position: 'relative',
        width: 'min(600px, 50vw)',
        background: 'linear-gradient(165deg, #FAF7FF 0%, #EFE7FC 100%)',
        borderRadius: 30,
        border: '1px solid rgba(255,255,255,0.75)',
        padding: 18,
        display: 'flex', flexDirection: 'column', gap: 12,
        fontFamily: 'Outfit, sans-serif',
        boxShadow: cardGlow,
      }}
    >
      {/* Live status banner — colour + text follow the caller's status
          (available / break countdown / blocked reason). */}
      <div
        style={{
          position: 'relative', overflow: 'hidden',
          background: banner.bg,
          border: '1px solid rgba(255,255,255,0.7)',
          borderRadius: 18,
          padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 14,
          color: INK, lineHeight: 1.35,
          boxShadow: glossShadow,
          transition: 'background 300ms',
        }}
      >
        <Sheen radius={18} />
        <span style={{
          position: 'relative', flexShrink: 0, width: 46, height: 46, borderRadius: '50%',
          background: banner.iconBg,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 6px 14px rgba(91,33,182,0.30)',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
        </span>
        <span style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: '0.84rem', fontWeight: 800, letterSpacing: '0.03em', color: INK }}>{banner.title}</span>
          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'rgba(59,7,100,0.62)' }}>{banner.sub}</span>
        </span>
        {/* Resume button — only while on break. Routes through onStartAutoCall
            (→ pendingAutoStart) which ends the break + restarts auto-call.
            Replaces the old full-screen break overlay's button. */}
        {status?.kind === 'break' && typeof onStartAutoCall === 'function' && (
          <button
            type="button"
            onClick={onStartAutoCall}
            style={{
              position: 'relative', marginLeft: 'auto', flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', gap: 7,
              height: '2.3rem', padding: '0 16px', borderRadius: 50, border: 'none',
              background: '#059669', color: '#fff',
              fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '0.82rem',
              cursor: 'pointer', boxShadow: '0 6px 16px rgba(5,150,105,0.35)',
              whiteSpace: 'nowrap',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start Auto-Call
          </button>
        )}
      </div>

      {/* Two columns: stacked stat boxes | touched ring */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <StatBox label="ASSIGNED LEADS" value={fmtCount(assignedLeads)} icon={ICON_ASSIGNED} />
          <StatBox label="TARGET" value={effectiveTarget} icon={ICON_TARGET} />
        </div>
        <div
          style={{
            position: 'relative', overflow: 'hidden',
            background: 'linear-gradient(160deg, #F8F3FF 0%, #ECE1FB 100%)',
            border: '1px solid rgba(255,255,255,0.7)',
            borderRadius: 20,
            padding: '12px 12px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0,
            boxShadow: glossShadow,
          }}
        >
          <Sheen radius={20} />
          <span style={{ position: 'relative', fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.10em', color: MUTED }}>
            TOUCHED
          </span>
          <div ref={trophyRef} style={{ position: 'relative' }}>
            {Number(touchedPercent) >= 100 ? (
              <div style={{ width: 'min(280px, 22vw)', height: 'min(280px, 22vw)', marginTop: -40, marginBottom: -40 }}>
                <Lottie
                  lottieRef={cardTrophyRef}
                  animationData={trophyAnim}
                  loop={false}
                  autoplay={false}
                  onDOMLoaded={() => { const a = cardTrophyRef.current; if (a) a.goToAndStop(Math.max(0, a.getDuration(true) - 1), true); }}
                  style={{ width: '100%', height: '100%' }}
                />
              </div>
            ) : (
              <TrophyFill percent={touchedPercent} />
            )}
          </div>
        </div>
      </div>

      {/* Vivid glossy tag tiles — wider, and horizontally scrollable inside
          the card (overflow row with a thin styled scrollbar). Each tile now
          carries its matching icon next to the label. */}
      <style>{`
        .cs-tiles-scroll::-webkit-scrollbar { height: 6px; }
        .cs-tiles-scroll::-webkit-scrollbar-thumb { background: rgba(124,58,237,0.28); border-radius: 999px; }
        .cs-tiles-scroll::-webkit-scrollbar-track { background: transparent; }
      `}</style>
      <div
        className="cs-tiles-scroll"
        style={{
          display: 'flex',
          gap: 12,
          overflowX: 'auto',
          paddingBottom: 6,
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(124,58,237,0.28) transparent',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {TILES.map(tile => (
          <div
            key={tile.id}
            style={{
              position: 'relative', overflow: 'hidden',
              flexShrink: 0,
              width: 104,
              background: `linear-gradient(165deg, ${tile.from} 0%, ${tile.to} 100%)`,
              color: tile.fg,
              borderRadius: 16,
              padding: '10px 6px',
              textAlign: 'center',
              display: 'flex', flexDirection: 'column', gap: 6,
              border: '1px solid rgba(255,255,255,0.35)',
              boxShadow: `0 9px 18px ${tile.glow}, inset 0 1px 0 rgba(255,255,255,0.55)`,
            }}
          >
            <Sheen radius={16} />
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.03em', lineHeight: 1.1 }}>
              {tileIcon(tile.id)}
              {tile.label}
            </span>
            <span style={{ position: 'relative', fontSize: '1.15rem', fontWeight: 800 }}>
              {fmtCount(counts[tile.id] ?? 0)}
            </span>
          </div>
        ))}
      </div>

      {/* 100% trophy celebration — portaled to <body> so the trophy can travel
          from the card to centre. NO backdrop blur/dim and pointerEvents:none so
          the celebration never disturbs or blocks the cards behind it; it just
          flies, plays once, and auto-dismisses. */}
      {celebrate && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 99999, pointerEvents: 'none' }}>
          {/* flying + growing trophy — fades in at start, fades out at end */}
          <div style={{
            position: 'fixed', ...flyStyle,
            opacity: show ? 1 : 0,
            transition: 'opacity 550ms ease, top 950ms cubic-bezier(.2,.9,.25,1), left 950ms cubic-bezier(.2,.9,.25,1), width 950ms cubic-bezier(.2,.9,.25,1), height 950ms cubic-bezier(.2,.9,.25,1), transform 950ms cubic-bezier(.2,.9,.25,1)',
            filter: 'drop-shadow(0 20px 50px rgba(124,58,237,0.45))',
            willChange: 'opacity,top,left,width,height,transform',
          }}>
            <Lottie
              lottieRef={lottieRef}
              animationData={trophyAnim}
              loop={false}
              autoplay
              onDOMLoaded={() => lottieRef.current?.setSpeed(0.5)}
              onComplete={() => setTimeout(dismissCelebrate, 600)}
              style={{ width: '100%', height: '100%' }}
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
