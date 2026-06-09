import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Lottie from 'lottie-react';
import savedAnim from '../assets/saved.json';

/* SaveSuccess — a one-shot tick-mark animation played whenever a save happens
   in the CRM admin. It listens for the global `mhs:saved` window event (fired
   by CrmShell's fetch interceptor on any successful admin POST/PUT/PATCH) and
   plays the Lottie once, centered, without blocking clicks. Mounted only in
   the admin shell, so it never fires on the caller login. */
export default function SaveSuccess() {
  const [visible, setVisible] = useState(false);
  const [playKey, setPlayKey] = useState(0);   // bump to restart the animation
  const hideTimer = useRef(null);

  useEffect(() => {
    function onSaved() {
      setPlayKey(k => k + 1);
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      // Safety hide in case onComplete doesn't fire.
      hideTimer.current = setTimeout(() => setVisible(false), 3200);
    }
    window.addEventListener('mhs:saved', onSaved);
    return () => {
      window.removeEventListener('mhs:saved', onSaved);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (!visible) return null;

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
      // Blur + dim the whole screen behind the animation while it plays.
      background: 'rgba(59,7,100,0.18)',
      backdropFilter: 'blur(9px)',
      WebkitBackdropFilter: 'blur(9px)',
      animation: 'mhs-saved-fade 220ms ease-out',
    }}>
      <style>{`@keyframes mhs-saved-fade { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <Lottie
        key={playKey}
        animationData={savedAnim}
        loop={false}
        autoplay
        onComplete={() => setVisible(false)}
        style={{ width: 'min(380px, 64vw)', height: 'min(380px, 64vw)', filter: 'drop-shadow(0 18px 44px rgba(91,33,182,0.35))' }}
      />
    </div>,
    document.body
  );
}
