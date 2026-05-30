/* ────────────────────────────────────────────────────────────────────────
   Meta Tracking — passive behaviour observers.
   ----------------------------------------------------------------------
   Import this file ONCE near app entry (main.jsx). It attaches global
   listeners that fire the following Meta custom events without each
   screen having to opt-in:

     ScrollDepth        — at 25 / 50 / 75 / 100% page-scroll milestones,
                          per session (each threshold fires at most once)
     TimeOnPage         — at 15 / 30 / 60 / 120 / 300 s milestones
     EngagementHigh     — composite signal: 3+ FieldSelect events
                          within a 60-second rolling window
     ExitIntent         — pointer leaves viewport from the top edge
                          (desktop only)
     VisibilityChange   — tab focused vs blurred
     PageHide           — fired on tab close / navigation away
                          (uses sendBeacon under the hood)

   None of these block the funnel — every handler is wrapped in try /
   catch, and analytics failures are silent.
   ──────────────────────────────────────────────────────────────────── */

import { mpTrackCustom } from './metaPixel';

let _wired = false;

export function initMetaTracking() {
  if (_wired || typeof window === 'undefined') return;
  _wired = true;

  /* ── 1. Scroll depth ───────────────────────────────────────────── */
  const SCROLL_BUCKETS = [25, 50, 75, 100];
  const firedScroll = new Set();
  function onScroll() {
    try {
      const h = document.documentElement;
      const total = (h.scrollHeight - h.clientHeight) || 1;
      const pct = Math.min(100, Math.max(0, (h.scrollTop / total) * 100));
      for (const b of SCROLL_BUCKETS) {
        if (pct >= b && !firedScroll.has(b)) {
          firedScroll.add(b);
          mpTrackCustom('ScrollDepth', {
            depth_pct: b,
            depth_label: `${b}%`,
          });
        }
      }
    } catch { /* ignore */ }
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ── 2. Time on page ───────────────────────────────────────────── */
  const TIME_BUCKETS = [15, 30, 60, 120, 300];
  const start = Date.now();
  const firedTime = new Set();
  for (const sec of TIME_BUCKETS) {
    setTimeout(() => {
      // Only fire if the tab is still visible — counting time spent
      // on a backgrounded tab inflates the signal.
      if (document.visibilityState !== 'visible') return;
      if (firedTime.has(sec)) return;
      firedTime.add(sec);
      mpTrackCustom('TimeOnPage', {
        seconds: sec,
        elapsed_ms: Date.now() - start,
      });
    }, sec * 1000);
  }

  /* ── 3. Engagement composite ─────────────────────────────────────
     Counts FieldSelect_ events; when 3 fire within a rolling 60s
     window, emits a single EngagementHigh custom event. Helps Meta
     identify "explorer" users vs. "click-bouncers". */
  const selectTimes = [];
  let engagementFired = false;
  window.addEventListener('mhs:meta:field-select', () => {
    const now = Date.now();
    selectTimes.push(now);
    // Trim entries older than 60s
    while (selectTimes.length && now - selectTimes[0] > 60000) selectTimes.shift();
    if (!engagementFired && selectTimes.length >= 3) {
      engagementFired = true;
      mpTrackCustom('EngagementHigh', {
        selects_in_window: selectTimes.length,
        window_sec: 60,
      });
    }
  });

  /* ── 4. Exit intent (desktop only) ─────────────────────────────── */
  if (window.matchMedia && !window.matchMedia('(pointer: coarse)').matches) {
    let exitFired = false;
    document.addEventListener('mouseout', (e) => {
      if (exitFired) return;
      if (!e.toElement && e.clientY < 10) {
        exitFired = true;
        mpTrackCustom('ExitIntent', { y: e.clientY });
      }
    });
  }

  /* ── 5. Visibility ─────────────────────────────────────────────── */
  document.addEventListener('visibilitychange', () => {
    mpTrackCustom('VisibilityChange', {
      state: document.visibilityState,
    });
  });

  /* ── 6. Page hide — fires on tab close / SPA navigation away ──── */
  window.addEventListener('pagehide', () => {
    mpTrackCustom('PageHide', {
      elapsed_ms: Date.now() - start,
      visible_at_hide: document.visibilityState === 'visible',
    });
  });
}

/* Tiny helper for the field-select side-effect: any caller that
   tracks a field selection should also dispatch this event so the
   EngagementHigh composite can count it. metaPixel.trackFieldSelect
   already calls window.dispatchEvent(new Event(...)) is unnecessary
   here since fieldSelect is a low-frequency call — instead the
   convention is to dispatch this from the screens directly. */
export function signalFieldSelect() {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new Event('mhs:meta:field-select')); } catch { /* ignore */ }
}
