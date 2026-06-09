import { useState, useEffect, useRef, useCallback } from 'react';
import AdminLogin              from './admin/AdminLogin';
import CallModule              from './modules/CallModule';
import AssignedLeadsModule     from './modules/AssignedLeadsModule';
import UntouchedLeadsModule    from './modules/UntouchedLeadsModule';
import CompletedLeadsModule    from './modules/CompletedLeadsModule';
import NotPickedLeadsModule    from './modules/NotPickedLeadsModule';
import MissedCallsModule       from './modules/MissedCallsModule';
import NextBatchModule         from './modules/NextBatchModule';
import IncomingCallToast       from './components/IncomingCallToast';
import MascotBot               from './components/MascotBot';
import RobotGuide              from './components/RobotGuide';
import { deriveCallerTag, readActivity } from './utils/callerActivity';
import { ROBOT_CLIP, stopRobotClip, getRobotVolume, setRobotVolume, playRobotClip, ROBOT_VOLUME_EVENT, setAccountPaused } from './utils/robotAudio';
import { stopAllRobotGuideAudio } from './components/RobotGuide';
import { TimerSettingsContext } from './context/TimerSettingsContext';
import { TIMER_DEFAULTS, mergeTimerSettings } from './config/timerSchema';

const PAGES = [
  {
    id: 'call',
    label: 'Call',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
      </svg>
    ),
  },
  {
    id: 'assigned',
    label: 'Assigned Leads',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2h-4"/>
        <path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2"/>
        <line x1="9" y1="11" x2="15" y2="11"/>
        <line x1="9" y1="15" x2="13" y2="15"/>
      </svg>
    ),
  },
  {
    id: 'completed',
    label: 'Completed Leads',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    ),
  },
  {
    id: 'not_picked',
    label: 'Not Picked',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        <line x1="22" y1="2" x2="2" y2="22"/>
      </svg>
    ),
  },
  {
    id: 'missed_calls',
    label: 'Missed Calls',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        <polyline points="14 2 18 6 22 2"/>
      </svg>
    ),
  },
  {
    id: 'untouched',
    label: 'Untouched',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    ),
  },
  {
    id: 'next_batch',
    label: 'Next Batch',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8"  y1="2" x2="8"  y2="6"/>
        <line x1="3"  y1="10" x2="21" y2="10"/>
        <polyline points="9 16 11 18 15 14"/>
      </svg>
    ),
  },
];

const PAGE_TITLES = {
  call:         { title: 'Call',             subtitle: '' },
  assigned:     { title: 'Assigned Leads',   subtitle: 'Leads assigned to you for follow-up' },
  untouched:    { title: 'Untouched',        subtitle: "Leads you haven't contacted yet" },
  completed:    { title: 'Completed Leads',  subtitle: 'Leads you have already handled' },
  not_picked:   { title: 'Not Picked',       subtitle: "Calls that didn't connect" },
  missed_calls: { title: 'Missed Calls',     subtitle: "Customers who called you but weren't picked up" },
  next_batch:   { title: 'Next Batch',       subtitle: "Parked here when Q14 was answered 'Yes' — promoted to Assigned when admin starts a new batch" },
};

/* Caller pages that have NO idle handling of their own. The Call and Assigned
   pages run their own idle nudges; these review pages did not — so a caller
   could dodge auto-pause by parking on one. The shell-level idle watchdog
   below covers exactly these. */
const IDLE_WATCH_PAGES = ['completed', 'not_picked', 'missed_calls', 'untouched', 'next_batch'];

