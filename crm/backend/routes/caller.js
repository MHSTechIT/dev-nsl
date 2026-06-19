/**
 * Caller-scoped API. Mounted at /api/caller, all routes go through callerAuth.
 *
 *   GET  /api/caller/me               — return the JWT-decoded caller info
 *   GET  /api/caller/leads            — leads assigned to req.caller.id
 *   GET  /api/caller/leads/events     — SSE; pushes new lead assignments
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const callerSse = require('../utils/callerSse');
const { callerAuth } = require('../middleware/callerAuth');
const { workspaceConfig } = require('../utils/callerWorkspace');
const tataInboundSync = require('../utils/tataInboundSync');
const activityLogger = require('../utils/activityLogger');
// Auto-pause alerts now go over WhatsApp (Whapi) instead of Telegram. Same
// (callerId, reason) signature, so the call sites below are unchanged.
const { notifyAutoPauseWhatsApp: notifyAutoPause } = require('../utils/whatsappAlerts');

router.use(callerAuth);

/* ── Preview (admin "view as caller") read-only gate ──
   When an admin opens a caller's pages via a preview token (preview:true),
   every data READ is a GET, so we allow GETs through but reject any
   state-mutating / telephony call (POST/PATCH/PUT/DELETE) with 403. This
   guarantees an admin preview can never start a real call, log activity,
   self-pause, or otherwise touch the real caller's live session. */
router.use((req, res, next) => {
  if (req.caller?.preview && req.method !== 'GET') {
    return res.status(403).json({ error: 'preview_read_only' });
  }
  next();
});

/* ── GET /api/caller/page-access ──
   Returns the logged-in caller's page_access map ({ pageId: bool }) so the
   CallerShell can hide pages an admin turned off in Marketing/Web Reminder →
   Access. Default (missing key) = visible. */
router.get('/page-access', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT page_access FROM crm_users WHERE id = $1', [req.caller.id]);
    res.json({ page_access: rows[0]?.page_access || {} });
  } catch (err) {
    console.error('caller page-access error:', err.message);
    res.json({ page_access: {} });
  }
});

/* ── POST /api/caller/heartbeat ──
   Caller's browser fires this every ~30s and on every activity-state change
   (auto-call start/stop, call start/end, break start/end). Server records the
   most recent state so the admin's Sales Performance "Status" column can
   render live green/orange/red badges.

   Body: { status: 'working'|'on_break'|'idle', break?: {...} }
     - status='working': in a call or auto-call mode
     - status='on_break': break modal is up
     - status='idle':    nothing active

   rest_started_at transitions:
     - any → 'working'      → rest_started_at = NULL
     - 'working' → other    → rest_started_at = NOW() (only if was previously NULL)
     - other → other        → rest_started_at unchanged */
