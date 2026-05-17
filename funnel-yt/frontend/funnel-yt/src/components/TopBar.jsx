import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import LanguageToggle from './LanguageToggle';
import { pixelBackNavigation } from '../utils/pixel';

const TOTAL = 4; // total funnel steps (screens 2–5)

export default function TopBar({ showBack = false, backPath = '/', onBack, step = 1 }) {
  const navigate = useNavigate();
  const { dispatch } = useFunnel();

  function handleBack() {
    pixelBackNavigation();
    dispatch({ type: 'SET_NAV_DIRECTION', payload: 'back' });
    if (onBack) { onBack(); } else { navigate(backPath); }
  }

  const pct = Math.round((step / TOTAL) * 100);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '14px 16px 10px',
    }}>
      {/* Back button */}
      <div style={{ flexShrink: 0, width: 34 }}>
        {showBack && (
          <button
            onClick={handleBack}
            style={{
              width: 34, height: 34,
              borderRadius: '50%',
              background: 'transparent',
              border: '2px solid #5B21B6',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              color: '#5B21B6',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
        )}
      </div>

      {/* Progress line */}
      <div style={{ flex: 1, height: 4, borderRadius: 99, background: 'rgba(91,33,182,0.12)', overflow: 'hidden' }}>
        <m.div
          style={{ height: '100%', borderRadius: 99, background: 'linear-gradient(90deg,#5B21B6,#8B6FEA)' }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        />
      </div>

      {/* Language toggle */}
      <div style={{ flexShrink: 0 }}>
        <LanguageToggle />
      </div>
    </div>
  );
}
