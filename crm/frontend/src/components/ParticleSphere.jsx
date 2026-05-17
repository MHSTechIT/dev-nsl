import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/* WebGL 3-D particle sphere — drop-in replacement for the orbital-line
   Lottie that used to sit behind the call button. Renders ~6,000 dots
   sampled on a unit sphere (Fibonacci distribution → near-perfect even
   coverage), with a shader-driven purple → pink → orange vertical
   gradient and 3-D simplex-noise displacement that gives the sphere a
   breathing / waving motion. Uses additive blending so overlapping dots
   brighten into a soft bloom without a post-processing pass.

   Designed to read against the CRM's lavender background — colours are
   saturated (deep purple, hot pink, orange) so they pop on light bg. */

/* ── Fibonacci-sphere point sampler ──────────────────────────────────
   Distributes N points on a unit sphere using the golden-ratio spiral.
   Vastly more even than Math.random() and gives a "soft" silhouette
   when projected. */
function fibonacciSphere(N) {
  const pos = new Float32Array(N * 3);
  const phi = Math.PI * (Math.sqrt(5) - 1);    // golden angle
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;            // from +1 to -1
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    pos[3 * i]     = Math.cos(theta) * r;
    pos[3 * i + 1] = y;
    pos[3 * i + 2] = Math.sin(theta) * r;
  }
  return pos;
}

/* ── Vertex shader ──
   Displaces each point along its radial direction by 3-D simplex noise
   sampled in time. The displacement amplitude (0.12) is what produces
   the "waving outer particles" effect of the reference image. The
   perspective-correct gl_PointSize scaling (300 / -mvPosition.z) keeps
   point size visually consistent regardless of camera distance. */
const vertexShader = /* glsl */ `
  uniform float uTime;
  varying float vY;

  // Ashima 3-D simplex noise (public domain)
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    vec3 pos = position;
    // Radial displacement driven by noise → breathing / wave effect.
    float n = snoise(pos * 1.5 + uTime * 0.3);
    pos += normalize(position) * n * 0.12;
    vY = pos.y;                                  // pass world-Y to fragment

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Perspective-correct point sizing — keeps dots tiny and individual.
    // The earlier 300/-z multiplier blew each dot up to hundreds of pixels,
    // making them overlap into a single solid gradient smear. The 10/-z
    // multiplier here keeps each dot in the 2-6 device-pixel range so they
    // read as actual dots, not a continuous wash. Front of sphere stays
    // visibly larger than the back for proper 3-D feel.
    gl_PointSize = (1.5 + abs(n) * 1.2) * (10.0 / -mvPosition.z);
  }
`;

/* ── Fragment shader ──
   1. Rounds each square gl_PointCoord into an anti-aliased dot (discard
      outside radius 0.5, smoothstep alpha for soft edges).
   2. Picks colour from a two-segment vertical lerp:
        top    #6E33C7 (deep purple)
        middle #DB338C (hot pink)
        bottom #FF6633 (orange)
      Saturated palette tuned to pop against the CRM's lavender bg. */
const fragmentShader = /* glsl */ `
  varying float vY;

  void main() {
    // Circular point shape with soft edge. Alpha kept at 0.65 (instead of
    // a flat 0.85) so overlapping dots don't paint completely over the
    // lavender bg — at this density we want a translucent particle cloud,
    // not an opaque smear.
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.30, d) * 0.65;

    // Y-position normalised to 0..1 (sphere is roughly -1.1..+1.1 after displacement).
    // Dark monochromatic CRM purple ramp — even the top of the sphere
    // is deep purple now so the embedded icon glow reads cleanly. All
    // stops sit inside the brand-600..900 range.
    float t = clamp(vY * 0.45 + 0.5, 0.0, 1.0);

    vec3 top    = vec3(0.486, 0.227, 0.929);  // #7C3AED purple-600 (was mid)
    vec3 mid    = vec3(0.357, 0.129, 0.714);  // #5B21B6 brand deep
    vec3 bot    = vec3(0.180, 0.063, 0.396);  // #2E1065 very deep purple
    vec3 color  = t > 0.5
      ? mix(mid, top, (t - 0.5) * 2.0)
      : mix(bot, mid, t * 2.0);

    gl_FragColor = vec4(color, alpha);
  }
`;

function Sphere({ count = 6000 }) {
  const meshRef     = useRef(null);
  const materialRef = useRef(null);

  // Positions are allocated once; only the time uniform changes per frame.
  const positions = useMemo(() => fibonacciSphere(count), [count]);

  // ShaderMaterial config — kept in a memo so a single instance survives
  // re-renders and the GPU shader program is only compiled once.
  //
  // Blending note: AdditiveBlending was tried first but only adds light to
  // whatever sits behind it — completely invisible against the CRM's light
  // lavender bg. NormalBlending paints each dot on top, so saturated
  // purple/pink/orange dots actually read.
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms:       { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.NormalBlending,
  }), []);

  useFrame((state, delta) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
    }
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.15;   // slow lazy spin
    }
  });

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={positions.length / 3}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <primitive object={material} ref={materialRef} attach="material" />
    </points>
  );
}

export default function ParticleSphere({ size = 520 }) {
  return (
    <div style={{ width: size, height: size }}>
      <Canvas
        camera={{ position: [0, 0, 3], fov: 50 }}
        dpr={[1, 2]}
        frameloop="always"
        gl={{ powerPreference: 'high-performance', antialias: false, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <Sphere count={6000} />
      </Canvas>
    </div>
  );
}
