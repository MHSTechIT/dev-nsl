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
  const {
    armLayerIndex = 0,
    // When `static` is true, the arm is LOCKED at `staticDeg` for the
    // entire loop — no wave animation. Used by the big CallModule robot
    // where the swinging arm was visually distracting. Leave false for
    // the corner mascot / cooldown celebration where the wave matters.
    static: staticLock = false,
    staticDeg = REST_DEG,
    // When `flipX` is true, the layer's scale X is negated so the arm
    // is horizontally mirrored. Use on the left arm to make it visually
    // mirror the right arm (both Lottie arm layers were exported in the
    // same orientation; without flipping, they look identical instead
    // of mirrored).
    flipX = false,
  } = opts;
  // Structured clone so the imported module is never mutated.
  const clone = JSON.parse(JSON.stringify(rawJson));
  const layer = clone?.layers?.[armLayerIndex];
  if (!layer?.ks?.r) return clone;

  if (flipX && layer.ks.s) {
    // Scale is usually a non-animated [x, y, z] array. Flip X by
    // negating the first component. Handle both shapes:
    //   { a: 0, k: [100, 100, 100] }
    //   { a: 1, k: [{ s: [100, 100, 100], t: 0 }, ...] }
    const s = layer.ks.s;
    if (Array.isArray(s.k) && typeof s.k[0] === 'number') {
      s.k = [-Math.abs(s.k[0]), s.k[1], s.k[2]];
    } else if (Array.isArray(s.k)) {
      for (const kf of s.k) {
        if (kf && Array.isArray(kf.s)) {
          kf.s = [-Math.abs(kf.s[0]), kf.s[1], kf.s[2]];
        }
      }
    }
  }

  if (!Array.isArray(layer.ks.r.k) && !staticLock) return clone;

  const total = clone.op - clone.ip;
  // Scale the cycle points proportionally to the layer's frame span so the
  // helper still works on bots with non-90-frame loops.
  const t = (frac) => Math.round(clone.ip + total * frac);

  if (staticLock) {
    // Flip the property from "animated" (a:1, k=keyframes[]) to
    // "non-animated" (a:0, k=number). With a:0 Lottie treats `k` as a
    // fixed value and applies no interpolation — the arm truly sits at
    // exactly staticDeg for the entire loop, regardless of frame count.
    layer.ks.r.a = 0;
    layer.ks.r.k = staticDeg;
    return clone;
  }

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

/**
 * hideLayer — set a layer's opacity to 0 so it doesn't render. Used to
 * remove the default blue eye rectangles so a custom overlay (e.g. pink
 * heart SVGs) can be positioned in their place.
 *
 * Pass a number or an array of layer indices. Returns a deep clone.
 */
export function hideLayer(rawJson, layerIndices) {
  const clone = JSON.parse(JSON.stringify(rawJson));
  const indices = Array.isArray(layerIndices) ? layerIndices : [layerIndices];
  for (const i of indices) {
    const layer = clone?.layers?.[i];
    if (!layer?.ks?.o) continue;
    layer.ks.o.a = 0;
    layer.ks.o.k = 0;
  }
  return clone;
}

/**
 * normalizeLoop — rescale precomp keyframe times so every internal cycle
 * ends exactly when the parent timeline ends. The robot-idle.json bot was
 * exported with a 90-frame parent (`op:90`) but its inner "orbiting atoms"
 * precomp runs on a 120-frame cycle (`op:120`, last keyframe at `t:119`).
 * When the parent loops at frame 90, the atoms are mid-orbit (~75% through
 * their cycle) and snap back to frame 0 — that's the visible hitch.
 *
 * For each asset (precomp), this helper finds the largest keyframe time
 * across all layers and rescales every keyframe proportionally so the
 * inner cycle completes exactly at the parent's `op`. After this pass the
 * loop is seamless because every animated property returns to its
 * starting value at exactly the same frame the loop restarts.
 *
 * Only the `t` field of keyframes is touched. Values, easings, paths —
 * everything else stays as the artist authored it.
 */
export function normalizeLoop(rawJson) {
  const clone = JSON.parse(JSON.stringify(rawJson));
  const parentOp = clone?.op;
  if (!parentOp || !Array.isArray(clone.assets)) return clone;

  // Walk a layer and yield every animated-property keyframe array.
  const collectKeyframeArrays = (layer, out) => {
    if (!layer) return;
    if (layer.ks) {
      for (const propKey of ['p', 'r', 's', 'o', 'a', 'sk', 'sa']) {
        const prop = layer.ks[propKey];
        if (prop && prop.a === 1 && Array.isArray(prop.k)) out.push(prop.k);
      }
    }
    if (Array.isArray(layer.shapes)) walkShapes(layer.shapes, out);
  };
  const walkShapes = (items, out) => {
    for (const s of items) {
      if (!s) continue;
      // Shape morph / stroke / fill — any property with `a:1` + `k[]`.
      for (const key of Object.keys(s)) {
        const val = s[key];
        if (val && typeof val === 'object' && val.a === 1 && Array.isArray(val.k)) {
          out.push(val.k);
        }
      }
      if (Array.isArray(s.it)) walkShapes(s.it, out);
    }
  };

  for (const asset of clone.assets) {
    if (!Array.isArray(asset.layers)) continue;

    const kfArrays = [];
    for (const layer of asset.layers) collectKeyframeArrays(layer, kfArrays);

    let maxT = 0;
    for (const arr of kfArrays) {
      for (const kf of arr) {
        if (kf && typeof kf.t === 'number' && kf.t > maxT) maxT = kf.t;
      }
    }
    if (maxT === 0 || maxT === parentOp) continue;

    const scale = parentOp / maxT;
    for (const arr of kfArrays) {
      for (const kf of arr) {
        if (kf && typeof kf.t === 'number') {
          kf.t = Math.round(kf.t * scale);
        }
      }
    }
    // Also clamp the asset-layer's own op so the precomp player stops at
    // the same point the parent timeline does — belt + suspenders.
    for (const layer of asset.layers) {
      if (typeof layer.op === 'number' && layer.op > parentOp) layer.op = parentOp;
    }
  }
  return clone;
}

/**
 * lockArmsDown — apply the canonical "both arms hanging at sides" pose
 * used everywhere in the CRM (CallModule, MascotBot, cooldown overlay,
 * DNP sad-bot, etc.).
 *
 * What it does in one call:
 *   • Right arm (layer 0) locked at 0° AND flipX so it mirrors the left.
 *   • Left  arm (layer 1) locked at 0° (no flip — kept as the artist's
 *     drawn orientation).
 * Result: both arms hang straight down, anatomically mirrored.
 *
 * Use this instead of calling patchRobotArm twice in every component.
 */
export function lockArmsDown(rawJson) {
  let p = patchRobotArm(rawJson, { armLayerIndex: 0, static: true, staticDeg: 0, flipX: true  });
  p     = patchRobotArm(p,        { armLayerIndex: 1, static: true, staticDeg: 0, flipX: false });
  return p;
}
