/**
 * Round-robin lead assigner.
 *
 * assignNewLead(leadId, sugarLevel, webinarId)
 *   • Finds eligible callers for the given webinar:
 *       enabled in lead_share_config + crm_users.is_active = true
 *       + allowed_lead_types contains 'all' OR matches the lead's sugar_level
 *   • Advances round_robin_state.last_position with FOR UPDATE locking so
 *     concurrent inserts can't double-assign.
 *   • Stamps leads.assigned_user_id + assigned_at, writes a lead_assignments row.
 *   • Pushes the new lead to that caller's SSE channel (after commit).
 *
 * Returns the assigned caller_id, or null if no eligible caller found / on error.
 */
const pool      = require('../db');
const callerSse = require('./callerSse');

async function assignNewLead(leadId, sugarLevel, webinarId) {
  if (!leadId || !webinarId) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Eligible callers for this webinar
    const { rows: eligible } = await client.query(`
      SELECT lsc.caller_id
        FROM lead_share_config lsc
        JOIN crm_users u ON u.id = lsc.caller_id
       WHERE lsc.webinar_id = $1
         AND lsc.enabled    = TRUE
         AND u.is_active    = TRUE
         AND ('all' = ANY(lsc.allowed_lead_types) OR $2 = ANY(lsc.allowed_lead_types))
       ORDER BY lsc.position ASC, lsc.created_at ASC
    `, [webinarId, sugarLevel]);

    if (eligible.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    // 2. Ensure a state row exists (no-op if it already does)
    await client.query(`
      INSERT INTO round_robin_state (webinar_id, last_position)
      VALUES ($1, -1)
      ON CONFLICT (webinar_id) DO NOTHING
    `, [webinarId]);

    // 3. Lock and read current cursor
    const { rows: locked } = await client.query(
      'SELECT last_position FROM round_robin_state WHERE webinar_id = $1 FOR UPDATE',
      [webinarId]
    );
    const lastPos = locked[0]?.last_position ?? -1;
    const nextIdx = (lastPos + 1) % eligible.length;
    const callerId = eligible[nextIdx].caller_id;

    // 4. Advance cursor
    await client.query(
      'UPDATE round_robin_state SET last_position = $1, updated_at = NOW() WHERE webinar_id = $2',
      [nextIdx, webinarId]
    );

    // 5. Assign the lead + write audit log
    await client.query(
      'UPDATE leads SET assigned_user_id = $1, assigned_at = NOW() WHERE id = $2',
      [callerId, leadId]
    );
    await client.query(
      `INSERT INTO lead_assignments (lead_id, caller_id, webinar_id, reason)
       VALUES ($1, $2, $3, 'round_robin')`,
      [leadId, callerId, webinarId]
    );

    await client.query('COMMIT');

    // 6. Push to the caller (after commit, fire-and-forget)
    pool.query(
      `SELECT l.*, w.name AS webinar_name
         FROM leads l
         LEFT JOIN webinars w ON w.id = l.webinar_id
        WHERE l.id = $1`,
      [leadId]
    )
      .then(r => {
        if (r.rows.length > 0) {
          callerSse.pushTo(callerId, { type: 'lead.assigned', lead: r.rows[0] });
        }
      })
      .catch(e => console.error('[Assigner] post-commit fetch:', e.message));

    return callerId;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[Assigner]', err.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Reset a webinar's round-robin cursor to -1.
 * Call this after the share-config changes (callers added/removed/disabled)
 * so the next assignment starts fresh from position 0.
 */
async function resetCursor(webinarId) {
  if (!webinarId) return;
  try {
    await pool.query(`
      INSERT INTO round_robin_state (webinar_id, last_position)
      VALUES ($1, -1)
      ON CONFLICT (webinar_id) DO UPDATE SET last_position = -1, updated_at = NOW()
    `, [webinarId]);
  } catch (err) {
    console.error('[Assigner] resetCursor:', err.message);
  }
}

module.exports = { assignNewLead, resetCursor };
