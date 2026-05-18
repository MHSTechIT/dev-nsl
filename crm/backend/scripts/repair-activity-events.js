/**
 * Repair caller_activity_events rows whose durations are clearly bogus
 * (Tata hangup webhook lost → ON_CALL row left open → closed hours/days
 * later with a 34h+ "duration"). Caps each tag at a realistic maximum
 * and back-computes ended_at so the dashboard stops showing the giant
 * spans.
 *
 * Safe to re-run — only rows that look broken are touched, and the
 * original (broken) duration is preserved in context.repair so we can
 * audit/rollback later if needed.
 *
 * Run with:
 *   cd E:\nsl\crm\backend
 *   node scripts/repair-activity-events.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

// "If a tag's duration is longer than this, we don't believe it." (seconds)
const SANE_MAX = {
  ON_CALL:         30 * 60,         //   30 min — longest realistic single call
  AFTER_CALL_FORM: 10 * 60,         //   10 min — form-fill window
  ON_REASON_FORM:  10 * 60,
  ACTIVE:           4 * 60 * 60,    //    4 h   — typical shift
  IDLE:             2 * 60 * 60,    //    2 h
  BREAK:           45 * 60,         //   45 min — generous break
  // Point-in-time tags (LOGGED_IN, LOGGED_OUT, RESUMED, etc.) should always
  // be 0s by design — anything else means a broken insert path. Cap to 0.
  LOGGED_IN:        0,
  LOGGED_OUT:       0,
  RESUMED:          0,
  PAUSED_BY_ADMIN:  0,
  UNPAUSED_BY_ADMIN: 0,
  BREAK_OVER:       0,
  OFFLINE:          0,
  PAUSED_BY_SMARTFLOW: 0,
};
// Replacement duration when we detect a stuck-open or runaway row. Most of
// these are conservative midpoints — "we don't know what really happened,
// pick a plausible number that won't dominate the day-total bar."
const REPAIR_DUR = {
  ON_CALL:          60,    //  1 min
  AFTER_CALL_FORM:  60,
  ON_REASON_FORM:   60,
  ACTIVE:           300,   //  5 min
  IDLE:             300,
  BREAK:            300,
  LOGGED_IN:        0,
  LOGGED_OUT:       0,
  RESUMED:          0,
  PAUSED_BY_ADMIN:  0,
  UNPAUSED_BY_ADMIN: 0,
  BREAK_OVER:       0,
  OFFLINE:          0,
  PAUSED_BY_SMARTFLOW: 0,
};

(async () => {
  const url = process.env.DATABASE_URL || '';
  const usesSsl = !/localhost|13\.234\.115\.104/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: usesSsl ? { rejectUnauthorized: false } : false,
  });

  try {
    // 1. CLOSED rows whose stored duration exceeds the sane max for their tag.
    let repairedClosed = 0;
    for (const tag of Object.keys(SANE_MAX)) {
      const cap = SANE_MAX[tag];
      const replacement = REPAIR_DUR[tag];
      const { rows } = await pool.query(
        `UPDATE caller_activity_events
            SET ended_at     = started_at + ($1::int || ' seconds')::interval,
                duration_sec = $1::int,
                context      = COALESCE(context, '{}'::jsonb) ||
                               jsonb_build_object(
                                 'repair', jsonb_build_object(
                                   'fixed_at',           NOW(),
                                   'reason',             'duration_exceeded_sane_max',
                                   'original_duration_sec', duration_sec,
                                   'capped_to_sec',      $1::int
                                 )
                               )
          WHERE tag = $2
            AND ended_at IS NOT NULL
            AND duration_sec > $3::int
          RETURNING id`,
        [replacement, tag, cap]
      );
      if (rows.length > 0) {
        console.log(`  [closed/${tag}] capped ${rows.length} runaway row(s) → duration=${replacement}s`);
        repairedClosed += rows.length;
      }
    }

    // 2. OPEN rows older than their tag's sane max — close them with the
    //    replacement duration. These are the "ghosts" that never got an
    //    endEvent call (server crash, lost Tata webhook, etc.).
    let repairedOpen = 0;
    for (const tag of Object.keys(SANE_MAX)) {
      const cap = SANE_MAX[tag];
      const replacement = REPAIR_DUR[tag];
      const { rows } = await pool.query(
        `UPDATE caller_activity_events
            SET ended_at     = started_at + ($1::int || ' seconds')::interval,
                duration_sec = $1::int,
                context      = COALESCE(context, '{}'::jsonb) ||
                               jsonb_build_object(
                                 'repair', jsonb_build_object(
                                   'fixed_at',  NOW(),
                                   'reason',    'open_row_older_than_sane_max',
                                   'capped_to_sec', $1::int
                                 )
                               )
          WHERE tag = $2
            AND ended_at IS NULL
            AND started_at < NOW() - ($3::int || ' seconds')::interval
          RETURNING id`,
        [replacement, tag, cap]
      );
      if (rows.length > 0) {
        console.log(`  [open/${tag}]   closed ${rows.length} ghost row(s) → duration=${replacement}s`);
        repairedOpen += rows.length;
      }
    }

    console.log(`\n✓ Done. ${repairedClosed} runaway rows capped, ${repairedOpen} ghost rows closed.`);
  } catch (err) {
    console.error('✗ FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
