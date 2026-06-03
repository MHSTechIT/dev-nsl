import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';

const CrmShell           = lazy(() => import('./CrmShell'));
const CallerShell        = lazy(() => import('./CallerShell'));
const NsmCallerShell     = lazy(() => import('./NsmCallerShell'));
const ManagerShell       = lazy(() => import('./ManagerShell'));
const TLShell            = lazy(() => import('./TLShell'));
const AdminResetPassword = lazy(() => import('./admin/AdminResetPassword'));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<CrmShell />} />
          <Route path="/marketing" element={<CrmShell />} />
          <Route path="/caller" element={<CallerShell />} />
          <Route path="/caller/junior" element={<CallerShell callerRole="junior_caller" callerName="Junior Caller" />} />
          <Route path="/caller/senior" element={<CallerShell callerRole="senior_caller" callerName="Senior Caller" />} />
          <Route path="/nsm-caller" element={<NsmCallerShell />} />
          <Route path="/manager" element={<ManagerShell />} />
          <Route path="/tl" element={<TLShell />} />
          <Route path="/admin/reset-password" element={<AdminResetPassword />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>
);
