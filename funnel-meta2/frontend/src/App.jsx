import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { FunnelProvider, useFunnel } from './context/FunnelContext';
import GearBackground from './components/GearBackground';
import Screen1A from './screens/Screen1A';

const Screen4 = lazy(() => import('./screens/Screen4'));
const AdminPage = lazy(() => import('./admin/AdminPage'));
const AdminResetPassword = lazy(() => import('./admin/AdminResetPassword'));
// Single-URL funnel: the funnel form, registration, WhatsApp redirect and the
// disqualified screens are ALL served at "/" — the address bar never changes.
// Which surface renders is driven by funnel state (state.stage), not the path.
const WhatsAppPage = lazy(() => import('./screens/WhatsAppPage'));
const Disqualified = lazy(() => import('./screens/Disqualified'));
const LanguageDisqualified = lazy(() => import('./screens/LanguageDisqualified'));
const NotTamil = lazy(() => import('./screens/NotTamil'));

const STAGE_SCREENS = {
  funnel:         <Screen1A />,
  register:       <Screen4 />,
  whatsapp:       <WhatsAppPage />,
  'not-eligible': <Disqualified />,
  'not-tamil':    <NotTamil />,
  language:       <LanguageDisqualified />,
};

function FunnelFlow() {
  const { state } = useFunnel();
  const stage = state.stage || 'funnel';
  return (
    <>
      <GearBackground />
      {/* Render ONLY the active stage. AnimatePresence was removed: its keyed
          child was a plain <div> (not a motion element), so under mode="sync"
          the outgoing screen never unmounted — leaving the registration form
          mounted behind the WhatsApp sheet (two screens + two timers at once).
          Each screen still runs its own initial→animate on mount, so entrance
          animations are unaffected; the old stage now properly unmounts. */}
      <div key={stage} style={{ display: 'contents' }}>
        {STAGE_SCREENS[stage] || STAGE_SCREENS.funnel}
      </div>
    </>
  );
}

export default function App() {
  const location = useLocation();
  if (location.pathname === '/admin/reset-password') {
    return <Suspense fallback={null}><AdminResetPassword /></Suspense>;
  }
  if (location.pathname.startsWith('/admin')) {
    return <Suspense fallback={null}><AdminPage /></Suspense>;
  }
  return (
    <FunnelProvider>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<FunnelFlow />} />
          {/* Any stray funnel path normalizes back to "/" — single URL. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </FunnelProvider>
  );
}