router.post('/heartbeat', async (req, res) => {
  const { status, break: breakInfo, tag, context } = req.body || {};
  const allowed = new Set(['working', 'on_break', 'idle']);
  if (!allowed.has(status)) {
    return res.status(422).json({ error: 'status must be one of: working, on_break, idle' });
  }
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    // Fetch previous state so we can update rest_started_at correctly,
    // and detect transitions for the activity audit log.
    const { rows: prev } = await pool.query(
      `SELECT activity_status, rest_started_at, last_heartbeat_at, is_active FROM ${cfg.users} WHERE id = $1`,
      [req.caller.id]
    );
    const prevStatus = prev[0]?.activity_status || null;
    const prevRest   = prev[0]?.rest_started_at || null;
    const prevHb     = prev[0]?.last_heartbeat_at || null;

    let nextRest;
    if (status === 'working') {
      nextRest = null;
    } else if (prevStatus === 'working' || !prevRest) {
      // First time leaving working OR rest_started_at was never set — stamp it.
      nextRest = new Date();
    } else {
      nextRest = prevRest;  // continue ticking
    }

    await pool.query(
      `UPDATE ${cfg.users}
          SET activity_status   = $1,
              activity_break    = $2::jsonb,
              last_heartbeat_at = NOW(),
              rest_started_at   = $3
        WHERE id = $4`,
      [
        status,
        breakInfo ? JSON.stringify(breakInfo) : null,
        nextRest,
        req.caller.id,
      ]
    );

    // ── Activity log (single-tag model) ──────────────────────────────────
    // The frontend computes ONE current tag and sends it here; we switch the
    // caller's single open span to it. Best-effort — never throws.
    try {
      const callerId = req.caller.id;
      const gapMs = prevHb ? Date.now() - new Date(prevHb).getTime() : Infinity;
      if (!prevHb || gapMs > 90_000) {
        await activityLogger.logPointEvent(callerId, 'LOGGED_IN', null, cfg.activity);
      }

      // Break-overrun auto-pause: >10 min past the break's end time pauses
      // the caller. The custom "Other" break is additionally exempt until
      // 30 min have elapsed since the break started.
      let autoPaused = false;
      if (tag === 'ON_BREAK' && breakInfo && breakInfo.endsAt && prev[0]?.is_active !== false) {
        const overtimeMs = Date.now() - new Date(breakInfo.endsAt).getTime();
        const elapsedMs  = breakInfo.startedAt ? Date.now() - new Date(breakInfo.startedAt).getTime() : 0;
        const isOther    = ![TEA_LABEL, LUNCH_LABEL, TWOHR_LABEL].includes(breakInfo.reason);
        if (overtimeMs > 10 * 60_000 && (!isOther || elapsedMs > 30 * 60_000)) {
          await pool.query(
            `UPDATE ${cfg.users}
                SET is_active = FALSE, auto_paused_at = NOW(), auto_pause_reason = $2
              WHERE id = $1`,
            [callerId, 'break_overrun']
          );
          try { callerSse.pushTo(callerId, { type: 'caller.paused' }); } catch (_) {}
          await activityLogger.switchTag(callerId, 'BLOCKED', { reason: 'break_overrun' }, cfg.activity);
          notifyAutoPause(callerId, 'break_overrun').catch(() => {});
          autoPaused = true;
        }
      }

      // Switch the single open span to the frontend-derived tag.
      if (!autoPaused && tag && activityLogger.SPAN_TAGS.has(tag)) {
        await activityLogger.switchTag(callerId, tag, context || null, cfg.activity);
      }
    } catch (logErr) {
      console.error('caller/heartbeat activity log error:', logErr.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('caller/heartbeat error:', err.message);
    res.status(500).json({ error: 'heartbeat_failed' });
  }
});

/* POST /api/caller/state was removed in the single-tag redesign — the
   heartbeat (above) is now the sole activity channel. The frontend derives
   ONE current tag and sends it on every heartbeat. */

/* Most-recent 08:00 AM IST as a UTC Date — the daily break-budget window
   start. 08:00 IST = 02:30 UTC. If "now" (IST) is before 08:00, the window
   opened yesterday. */
function breakBudgetWindowStart() {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  let y = istNow.getUTCFullYear(), m = istNow.getUTCMonth(), d = istNow.getUTCDate();
  if (istNow.getUTCHours() < 8) {
    const prev = new Date(Date.UTC(y, m, d) - 86400000);
    y = prev.getUTCFullYear(); m = prev.getUTCMonth(); d = prev.getUTCDate();
  }
  return new Date(Date.UTC(y, m, d, 2, 30, 0)); // 08:00 IST
}

/* ── GET /api/caller/break-budget ──
   Today's break usage (since 08:00 IST) for this caller, computed from the
   BREAK rows in caller_activity_events. Drives the break-picker: Tea is
   capped at 2/day, Lunch 1/day, 2-hr 1/day, and "Other" shares a 30-min/day
   pool. Ongoing breaks count via elapsed time. */
const TEA_LABEL   = 'Tea Break';
const LUNCH_LABEL = 'Lunch Break';
const TWOHR_LABEL = '2 Hour Permission';
router.get('/break-budget', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { rows } = await pool.query(
      `SELECT context->>'reason' AS reason,
              COALESCE(duration_sec, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)) AS dur_sec
         FROM ${cfg.activity}
        WHERE caller_id = $1 AND tag = 'ON_BREAK' AND started_at >= $2`,
      [req.caller.id, breakBudgetWindowStart()]
    );
    let tea = 0, lunch = 0, twohr = 0, otherSec = 0;
    for (const r of rows) {
      if (r.reason === TEA_LABEL)        tea++;
      else if (r.reason === LUNCH_LABEL) lunch++;
      else if (r.reason === TWOHR_LABEL) twohr++;
      else                               otherSec += Number(r.dur_sec) || 0;
    }
    res.json({
      tea_used:           tea,
      lunch_used:         lunch,
      twohr_used:         twohr,
      other_minutes_used: Math.round(otherSec / 60),
      // limits — caps the picker uses to grey out options
      limits: { tea: 2, lunch: 1, twohr: 1, other_minutes: 30 },
    });
  } catch (err) {
    console.error('caller/break-budget error:', err.message);
    res.status(500).json({ error: 'break_budget_failed' });
  }
});

/* ── GET /api/caller/stats ──
   Live numbers for the Call-page status card:
     • assigned — active assigned leads (same definition as GET /leads)
     • tags     — counts of leads this caller TAGGED TODAY (IST) by qualification
                  tag (HOT/WARM/COLD/JUNK) + FOLLOW-UP (follow_up) + DNP
                  (not_picked). The "today" window is the IST calendar day, so the
                  tiles naturally reset to 0 at 12:00 AM IST every night.
   Scoped to the caller's recent webinars, so it reflects the current batch. */
