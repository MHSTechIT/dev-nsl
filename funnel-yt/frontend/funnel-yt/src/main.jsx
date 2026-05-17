import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { LazyMotion, domAnimation, MotionConfig } from 'framer-motion';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      {/* Force animations regardless of OS reduced-motion preference. */}
      <MotionConfig reducedMotion="never">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </MotionConfig>
    </LazyMotion>
  </StrictMode>
);
