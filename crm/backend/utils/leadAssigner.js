/**
 * Round-robin lead assigner.
 *
 * assignNewLead(leadId, sugarLevel, webinarId)
 *   • Finds eligible callers for the given webinar:
 *       enabled in lead_share_config (paused callers ARE included — leads
 *       queue up for them to work on resume) + allowed_lead_types contains
 *       'all' OR matches the lead's sugar_level
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

    // 0. Same-webinar duplicate guard.
    //    If another lead with the same whatsapp_number already exists for this
    //    webinar AND has been assigned to a caller, skip the round-robin step.
    //    The lead row is kept (assigned_user_id stays NULL) and the rotation
    //    cursor does not advance, so the next genuine lead lands on the caller
    //    who would have been next.
    const { rows: dup } = await client.query(`
      SELECT earlier.id AS earlier_lead_id, earlier.assigned_user_id
        FROM leads earlier
        JOIN leads new_lead
          ON new_lead.whatsapp_number = earlier.whatsapp_number
         AND new_lead.webinar_id      = earlier.webinar_id
       WHERE new_lead.id              = $1
         AND earlier.id              <> $1
         AND earlier.assigned_user_id IS NOT NULL
       ORDER BY earlier.created_at ASC
       LIMIT 1
    `, [leadId]);

    if (dup.length > 0) {
      await client.query('COMMIT');
      console.log(JSON.stringify({
        type:              'lead.assign.duplicate_skipped',
        lead_id:           leadId,
        earlier_lead_id:   dup[0].earlier_lead_id,
        earlier_caller_id: dup[0].assigned_user_id,
        webinar_id:        webinarId,
        at:                new Date().toISOString(),
      }));
      return null;
    }

    // 0b. The lead's workspace = its source (meta / yt / meta2). A caller
    //     tagged to a workspace only receives that workspace's leads; untagged
    //     callers (workspace IS NULL) receive everything (no regression).
    const { rows: srcRow } = await client.query(
      'SELECT source FROM leads WHERE id = $1',
      [leadId]
    );
    const leadSource = srcRow[0]?.source ?? null;

    // 1. Eligible callers for this webinar.
    //    A caller "in the leads logic" = an enabled lead_share_config row.
    //    Paused callers (crm_users.is_active = FALSE) are intentionally NOT
    //    excluded: round-robin keeps assigning to them so leads queue up for
    //    when they resume, instead of being skipped and handed to others.
    //    To stop a caller getting leads, disable them in the leads-logic page.
    const { rows: eligible } = await client.query(`
      SELECT lsc.caller_id
        FROM lead_share_config lsc
        JOIN crm_users u ON u.id = lsc.caller_id
       WHERE lsc.webinar_id = $1
         AND lsc.enabled    = TRUE
         AND ('all' = ANY(lsc.allowed_lead_types) OR $2 = ANY(lsc.allowed_lead_types))
         AND u.deleted_at IS NULL
         AND (u.workspace IS NULL OR u.workspace = $3::text)
       ORDER BY lsc.position ASC, lsc.created_at ASC
    `, [webinarId, sugarLevel, leadSource]);

    if (eligible.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    // 2. Per-webinar assignment lock. We keep the round_robin_state row purely
    //    as a mutex (SELECT … FOR UPDATE) so concurrent inserts serialize and
    //    the least-loaded count below always sees committed assignments — no
    //    double-assign, no two leads racing onto the same caller.
    await client.query(`
      INSERT INTO round_robin_state (webinar_id, last_position)
      VALUES ($1, -1)
      ON CONFLICT (webinar_id) DO NOTHING
    `, [webinarId]);
    await client.query(
      'SELECT last_position FROM round_robin_state WHERE webinar_id = $1 FOR UPDATE',
      [webinarId]
    );

    // 3. Least-loaded assignment. Among the eligible callers, pick the one with
    //    the FEWEST leads already assigned in THIS webinar (tie-break = rotation
    //    position, so the first eligible caller wins an initial tie). This stays
    //    fair even when the eligible set is filtered per-lead (sugar_level /
    //    workspace) or the roster / tags / enabled-state change over time —
    //    cases a single positional cursor cannot keep balanced (and which the
    //    config-save cursor-reset actively skewed toward position 0). It also
    //    self-corrects an existing imbalance: each new lead flows to whoever is
    //    currently behind, until the eligible callers level out.
    const eligibleIds = eligible.map(e => e.caller_id);
    const { rows: cnt } = await client.query(
      `SELECT assigned_user_id::text AS id, COUNT(*)::int AS c
         FROM leads
        WHERE webinar_id = $1 AND assigned_user_id = ANY($2::uuid[])
        GROUP BY assigned_user_id`,
      [webinarId, eligibleIds]
    );
    const countMap = {};
    for (const r of cnt) countMap[r.id] = r.c;
    let callerId  = eligible[0].caller_id;
    let chosenIdx = 0;
    let best      = Infinity;
    eligible.forEach((e, i) => {
      const c = countMap[e.caller_id] || 0;
      if (c < best) { best = c; callerId = e.caller_id; chosenIdx = i; }
    });

    // 4. Keep last_position pointed at the chosen caller (observability only;
    //    selection above is least-loaded, not cursor-based).
    await client.query(
      'UPDATE round_robin_state SET last_position = $1, updated_at = NOW() WHERE webinar_id = $2',
      [chosenIdx, webinarId]
    );

    // 5. Assign the lead + write audit log
    await client.query(
      'UPDATE leads SET assigned_user_id = $1, assigned_at = NOW() WHERE id = $2',
      [callerId, leadId]
    );
    await client.query(
      `INSERT INTO lead_assignments (lead_id, caller_id, webinar_id, reason, kind)
       VALUES ($1, $2, $3, 'round_robin', 'fresh')`,
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
