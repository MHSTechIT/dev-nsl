import { useRef, useEffect } from 'react';
import Lottie from 'lottie-react';
import loadingAnim from '../assets/loading.json';

/* Loading — large brand-purple Lottie animation shown in place of "Loading…"
   text anywhere a page/section is fetching. No caption (animation only).
   `size` scales it; `style` tweaks the wrapper; `speed` controls playback
   rate (default 0.35 → very slow). (A `label` prop may still be passed by
   callers — it's intentionally ignored, no text is rendered.) */
export default function Loading({ size = 240, style, speed = 0.35 }) {
  const lottieRef = useRef(null);
  useEffect(() => { lottieRef.current?.setSpeed(speed); }, [speed]);
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        ...style,
      }}
    >
      <Lottie lottieRef={lottieRef} animationData={loadingAnim} loop autoplay style={{ width: size, height: size }} />
    </div>
  );
}
