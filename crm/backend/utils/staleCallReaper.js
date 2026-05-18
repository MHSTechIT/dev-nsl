/* Stale-call watchdog.
   ===================================================================
   Tata's webhook delivery is best-effort. When a call's terminal events
   (hangup / recording) never arrive, a `calls` row can sit in 'initiated'
   or 'ringing' indefinitely — the CRM modal stays stuck in a ringing
   phase and the lead never moves out of the queue.

   This watchdog scans every `intervalMs` and marks any non-terminal
   `calls` row older than `staleAfterMs` as 'failed'. It also pushes an
   SSE event to the owning caller's CRM tab so the auto-call state
   machine can advance (the modal listens for call.update / agent.missed
   / call.hangup and synthesizes a recovery).
   =================================================================== */

const pool      = require('../db');
const callerSse = require('./callerSse');

const DEFAULT_INTERVAL_MS    = 60 * 1000;        // 60 s
const DEFAULT_STALE_AFTER_MS = 3 * 60 * 1000;    // 3 min — generous enough
                                                  // that legitimate ringing
                                                  // (~50 s) doesn't trip it.

let _timer = null;

async function reapOnce(staleAfterMs) {
  const cutoffMin = Math.ceil(staleAfterMs / 60000);
  try {
    const { rows } = await pool.query(
      `UPDATE calls
          SET status      = 'failed',
              ended_at    = COALESCE(ended_at, NOW()),
              error_message = COALESCE(error_message, 'stale-call-reaper'),
              updated_at  = NOW()
        WHERE status IN ('initiated','ringing','answered')
          AND started_at < NOW() - ($1 || ' minutes')::interval
          AND ended_at IS NULL
        RETURNING id, lead_id, caller_id, provider_call_id`,
      [String(cutoffMin)]
    );
    if (rows.length === 0) return 0;
    for (const r of rows) {
      try {
        console.log(JSON.stringify({
          type:             'stale_call_reaped',
          call_id:          r.id,
          lead_id:          r.lead_id,
          caller_id:        r.caller_id,
          provider_call_id: r.provider_call_id,
          stale_after_min:  cutoffMin,
          at:               new Date().toISOString(),
        }));
      } catch (_) { /* best-effort log */ }
      // Close any matching activity-event rows that would otherwise be
      // left open forever (ON_CALL / AFTER_CALL_FORM / ON_REASON_FORM
      // tags). Without this the caller's activity dashboard ends up
      // showing 30h+ "on call" entries days later.
      if (r.caller_id) {
        try {
          await pool.query(
            `UPDATE caller_activity_events
                SET ended_at     = NOW(),
                    duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int),
                    context      = COALESCE(context, '{}'::jsonb) ||
                                   jsonb_build_object('closed_by', 'stale_call_reaper',
                                                      'call_id',   $2::text)
              WHERE caller_id = $1
                AND tag IN ('ON_CALL','AFTER_CALL_FORM','ON_REASON_FORM')
                AND ended_at IS NULL`,
            [r.caller_id, r.id]
          );
        } catch (err) {
          console.error('[staleCallReaper] activity-event close error:', err.message);
        }
        // Notify the owning caller so the modal can synthesize a recovery
        // (call.hangup → form_window if customer answered, else agent.missed).
        callerSse.pushTo(r.caller_id, {
          type: 'call.hangup',
          call: {
            id:        r.id,
            lead_id:   r.lead_id,
            caller_id: r.caller_id,
            status:    'failed',
            ended_at:  new Date().toISOString(),
          },
        });
      }
    }
    return rows.length;
  } catch (err) {
    console.error('[staleCallReaper] reap error:', err.message);
    return 0;
  }
}

function startStaleCallReaper({
  intervalMs    = DEFAULT_INTERVAL_MS,
  staleAfterMs  = DEFAULT_STALE_AFTER_MS,
} = {}) {
  if (_timer) return;
  console.log(`[staleCallReaper] scheduler started — every ${Math.round(intervalMs/1000)}s, stale ≥ ${Math.round(staleAfterMs/60000)}min`);
  _timer = setInterval(() => { reapOnce(staleAfterMs); }, intervalMs);
  // Fire once on startup so stuck rows from a previous restart get cleared.
  setTimeout(() => reapOnce(staleAfterMs), 5000);
}

function stopStaleCallReaper() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startStaleCallReaper, stopStaleCallReaper, reapOnce };
