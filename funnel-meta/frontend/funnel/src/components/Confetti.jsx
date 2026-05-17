import { useEffect, useRef, useState } from 'react';

const COLORS = [
  '#5B21B6', '#7C3AED', '#9333EA',
  '#A78BFA', '#C4B5FD', '#DDD6FE',
  '#3B0764', '#6D28D9', '#8B5CF6',
  '#EDE9FE', '#ffffff', '#7C3AED',
  '#5B21B6', '#A78BFA',
];

function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

/* Build particles that burst outward from the center */
function makeParticles(cx, cy, count) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + rand(-0.15, 0.15);
    const speed = rand(14, 26); // fast initial burst
    const type  = i % 3 === 0 ? 0 : i % 5 === 1 ? 1 : 2; // more ribbons

    return {
      x:       cx,
      y:       cy,
      vx:      Math.cos(angle) * speed,
      vy:      Math.sin(angle) * speed,
      gravity: rand(0.03, 0.07),   // low gravity → slow drift down
      drag:    rand(0.88, 0.93),   // heavy drag → rapid horizontal deceleration
      rot:     rand(0, 360),
      rotVel:  rand(-4, 4),
      color:   COLORS[Math.floor(Math.random() * COLORS.length)],
      type,
      // smaller pieces
      w: type === 2 ? rand(2, 4)  : type === 1 ? rand(6, 10) : rand(4, 7),
      h: type === 2 ? rand(8, 16) : type === 1 ? rand(10, 16) : rand(4, 7),
      opacity: 1,
    };
  });
}

function drawParticle(ctx, p) {
  ctx.save();
  ctx.globalAlpha = p.opacity;
  ctx.translate(p.x, p.y);
  ctx.rotate((p.rot * Math.PI) / 180);
  ctx.fillStyle = p.color;

  if (p.type === 0) {
    /* Circle */
    ctx.beginPath();
    ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
    ctx.fill();

  } else if (p.type === 1) {
    /* Wide rectangle with rounded ends */
    const r = Math.min(p.w, p.h) * 0.25;
    ctx.beginPath();
    ctx.moveTo(-p.w / 2 + r, -p.h / 2);
    ctx.lineTo( p.w / 2 - r, -p.h / 2);
    ctx.arcTo(  p.w / 2,     -p.h / 2,  p.w / 2,     -p.h / 2 + r, r);
    ctx.lineTo( p.w / 2,      p.h / 2 - r);
    ctx.arcTo(  p.w / 2,      p.h / 2,   p.w / 2 - r,  p.h / 2,     r);
    ctx.lineTo(-p.w / 2 + r,  p.h / 2);
    ctx.arcTo( -p.w / 2,      p.h / 2,  -p.w / 2,      p.h / 2 - r, r);
    ctx.lineTo(-p.w / 2,     -p.h / 2 + r);
    ctx.arcTo( -p.w / 2,     -p.h / 2,  -p.w / 2 + r, -p.h / 2,     r);
    ctx.closePath();
    ctx.fill();

  } else {
    /* Ribbon — long wavy strip, clearly visible */
    const hw = p.w / 2;
    const hh = p.h / 2;
    const wave = p.w * 0.8; // amplitude of wave
    ctx.beginPath();
    ctx.moveTo(-hw, -hh);
    // Left edge: wavy down
    ctx.bezierCurveTo(-hw + wave, -hh * 0.5, -hw - wave, hh * 0.5, -hw, hh);
    // Bottom cap
    ctx.lineTo(hw, hh);
    // Right edge: wavy back up
    ctx.bezierCurveTo(hw - wave, hh * 0.5, hw + wave, -hh * 0.5, hw, -hh);
    ctx.closePath();
    ctx.fill();
    // Subtle highlight stripe
    ctx.globalAlpha = p.opacity * 0.25;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-hw * 0.3, -hh);
    ctx.bezierCurveTo(-hw * 0.3 + wave * 0.5, -hh * 0.5, -hw * 0.3 - wave * 0.5, hh * 0.5, -hw * 0.3, hh);
    ctx.lineWidth = p.w * 0.18;
    ctx.stroke();
  }

  ctx.restore();
}

export default function Confetti({ active, count = 140, duration = 4000, speedScale = 1, onDone }) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);
  const [show, setShow]   = useState(false);

  useEffect(() => {
    if (!active) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canvas  = canvasRef.current;
    if (!canvas) return;

    const maxW    = Math.min(window.innerWidth, 480);
    canvas.width  = maxW;
    canvas.height = window.innerHeight;
    /* horizontally center the canvas over the content column */
    canvas.style.left      = '50%';
    canvas.style.transform = 'translateX(-50%)';
    canvas.style.width     = maxW + 'px';
    const ctx = canvas.getContext('2d');
    setShow(true);

    /* ── Reduced-motion fallback ── */
    if (reduced) {
      ctx.fillStyle = 'rgba(124,58,237,0.10)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const tid = setTimeout(() => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        setShow(false); onDone?.();
      }, 600);
      return () => clearTimeout(tid);
    }

    /* ── Burst from content-column center ── */
    const cx    = maxW / 2;
    const cy    = canvas.height / 2;
    const parts = makeParticles(cx, cy, count, speedScale);
    const start = performance.now();

    function frame(now) {
      const elapsed  = now - start;
      const progress = Math.min(elapsed / duration, 1);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let anyAlive = false;

      for (const p of parts) {
        if (p.y > canvas.height + 80 || p.opacity <= 0.01) continue;
        anyAlive = true;

        /* Physics */
        p.vy  += p.gravity;
        p.vx  *= p.drag;
        p.x   += p.vx;
        p.y   += p.vy;
        p.rot += p.rotVel;

        /* Fade only in last 25% of animation */
        if (progress > 0.75) {
          p.opacity = Math.max(0, 1 - (progress - 0.75) / 0.25);
        }

        drawParticle(ctx, p);
      }

      if (anyAlive && progress < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        setShow(false);
        onDone?.();
      }
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position:      'fixed',
        top:           0,
        pointerEvents: 'none',
        zIndex:        9999,
        display:       show ? 'block' : 'none',
      }}
    />
  );
}
