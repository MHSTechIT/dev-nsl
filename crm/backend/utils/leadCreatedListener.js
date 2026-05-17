/**
 * lead.created NOTIFY handler.
 *
 * Wires the cross-service bridge: when a funnel service finishes inserting a
 * new lead it fires pg_notify('lead.created', JSON.stringify({leadId, source,
 * sugarLevel, webinarId})). This handler runs on the CRM service (and on the
 * single-process app.js in dev mode) — it picks up the notification and calls
 * leadAssigner.assignNewLead() which writes leads.assigned_user_id,
 * INSERTs lead_assignments, and pushes callerSse to the picked caller.
 *
 * Also exports `sweepUnassignedLeads()` — CRM startup hook that scans for
 * leads inserted while CRM was offline (NOTIFY is fire-and-forget, not
 * durable) and assigns them retroactively.
 */
const pool             = require('../db');
const { assignNewLead } = require('./leadAssigner');

function handleLeadCreated(rawPayload) {
  let payload;
  try { payload = JSON.parse(rawPayload || '{}'); }
  catch (e) {
    console.error('[lead.created listener] bad JSON payload:', rawPayload);
    return;
  }
  const { leadId, sugarLevel, webinarId } = payload;
  if (!leadId) {
    console.error('[lead.created listener] missing leadId in payload', payload);
    return;
  }
  // Fire-and-forget — assignNewLead handles its own errors and returns null
  // on no-eligible-caller. We log the outcome for observability.
  assignNewLead(leadId, sugarLevel, webinarId)
    .then(callerId => {
      console.log(JSON.stringify({
        type:      'lead.created.assigned',
        lead_id:   leadId,
        caller_id: callerId || null,
        source:    payload.source || null,
        at:        new Date().toISOString(),
      }));
    })
    .catch(err => {
      console.error('[lead.created listener] assignNewLead threw:', err.message);
    });
}

/**
 * Startup sweep — assign any leads that landed while CRM was offline. NOTIFY
 * messages do not persist across reconnects, so without this sweep a registration
 * during a CRM outage would never get a caller assigned. Bounded to 24h so the
 * scan is cheap.
 */
async function sweepUnassignedLeads() {
  try {
    const { rows } = await pool.query(`
      SELECT id, sugar_level, webinar_id
        FROM leads
       WHERE assigned_user_id IS NULL
         AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at ASC
    `);
    if (rows.length === 0) {
      console.log('[lead.created sweep] no unassigned leads in last 24h');
      return;
    }
    console.log(`[lead.created sweep] processing ${rows.length} unassigned leads`);
    for (const r of rows) {
      try {
        const callerId = await assignNewLead(r.id, r.sugar_level, r.webinar_id);
        console.log(JSON.stringify({
          type:      'lead.created.sweep_assigned',
          lead_id:   r.id,
          caller_id: callerId || null,
          at:        new Date().toISOString(),
        }));
      } catch (e) {
        console.error(`[lead.created sweep] failed for ${r.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[lead.created sweep] query failed:', e.message);
  }
}

module.exports = { handleLeadCreated, sweepUnassignedLeads };
