/* Caller activity logger — append-only audit trail.
   ===================================================================
   SINGLE-TAG MODEL: a caller has at most ONE open span at any moment.
   `switchTag` atomically closes the current open span and opens the new
   one in a transaction; the partial unique index
   `caller_activity_events_one_open` (see app.js) makes a second open
   row physically impossible, so races / multi-tab can't double-track.

   Point events (LOGGED_IN / LOGGED_OUT / LATE_RETURN) are zero-duration
   markers — they carry ended_at, so they never count as "open" spans.

   All functions are best-effort: errors are logged, never thrown, so a
   logging failure can never break the request path.
   =================================================================== */
const pool = require('../db');

/* Which activity table to write to, resolved per workspace. The shared caller
   routes pass the caller's workspace table; everything defaults to the Meta
   table so existing callers are unaffected. Allowlisted to prevent injection
   (the value is interpolated into SQL). */
const ACTIVITY_TABLES = new Set(['caller_activity_events', 'nsm_caller_activity_events']);
function activityTable(table) {
  return ACTIVITY_TABLES.has(table) ? table : 'caller_activity_events';
}

/* Span tags — exactly one open per caller (DB-enforced). */
const SPAN_TAGS = new Set([
  // Page tags — which workspace tab the caller is idling on.
  'ON_PAGE_CALL', 'ON_PAGE_ASSIGNED', 'ON_PAGE_COMPLETED',
  'ON_PAGE_NOT_PICKED', 'ON_PAGE_MISSED_CALLS', 'ON_PAGE_UNTOUCHED',
  'ON_PAGE_NEXT_BATCH',
  'ON_CALL',            // connected to a customer (talk time)
  'IN_FORM',            // after-call note form
  'REASON_CARD',        // "why didn't they pick / why no form" cards
  'EDITING_COMPLETED',  // editing an already-completed lead
  'ON_BREAK',           // on a break (type + timer in context)
  'BREAK_PICKER',       // choosing a break
  'BLOCKED',            // system auto-pause (reason in context)
  'PAUSED_BY_ADMIN',    // admin manually paused
]);

/* Point events — zero-duration markers (ended_at = started_at). */
const POINT_TAGS = new Set(['LOGGED_IN', 'LOGGED_OUT', 'LATE_RETURN']);

const VALID_TAGS = new Set([...SPAN_TAGS, ...POINT_TAGS]);

/* Atomically switch the caller's single open span to `newTag`.
   - If the open span already has `newTag`, it's a no-op (context refreshed).
   - Otherwise every open span is closed (stamped ended_at + duration_sec)
     and a fresh open span is inserted — all in one transaction.
   The SELECT ... FOR UPDATE row-lock serialises concurrent callers; the
   unique index is the final backstop. */
async function switchTag(callerId, newTag, context = null, table = 'caller_activity_events') {
  if (!callerId || !SPAN_TAGS.has(newTag)) return null;
  const T = activityTable(table);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, tag, started_at FROM ${T}
        WHERE caller_id = $1 AND ended_at IS NULL
        ORDER BY started_at DESC
        FOR UPDATE`,
      [callerId]
    );
    const open = rows[0];
    if (open && open.tag === newTag) {
      if (context) {
        await client.query(
          `UPDATE ${T}
              SET context = COALESCE(context, '{}'::jsonb) || $2::jsonb
            WHERE id = $1`,
          [open.id, JSON.stringify(context)]
        );
      }
      await client.query('COMMIT');
      return open.id;
    }
    if (rows.length > 0) {
      // A span the caller held for under 1 second is a flap or a pass-through
      // tab switch — delete it rather than logging a 0-second row that
      // clutters the timeline. Anything 1s or longer is closed normally.
      const openMs = Date.now() - new Date(open.started_at).getTime();
      if (rows.length === 1 && openMs < 1000) {
        await client.query(`DELETE FROM ${T} WHERE id = $1`, [open.id]);
      } else {
        await client.query(
          `UPDATE ${T}
              SET ended_at     = NOW(),
                  duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
            WHERE caller_id = $1 AND ended_at IS NULL`,
          [callerId]
        );
      }
    }
    const { rows: ins } = await client.query(
      `INSERT INTO ${T} (caller_id, tag, started_at, context)
       VALUES ($1, $2, NOW(), $3::jsonb)
       RETURNING id`,
      [callerId, newTag, context ? JSON.stringify(context) : null]
    );
    await client.query('COMMIT');
    return ins[0].id;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('[activityLogger] switchTag error:', err.message);
    return null;
  } finally {
    client.release();
  }
}

/* Close the caller's open span, if any (used by logout + the reaper).
   `at` lets the reaper backdate the close to the last heartbeat. */
async function closeOpenSpan(callerId, at = null, table = 'caller_activity_events') {
  if (!callerId) return;
  const T = activityTable(table);
  try {
    await pool.query(
      `UPDATE ${T}
          SET ended_at     = COALESCE($2::timestamptz, NOW()),
              duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (COALESCE($2::timestamptz, NOW()) - started_at))::int)
        WHERE caller_id = $1 AND ended_at IS NULL`,
      [callerId, at]
    );
  } catch (err) {
    console.error('[activityLogger] closeOpenSpan error:', err.message);
  }
}

/* Insert a point-in-time event (no duration): LOGGED_IN, LOGGED_OUT,
   LATE_RETURN. Never counts as an open span. */
async function logPointEvent(callerId, tag, context = null, table = 'caller_activity_events') {
  if (!callerId || !POINT_TAGS.has(tag)) return null;
  const T = activityTable(table);
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${T} (caller_id, tag, started_at, ended_at, duration_sec, context)
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

module.exports = { switchTag, closeOpenSpan, logPointEvent, VALID_TAGS, SPAN_TAGS, POINT_TAGS };