router.get('/stats', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    // Reused IST "noted today" predicate — last_note_at falls on the current
    // Asia/Kolkata calendar day. Crossing midnight IST flips every tile to 0.
    const TODAY_IST = `(l.last_note_at AT TIME ZONE 'Asia/Kolkata')::date
                       = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`;
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE l.next_batch_parked = FALSE
             AND (l.last_note_outcome IS NULL
                  OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()))
         )::int AS assigned,
         COUNT(*) FILTER (WHERE l.lead_tag = 'HOT'  AND ${TODAY_IST})::int AS hot,
         COUNT(*) FILTER (WHERE l.lead_tag = 'WARM' AND ${TODAY_IST})::int AS warm,
         COUNT(*) FILTER (WHERE l.lead_tag = 'COLD' AND ${TODAY_IST})::int AS cold,
         COUNT(*) FILTER (WHERE l.lead_tag = 'JUNK' AND ${TODAY_IST})::int AS junk,
         COUNT(*) FILTER (WHERE l.last_note_outcome = 'follow_up'  AND ${TODAY_IST})::int AS followup,
         COUNT(*) FILTER (WHERE l.last_note_outcome = 'not_picked' AND ${TODAY_IST})::int AS dnp
       FROM leads l
       WHERE l.assigned_user_id = $1
         AND (l.webinar_id IS NULL OR l.webinar_id IN ${cfg.recentWebinars})`,
      [req.caller.id]
    );
    const r = rows[0] || {};
    res.json({
      assigned: r.assigned || 0,
      tags: {
        hot: r.hot || 0, warm: r.warm || 0, cold: r.cold || 0,
        junk: r.junk || 0, followup: r.followup || 0, dnp: r.dnp || 0,
      },
    });
  } catch (err) {
    console.error('caller/stats error:', err.message);
    res.status(500).json({ error: 'stats_failed' });
  }
});

/* ── GET /api/caller/timer-settings ──
   Returns the merged admin-tuned timing values (stored clamped over defaults)
   so the caller frontend can drive its timers from server config. */
router.get('/timer-settings', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { mergeTimerSettings } = require('../utils/timerDefaults');
    const { rows } = await pool.query(`SELECT settings FROM ${cfg.timer} WHERE id = 1`);
    res.json({ settings: mergeTimerSettings(rows[0]?.settings || {}) });
  } catch (err) {
    console.error('caller/timer-settings error:', err.message);
    res.status(500).json({ error: 'timer_settings_failed' });
  }
});

/* ── POST /api/caller/late-reason ──
   Caller came back from a break >10 min late and typed why. We record it as
   a LATE_RETURN point event so it surfaces in the admin Activity Log drawer
   (admin sees the reason + how late). Body: { reason, over_by_sec }. */
router.post('/late-reason', async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  const overBySec = Number(req.body?.over_by_sec) || 0;
  if (!reason) return res.status(422).json({ error: 'reason is required' });
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    await activityLogger.logPointEvent(req.caller.id, 'LATE_RETURN', {
      reason, over_by_sec: overBySec,
    }, cfg.activity);
    console.log(JSON.stringify({
      type: 'caller.late_return', caller_id: req.caller.id,
      over_by_sec: overBySec, reason, at: new Date().toISOString(),
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('caller/late-reason error:', err.message);
    res.status(500).json({ error: 'late_reason_failed' });
  }
});

/* ── POST /api/caller/self-pause ──
   The caller workspace auto-pauses the account after repeated ignored robot
   nudges (idle screen, reason cards, break picker). Flips is_active = FALSE
   and pushes `caller.paused` over SSE so CallerShell shows the paused robot
   straight away. Resume is admin-only (the existing PATCH endpoint).
   Body: { reason? }. */
router.post('/self-pause', async (req, res) => {
  const reason = typeof req.body?.reason === 'string'
    ? req.body.reason.trim().slice(0, 200) : 'robot nudge ignored';
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    await pool.query(
      `UPDATE ${cfg.users}
          SET is_active        = FALSE,
              auto_paused_at    = NOW(),
              auto_pause_reason = $2
        WHERE id = $1`,
      [req.caller.id, reason]
    );
    await activityLogger.logPointEvent(req.caller.id, 'PAUSED_BY_SMARTFLOW', { reason }, cfg.activity);
    try { callerSse.pushTo(req.caller.id, { type: 'caller.paused' }); } catch (_) {}
    notifyAutoPause(req.caller.id, reason).catch(() => {});
    // Mark whatever lead this caller had open as Incomplete so it
    // surfaces in Completed Calls. Mirrors the admin/manager Pause
    // path; we want every auto-pause / admin-pause / manager-pause
    // path to converge on the same outcome. (Meta-only for now — the NSM
    // in-flight-cleanup util lands with the rest of NSM telephony.)
    if (cfg.workspace === 'meta') {
      try {
        const { markInFlightLeadIncomplete } = require('../utils/markInFlightLeadIncomplete');
        markInFlightLeadIncomplete({
          callerId: req.caller.id,
          reason:   `self_pause:${reason}`,
        }).catch(() => {});
      } catch (e) {
        console.error('[caller/self-pause] markInFlightLeadIncomplete load error:', e.message);
      }
    }
    console.log(JSON.stringify({
      type: 'caller.self_pause', caller_id: req.caller.id, reason,
      at: new Date().toISOString(),
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('caller/self-pause error:', err.message);
    res.status(500).json({ error: 'self_pause_failed' });
  }
});

/* ── GET /api/caller/me ──
   Returns the JWT payload PLUS the live is_active flag. The caller frontend
   uses is_active to show a blocking "paused by admin" overlay; the JWT alone
   can't be trusted for that because admin can flip it mid-session. */
router.get('/me', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { rows } = await pool.query(
      `SELECT is_active, auto_paused_at, auto_pause_reason FROM ${cfg.users} WHERE id = $1`,
      [req.caller.id]
    );
    const row = rows[0] || {};
    res.json({ caller: {
      ...req.caller,
      is_active:         row.is_active !== false,  // default to active if row vanished
      auto_paused_at:    row.auto_paused_at || null,
      auto_pause_reason: row.auto_pause_reason || null,
    } });
  } catch (err) {
    console.error('caller/me error:', err.message);
    // Return an error — never a fabricated is_active. A transient DB blip
    // must NOT flip the caller's pause state: that flipped the activity tag
    // between BLOCKED and the page tag, littering the log with 0s spans.
    // The frontend keeps its last known pause state on a failed /me.
    res.status(503).json({ error: 'me_unavailable' });
  }
});

/* ── GET /api/caller/leads ──
   Active assigned = no note yet, or marked follow_up whose time has arrived.
   Follow-ups whose time hasn't arrived live in the Completed Leads page.

   The LEAD_SELECT projection and the RECENT_WEBINARS subquery are resolved
   per-workspace from utils/callerWorkspace.js (cfg.leadSelect /
   cfg.recentWebinars) so the same handlers serve Meta and NSM leads. */
router.get('/leads', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { rows } = await pool.query(
      `${cfg.leadSelect}
        WHERE l.assigned_user_id = $1
          AND l.next_batch_parked = FALSE
          AND (
            -- Untouched-new leads stay scoped to the recent (current + previous)
            -- webinar window (plus pinned: admin "move to Assigned", reopened
            -- DNP/missed, inbound call). The matching Untouched query excludes
            -- pinned so they're never in both.
            (l.last_note_outcome IS NULL
              AND (l.webinar_id IS NULL OR l.webinar_id IN ${cfg.recentWebinars} OR l.pinned_at IS NOT NULL))
            -- A DUE follow-up always returns to Assigned regardless of webinar
            -- age — the caller scheduled it, so it must come back even after the
            -- webinar has ended / aged out of the recent window.
            OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW())
          )
        ORDER BY
          (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()) DESC NULLS LAST,
          l.pinned_at  DESC NULLS LAST,
          l.assigned_at DESC NULLS LAST, l.created_at DESC`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

/* ── GET /api/caller/leads/not-picked ──
   Leads this caller couldn't reach — either marked DNP (Did Not Pick) via
   the call-note modal OR auto-paused after the 5-attempt SmartFlow cap.
   Both buckets share the same "couldn't reach the customer" UX state. */
router.get('/leads/not-picked', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { rows } = await pool.query(
      `${cfg.leadSelect}
        WHERE l.assigned_user_id = $1
          AND l.last_note_outcome IN ('not_picked', 'auto_paused')
        ORDER BY l.last_note_at DESC NULLS LAST, l.created_at DESC`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads/not-picked error:', err.message);
    res.status(500).json({ error: 'Failed to fetch not-picked leads' });
  }
});

/* ── GET /api/caller/daily-target ──
   The global daily call target + how many DISTINCT leads this caller has dialed
   today (IST). Powers the caller-page progress cup. attempts counts outbound
   call attempts to actual leads; `done` flips true once target is reached. */
router.get('/daily-target', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { rows: t } = await pool.query('SELECT target FROM caller_daily_target WHERE id = 1');
    const target = t[0]?.target ?? 0;
    const { rows: a } = await pool.query(
      `SELECT COUNT(DISTINCT lead_id)::int AS attempts
         FROM ${cfg.calls}
        WHERE caller_id = $1
          AND direction = 'outbound'
          AND lead_id IS NOT NULL
          AND (started_at AT TIME ZONE 'Asia/Kolkata')::date
              = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      [req.caller.id]
    );
    const attempts_today = a[0]?.attempts ?? 0;
    res.json({ target, attempts_today, done: target > 0 && attempts_today >= target });
  } catch (err) {
    console.error('caller/daily-target error:', err.message);
    res.status(500).json({ error: 'Failed to load daily target' });
  }
});

