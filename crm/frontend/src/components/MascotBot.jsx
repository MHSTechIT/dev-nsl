import { useMemo } from 'react';
import Lottie from 'lottie-react';

import idleData      from '../assets/bot/robot-idle.json';
import happyData     from '../assets/bot/robot-happy.json';
import thinkingData  from '../assets/bot/robot-thinking.json';
import { patchRobotArm } from '../utils/patchRobotArm';

/* All robot Lotties ship with the bot's right arm pinned at ~190°
   (waving) for every frame — patch the rotation so the arm raises briefly
   then rests at the side. Same helper is used everywhere a robot Lottie
   is imported (LeadCallNoteModal, AssignedLeadsModule). */
const PATCHED_IDLE     = patchRobotArm(idleData);
const PATCHED_HAPPY    = patchRobotArm(happyData);
const PATCHED_THINKING = patchRobotArm(thinkingData);

/* Floating mascot in the caller dashboard's bottom-right corner.
   Renders one of three Lottie variants based on `mood`. The full-screen
   celebration moment (after Complete Call) is rendered by the cooldown
   card in AssignedLeadsModule.jsx, not here — this component is *only*
   the small corner mascot. */
const MOOD_MAP = {
  idle:     PATCHED_IDLE,
  happy:    PATCHED_HAPPY,
  thinking: PATCHED_THINKING,
};

export default function MascotBot({ mood = 'idle' }) {
  const animationData = MOOD_MAP[mood] || idleData;
  const loop = mood !== 'happy';

  /* Key on mood so happy can re-trigger cleanly when fired back-to-back. */
  const key = useMemo(() => `mascot-${mood}-${Date.now()}`, [mood]);

  return (
    <div
      aria-hidden="true"
      style={{
        position:      'fixed',
        bottom:        16,
        right:         16,
        zIndex:        9400,  // sits below the post-call cooldown overlay (9500)
        width:         96,
        height:        96,
        background:    'transparent',
        pointerEvents: 'none',
      }}
    >
      <Lottie
        key={key}
        animationData={animationData}
        loop={loop}
        autoplay
        style={{ width: '100%', height: '100%' }}
        rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
      />
    </div>
  );
}
