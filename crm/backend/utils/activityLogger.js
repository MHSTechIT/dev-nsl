/* Caller activity logger — append-only audit trail.
   Records every status transition in `caller_activity_events`. One open
   row per (caller_id, tag) is allowed; calling startEvent again for the
   same tag is a no-op (idempotent). endEvent stamps ended_at + duration.

   All functions are best-effort: errors are logged but never thrown to
   the caller, so a logging failure can never break the request path
   (heartbeat, call start/end, admin pause, etc.).

   Tags (kept in sync with frontend CallerActivityDrawer.jsx):
     LOGGED_IN, LOGGED_OUT, ACTIVE, ON_CALL, AFTER_CALL_FORM,
     ON_REASON_FORM, BREAK, BREAK_OVER, RESUMED, IDLE,
     PAUSED_BY_ADMIN, UNPAUSED_BY_ADMIN, OFFLINE
*/
const pool = require('../db');

const VALID_TAGS = new Set([
  'LOGGED_IN', 'LOGGED_OUT', 'ACTIVE', 'ON_CALL', 'AFTER_CALL_FORM',
  'ON_REASON_FORM', 'BREAK', 'BREAK_OVER', 'RESUMED', 'IDLE',
  'PAUSED_BY_ADMIN', 'UNPAUSED_BY_ADMIN', 'OFFLINE',
  // System-driven pause when a caller trips the SmartFlow agent-leg
  // retry cap (AGENT_RETRY_CAP in LeadCallNoteModal.jsx). The note-save
  // endpoint logs this once when it flips crm_users.is_active = FALSE.
  // Resume is handled by the existing PAUSED_BY_ADMIN / UNPAUSED_BY_ADMIN
  // pair via the super-admin PATCH endpoint.
  'PAUSED_BY_SMARTFLOW',
  // Page-level tags — exactly one open at any time on a logged-in caller.
  // Emitted by CallerShell when `activePage` changes.
  'ON_PAGE_CALL', 'ON_PAGE_ASSIGNED', 'ON_PAGE_COMPLETED',
  'ON_PAGE_NOT_PICKED', 'ON_PAGE_MISSED_CALLS', 'ON_PAGE_UNTOUCHED',
  'ON_PAGE_NEXT_BATCH',
  // Modal/overlay tags — replace the page tag while open and resume it on close.
  // VIEWING_LEAD: lead card modal is open, no call has started yet.
  // BREAK_PICKER: "Stop auto-call — pick your break reason" card.
  // BREAK_OTHER_PICKER: the "Other" sub-picker where caller types a custom reason.
  'VIEWING_LEAD', 'BREAK_PICKER', 'BREAK_OTHER_PICKER',
]);

/* Start an event. If one is already open for this (caller, tag), the
   call is a no-op so heartbeats can fire freely. */
async function startEvent(callerId, tag, context = null) {
  if (!callerId || !VALID_TAGS.has(tag)) return;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM caller_activity_events
        WHERE caller_id = $1 AND tag = $2 AND ended_at IS NULL
        LIMIT 1`,
      [callerId, tag]
    );
    if (rows.length > 0) return rows[0].id;  // already open
    const { rows: ins } = await pool.query(
      `INSERT INTO caller_activity_events (caller_id, tag, started_at, context)
       VALUES ($1, $2, NOW(), $3::jsonb)
       RETURNING id`,
      [callerId, tag, context ? JSON.stringify(context) : null]
    );
    return ins[0].id;
  } catch (err) {
    console.error('[activityLogger] startEvent error:', err.message);
    return null;
  }
}

/* End any open event for (caller, tag). If no open row exists this is
   a no-op. Optional `contextPatch` shallow-merges into the existing
   context (used to record over_by_sec when ending BREAK). */
async function endEvent(callerId, tag, contextPatch = null) {
  if (!callerId || !VALID_TAGS.has(tag)) return;
  try {
    if (contextPatch && typeof contextPatch === 'object') {
      await pool.query(
        `UPDATE caller_activity_events
            SET ended_at     = NOW(),
                duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int),
                context      = COALESCE(context, '{}'::jsonb) || $3::jsonb
          WHERE caller_id = $1 AND tag = $2 AND ended_at IS NULL`,
        [callerId, tag, JSON.stringify(contextPatch)]
      );
    } else {
      await pool.query(
        `UPDATE caller_activity_events
            SET ended_at     = NOW(),
                duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
          WHERE caller_id = $1 AND tag = $2 AND ended_at IS NULL`,
        [callerId, tag]
      );
    }
  } catch (err) {
    console.error('[activityLogger] endEvent error:', err.message);
  }
}

/* End any open events for this caller across multiple tags at once. */
async function endEventsForCaller(callerId, tags) {
  if (!callerId || !Array.isArray(tags) || tags.length === 0) return;
  const filtered = tags.filter(t => VALID_TAGS.has(t));
  if (filtered.length === 0) return;
  try {
    await pool.query(
      `UPDATE caller_activity_events
          SET ended_at     = NOW(),
              duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
        WHERE caller_id = $1 AND tag = ANY($2::text[]) AND ended_at IS NULL`,
      [callerId, filtered]
    );
  } catch (err) {
    console.error('[activityLogger] endEventsForCaller error:', err.message);
  }
}

/* Insert a point-in-time event (no duration). Useful for transitions
   that don't represent a sustained state: LOGGED_IN, LOGGED_OUT,
   RESUMED, PAUSED_BY_ADMIN, UNPAUSED_BY_ADMIN. */
async function logPointEvent(callerId, tag, context = null) {
  if (!callerId || !VALID_TAGS.has(tag)) return;
  try {
    const { rows } = await pool.query(
      `INSERT INTO caller_activity_events (caller_id, tag, started_at, ended_at, duration_sec, context)
       VALUES ($1, $2, NOW(), NOW(), 0, $3::jsonb)
       RETURNING id`,
      [callerId, tag, context ? JSON.stringify(context) : null]
    );
    return rows[0].id;
  } catch (err) {
    console.error('[activityLogger] logPointEvent error:', err.message);
    return null;
  }
}

module.exports = { startEvent, endEvent, endEventsForCaller, logPointEvent, VALID_TAGS };