/* ── GET /api/caller/leads/untouched ──
   Leads still assigned to this caller but tied to an OLDER webinar — older
   than the current + previous webinar. They drop out of the Assigned queue
   so the caller focuses on the latest two webinars, but stay fully callable
   here. Same uncompleted/non-parked filter as /leads, just the inverse
   webinar window. NULL-webinar leads never land here (they stay in Assigned). */
router.get('/leads/untouched', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { rows } = await pool.query(
      `${cfg.leadSelect}
        WHERE l.assigned_user_id = $1
          AND l.next_batch_parked = FALSE
          -- Only untouched-NEW leads on old webinars live here. Due follow-ups on
          -- old webinars now return to Assigned (see /leads), so they're excluded
          -- to avoid double-listing.
          AND l.last_note_outcome IS NULL
          AND l.webinar_id IS NOT NULL
          AND l.webinar_id NOT IN ${cfg.recentWebinars}
          -- Pinned leads belong in Assigned (see /leads), never Untouched.
          AND l.pinned_at IS NULL
        ORDER BY l.assigned_at ASC NULLS LAST, l.created_at ASC`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads/untouched error:', err.message);
    res.status(500).json({ error: 'Failed to fetch untouched leads' });
  }
});

/* ── POST /api/caller/leads/reopen ──
   "Refill the Assigned bucket" — called from the queue-end modal after an
   auto-call run finishes. Body: { source: 'dnp' | 'missed' }.

     'dnp'    → leads this caller marked as 'not_picked'.
     'missed' → leads linked to inbound-missed calls that hit either this
                caller (caller_id match) or this caller's configured Tata
                DIDs (tata_caller_id / tata_agent_number).

   For each matched lead we clear last_note_outcome and re-stamp
   assigned_at = NOW() so the Assigned Leads list (sorted assigned_at
   DESC) bubbles them straight to the top. Returns { moved: <count> }. */
