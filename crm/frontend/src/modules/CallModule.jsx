import { useEffect, useMemo } from 'react';
import Lottie from 'lottie-react';

import happyBotRaw from '../assets/bot/robot-happy.json';
import { patchRobotArm } from '../utils/patchRobotArm';

/* Patch the robot-happy Lottie ONCE at module scope so the arm doesn't
   stay pinned at 190° (the raw export has a hardcoded wave pose). The
   same helper is reused by MascotBot.jsx and the cooldown overlay. */
const PATCHED_HAPPY = patchRobotArm(happyBotRaw);

/* Friendly Tanglish + English greeting lines. One is picked per mount
   so each time the caller switches to the Call tab they get a slightly
   different prompt without it feeling random within a single visit. */
const GREETINGS = [
  "Vaa boss, ready ah? Click the button — let's roll!",
  "Indha naal-a kandu kandu adipom — start pannu!",
  "All set? Press Start Call and let me line up your leads.",
  "Energy full-a iruka? Then start pannalaam!",
  "One click → next lead → next sale. Let's go!",
  "Sema day-ku ready? Hit Start Call!",
];

/* Call page — landing page for the caller.
   Renders a happy mascot in the center, a speech bubble above it with a
   short motivational line, and a single Start Call button below. The
   button delegates to CallerShell's `onStartAutoCall` handler which
   navigates to Assigned Leads and kicks off the auto-call sequence. */
export default function CallModule({ onStartAutoCall }) {
  useEffect(() => {
    const prevHtml = document.documentElement.style.overflow;
    const prevBody = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, []);

  const greeting = useMemo(
    () => GREETINGS[Math.floor(Math.random() * GREETINGS.length)],
    []
  );

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: 'calc(100vh - 110px)',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <style>{`
        @keyframes cm-bubble-in {
          from { opacity: 0; transform: translateY(-6px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0)    scale(1); }
        }
        @keyframes cm-bubble-float {
          0%   { transform: translateY(0); }
          50%  { transform: translateY(-4px); }
          100% { transform: translateY(0); }
        }
        @keyframes cm-btn-pulse {
          0%, 100% { box-shadow: 0 6px 20px rgba(91,33,182,0.35), 0 0 0 0 rgba(124,58,237,0.45); }
          50%      { box-shadow: 0 6px 20px rgba(91,33,182,0.35), 0 0 0 14px rgba(124,58,237,0); }
        }
        .cm-btn:hover { transform: scale(1.04); }
        .cm-btn:active { transform: scale(0.97); }
      `}</style>

      {/* Vertical stack: bubble, robot, button. Centered as a column. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
        }}
      >
        {/* Speech bubble — sits above the robot with a small downward tail */}
        <div
          style={{
            position: 'relative',
            background: '#fff',
            color: '#3B0764',
            padding: '14px 22px',
            borderRadius: 22,
            border: '1px solid rgba(209,196,240,0.55)',
            boxShadow: '0 10px 26px rgba(91,33,182,0.16)',
            fontFamily: 'Outfit, sans-serif',
            fontWeight: 600,
            fontSize: '0.98rem',
            maxWidth: 'min(440px, 86vw)',
            textAlign: 'center',
            animation: 'cm-bubble-in 320ms ease-out, cm-bubble-float 4.2s ease-in-out 320ms infinite',
          }}
        >
          {greeting}
          {/* Downward tail */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              bottom: -8,
              left: '50%',
              transform: 'translateX(-50%) rotate(45deg)',
              width: 14,
              height: 14,
              background: '#fff',
              borderRight: '1px solid rgba(209,196,240,0.55)',
              borderBottom: '1px solid rgba(209,196,240,0.55)',
            }}
          />
        </div>

        {/* Robot — happy mascot, larger than the corner one */}
        <div
          aria-hidden="true"
          style={{
            width: 'min(280px, 60vw, 40vh)',
            height: 'min(280px, 60vw, 40vh)',
            pointerEvents: 'none',
          }}
        >
          <Lottie
            animationData={PATCHED_HAPPY}
            loop
            autoplay
            style={{ width: '100%', height: '100%' }}
            rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
          />
        </div>

        {/* Start Call button — pill, violet, pulses softly */}
        <button
          type="button"
          className="cm-btn"
          onClick={() => { if (typeof onStartAutoCall === 'function') onStartAutoCall(); }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 28px',
            borderRadius: 999,
            border: 'none',
            background: 'linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)',
            color: '#fff',
            fontFamily: 'Outfit, sans-serif',
            fontWeight: 800,
            fontSize: '1.02rem',
            letterSpacing: '0.03em',
            cursor: 'pointer',
            transition: 'transform 180ms ease',
            animation: 'cm-btn-pulse 2.4s ease-in-out infinite',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
          Start Call
        </button>
      </div>
    </div>
  );
}
