/**
 * patchRobotArm — fix the bot's "always-raised right arm".
 *
 * The robot-{idle,happy,thinking,sad}.json Lottie files all have layer 0
 * (the right arm, "Arm 2") rotated to ~190° throughout the entire 90-frame
 * loop — so the hand stays up forever. This helper deep-clones the JSON
 * and rewrites the arm's rotation keyframes so it raises briefly mid-loop
 * then rests at the side (~70°) for most of the cycle.
 *
 * Default cycle (90 frames @ 30fps = 3 s):
 *     0   – 25: arm down (~70°)
 *    25  – 45: ramp up
 *    45  – 60: hold wave (~190°)
 *    60  – 85: ramp down
 *    85  – 90: rest
 *
 * The cycle scales proportionally to the source animation's frame count
 * so it Just Works for any 30-fps robot Lottie ≥ 90 frames.
 *
 * Usage:
 *     import idleData from '../assets/bot/robot-idle.json';
 *     const PATCHED_IDLE = patchRobotArm(idleData);
 */
const REST_DEG = 70;
const WAVE_DEG = 190;
const EASE = { o: { x: 0.333, y: 0 }, i: { x: 0.667, y: 1 } };

export function patchRobotArm(rawJson, opts = {}) {
  const { armLayerIndex = 0 } = opts;
  // Structured clone so the imported module is never mutated.
  const clone = JSON.parse(JSON.stringify(rawJson));
  const layer = clone?.layers?.[armLayerIndex];
  if (!layer?.ks?.r || !Array.isArray(layer.ks.r.k)) return clone;

  const total = clone.op - clone.ip;
  // Scale the cycle points proportionally to the layer's frame span so the
  // helper still works on bots with non-90-frame loops.
  const t = (frac) => Math.round(clone.ip + total * frac);
  layer.ks.r.k = [
    { ...EASE, s: [REST_DEG], t: t(0)    },
    { ...EASE, s: [REST_DEG], t: t(0.28) },
    { ...EASE, s: [WAVE_DEG], t: t(0.50) },
    { ...EASE, s: [WAVE_DEG], t: t(0.67) },
    { ...EASE, s: [REST_DEG], t: t(0.95) },
    {          s: [REST_DEG], t: t(1.00) },  // terminator
  ];
  return clone;
}
