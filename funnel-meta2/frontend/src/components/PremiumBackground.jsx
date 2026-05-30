import { useEffect, useRef } from 'react';

/*
 * PremiumBackground
 * - Canvas aurora mesh gradient (slow-morphing radial orbs)
 * - Floating particles layer
 * - Smooth cursor glow with lerp
 * - SVG noise grain overlay
 * All runs in a single RAF loop — no re-renders after mount.
 */

const ORBS = [
  { ox: 0.18, oy: 0.28, r: 0.60, color: '139,92,246',  spd: 0.00018 }, // violet
  { ox: 0.72, oy: 0.18, r: 0.55, color: '91,33,182',   spd: 0.00013 }, // deep purple
  { ox: 0.50, oy: 0.82, r: 0.50, color: '167,139,250', spd: 0.00022 }, // light violet
  { ox: 0.85, oy: 0.60, r: 0.42, color: '196,181,253', spd: 0.00016 }, // lavender
];

function makeParticles(count) {
  return Array.from({ length: count }, () => ({
    x:  Math.random(),
    y:  Math.random(),
    sz: Math.random() * 1.8 + 0.6,
    vx: (Math.random() - 0.5) * 0.000055,
    vy: (Math.random() - 0.5) * 0.000055,
    op: Math.random() * 0.28 + 0.08,
  }));
}

export default function PremiumBackground() {
  const canvasRef  = useRef(null);
  const glowRef    = useRef(null);
  const mouse      = useRef({ x: -1500, y: -1500 });
  const smooth     = useRef({ x: -1500, y: -1500 });
  const frameAurora = useRef(null);
  const frameGlow   = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext('2d');
    const particles = makeParticles(80);
    let t = 0;
    let W = 0, H = 0;

    const resize = () => {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    /* ── Aurora + particles loop ── */
    const drawFrame = () => {
      t += 1;

      ctx.clearRect(0, 0, W, H);

      // Base fill matching app background
      ctx.fillStyle = '#EDEAF8';
      ctx.fillRect(0, 0, W, H);

      // Aurora orbs
      ORBS.forEach((orb, i) => {
        const px = orb.ox + Math.sin(t * orb.spd + i * 1.7)  * 0.14;
        const py = orb.oy + Math.cos(t * orb.spd * 1.4 + i)  * 0.11;
        const r  = Math.min(W, H) * orb.r;

        const g = ctx.createRadialGradient(px * W, py * H, 0, px * W, py * H, r);
        g.addColorStop(0,   `rgba(${orb.color},0.45)`);
        g.addColorStop(0.4, `rgba(${orb.color},0.18)`);
        g.addColorStop(1,   `rgba(${orb.color},0)`);

        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      });

      // Particles
      ctx.save();
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -0.01) p.x = 1.01;
        if (p.x >  1.01) p.x = -0.01;
        if (p.y < -0.01) p.y = 1.01;
        if (p.y >  1.01) p.y = -0.01;

        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, p.sz, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(91,33,182,${p.op})`;
        ctx.fill();
      });
      ctx.restore();

      frameAurora.current = requestAnimationFrame(drawFrame);
    };
    drawFrame();

    /* ── Cursor glow lerp loop ── */
    const lerpGlow = () => {
      const s = smooth.current;
      const m = mouse.current;
      s.x += (m.x - s.x) * 0.055;
      s.y += (m.y - s.y) * 0.055;
      if (glowRef.current) {
        glowRef.current.style.transform =
          `translate(${s.x - 180}px, ${s.y - 180}px)`;
      }
      frameGlow.current = requestAnimationFrame(lerpGlow);
    };
    lerpGlow();

    const onMove = e => { mouse.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', onMove);

    return () => {
      cancelAnimationFrame(frameAurora.current);
      cancelAnimationFrame(frameGlow.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  return (
    <>
      {/* Aurora canvas */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed', top: 0, left: 0,
          width: '100%', height: '100%',
          zIndex: -3, pointerEvents: 'none',
        }}
      />

      {/* Grain/noise overlay */}
      <div style={{
        position: 'fixed', inset: 0,
        zIndex: -2, pointerEvents: 'none',
        opacity: 0.032,
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)'/%3E%3C/svg%3E")`,
        backgroundSize: '200px 200px',
      }} />

      {/* Cursor glow */}
      <div
        ref={glowRef}
        style={{
          position: 'fixed', top: 0, left: 0,
          width: 360, height: 360,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(139,92,246,0.13) 0%, rgba(91,33,182,0.05) 45%, transparent 70%)',
          filter: 'blur(28px)',
          pointerEvents: 'none',
          zIndex: -1,
          willChange: 'transform',
        }}
      />
    </>
  );
}
