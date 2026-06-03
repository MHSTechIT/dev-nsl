import { useState, useEffect } from 'react';
import WebinarDashboard from './WebinarDashboard';
import Login from './Login';
import { getToken, getUser, clearSession, setUnauthorizedHandler } from './api';

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());

  // A 401 from any API call (expired/invalid token) bounces back to login.
  useEffect(() => { setUnauthorizedHandler(() => setAuthed(false)); }, []);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return <WebinarDashboard user={getUser()} onLogout={() => { clearSession(); setAuthed(false); }} />;
}
