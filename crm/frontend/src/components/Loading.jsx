import Lottie from 'lottie-react';
import loadingAnim from '../assets/loading.json';

/* Loading — large brand-purple Lottie animation shown in place of "Loading…"
   text anywhere a page/section is fetching. No caption (animation only).
   `size` scales it; `style` tweaks the wrapper. (A `label` prop may still be
   passed by callers — it's intentionally ignored, no text is rendered.) */
export default function Loading({ size = 240, style }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        ...style,
      }}
    >
      <Lottie animationData={loadingAnim} loop autoplay style={{ width: size, height: size }} />
    </div>
  );
}
