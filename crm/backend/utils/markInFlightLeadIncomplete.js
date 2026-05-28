/* Shared utility — mark a caller's currently-open lead as Incomplete.
   ===================================================================
   Called when a caller is forcibly removed from active work:
     • Admin / Manager hits Pause on the Sales Performance kebab.
     • Caller self-pauses (idle nudge cap, /api/caller/self-pause).
     • Caller's heartbeat goes stale, the browser was closed without
       a save (handled by activitySpanReaper — this helper is the
       same code path, factored out so all three triggers stay in
       sync).

   "Currently open" lead = whichever lead the caller is mid-working
   right now. We identify it via the open activity span (rows in
   caller_activity_events with ended_at IS NULL AND a lead-work tag:
   ON_CALL / IN_FORM / REASON_CARD). The span's context column carries
   the lead_id we wrote when the caller entered that phase.

   Guarantees:
     - No-op if the caller has no open lead-work span.
     - No-op if the lead already has a real outcome (NEVER overrides
       completed / not_interested / not_picked / etc.).
     - Returns the lead_id that was marked, or null if nothing happened.
     - Logs a single structured line for audit / debugging.

   Side-effects (when it DOES mark):
     - leads.last_note_outcome = 'incomplete'
     - leads.last_note_at      = NOW()
     - leads.completed_at      = NOW()
     - lead_tag stays whatever it was (NULL if the caller never reached
       the classifier).

   Use:
     const { markInFlightLeadIncomplete } = require('./markInFlightLeadIncomplete');
     const leadId = await markInFlightLeadIncomplete({ callerId, reason: 'admin_pause' });
*/
const pool = require('../db');

const LEAD_WORK_TAGS = ['ON_CALL', 'IN_FORM', 'REASON_CARD'];

async function markInFlightLeadIncomplete({ callerId, reason = 'unknown' } = {}) {
  if (!callerId) return null;
  try {
    // Find the most recent OPEN lead-work span for this caller.
    // ON_CALL / IN_FORM / REASON_CARD are the three span tags that
    // mean "actively working a specific lead".
    const { rows: spans } = await pool.query(
      `SELECT id, tag, context, started_at
         FROM caller_activity_events
        WHERE caller_id = $1
          AND ended_at IS NULL
          AND tag = ANY($2::text[])
        ORDER BY started_at DESC
        LIMIT 1`,
      [callerId, LEAD_WORK_TAGS]
    );
    const span = spans[0];
    const leadId = span?.context?.lead_id;
    if (!leadId) {
      // No in-flight lead — nothing to mark. (Common case when the
      // caller was idle on the queue page when paused.)
      return null;
    }

    // Mark the lead Incomplete — but only if no real outcome exists yet.
    // The EXISTS guard ensures we don't stamp Incomplete on a lead that
    // never actually had a call placed (e.g. caller paused while staring
    // at the ext_check overlay before clicking Yes & Proceed).
    const { rows: marked } = await pool.query(
      `UPDATE leads l
          SET last_note_outcome = 'incomplete',
              last_note_at      = NOW(),
              completed_at      = NOW()
        WHERE l.id = $1
          AND l.last_note_outcome IS NULL
          AND EXISTS (
            SELECT 1 FROM calls c
             WHERE c.lead_id = l.id AND c.caller_id = $2
          )
        RETURNING id`,
      [leadId, callerId]
    );

    if (marked.length === 0) {
      // Either the lead already had an outcome (someone saved between
      // the span open and the pause) or no call was ever placed.
      return null;
    }

    console.log(JSON.stringify({
      type:       'lead.incomplete_on_pause',
      lead_id:    leadId,
      caller_id:  callerId,
      span_tag:   span.tag,
      reason,
      at:         new Date().toISOString(),
    }));
    return leadId;
  } catch (err) {
    console.error('[markInFlightLeadIncomplete] error:', err.message);
    return null;
  }
}

module.exports = { markInFlightLeadIncomplete, LEAD_WORK_TAGS };
