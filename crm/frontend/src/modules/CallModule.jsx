import { useEffect, useMemo, useRef, useState } from 'react';
import Lottie from 'lottie-react';
import useRobotNudge from '../hooks/useRobotNudge';
import { useTimerSettings } from '../context/TimerSettingsContext';
import CallStatsPanel from './CallStatsPanel';

// Use the SAME robot the corner MascotBot uses (robot-idle.json) — the
// happy variant + heart-eye overlay didn't land the eyes inside the
// visor, so we fall back to the idle bot which is the default mascot
// appearance across the whole CRM.
import idleBotRaw from '../assets/bot/robot-idle.json';
import { lockArmsDown, normalizeLoop } from '../utils/patchRobotArm';
import { playRobotClip, bindAudioToRobotVolume, ROBOT_CLIP } from '../utils/robotAudio';

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

/* Spoken when the account is paused — same line the old fullscreen overlay
   robot used, now delivered through the Call-page center robot instead. */
const PAUSED_TEXT = 'account pause aaiduchu nanba admin ah contact pannunga';

/* Today's date as an IST YYYY-MM-DD string — gates the once-a-day greeting. */
function todayIstYmd() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/* SpeechBubble — the white bubble (with a downward tail) shown above the
   center robot. Used both for the daily greeting and the idle nudge.
   `fading` swaps the entry/float animation for the greeting's one-shot
   fade-out when its audio ends. Timing values are passed in by the parent
   (which owns the TimerSettings context). */
function SpeechBubble({ children, fading = false, fadeMs, inMs, floatMs }) {
  return (
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
        animation: fading
          ? `cm-bubble-out ${fadeMs}ms ease-out forwards`
          : `cm-bubble-in ${inMs}ms ease-out, cm-bubble-float ${floatMs}ms ease-in-out ${inMs}ms infinite`,
      }}
    >
      {children}
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
  );
}

/* Call page — landing page for the caller.
   Renders a happy mascot in the center, a speech bubble above it with a
   short motivational line, and a single Start Call button below. The
   button delegates to CallerShell's `onStartAutoCall` handler which
   navigates to Assigned Leads and kicks off the auto-call sequence. */