router.post('/leads/reopen', async (req, res) => {
  const source = (req.body?.source || '').trim();
  if (source !== 'dnp' && source !== 'missed' && source !== 'untouched') {
    return res.status(422).json({ error: 'source must be "dnp", "missed", or "untouched"' });
  }

  // 'untouched' is a placeholder bucket — the data definition is TBD. For now
  // we accept the source so the front-end button works, but return zero moves.
  // Once we know what "untouched" means (no calls? no notes? unassigned?), the
  // matching UPDATE goes here.
  if (source === 'untouched') {
    return res.json({ moved: 0, source, pending_definition: true });
  }

  const cfg = workspaceConfig(req.caller.workspace);
  try {
    let result;
    if (source === 'dnp') {
      // Reopen both 'not_picked' and 'auto_paused' — both mean
      // "we couldn't reach the customer" and the UX bucket is the same.
      result = await pool.query(
        `UPDATE ${cfg.leads}
            SET last_note_outcome        = NULL,
                last_note_interested     = NULL,
                last_note_outcome_subtag = NULL,
                last_note_at             = NULL,
                follow_up_at             = NULL,
                completed_at             = NULL,
                assigned_at              = NOW(),
                pinned_at                = NOW(),
                -- Fresh assignment ⇒ no tag (see admin.js reopen note).
                lead_tag                 = NULL
          WHERE assigned_user_id  = $1
            AND last_note_outcome IN ('not_picked', 'auto_paused')
          RETURNING id`,
        [req.caller.id]
      );
    } else {
      // Resolve this caller's own DIDs (last-10) for matching unassigned
      // inbound-missed rows — same approach the /missed-inbound endpoint uses.
      const { rows: meRows } = await pool.query(
        `SELECT
           RIGHT(REGEXP_REPLACE(COALESCE(tata_caller_id, ''),    '\\D', '', 'g'), 10) AS caller_did,
           RIGHT(REGEXP_REPLACE(COALESCE(tata_agent_number, ''), '\\D', '', 'g'), 10) AS agent_did
           FROM ${cfg.users} WHERE id = $1`,
        [req.caller.id]
      );
      const myDids = [meRows[0]?.caller_did, meRows[0]?.agent_did].filter(d => d && d.length === 10);

      result = await pool.query(
        `UPDATE ${cfg.leads}
            SET last_note_outcome        = NULL,
                last_note_interested     = NULL,
                last_note_outcome_subtag = NULL,
                last_note_at             = NULL,
                follow_up_at             = NULL,
                completed_at             = NULL,
                assigned_at              = NOW(),
                pinned_at                = NOW(),
                assigned_user_id         = COALESCE(assigned_user_id, $1),
                -- Fresh assignment ⇒ no tag (see admin.js reopen note).
                lead_tag                 = NULL
          WHERE id IN (
            SELECT DISTINCT lead_id FROM ${cfg.calls}
             WHERE direction = 'inbound'
               AND lead_id IS NOT NULL
               AND status IN ('missed','failed')
               AND (caller_id = $1 OR did_number = ANY($2::text[]))
          )
          RETURNING id`,
        [req.caller.id, myDids]
      );
    }
    res.json({ moved: result.rowCount, source });
  } catch (err) {
    console.error('caller/leads/reopen error:', err.message);
    res.status(500).json({ error: 'Failed to reopen leads.' });
  }
});

/* ── GET /api/caller/leads/completed ──
   Completed leads + scheduled-but-not-yet-due follow-ups for this caller.
   Excludes leads parked in the Next-Batch bucket — those have their own page. */
router.get('/leads/completed', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { rows } = await pool.query(
      `${cfg.leadSelect}
        WHERE l.assigned_user_id = $1
          AND l.next_batch_parked = FALSE
          AND (
            l.last_note_outcome IN ('completed','not_interested','incomplete')
            OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW())
          )
        ORDER BY l.last_note_at DESC NULLS LAST`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads/completed error:', err.message);
    res.status(500).json({ error: 'Failed to fetch completed leads' });
  }
});

/* ── GET /api/caller/leads/next-batch ──
   Leads the caller parked by answering Q14 "Next Batch Joining" with Yes.
   They sit here until the admin starts a new batch (updates next_webinar_at),
   at which point routes/admin.js promotes them back to /leads as follow-ups. */
router.get('/leads/next-batch', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    const { rows } = await pool.query(
      `${cfg.leadSelect}
        WHERE l.assigned_user_id = $1
          AND l.next_batch_parked = TRUE
        ORDER BY l.next_batch_parked_at DESC NULLS LAST, l.last_note_at DESC NULLS LAST`,
      [req.caller.id]
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('caller/leads/next-batch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch next-batch leads' });
  }
});

/* ── POST /api/caller/leads/:id/note ──
   Save the post-call form. Updates the lead's denormalized state and writes
   an immutable lead_call_notes row. Pushes SSE so both views update live. */
