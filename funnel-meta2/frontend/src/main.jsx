import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { LazyMotion, domAnimation, MotionConfig } from 'framer-motion';
import './index.css';
import App from './App';

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