export default function CallerShell({ callerName: nameProp, callerRole: roleProp }) {
  const [user, setUser]             = useState(() => {
    const raw = sessionStorage.getItem('mhs_crm_user');
    if (raw) { try { return JSON.parse(raw); } catch { return null; } }
    return null;
  });
  /* Active tab — restored from sessionStorage so a page refresh keeps the
     caller on the same tab instead of bouncing back to Call. sessionStorage
     (not local) keeps it scoped to this login session: a fresh login still
     lands on the Call page. */
  const [activePage, setActive]       = useState(() => {
    try {
      const saved = sessionStorage.getItem('mhs_caller_active_page');
      if (saved && PAGES.some(p => p.id === saved)) return saved;
    } catch { /* sandbox / storage disabled */ }
    return 'call';
  });

  /* Lead count for the active page — each list module reports its count
     via the onCount prop, and we render it under the page subtitle.
     Reset to null whenever the active page changes so the previous
     page's stale number doesn't flash. */
  const [leadCount, setLeadCount] = useState(null);
  useEffect(() => { setLeadCount(null); }, [activePage]);

  /* Live numbers + break state for the Call-page status card. */
  const [callerStats, setCallerStats] = useState({ assigned: 0, tags: {} });
  const [callerBreak, setCallerBreak] = useState(null);  // bubbled up from AssignedLeadsModule

  /* Per-caller page access (admin Access panel). Pages turned off there are
     hidden from this caller's tab bar. Missing key = visible (default ON). */
  const [pageAccess, setPageAccess] = useState({});
  useEffect(() => {
    const t = sessionStorage.getItem('mhs_crm_token') || '';
    if (!t) return;
    fetch('/api/caller/page-access', { headers: { Authorization: `Bearer ${t}` } })
      .then(r => r.json())
      .then(d => setPageAccess(d.page_access || {}))
      .catch(() => {});
  }, []);
  const visiblePages = PAGES.filter(p => pageAccess[p.id] !== false);
  // If the saved/active page got turned off, fall back to the first visible one.
  useEffect(() => {
    if (visiblePages.length && !visiblePages.some(p => p.id === activePage)) {
      setActive(visiblePages[0].id);
    }
  }, [pageAccess]); // eslint-disable-line react-hooks/exhaustive-deps
  /* When the Call page's big start button is pressed, we navigate to the
     Assigned tab and flag a one-shot "auto-start me when leads are ready".
     AssignedLeadsModule consumes the flag and clears it on first trigger. */
  const [pendingAutoStart, setPendingAutoStart] = useState(false);
  const requestAutoStart   = useCallback(() => {
    // Auto-call now runs ON the Call page (callPageMode) — no navigation away.
    setPendingAutoStart(true);
  }, []);
  const clearPendingAutoStart = useCallback(() => setPendingAutoStart(false), []);
  /* On the Call page every robot line is funneled through CallModule's single
     center robot. AssignedLeadsModule (callPageMode) pushes its corner-robot
     messages up here via onRobotMessage; CallModule renders them in its bubble. */
  const [callRobotMsg, setCallRobotMsg] = useState(null);
  const [showDropdown, setShowDropdown] = useState(false);
  /* Hamburger toggle — when true, the tab bar collapses into a single
     three-line button. Defaults to COLLAPSED on every login / refresh so
     the caller sees the clean Call page (robot + Start Call) without the
     tab strip cluttering the layout. Clicking the hamburger expands the
     full tab strip on demand. */
  const [tabsCollapsed, setTabsCollapsed] = useState(true);
  const [externalHighlightId, setExternalHighlightId] = useState(null);
  const dropRef = useRef(null);
  /* Pause state — live-tracked via /api/caller/me + SSE caller.paused / caller.resumed.
     null = unknown (still loading), true = active, false = paused-by-admin. */
  const [isActive, setIsActive] = useState(null);
  /* When the caller is auto-paused (idle nudge / break overrun / SmartFlow),
     `autoPausedAt` is set and the activity tag becomes BLOCKED. An admin pause
     leaves it null, so the tag becomes PAUSED_BY_ADMIN instead. */
  const [pauseInfo, setPauseInfo] = useState({ autoPausedAt: null, reason: null });

  /* Admin-controlled timing settings — fetched once on mount and kept live
     via the leads-events SSE (timer.settings.updated). Provided to every
     caller component through TimerSettingsContext below. */
  const [timerSettings, setTimerSettings] = useState(TIMER_DEFAULTS);

  /* Mascot mood — purely-visual local state owned by the shell.
     `setMood(mood)`              → switch to mood, stays there.
     `setMood(mood, autoRevertMs)` → switch to mood, auto-revert to 'idle' after Nms.
     Any pending revert timer is cleared on each call. */
  const [mascotMood, setMascotMood] = useState('idle');
  const mascotTimerRef = useRef(null);
  const setMood = useCallback((mood, autoRevertMs) => {
    if (mascotTimerRef.current) {
      clearTimeout(mascotTimerRef.current);
      mascotTimerRef.current = null;
    }
    setMascotMood(mood || 'idle');
    if (mood && mood !== 'idle' && typeof autoRevertMs === 'number' && autoRevertMs > 0) {
      mascotTimerRef.current = setTimeout(() => {
        mascotTimerRef.current = null;
        setMascotMood('idle');
      }, autoRevertMs);
    }
  }, []);
  useEffect(() => () => {
    if (mascotTimerRef.current) clearTimeout(mascotTimerRef.current);
  }, []);

  /* Toast → "Open lead" handler: jump to Assigned tab and ask the module
     to highlight the row. The module clears the highlight on its own timer. */
  const handleOpenLead = (leadId) => {
    setActive('assigned');
    setExternalHighlightId(leadId);
    // Reset the marker after the configured delay so re-clicking the same lead re-triggers
    setTimeout(() => setExternalHighlightId(prev => prev === leadId ? null : prev), timerSettings.leadHighlightResetMs);
  };

  useEffect(() => {
    document.body.style.maxWidth = 'none';
    document.body.style.margin   = '0';
    document.body.style.background = '#EDEAF8';
    return () => {
      document.body.style.maxWidth = '';
      document.body.style.margin = '';
      document.body.style.background = '';
    };
  }, []);

  /* close dropdown on outside click */
  useEffect(() => {
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  /* Pause check — fetch /api/caller/me on mount and on any caller.paused /
     caller.resumed SSE message. The overlay below renders when is_active is
     explicitly false; null (still loading) renders nothing so we don't flash
     it during the first paint. */
  const jwtForEffect = user ? (sessionStorage.getItem('mhs_crm_token') || '') : '';
  useEffect(() => {
    if (!user || !jwtForEffect) return undefined;
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch('/api/caller/me', {
          headers: { Authorization: `Bearer ${jwtForEffect}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const c = data?.caller || {};
        setIsActive(c.is_active !== false);
        const ap = c.auto_paused_at || null;
        const rs = c.auto_pause_reason || null;
        // Keep the same object reference when nothing changed so the heartbeat
        // effect doesn't fire on every /me poll.
        setPauseInfo(prev => (prev.autoPausedAt === ap && prev.reason === rs) ? prev : { autoPausedAt: ap, reason: rs });
      } catch { /* network blips don't lock anyone out */ }
    }
    refresh();
    /* Pull the admin-saved timer settings once on mount. Failures fall back
       to the schema defaults already held in state. */
    (async () => {
      try {
        const res = await fetch('/api/caller/timer-settings', {
          headers: { Authorization: `Bearer ${jwtForEffect}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setTimerSettings(mergeTimerSettings(data?.settings));
      } catch { /* defaults stay in place */ }
    })();
    const url = `/api/caller/leads/events?token=${encodeURIComponent(jwtForEffect)}`;
    const es  = new EventSource(url);
    // Re-sync the pause state every time the SSE (re)connects. After a backend
    // restart or a dropped connection the caller's is_active could otherwise
    // go stale — page usable while the admin shows Paused, or vice-versa.
    es.onopen = () => { refresh(); };
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        // Flip the overlay instantly, then refresh() to pull the pause reason.
        if (msg?.type === 'caller.paused')  { setIsActive(false); refresh(); }
        if (msg?.type === 'caller.resumed') { setIsActive(true);  refresh(); }
        // Live timer-settings push — admin saved a new value.
        if (msg?.type === 'timer.settings.updated') {
          setTimerSettings(mergeTimerSettings(msg.settings));
        }
      } catch { /* ignore */ }
    };
    return () => { cancelled = true; es.close(); };
  }, [user, jwtForEffect]);

  /* Call-page stats — assigned count + per-tag call counts. Polled, and
     refreshed immediately on any activity change (e.g. a saved call note). */
  useEffect(() => {
    if (!user || !jwtForEffect) return undefined;
    let cancelled = false;
    async function loadStats() {
      try {
        const res = await fetch('/api/caller/stats', { headers: { Authorization: `Bearer ${jwtForEffect}` } });
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setCallerStats({ assigned: d.assigned || 0, tags: d.tags || {} });
      } catch { /* network blips ignored */ }
    }
    loadStats();
    const id = setInterval(loadStats, 15000);
    const onChange = () => loadStats();
    window.addEventListener('mhs:activity:changed', onChange);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener('mhs:activity:changed', onChange); };
  }, [user, jwtForEffect]);

  /* Persist the active tab so a refresh restores it (consumed by the
     activePage useState initialiser above). */
  useEffect(() => {
    try { sessionStorage.setItem('mhs_caller_active_page', activePage); } catch { /* sandbox */ }
  }, [activePage]);

  /* Activity heartbeat — POST /api/caller/heartbeat every 30s. The frontend
     computes ONE current tag (deriveCallerTag); the backend switches the
     caller's single open activity span to it. Also fires immediately on any
     `mhs:activity:changed` event (a module sub-state change or a pause) so
     the admin timeline reacts within a second. */
  const hbRef = useRef({ activePage: 'call', isActive: null, pauseInfo: { autoPausedAt: null, reason: null } });
  hbRef.current = { activePage, isActive, pauseInfo };
  useEffect(() => {
    if (!user || !jwtForEffect) return undefined;

    async function send() {
      const act = readActivity(jwtForEffect);
      const { activePage: pg, isActive: ia, pauseInfo: pi } = hbRef.current;
      const tag = deriveCallerTag({
        activePage:   pg,
        isActive:     ia,
        autoPausedAt: pi.autoPausedAt,
        subTag:       act.subTag,
      });
      const context = tag === 'BLOCKED'
        ? { reason: pi.reason || 'auto_paused' }
        : (act.subContext || null);
      try {
        await fetch('/api/caller/heartbeat', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtForEffect}` },
          body:    JSON.stringify({ status: act.status, break: act.break, tag, context }),
        });
      } catch { /* network blips ignored — next tick will retry */ }
    }

    send();  // immediate heartbeat on mount
    const intervalId = setInterval(send, timerSettings.heartbeatIntervalMs);
    const onChange = () => { send(); };
    // Background tabs get their timers throttled/frozen by the browser, so
    // the heartbeat lags while the caller is on another tab or app. Fire one
    // immediately when they return so the activity tag re-syncs at once.
    const onVisible = () => { if (document.visibilityState === 'visible') send(); };
    window.addEventListener('mhs:activity:changed', onChange);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('mhs:activity:changed', onChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, jwtForEffect, timerSettings.heartbeatIntervalMs]);

  /* Fire an immediate heartbeat when CallerShell-owned state (tab or pause)
     changes so the activity tag updates without waiting for the 30s tick. */
  useEffect(() => {
    if (!user || !jwtForEffect) return;
    try { window.dispatchEvent(new Event('mhs:activity:changed')); } catch { /* no-op */ }
  }, [activePage, isActive, pauseInfo, user, jwtForEffect]);

  /* When the caller is paused, EVERY page-level audio source has to go
     silent — only the fullscreen paused-overlay robot is allowed to
     speak its "contact admin" line. We do this in three steps:
       1. stopRobotClip()           — kills the playRobotClip pipeline.
       2. stopAllRobotGuideAudio()  — kills every cached RobotGuide
                                       Audio element (corner / network-
                                       recovered / idle nudge / etc.).
       3. setAccountPaused(true)    — flips a module-level flag inside
                                       robotAudio.js so any subsequent
                                       playRobotClip call is a no-op,
                                       and RobotGuide skips new plays
                                       unless variant === 'overlay'.
     On resume (isActive === true) the flag flips back so future audio
     can play normally again. */
  useEffect(() => {
    if (isActive === false) {
      try { stopRobotClip();           } catch { /* ignore */ }
      try { stopAllRobotGuideAudio();  } catch { /* ignore */ }
      try { setAccountPaused(true);    } catch { /* ignore */ }
    } else if (isActive === true) {
      try { setAccountPaused(false);   } catch { /* ignore */ }
    }
  }, [isActive]);

  /* Idea #20 — network-recovered reassurance. When the browser drops offline
     and then comes back, flash a corner robot so the caller knows it's safe
     to keep going. `netRecoverPulse` bumps on each recovery and auto-clears
     after 7 s so the robot disappears on its own. */
  const [netRecoverPulse, setNetRecoverPulse] = useState(0);
  useEffect(() => {
    let wasOffline = false;
    const onOffline = () => { wasOffline = true; };
    const onOnline  = () => { if (wasOffline) { wasOffline = false; setNetRecoverPulse(p => p + 1); } };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online',  onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online',  onOnline);
    };
  }, []);
  useEffect(() => {
    if (netRecoverPulse === 0) return undefined;
    const id = setTimeout(() => setNetRecoverPulse(0), timerSettings.netRecoverPulseMs);
    return () => clearTimeout(id);
  }, [netRecoverPulse, timerSettings.netRecoverPulseMs]);
  /* On the Call page, deliver the network-recovered line through the center
     robot instead of the bottom-right corner robot (single-robot Call page). */
  useEffect(() => {
    if (activePage !== 'call' || netRecoverPulse === 0) return;
    setCallRobotMsg({ text: 'network vandhuduchu nanba, continue pannu', clip: 52, key: `net-${netRecoverPulse}` });
  }, [netRecoverPulse, activePage]);

  /* ── Idle watchdog for the review pages ──
     The Call & Assigned pages nudge an idle caller themselves. The review
     pages (IDLE_WATCH_PAGES) did not, so a caller could park there and never
     get auto-paused. This watches for "no action taken" — no click / key
     press. After `robotNudgeIntervalMs` with no action the robot nudges;
     after `autoPauseNudgeCount` ignored nudges the account auto-pauses via
     POST /api/caller/self-pause. Any click or keypress resets the clock. */
  const [idleNudge, setIdleNudge] = useState(0);
  const idleActionRef = useRef(Date.now());
  const idlePausedRef = useRef(false);
  useEffect(() => {
    const armed = isActive === true && IDLE_WATCH_PAGES.includes(activePage);
    if (!armed || !jwtForEffect) { setIdleNudge(0); return undefined; }
    idleActionRef.current = Date.now();
    idlePausedRef.current = false;
    setIdleNudge(0);
    const onAction = () => { idleActionRef.current = Date.now(); setIdleNudge(0); };
    window.addEventListener('pointerdown', onAction);
    window.addEventListener('keydown',     onAction);
    const interval = timerSettings.robotNudgeIntervalMs;
    const cap      = timerSettings.autoPauseNudgeCount;
    const id = setInterval(() => {
      const n = Math.floor((Date.now() - idleActionRef.current) / interval);
      setIdleNudge(n);
      if (n >= cap && !idlePausedRef.current) {
        idlePausedRef.current = true;
        fetch('/api/caller/self-pause', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtForEffect}` },
          body:    JSON.stringify({ reason: `Idle — no action taken on the ${activePage} page` }),
        }).catch(() => {});
      }
    }, 1000);
    return () => {
      clearInterval(id);
      window.removeEventListener('pointerdown', onAction);
      window.removeEventListener('keydown',     onAction);
    };
  }, [isActive, activePage, jwtForEffect, timerSettings.robotNudgeIntervalMs, timerSettings.autoPauseNudgeCount]);

  /* Voice the review-page idle nudge — same clip 40 ("do something")
     the Call page uses for its idle nudge. Previously these pages
     showed the visible bubble but stayed silent, so the warning felt
     weaker than on Assigned (which plays clip 41 on its own nudges).
     Fires once per nudge tick — matches the agent/form reason-card
     nudge cadence in LeadCallNoteModal. */
  useEffect(() => {
    if (idleNudge >= 1) playRobotClip(40);
  }, [idleNudge]);

  function handleLogout() {
    sessionStorage.removeItem('mhs_crm_user');
    sessionStorage.removeItem('mhs_crm_token');
    sessionStorage.removeItem('mhs_admin_token');
    sessionStorage.removeItem('mhs_caller_active_page');
    setUser(null);
  }

  if (!user) return <AdminLogin />;

  const callerName = user.full_name || nameProp || 'Caller';
  const callerRole = user.role      || roleProp || 'junior_caller';
  const jwt        = sessionStorage.getItem('mhs_crm_token') || '';     // caller JWT for /api/caller/*
  const roleLabel  = (
    callerRole === 'senior_caller' ? 'Senior Caller' :
    callerRole === 'junior_caller' ? 'Junior Caller' :
    callerRole === 'manager'       ? 'Manager' :
    callerRole === 'trainer'       ? 'Trainer' :
    callerRole === 'admin'         ? 'Admin' :
    callerRole === 'team_leader'   ? 'Team Leader' :
    'Team Member'
  );

  return (
    <TimerSettingsContext.Provider value={timerSettings}>
    <div style={{ minHeight: '100vh', background: '#EDEAF8', fontFamily: 'Outfit, sans-serif', padding: 16 }}>
      <style>{`
        /* Hide the scrollbar in WebKit (Chrome / Safari / Edge). The
           inline scrollbarWidth:'none' covers Firefox; this covers the
           rest. Applies at every viewport — overflow is always on. */
        .caller-tabs::-webkit-scrollbar { width: 0; height: 0; display: none; }
        @media (max-width: 720px) {
          .caller-topbar  { gap: 8px !important; }
          .caller-tabs    { padding: 4px !important; }
          .caller-tab-btn { padding: 8px 12px !important; font-size: 0.78rem !important; }
        }
      `}</style>

      {/* ── Top bar: tab card (left/center) + floating logo (right) ── */}
      <div
        className="caller-topbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* Tab card — wraps a hamburger toggle + the tab buttons.
            When `tabsCollapsed` is true, ONLY the hamburger shows
            (the tabs are removed from layout). Click the hamburger
            to re-expand. */}
        <div
          className="caller-tabs"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: '#fff',
            borderRadius: 16,
            padding: 6,
            border: '1px solid rgba(209,196,240,0.40)',
            boxShadow: '0 8px 32px rgba(91,33,182,0.10), 0 2px 8px rgba(91,33,182,0.04)',
            minWidth: 0,
            flexShrink: 1,
            // Always-on horizontal scroll so tabs stay inside the white
            // card at any viewport width. The scrollbar itself is hidden
            // (looks ugly inside a pill); trackpad / touch / shift-wheel
            // still scroll. Previously this lived in a 720px media query
            // so wider screens with too many tabs (e.g. Untouched / Next
            // Batch) overflowed the card.
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          {/* Hamburger — always visible, toggles the tab strip */}
          <button
            type="button"
            onClick={() => setTabsCollapsed(c => !c)}
            aria-label={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
            title={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 38, height: 38, borderRadius: 12, border: 'none',
              cursor: 'pointer', transition: 'background 180ms',
              background: tabsCollapsed ? '#5B21B6' : 'rgba(91,33,182,0.08)',
              color: tabsCollapsed ? '#fff' : '#5B21B6',
              flexShrink: 0,
            }}
            onMouseEnter={e => { if (!tabsCollapsed) e.currentTarget.style.background = 'rgba(91,33,182,0.15)'; }}
            onMouseLeave={e => { if (!tabsCollapsed) e.currentTarget.style.background = 'rgba(91,33,182,0.08)'; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          {!tabsCollapsed && visiblePages.map(p => {
            const isActive = activePage === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setActive(p.id)}
                className="caller-tab-btn"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '8px 16px', borderRadius: 12, border: 'none',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.85rem',
                  cursor: 'pointer', transition: 'all 200ms', whiteSpace: 'nowrap', flexShrink: 0,
                  background: isActive ? '#5B21B6' : 'transparent',
                  color:      isActive ? '#fff'    : 'rgba(91,33,182,0.55)',
                  boxShadow:  isActive ? '0 2px 10px rgba(91,33,182,0.30)' : 'none',
                }}
              >
                {p.icon}
                <span>{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* Floating logo (no card) on the right — click toggles dropdown */}
        <div ref={dropRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setShowDropdown(v => !v)}
            aria-label="Account menu"
            title="Account menu"
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: showDropdown ? 0.75 : 1,
              transition: 'opacity 180ms',
            }}
          >
            <img
              src="/favicon.png"
              alt="MHS"
              style={{ width: 40, height: 40, objectFit: 'contain' }}
            />
          </button>

          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 10px)',
                right: 0,
                minWidth: 220,
                background: '#fff',
                borderRadius: 14,
                border: '1px solid rgba(209,196,240,0.60)',
                boxShadow: '0 16px 48px rgba(91,33,182,0.20)',
                overflow: 'hidden',
                zIndex: 100,
                fontFamily: 'Outfit, sans-serif',
              }}
            >
              {/* User identity */}
              <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid rgba(209,196,240,0.40)' }}>
                <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(91,33,182,0.45)', marginBottom: 4 }}>
                  Signed in as
                </div>
                <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#3B0764', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {callerName}
                </div>
                <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)', marginTop: 2 }}>
                  {roleLabel}
                </div>
                {user.email && (
                  <div style={{ fontSize: '0.7rem', color: 'rgba(91,33,182,0.45)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {user.email}
                  </div>
                )}
              </div>

              {/* Robot voice volume — persists per-browser in localStorage
                  and applies to every playRobotClip() call across the app.
                  Tapping the speaker icon mutes/restores; the slider does
                  fine-grained control. Volume sample plays on slider
                  release so the caller hears the new level. */}
              <RobotVolumeRow />

              {/* Sign out */}
              <button
                onClick={handleLogout}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  border: 'none',
                  background: 'transparent',
                  textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 10,
                  fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem', fontWeight: 600,
                  color: '#DC2626',
                  cursor: 'pointer',
                  transition: 'background 150ms',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(254,242,242,0.70)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Page header ──
         The Call page is fullscreen-cinematic on purpose (orbit flow +
         centred glow button), so its header is suppressed. Every other
         page still shows the standard title + subtitle. */}
      {activePage !== 'call' && (
        <div style={{ marginBottom: 16, padding: '0 4px' }}>
          {/* Title row — heading + inline lead-count chip side-by-side.
              `flex-wrap` lets the chip drop to its own line on narrow
              viewports if there's not enough room for both. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, fontWeight: 700, fontSize: '1.25rem', color: '#3B0764' }}>
              {PAGE_TITLES[activePage]?.title || 'Dashboard'}
            </h1>
            {/* Lead count chip — reported by the active module via the
                onCount prop, hidden until the module has actually loaded
                (leadCount === null) so we never show a misleading "0". */}
            {leadCount != null && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 12px', borderRadius: 50,
                background: 'rgba(91,33,182,0.10)',
                border: '1px solid rgba(91,33,182,0.20)',
                color: '#5B21B6',
                fontFamily: 'Outfit, sans-serif',
                fontSize: '0.74rem', fontWeight: 700,
                letterSpacing: '0.02em',
              }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                {leadCount} {leadCount === 1 ? 'lead' : 'leads'}
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)' }}>
            {PAGE_TITLES[activePage]?.subtitle || ''}
          </p>
        </div>
      )}

      {/* ── Active page ── */}
      {activePage === 'call' && (
        <>
          <CallModule
            jwt={jwt} isActive={isActive} onStartAutoCall={requestAutoStart} robotMessage={callRobotMsg}
            /* Live status card data */
            assignedCount={leadCount != null ? leadCount : callerStats.assigned}
            tagCounts={callerStats.tags}
            callStatus={
              isActive === false
                ? { kind: 'blocked', reason: pauseInfo.reason || 'Account paused — contact admin' }
                : (callerBreak && callerBreak.endsAt)
                  ? { kind: 'break', reason: callerBreak.reason || 'On Break', endsAt: callerBreak.endsAt }
                  : { kind: 'active' }
            }
          />
          {/* Auto-call engine + call-note form + alert/break cards run here in
              callPageMode (no leads table) — overlaying the Call page so the
              caller never leaves it. Its corner-robot lines are routed to the
              center robot via onRobotMessage (no separate bottom robot). */}
          <AssignedLeadsModule callPageMode jwt={jwt} isActive={isActive} setMood={setMood} pendingAutoStart={pendingAutoStart} clearPendingAutoStart={clearPendingAutoStart} onCount={setLeadCount} onRobotMessage={setCallRobotMsg} onBreakInfo={setCallerBreak} />
        </>
      )}
      {activePage === 'assigned'     && <AssignedLeadsModule  jwt={jwt} isActive={isActive} externalHighlightId={externalHighlightId} setMood={setMood} pendingAutoStart={pendingAutoStart} clearPendingAutoStart={clearPendingAutoStart} onCount={setLeadCount} />}
      {activePage === 'untouched'    && <UntouchedLeadsModule jwt={jwt} onCount={setLeadCount} />}
      {activePage === 'completed'    && <CompletedLeadsModule jwt={jwt} onCount={setLeadCount} />}
      {activePage === 'not_picked'   && <NotPickedLeadsModule jwt={jwt} onCount={setLeadCount} />}
      {activePage === 'missed_calls' && <MissedCallsModule    jwt={jwt} onCount={setLeadCount} />}
      {activePage === 'next_batch'   && <NextBatchModule      jwt={jwt} onCount={setLeadCount} />}

      {/* ── Floating incoming-call toasts (top-right, persists across tabs) ── */}
      <IncomingCallToast jwt={jwt} onOpenLead={handleOpenLead} />

      {/* ── #20 — network-recovered robot (auto-clears after 7s) ──
         On the Call page it's routed to the center robot (effect below);
         everywhere else it flashes the bottom-right corner robot. */}
      {netRecoverPulse > 0 && activePage !== 'call' && (
        <RobotGuide
          variant="corner"
          mood="happy"
          text="network vandhuduchu nanba, continue pannu"
          audioSrc={ROBOT_CLIP[52]}
          pulse={netRecoverPulse}
          bubbleHideMs={6000}
        />
      )}

      {/* ── Idle nudge for the review pages — re-asks every nudge interval;
           the watchdog auto-pauses the account once the cap is reached. ── */}
      {idleNudge >= 1 && isActive === true && IDLE_WATCH_PAGES.includes(activePage) && (
        <RobotGuide
          variant="corner"
          mood="idle"
          text="nanba, idle ah irukeenga — lead call panna thodanga"
          pulse={idleNudge}
          bubbleHideMs={timerSettings.robotBubbleHideMs}
        />
      )}

      {/* ── Mascot bot (bottom-right) — removed per design.
           The CallModule already shows a much larger version of the same
           bot in the center of the Call page; the corner duplicate just
           competed for attention. Kept the import + setMood plumbing in
           case we want to bring it back behind a toggle later. */}
      {false && <MascotBot mood={mascotMood} />}

      {/* ── Paused robot — replaces the old paused-by-admin card ──
         Renders only when /api/caller/me reports is_active = false (admin
         pause OR any SmartFlow / nudge-exhaust auto-pause). No dismiss — the
         caller waits for admin to resume them. RobotGuide's overlay variant
         sits at z-index 9600; we lift it above every modal with the wrapper
         z-index 9900 so even an in-flight call modal can't be touched.
         On the Call page this overlay is suppressed — the paused line is
         shown through CallModule's center robot instead (single-robot page). */}
      {isActive === false && activePage !== 'call' && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9900 }}>
          <RobotGuide
            variant="overlay"
            mood="sad"
            text="account pause aaiduchu nanba admin ah contact pannunga"
            audioSrc={ROBOT_CLIP[53]}
            bubbleHideMs={999999}
          />
        </div>
      )}
    </div>
    </TimerSettingsContext.Provider>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   RobotVolumeRow — slider + speaker icon for the persisted robot voice
   volume. Subscribes to ROBOT_VOLUME_EVENT so cross-tab changes update
   live. Plays a short sample (clip 40 = generic robot voice) on release
   so the caller hears the new level immediately.
   ────────────────────────────────────────────────────────────────────── */