// 'auto_paused' = the auto-call workflow hit the AGENT_RETRY_CAP SmartFlow
//                  cap on the agent leg (currently 15, defined in
//                  apps/crm/src/modules/LeadCallNoteModal.jsx). The lead is
//                  parked AND the caller's own crm_users.is_active is flipped
//                  to FALSE — only a super admin can resume them via PATCH
//                  /api/admin/crm-users/:id { is_active: true }.
// 'incomplete' = caller closed the modal (X button) WITHOUT finishing the
//                 form. The note row captures whatever partial values they
//                 typed; the lead lands in Completed Calls with the
//                 INCOMPLETE badge. Discovery-field validations are skipped
//                 (form was abandoned mid-fill, fields may be empty / invalid).
const ALLOWED_OUTCOMES = ['completed', 'follow_up', 'not_interested', 'not_picked', 'auto_paused', 'incomplete'];
const ALLOWED_RANGES   = ['250+', '200-250', '100-200', 'no_diabetes'];
const ALLOWED_AGES     = ['0-18', '19-24', '25-34', '35-44', '45-54', 'above-54'];

// Allowed values for outcome_subtag — the refinement reason the caller
// picks in the Not Interested dropdown OR the second-DNP choice card.
// Anything else is rejected with 422.
const ALLOWED_OUTCOME_SUBTAGS = new Set([
  // Not Interested toggle dropdown
  'other_languages', 'already_paid', 'not_available_for_webinar',
  'no_diabetes', 'no_sugar_interested', 'no_sugar_not_interested',
  'not_register', 'just_for_knowledge', 'call_disconnected',
  'wrong_number', 'already_attended',
  // Second-DNP choice card (the three non-DNP options)
  'switch_off', 'out_of_service', 'no_ring',
]);

// Allowed values for lead_tag — the modal computes this via
// classifyLeadTag() OR forces 'JUNK' when a subtag is set. The route
// trusts and persists what it receives, so the badge in Completed Calls
// reflects exactly what the caller saw at save time.
const ALLOWED_LEAD_TAGS = new Set(['HOT', 'WARM', 'COLD', 'JUNK']);

