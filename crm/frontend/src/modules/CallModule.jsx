import { useEffect, useState } from 'react';
import Lottie from 'lottie-react';

// Use the SAME robot the corner MascotBot uses (robot-idle.json) — the
// happy variant + heart-eye overlay didn't land the eyes inside the
// visor, so we fall back to the idle bot which is the default mascot
// appearance across the whole CRM.
import idleBotRaw from '../assets/bot/robot-idle.json';
import { lockArmsDown, normalizeLoop } from '../utils/patchRobotArm';

// Voice clips — each v1..v10 mp3 is a Tanglish read-aloud of the matching
// greeting text. Vite resolves these imports to hashed URLs at build time
// so we can hand them straight to `new Audio(...)`.
import v1Audio  from '../assets/audio/voice/v1.mp3';
import v2Audio  from '../assets/audio/voice/v2.mp3';
import v3Audio  from '../assets/audio/voice/v3.mp3';
import v4Audio  from '../assets/audio/voice/v4.mp3';
import v5Audio  from '../assets/audio/voice/v5.mp3';
import v6Audio  from '../assets/audio/voice/v6.mp3';
import v7Audio  from '../assets/audio/voice/v7.mp3';
import v8Audio  from '../assets/audio/voice/v8.mp3';
import v9Audio  from '../assets/audio/voice/v9.mp3';
import v10Audio from '../assets/audio/voice/v10.mp3';

// Two passes:
//   1. lockArmsDown — fixes the artist's always-raised right arm and
//      keeps both arms hanging at the sides.
//   2. normalizeLoop — rescales the orbiting-atom precomp keyframes so
//      its 120-frame cycle finishes inside the parent's 90-frame loop.
//      Without this you see a small "snap" every 3 seconds when the
//      atoms reset mid-orbit.
const PATCHED_IDLE = normalizeLoop(lockArmsDown(idleBotRaw));

/* Tanglish greeting pool — text + matching voice clip. One pair is picked
   the FIRST time per IST day per caller (see the useMemo below) so each
   morning feels fresh without nagging the user on every reload. The audio
   plays the same line aloud through the page so the caller hears the
   mascot greet them as soon as the page loads. */