function RobotVolumeRow() {
  const [vol, setVol] = useState(() => getRobotVolume());

  useEffect(() => {
    function onEvt(e) {
      const next = typeof e.detail === 'number' ? e.detail : getRobotVolume();
      setVol(next);
    }
    window.addEventListener(ROBOT_VOLUME_EVENT, onEvt);
    return () => window.removeEventListener(ROBOT_VOLUME_EVENT, onEvt);
  }, []);

  // Remember the last non-zero level so unmute restores it.
  const lastNonZeroRef = useRef(vol > 0 ? vol : 0.9);
  useEffect(() => { if (vol > 0) lastNonZeroRef.current = vol; }, [vol]);

  function commit(next) {
    setRobotVolume(next); // module updates _volume + persists + dispatches event
  }

  function toggleMute() {
    if (vol > 0) commit(0);
    else commit(lastNonZeroRef.current || 0.9);
  }

  function previewClip() {
    // Brief sample so the caller hears their new level. playRobotClip
    // already reads the updated _volume so we don't pass it explicitly.
    try { playRobotClip(40); } catch { /* ignore */ }
  }

  const muted   = vol <= 0;
  const percent = Math.round(vol * 100);

  return (
    <div style={{
      padding: '12px 16px',
      borderBottom: '1px solid rgba(209,196,240,0.40)',
      display: 'flex', flexDirection: 'column', gap: 8,
      fontFamily: 'Outfit, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'rgba(91,33,182,0.55)',
        }}>
          Robot voice
        </span>
        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#5B21B6' }}>
          {muted ? 'Muted' : `${percent}%`}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Speaker / mute toggle */}
        <button
          type="button"
          onClick={toggleMute}
          title={muted ? 'Unmute robot voice' : 'Mute robot voice'}
          style={{
            width: 30, height: 30,
            borderRadius: 8, border: '1px solid rgba(139,92,246,0.25)',
            background: muted ? 'rgba(220,38,38,0.10)' : 'rgba(91,33,182,0.08)',
            color: muted ? '#DC2626' : '#5B21B6',
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            transition: 'all 150ms',
          }}
        >
          {muted ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="23" y1="9" x2="17" y2="15"/>
              <line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              {vol >= 0.35 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>}
              {vol >= 0.7  && <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>}
            </svg>
          )}
        </button>

        {/* Slider */}
        <input
          type="range"
          min="0" max="100" step="1"
          value={percent}
          onChange={(e) => commit(Number(e.target.value) / 100)}
          onMouseUp={previewClip}
          onTouchEnd={previewClip}
          style={{
            flex: 1,
            height: 4,
            accentColor: '#5B21B6',
            cursor: 'pointer',
          }}
        />
      </div>
    </div>
  );
}