router.post('/leads/:id/note', async (req, res) => {
  const lead_id = req.params.id;
  const cfg = workspaceConfig(req.caller.workspace);
  const {
    full_name,
    sugar_confirmation, confirmed_range, range_for,
    patient_age, diet_status, takes_medicine, note,
    hba1c, other_languages, working_professional, location,
    already_paid, webinar_attended, available_for_webinar, next_batch_joining,
    outcome, follow_up_at, call_id,
    interested,
    outcome_subtag, lead_tag,
  } = req.body || {};

  if (!ALLOWED_OUTCOMES.includes(outcome)) {
    return res.status(422).json({ error: 'outcome must be one of: ' + ALLOWED_OUTCOMES.join(', ') });
  }
  if (outcome_subtag != null && outcome_subtag !== '' && !ALLOWED_OUTCOME_SUBTAGS.has(outcome_subtag)) {
    return res.status(422).json({ error: 'invalid outcome_subtag' });
  }
  if (lead_tag != null && lead_tag !== '' && !ALLOWED_LEAD_TAGS.has(lead_tag)) {
    return res.status(422).json({ error: 'invalid lead_tag' });
  }
  // 'not_picked' / 'auto_paused' = caller never reached the customer.
  // 'incomplete'                  = caller reached the customer but X-ed
  //                                 out without finishing the form.
  // All three skip the discovery-field validations because the relevant
  // fields are either missing (no contact ever) or partial (abandoned).
  const NO_CONTACT_OUTCOMES = new Set(['not_picked', 'auto_paused', 'incomplete']);
  if (!NO_CONTACT_OUTCOMES.has(outcome)) {
    if (outcome === 'follow_up' && !follow_up_at) {
      return res.status(422).json({ error: 'follow_up_at required when outcome is follow_up' });
    }
    if (confirmed_range && !ALLOWED_RANGES.includes(confirmed_range)) {
      return res.status(422).json({ error: 'invalid confirmed_range' });
    }
    if (patient_age && !ALLOWED_AGES.includes(patient_age)) {
      return res.status(422).json({ error: 'invalid patient_age' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Confirm the lead is assigned to this caller
    const { rows: leadRows } = await client.query(
      `SELECT id, assigned_user_id FROM ${cfg.leads} WHERE id = $1`,
      [lead_id]
    );
    if (leadRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'lead not found' });
    }
    if (leadRows[0].assigned_user_id !== req.caller.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'lead not assigned to you' });
    }

    // Insert the note row
    const { rows: noteRows } = await client.query(
      `INSERT INTO ${cfg.notes}
         (lead_id, caller_id, call_id, sugar_confirmation, confirmed_range,
          range_for, patient_age, diet_status, takes_medicine, note,
          hba1c, other_languages, working_professional, location,
          already_paid, webinar_attended, available_for_webinar, next_batch_joining,
          outcome, follow_up_at, interested, outcome_subtag, lead_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
       RETURNING id, created_at`,
      [
        lead_id, req.caller.id, call_id || null,
        sugar_confirmation || null, confirmed_range || null,
        range_for || null, patient_age || null,
        diet_status || null, takes_medicine || null,
        (note || '').trim() || null,
        hba1c || null, other_languages || null,
        working_professional || null, location || null,
        already_paid || null, webinar_attended || null,
        available_for_webinar || null, next_batch_joining || null,
        outcome,
        outcome === 'follow_up' ? follow_up_at : null,
        interested === 'yes' || interested === 'no' ? interested : null,
        outcome_subtag || null,
        lead_tag || null,
      ]
    );

    // Update denormalized columns on leads (and full_name if the caller edited it).
    // Re-asserts assigned_user_id in WHERE to close the TOCTOU window between
    // the ownership SELECT above and this UPDATE — a concurrent reassignment
    // would otherwise let this caller mutate a lead they no longer own.
    // If the caller answered Q14 (next_batch_joining) with Yes, park the lead
    // in the Next-Batch bucket — it disappears from Assigned/Completed until
    // admin starts a new batch.
    const cleanName = typeof full_name === 'string' ? full_name.trim() : '';
    const parkForNextBatch = next_batch_joining === 'yes';
    await client.query(
      `UPDATE ${cfg.leads}
          SET last_note_outcome         = $2,
              last_note_at              = NOW(),
              follow_up_at              = $3,
              completed_at              = CASE WHEN $2 IN ('completed','not_interested','incomplete') THEN NOW() ELSE NULL END,
              last_note_interested      = $4,
              full_name                 = COALESCE(NULLIF($5, ''), full_name),
              next_batch_parked         = CASE WHEN $7 THEN TRUE  ELSE next_batch_parked    END,
              next_batch_parked_at      = CASE WHEN $7 THEN NOW() ELSE next_batch_parked_at END,
              last_note_outcome_subtag  = $8,
              lead_tag                  = COALESCE($9, lead_tag)
        WHERE id = $1
          AND assigned_user_id = $6`,
      [
        lead_id,
        outcome,
        outcome === 'follow_up' ? follow_up_at : null,
        interested === 'yes' || interested === 'no' ? interested : null,
        cleanName,
        req.caller.id,
        parkForNextBatch,
        outcome_subtag || null,
        lead_tag || null,
      ]
    );

    // SmartFlow auto-pause: when the caller submits a note with
    // outcome='auto_paused' the front-end has just tripped AGENT_RETRY_CAP
    // (currently 15) consecutive agent-side misses on this lead. We flip the
    // caller's own is_active to FALSE inside the same transaction so the
    // lead-state change and the account-pause are atomic. The caller cannot
    // un-pause themselves — only a super admin can, via PATCH
    // /api/admin/crm-users/:id (adminAuth = ADMIN_PASSWORD bearer).
    //
    // We only act when is_active is currently TRUE — repeat auto_paused
    // outcomes on subsequent leads should not overwrite an earlier
    // auto_paused_at timestamp, and they should not log duplicate audit
    // events. The RETURNING clause tells us whether we actually paused.
    let autoPausedThisRequest = false;
    if (outcome === 'auto_paused') {
      const { rows: pauseRows } = await client.query(
        `UPDATE ${cfg.users}
            SET is_active         = FALSE,
                auto_paused_at    = NOW(),
                auto_pause_reason = 'smartflow_cap_exceeded'
          WHERE id        = $1
            AND is_active = TRUE
        RETURNING id`,
        [req.caller.id]
      );
      autoPausedThisRequest = pauseRows.length > 0;
    }

    await client.query('COMMIT');

    // Fire the Telegram alert AFTER the transaction commits, so subscribers
    // never see a "paused" alert that we later rolled back.
    if (autoPausedThisRequest) {
      notifyAutoPause(req.caller.id, 'smartflow_cap_exceeded').catch(() => {});
    }

    // Structured log — one JSON line per note save. Grep on Render with
    // e.g. `lead_id=<uuid>` to trace a lead's lifecycle across callers.
    console.log(JSON.stringify({
      type:      'call_note_saved',
      caller_id: req.caller.id,
      lead_id,
      outcome,
      call_id:   call_id || null,
      follow_up_at: outcome === 'follow_up' ? follow_up_at : null,
      note_id:   noteRows[0].id,
      auto_paused_caller: autoPausedThisRequest,
      at:        new Date().toISOString(),
    }));

    // Push SSE so both Assigned and Completed pages can react
    callerSse.pushTo(req.caller.id, {
      type: 'lead.note_saved',
      lead_id,
      outcome,
      follow_up_at: outcome === 'follow_up' ? follow_up_at : null,
      note_id: noteRows[0].id,
    });

    // Side effects of the SmartFlow auto-pause. Pushed AFTER commit so the
    // CallerShell receives them only once the DB state actually reflects
    // is_active=FALSE.
    if (autoPausedThisRequest) {
      try {
        callerSse.pushTo(req.caller.id, {
          type: 'caller.paused',
          is_active: false,
          reason:    'smartflow_cap_exceeded',
        });
      } catch (sseErr) {
        console.error('[caller] smartflow-pause SSE push error:', sseErr.message);
      }
      activityLogger.logPointEvent(
        req.caller.id,
        'PAUSED_BY_SMARTFLOW',
        { lead_id },
        cfg.activity
      );
    }

    res.json({
      success: true,
      note_id: noteRows[0].id,
      outcome,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('caller/note error:', err.message);
    res.status(500).json({ error: 'Failed to save note' });
  } finally {
    client.release();
  }
});

/* ── GET /api/caller/leads/events ── (SSE)
   Note: EventSource cannot set headers, so callerAuth also accepts ?token=<jwt> */
router.get('/leads/events', (req, res) => {
  res.set({
    'Content-Type':    'text/event-stream',
    'Cache-Control':   'no-cache',
    'Connection':      'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  callerSse.add(req.caller.id, res);

  // Heartbeat every 30 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n'); } catch (_) { /* drop on next pushTo */ }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    callerSse.remove(req.caller.id, res);
  });
});

/* ── GET /api/caller/calls/missed-inbound ──
   Customers who called the caller's Tata DID but weren't connected (or rang
   without anyone picking up). Includes:
     – calls linked to a lead assigned to this caller (status=missed/failed
       OR a stale 'ringing' row older than 2 min)
     – calls with no matching lead (caller_id NULL) — surfaced to every CRM
       as an 'Unknown caller' that any agent can claim.

   Sorted newest-first so fresh missed calls always appear at the top. */
router.get('/calls/missed-inbound', async (req, res) => {
  const cfg = workspaceConfig(req.caller.workspace);
  try {
    // Look up this caller's own Tata numbers (last-10) — we filter the
    // unassigned-missed bucket to only those that hit one of these DIDs.
    // Without this, every caller saw every missed call across the org.
    const { rows: meRows } = await pool.query(
      `SELECT
         RIGHT(REGEXP_REPLACE(COALESCE(tata_caller_id, ''),    '\\D', '', 'g'), 10) AS caller_did,
         RIGHT(REGEXP_REPLACE(COALESCE(tata_agent_number, ''), '\\D', '', 'g'), 10) AS agent_did
         FROM ${cfg.users} WHERE id = $1`,
      [req.caller.id]
    );
    const myDids = [meRows[0]?.caller_did, meRows[0]?.agent_did].filter(d => d && d.length === 10);

    const { rows } = await pool.query(
      `SELECT c.id, c.lead_id, c.caller_id, c.provider_call_id, c.status,
              c.direction, c.started_at, c.ended_at, c.duration_sec, c.recording_url,
              c.hangup_by, c.raw_payload, c.caller_phone, c.did_number,
              l.full_name AS lead_full_name,
              ${cfg.leadPhoneExpr} AS lead_phone,
              l.email AS lead_email,
              ${cfg.leadSugarExpr} AS lead_sugar_level
         FROM ${cfg.calls} c
         LEFT JOIN ${cfg.leads} l ON l.id = c.lead_id
        WHERE c.direction = 'inbound'
          AND (
            c.caller_id = $1
            OR (c.caller_id IS NULL AND c.did_number = ANY($2::text[]))
          )
          AND (
            c.status IN ('missed','failed')
            OR (c.status = 'ringing' AND c.started_at < NOW() - INTERVAL '2 minutes')
            OR (c.status = 'ended' AND c.agent_answered_at IS NULL)
          )
        ORDER BY c.started_at DESC NULLS LAST
        LIMIT 200`,
      [req.caller.id, myDids]
    );

    // Caller phone — prefer the dedicated calls.caller_phone column; if NULL
    // (very old rows that pre-date the column), fall back to the lead's phone,
    // then to a best-effort scrape of raw_payload aliases.
    const out = rows.map(r => {
      const raw = r.raw_payload || {};
      const phoneRaw = r.caller_phone
        || r.lead_phone
        || raw.caller_id_number || raw.client_number || raw.callerIdNumber
        || raw.from || raw.From || raw.from_number || raw.source || null;
      const phone10 = phoneRaw ? String(phoneRaw).replace(/\D/g, '').slice(-10) : null;
      return {
        id:              r.id,
        lead_id:         r.lead_id,
        is_known:        !!r.lead_id,
        full_name:       r.lead_full_name || 'Unknown caller',
        phone:           phone10,
        email:           r.lead_email,
        sugar_level:     r.lead_sugar_level,
        status:          r.status,
        started_at:      r.started_at,
        duration_sec:    r.duration_sec,
        recording_url:   r.recording_url,
        hangup_by:       r.hangup_by,
      };
    });
    res.json({
      calls: out,
      total: out.length,
      // Surface which DIDs are being filtered on so the UI can show the
      // caller what numbers their missed-calls list is scoped to.
      filtered_dids: myDids,
    });
  } catch (err) {
    console.error('caller/calls/missed-inbound error:', err.message);
    res.status(500).json({ error: 'Failed to fetch missed inbound calls' });
  }
});

/* ── POST /api/caller/calls/sync-inbound ──
   Manually triggers a Tata CDR poll. Useful from the Missed Calls page to
   force-refresh when the customer reports they just called. Returns the
   poll result so the frontend can show "synced 3 new" or the error. */
router.post('/calls/sync-inbound', async (req, res) => {
  // tataInboundSync polls Meta's CDR → calls table. NSM inbound CDR sync lands
  // with the rest of NSM telephony; until then it's a no-op for NSM callers.
  if (workspaceConfig(req.caller.workspace).workspace !== 'meta') {
    return res.json({ upserted: 0, skipped: true });
  }
  try {
    const result = await tataInboundSync.syncOnce({ lookbackMinutes: 60 });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
