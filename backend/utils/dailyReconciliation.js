/* Daily reconciliation report.
   ===================================================================
   Safety net for leads that slipped through the call flow without a
   captured outcome. Logs (per caller) any lead that:
     • has been assigned for > 24 h
     • has last_note_outcome = NULL
   Findings go to console as JSON — Render captures them, you grep on
   Render's log search. Counterpart to the in-flight save-on-close
   guard in the CRM modal: that prevents the bug from happening; this
   catches the residual cases that slip past anyway (e.g. tab crash
   before save, network drop during POST).
   =================================================================== */

const pool = require('../db');
const cron = require('node-cron');

let _scheduled = false;

async function runOnce() {
  try {
    const { rows } = await pool.query(`
      SELECT
        l.assigned_user_id       AS caller_id,
        u.full_name              AS caller_name,
        COUNT(*)::int            AS stale_count,
        MIN(l.assigned_at)       AS oldest_assigned_at,
        MAX(l.assigned_at)       AS newest_assigned_at
      FROM leads l
      LEFT JOIN crm_users u ON u.id = l.assigned_user_id
      WHERE l.assigned_user_id IS NOT NULL
        AND l.assigned_at      < NOW() - INTERVAL '24 hours'
        AND l.last_note_outcome IS NULL
      GROUP BY l.assigned_user_id, u.full_name
      ORDER BY stale_count DESC
    `);
    const totalStale = rows.reduce((sum, r) => sum + r.stale_count, 0);
    console.log(JSON.stringify({
      type:        'daily_reconciliation',
      total_stale: totalStale,
      per_caller:  rows.map(r => ({
        caller_id:   r.caller_id,
        caller_name: r.caller_name,
        stale_count: r.stale_count,
        oldest_at:   r.oldest_assigned_at,
        newest_at:   r.newest_assigned_at,
      })),
      at:          new Date().toISOString(),
    }));
  } catch (err) {
    console.error('[dailyReconciliation] error:', err.message);
  }
}

function startDailyReconciliation({
  // Default: 02:00 IST = 20:30 UTC. Off-hours so it doesn't compete
  // with the daily 23:55 IST sheets sync.
  cronExpr = '30 20 * * *',
} = {}) {
  if (_scheduled) return;
  _scheduled = true;
  cron.schedule(cronExpr, () => {
    console.log('[dailyReconciliation] running…');
    runOnce();
  });
  console.log(`[dailyReconciliation] scheduled (${cronExpr})`);
}

module.exports = { startDailyReconciliation, runOnce };
