import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { useFunnel } from '../context/FunnelContext';
import { t } from '../translations';
import { formatISTDateTime } from '../utils/time';
import { pixelPurchase, pixelGroupJoinInitiated } from '../utils/pixel';
import { trackEvent } from '../utils/trackEvent';
const slideIn = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18, ease: 'easeIn' } },
};

export default function Screen5() {
  const { state } = useFunnel();
  const lang = state.lang;
  const navigate = useNavigate();
  const [seatSecs, setSeatSecs] = useState(300);
  const [joinState, setJoinState] = useState('idle');

  useEffect(() => {
    if (!state.submittedLeadId) navigate('/', { replace: true });
    else pixelPurchase(state.leadScore);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setSeatSecs(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  function handleJoin() {
    if (!state.whatsappGroupLink) return;
    setJoinState('joining');
    trackEvent('wa_join_clicked', state.webinarConfig?.next_webinar_at);
    pixelGroupJoinInitiated();
    window.open(state.whatsappGroupLink, '_blank');
    setTimeout(() => setJoinState('joined'), 2000);
  }

  const firstName = (state.fullName || '').split(' ')[0];
  const seatMin = String(Math.floor(seatSecs / 60)).padStart(2, '0');
  const seatSec2 = String(seatSecs % 60).padStart(2, '0');

  return (
    <m.div variants={slideIn} initial="initial" animate="animate" exit="exit" className="flex flex-col min-h-screen">
      <div className="flex-1 px-4 pb-8 flex flex-col items-center gap-5 text-center">

        {/* Success icon */}
        <m.div
          initial={{ scale: 0, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14 }}
          className="w-20 h-20 rounded-full flex items-center justify-center text-3xl shadow-[0_8px_30px_rgba(91,33,182,0.3)]"
          style={{ background: 'linear-gradient(135deg, #5B21B6, #8B6FEA)' }}
        >
          ✓
        </m.div>

        <div>
          <h2 className="font-heading text-2xl font-bold text-purple-900">
            {firstName ? `${firstName}, ` : ''}{t.screen5.headline[lang]}
          </h2>
          <p className="font-sans text-sm text-purple-500 mt-1">{t.screen5.subheadline[lang]}</p>
        </div>

        {/* Webinar details */}
        {state.webinarConfig.next_webinar_at && (
          <div className="glass-card px-5 py-4 w-full text-left">
            <p className="font-sans text-xs text-purple-400 font-semibold uppercase tracking-widest mb-2">
              {t.screen5.webinarDetails[lang]}
            </p>
            <p className="font-heading font-bold text-purple-900 text-lg">
              {formatISTDateTime(state.webinarConfig.next_webinar_at)}
            </p>
            <p className="font-sans text-xs text-purple-400 mt-1">India Standard Time (IST)</p>
          </div>
        )}

        {/* Seat countdown urgency */}
        {seatSecs > 0 && (
          <div className="dark-purple-section rounded-card px-5 py-4 w-full text-center">
            <p className="font-sans text-sm text-purple-200 mb-1">{t.screen5.seatWarning[lang]}</p>
            <p className="font-heading font-bold text-gold text-3xl tracking-widest">{seatMin}:{seatSec2}</p>
          </div>
        )}

        {/* WhatsApp CTA */}
        <div className="w-full mt-auto space-y-3">
          <m.button
            onClick={handleJoin}
            disabled={joinState === 'joined'}
            className="btn-wa disabled:opacity-60"
            animate={joinState === 'idle' ? { scale: [1, 1.025, 1] } : {}}
            transition={{ repeat: Infinity, repeatDelay: 2, duration: 0.5 }}
          >
            {joinState === 'joining' && t.screen5.joining[lang]}
            {joinState === 'joined' && t.screen5.joined[lang]}
            {joinState === 'idle' && (
              <>
                <span className="text-2xl">💬</span>
                {t.screen5.joinBtn[lang]}
              </>
            )}
          </m.button>
        </div>
      </div>
    </m.div>
  );
}
