import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { FunnelProvider } from './context/FunnelContext';
import GearBackground from './components/GearBackground';
import Screen1A from './screens/Screen1A';

const Screen4 = lazy(() => import('./screens/Screen4'));
const AdminPage = lazy(() => import('./admin/AdminPage'));
const AdminResetPassword = lazy(() => import('./admin/AdminResetPassword'));

function FunnelRoutes() {
  const location = useLocation();
  return (
    <>
      <GearBackground />
      <AnimatePresence mode="sync" initial={false}>
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<Screen1A />} />
          <Route path="/language" element={<Navigate to="/" replace />} />
          <Route path="/duration" element={<Navigate to="/register" replace />} />
          <Route path="/register" element={<Screen4 />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AnimatePresence>
    </>
  );
}

export default function App() {
  const location = useLocation();
  const isAdmin = location.pathname.startsWith('/admin');
  if (location.pathname === '/admin/reset-password') {
    return <Suspense fallback={null}><AdminResetPassword /></Suspense>;
  }
  if (isAdmin) {
    return <Suspense fallback={null}><AdminPage /></Suspense>;
  }
  return (
    <FunnelProvider>
      <Suspense fallback={null}>
        <FunnelRoutes />
      </Suspense>
    </FunnelProvider>
  );
}
