import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { LazyMotion, domAnimation, MotionConfig } from 'framer-motion';
import './index.css';
import App from './App';
import { trackPageView } from './utils/metaPixel';
import { initMetaTracking } from './utils/metaTracking';

// Attach global Meta behaviour observers (scroll depth, time-on-page,
// engagement composite, exit intent, visibility). Idempotent — safe
// to call once at startup. Then fire the first PageView with rich
// context (UTM + visitor_id + fbp/fbc + dedup event_id) instead of
// the bare fbq('track','PageView') the old HTML head used to fire.
initMetaTracking();
trackPageView({ landing: true });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      {/* reducedMotion="never" forces every framer-motion animation to play
          even when the device has "Reduce motion" / "Remove animations"
          enabled in OS accessibility settings. The CTA pulse is critical
          attention-grabbing — disabling it silently confused live testers. */}
      <MotionConfig reducedMotion="never">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </MotionConfig>
    </LazyMotion>
  </StrictMode>
);