export default function CallModule({ jwt, onStartAutoCall, isActive, robotMessage, assignedCount, tagCounts, callStatus, callActive = false }) {
  const t = useTimerSettings();
  // When the account is paused, the Call page suppresses the fullscreen
  // overlay robot (CallerShell) and shows the paused line through THIS
  // center robot instead — one robot owns every message on the Call page.
  const paused = isActive === false;
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

  /* Daily greeting — shown once per IST day per caller. `mhs_greeting_day_<uid>`
     in localStorage holds the date the greeting was last shown; if that is
     today, no greeting is picked (greeting = null) so it never repeats on
     a re-visit or a re-login. The key naturally resets the next day. */
  const greetingDayKey = useMemo(() => {
    try {
      const [, p] = (jwt || '').split('.');
      const uid = JSON.parse(atob(p || ''))?.user_id;
      return uid ? `mhs_greeting_day_${uid}` : 'mhs_greeting_day_anon';
    } catch { return 'mhs_greeting_day_anon'; }
  }, [jwt]);
  const [greeting, setGreeting] = useState(() => {
    try {
      if (localStorage.getItem(greetingDayKey) === todayIstYmd()) return null;
    } catch { /* sandbox / storage disabled */ }
    return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  });
  // While true the bubble plays its fade-out animation. We delay the
  // actual unmount (`setGreeting(null)`) until the animation has finished
  // so the user sees a smooth opacity ramp instead of a hard pop.
  const [bubbleFading, setBubbleFading] = useState(false);

  /* Stamp today the moment a greeting is picked, so it is not shown again
     until tomorrow (survives re-visits and re-logins via localStorage). */
  useEffect(() => {
    if (!greeting) return;
    try { localStorage.setItem(greetingDayKey, todayIstYmd()); } catch { /* sandbox */ }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!greeting?.audio || isActive !== true) return;  // stay silent while paused / still loading

    const audio = new Audio(greeting.audio);
    // Read the persisted Robot Voice slider AND subscribe to live
    // changes so dragging the volume mid-greeting updates this clip in
    // real time. teardown() runs in the cleanup at the bottom of this
    // effect to detach the listener on unmount.
    const teardownVolBind = bindAudioToRobotVolume(audio);

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
      unmountTimer = setTimeout(() => setGreeting(null), t.greetingBubbleFadeMs);
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
      try { teardownVolBind(); } catch (_) { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, t.greetingBubbleFadeMs]);  // plays once the caller is confirmed active — never while paused

  /* Idle nudge — the caller is parked on the Call page and hasn't pressed
     "Start Call". The corner robot re-asks "nanba irukkiya" every 30 s; after
     5 unanswered nudges (~2.5 min) the account auto-pauses via
     POST /api/caller/self-pause. Same useRobotNudge engine the Assigned-page
     idle nudge uses. */
  const nudgeStorageKey = useMemo(() => {
    try {
      const [, payload] = (jwt || '').split('.');
      const uid = JSON.parse(atob(payload || ''))?.user_id;
      return `mhs_nudge_callpage_${uid || 'anon'}`;
    } catch { return 'mhs_nudge_callpage_anon'; }
  }, [jwt]);

  const { count: idleNudgeCount } = useRobotNudge({
    // Suspend the "never pressed Start Call" idle watchdog while a call is in
    // progress — the caller is on the phone, not idle. useRobotNudge clears its
    // count when active flips false, so it restarts fresh after each call.
    active: isActive === true && !callActive,
    intervalMs: t.robotNudgeIntervalMs,
    maxRepeats: t.autoPauseNudgeCount,
    storageKey: nudgeStorageKey,
    onExhausted: () => {
      fetch('/api/caller/self-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ reason: 'Idle — never pressed Start Call' }),
      }).catch(() => {});
    },
  });

  /* Leaving the Call page (tab switch or "Start Call") unmounts CallModule —
     wipe the deadline anchor so a later return starts a fresh 30 s. A hard
     refresh does NOT run React cleanup, so the anchor survives a reload and a
     caller can't dodge the auto-pause by refreshing. */
  useEffect(() => () => {
    try { localStorage.removeItem(nudgeStorageKey); } catch (_) { /* ignore */ }
  }, [nudgeStorageKey]);

  /* Voice the idle nudge each time it re-asks (clip 40). */
  useEffect(() => {
    if (idleNudgeCount >= 1) playRobotClip(40);
  }, [idleNudgeCount]);

  /* Paused → speak the "contact admin" line through the center robot.
     We play the clip via a raw Audio element (not playRobotClip) because
     CallerShell flips the global pause-mute that turns playRobotClip into a
     no-op; the overlay used to bypass that, and on the Call page this does
     the same. Plays once when paused begins; stops on resume/unmount. */
  useEffect(() => {
    if (!paused) return undefined;
    let audio = null;
    let teardownVol = null;
    try {
      audio = new Audio(ROBOT_CLIP[53]);
      teardownVol = bindAudioToRobotVolume(audio);
      audio.play().catch(() => { /* autoplay blocked — bubble still shows */ });
    } catch { /* ignore */ }
    return () => {
      try { audio && audio.pause(); } catch { /* ignore */ }
      try { teardownVol && teardownVol(); } catch { /* ignore */ }
    };
  }, [paused]);

  /* External robot message — routed up from AssignedLeadsModule (callPageMode)
     so its corner-robot lines (e.g. the post-break "welcome back") show on the
     center robot instead of a separate bottom robot. Shown transiently then
     cleared; each new `key` re-triggers. Suppressed while paused. */
  const [extMsg, setExtMsg] = useState(null);
  const extKeyRef = useRef(null);
  useEffect(() => {
    if (!robotMessage || robotMessage.key == null || robotMessage.key === extKeyRef.current) return undefined;
    extKeyRef.current = robotMessage.key;
    setExtMsg(robotMessage);
    if (robotMessage.clip) { try { playRobotClip(robotMessage.clip); } catch { /* ignore */ } }
    const id = setTimeout(() => setExtMsg(null), t.robotBubbleHideMs || 8000);
    return () => clearTimeout(id);
  }, [robotMessage, t.robotBubbleHideMs]);

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
        gap: 'min(7vw, 110px)',
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
          animation: cm-glow-breathe ${t.glowBreatheInnerMs}ms ease-in-out infinite;
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
          animation: cm-glow-breathe ${t.glowBreatheOuterMs}ms ease-in-out infinite;
        }
        .cm-btn:hover { transform: scale(1.04); }
        .cm-btn:active { transform: scale(0.97); }
      `}</style>

      {/* Left: caller status / stats card — live assigned count, call tag
          counts, and the caller's current status (break countdown / blocked). */}
      <CallStatsPanel jwt={jwt} assignedLeads={assignedCount} counts={tagCounts} status={callStatus} onStartAutoCall={onStartAutoCall} />

      {/* Right: vertical stack — bubble, robot, button. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
        }}
      >
        {/* Speech bubble above the robot. Priority: paused message (persistent)
            → routed external message → idle nudge → daily greeting. The Call
            page funnels every robot line through this one bubble. */}
        {paused ? (
          <SpeechBubble
            fadeMs={t.greetingBubbleFadeMs}
            inMs={t.greetingBubbleInMs}
            floatMs={t.greetingBubbleFloatMs}
          >{PAUSED_TEXT}</SpeechBubble>
        ) : extMsg ? (
          <SpeechBubble
            key={`ext-${extMsg.key}`}
            fadeMs={t.greetingBubbleFadeMs}
            inMs={t.greetingBubbleInMs}
            floatMs={t.greetingBubbleFloatMs}
          >{extMsg.text}</SpeechBubble>
        ) : idleNudgeCount >= 1 ? (
          <SpeechBubble
            key={idleNudgeCount}
            fadeMs={t.greetingBubbleFadeMs}
            inMs={t.greetingBubbleInMs}
            floatMs={t.greetingBubbleFloatMs}
          >nanba irukkingala start call amukunga</SpeechBubble>
        ) : greeting ? (
          <SpeechBubble
            fading={bubbleFading}
            fadeMs={t.greetingBubbleFadeMs}
            inMs={t.greetingBubbleInMs}
            floatMs={t.greetingBubbleFloatMs}
          >{greeting.text}</SpeechBubble>
        ) : null}

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
          className={paused ? '' : 'cm-btn'}
          disabled={paused}
          onClick={() => { if (!paused && typeof onStartAutoCall === 'function') onStartAutoCall(); }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 28px',
            borderRadius: 999,
            border: 'none',
            background: paused
              ? 'rgba(91,33,182,0.35)'
              : 'linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)',
            color: '#fff',
            fontFamily: 'Outfit, sans-serif',
            fontWeight: 800,
            fontSize: '1.02rem',
            letterSpacing: '0.03em',
            cursor: paused ? 'not-allowed' : 'pointer',
            opacity: paused ? 0.7 : 1,
            transition: 'transform 180ms ease',
            animation: paused ? 'none' : `cm-btn-pulse ${t.btnPulseMs}ms ease-in-out infinite`,
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