const GREETINGS = [
  { text: 'vanakam boss! full energy oda arambikalama. start call button ah amukkunga',                                audio: v1Audio  },
  { text: 'hello champion! leads ellam waitingla irukku vanga call start pannalam',                                   audio: v2Audio  },
  { text: 'vanakam nanba! fresh minset oda vanthutingala. ippo start call click pannunga',                            audio: v3Audio  },
  { text: 'hey nanba oru nalla opening call pothum innaiku shift mulukka mass agidum call pannlam vaanga',            audio: v4Audio  },
  { text: 'vaanga nanba dail screen ready ippo neenga ready ah start pannunga call pannlam vaanga',                   audio: v5Audio  },
  { text: 'vankam rockstar! unga voice kekka customers wait pannitu irukkanga call pannlam vaanga',                   audio: v6Audio  },
  { text: 'enna nanba! confident full ah irukku pola athe flow la calls ah thodangunga',                              audio: v7Audio  },
  { text: 'vaanga nanba! innaiku target ah mudikura moodla irukkinga pola start call ah amukkunga',                   audio: v8Audio  },
  { text: 'vanakam nanba! smile oda arambicha shift um super ah pogum vaanga call panlam',                            audio: v9Audio  },
  { text: 'vanakam nanba ovvoru callum oru oppurtunities ippove start pannunga',                                      audio: v10Audio },
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

  /* Pick a fresh random `{ text, audio }` pair on every mount of the Call
     page. Using `useState` with a lazy initialiser keeps the selection
     stable across re-renders within a single mount — so the bubble + the
     audio effect below always reference the SAME pick. Lazy init is the
     idiomatic React way to do "run once" work that's safe under StrictMode
     double-invocation in dev. The bubble is hidden the moment the audio
     clip finishes (see audio.ended handler below). */
  const [greeting, setGreeting] = useState(
    () => GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
  );
  // While true the bubble plays its fade-out animation. We delay the
  // actual unmount (`setGreeting(null)`) until the animation has finished
  // so the user sees a smooth opacity ramp instead of a hard pop.
  const [bubbleFading, setBubbleFading] = useState(false);
  const BUBBLE_FADE_MS = 420;

  /* Play the matching voice clip when the bubble appears.
     Chrome blocks `audio.play()` until the page has received a real user
     gesture, so a fresh reload of /call (no click yet) rejects the play
     promise. We handle this by:
       1. Trying to play immediately — works if the user just clicked a
          nav link to land here (gesture still credited).
       2. If that fails, attaching one-shot click/keydown/touch listeners
          to the window. The very first interaction anywhere on the page
          retries the play() call and then removes itself.
     When the clip finishes playing we clear `greeting` so the speech
     bubble disappears — the page returns to the clean robot + Start Call
     look. If autoplay was blocked and the user never interacted, the
     bubble stays visible until they navigate away.
     On unmount we pause the clip and detach the fallback listeners so
     nothing keeps speaking after the caller leaves the page. */
  useEffect(() => {
    if (!greeting?.audio) return;

    const audio = new Audio(greeting.audio);
    audio.volume = 0.9;

    let played = false;
    const tryPlay = () => {
      if (played) return;
      audio.play().then(() => { played = true; }).catch(() => {
        /* still blocked — wait for next interaction */
      });
    };

    // Two-step hide so the bubble has time to play its fade-out:
    //   1. Flip `bubbleFading` → CSS animation drops opacity to 0.
    //   2. After the animation duration, unmount via setGreeting(null).
    let unmountTimer = null;
    const onEnded = () => {
      setBubbleFading(true);
      unmountTimer = setTimeout(() => setGreeting(null), BUBBLE_FADE_MS);
    };
    const onInteract = () => {
      tryPlay();
      if (played) detach();
    };
    const detach = () => {
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('keydown',     onInteract);
      window.removeEventListener('touchstart',  onInteract);
    };

    audio.addEventListener('ended', onEnded);
    tryPlay();                                     // (1) immediate attempt
    window.addEventListener('pointerdown', onInteract);  // (2) fallback
    window.addEventListener('keydown',     onInteract);
    window.addEventListener('touchstart',  onInteract);

    return () => {
      detach();
      audio.removeEventListener('ended', onEnded);
      if (unmountTimer) clearTimeout(unmountTimer);
      try { audio.pause(); audio.currentTime = 0; } catch (_) { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // run once — greeting is set in lazy init and never changes during a mount

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: 'calc(100vh - 110px)',
        // overflow: visible so the robot's soft halo can bleed upward
        // past the wrapper's top edge (the wrapper's top sits right
        // below the tab bar — without this, the glow gets clipped at
        // the top while spreading freely sideways + downward).
        // The page itself stays non-scrollable because document.body
        // is locked via the useEffect below.
        overflow: 'visible',
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
        /* Fade-out used when the greeting audio finishes — softens the
           bubble's exit so it doesn't snap out of existence. */
        @keyframes cm-bubble-out {
          from { opacity: 1; transform: translateY(0)   scale(1); }
          to   { opacity: 0; transform: translateY(-4px) scale(0.98); }
        }
        @keyframes cm-btn-pulse {
          0%, 100% { box-shadow: 0 6px 20px rgba(91,33,182,0.35), 0 0 0 0 rgba(124,58,237,0.45); }
          50%      { box-shadow: 0 6px 20px rgba(91,33,182,0.35), 0 0 0 14px rgba(124,58,237,0); }
        }
        /* Soft violet halo behind the robot — breathes with the mascot.
           Two stacked layers: a tight inner core, a wider diffused glow. */
        @keyframes cm-glow-breathe {
          0%, 100% { opacity: 0.55; transform: translate(-50%, -50%) scale(1);    }
          50%      { opacity: 0.85; transform: translate(-50%, -50%) scale(1.08); }
        }
        .cm-robot-glow-inner {
          position: absolute;
          top: 50%; left: 50%;
          width: 160%; height: 160%;
          transform: translate(-50%, -50%);
          background: radial-gradient(circle at center,
            rgba(167,139,250,0.60) 0%,
            rgba(139,92,246,0.36)  35%,
            rgba(124,58,237,0.14)  60%,
            rgba(124,58,237,0)     78%);
          filter: blur(28px);
          pointer-events: none;
          z-index: 0;
          animation: cm-glow-breathe 4s ease-in-out infinite;
        }
        .cm-robot-glow-outer {
          position: absolute;
          top: 50%; left: 50%;
          width: 260%; height: 260%;
          transform: translate(-50%, -50%);
          background: radial-gradient(circle at center,
            rgba(124,58,237,0.34) 0%,
            rgba(91,33,182,0.20)  35%,
            rgba(91,33,182,0.08)  60%,
            rgba(91,33,182,0)     80%);
          filter: blur(70px);
          pointer-events: none;
          z-index: 0;
          animation: cm-glow-breathe 6s ease-in-out infinite;
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
        {/* Speech bubble — sits above the robot with a small downward
            tail. Only renders on the user's FIRST visit of the IST day;
            the greeting useMemo returns null on subsequent reloads
            (until midnight IST) so the page stays clean. */}
        {greeting && (
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
              // While fading we OVERRIDE the entry/float animations with a
              // single one-shot fade-out that ends at opacity 0. `forwards`
              // makes the final state stick so the bubble doesn't snap back
              // before the unmount timer fires.
              animation: bubbleFading
                ? `cm-bubble-out ${BUBBLE_FADE_MS}ms ease-out forwards`
                : 'cm-bubble-in 320ms ease-out, cm-bubble-float 4.2s ease-in-out 320ms infinite',
            }}
          >
            {greeting.text}
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
        )}

        {/* Robot — happy mascot, larger than the corner one. Wrapped in a
            positioned container so the two soft glow layers sit BEHIND it
            via z-index. */}
        <div
          aria-hidden="true"
          style={{
            position: 'relative',
            width: 'min(420px, 80vw, 55vh)',
            height: 'min(420px, 80vw, 55vh)',
            pointerEvents: 'none',
          }}
        >
          {/* Outer wide-spread halo */}
          <div className="cm-robot-glow-outer" />
          {/* Inner brighter glow */}
          <div className="cm-robot-glow-inner" />
          <Lottie
            animationData={PATCHED_IDLE}
            loop
            autoplay
            style={{ width: '100%', height: '100%', position: 'relative', zIndex: 1 }}
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
