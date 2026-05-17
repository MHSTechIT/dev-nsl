/**
 * CRM service entry.
 *
 * Owns:
 *   - All admin / auth / caller / calls / recordings / webhooks routes.
 *   - All schema migrations (re-uses the auto-migration block in app.js).
 *   - All cron schedulers (linkSwap, tataInbound, leadsAlert, sheetsSync,
 *     staleCallReaper, dailyReconciliation).
 *   - The 'lead.created' LISTEN handler that drives lead → caller assignment
 *     when the funnel services fire pg_notify.
 *   - The startup sweep that catches any leads that arrived while CRM was
 *     offline (NOTIFY is not durable).
 *
 * funnel-meta and funnel-yt do NOT require this file. They build their own
 * minimal Express app in servers/funnel-{meta,yt}.js so a bug in CRM code
 * paths can't crash funnel registrations.
 *
 * Default port: 3003. Override via PORT env. The legacy single-process
 * entry (index.js, port 3001) also continues to work — it requires app.js
 * and starts the same schedulers, so dev workflows are unchanged.
 */
require('dotenv').config();

const { installCrashGuards } = require('./_shared');
installCrashGuards('crm');

// app.js owns the full Express app + all middleware + all route mounts +
// runs every auto-migration as a side effect of require(). The funnel
// services intentionally do NOT import this — they build their own minimal
// app. CRM gets everything for free.
const app = require('../app');

const cron = require('node-cron');
const { startLinkSwapScheduler }               = require('../utils/linkSwapScheduler');
const { syncLeadsToSheet }                      = require('../utils/leadsSheetSync');
const { startScheduler: startTataInboundSync }  = require('../utils/tataInboundSync');
const { startScheduler: startLeadsAlert }       = require('../utils/leadsAlertScheduler');
const { startStaleCallReaper }                  = require('../utils/staleCallReaper');
const { startDailyReconciliation }              = require('../utils/dailyReconciliation');

const { startListener }                         = require('../utils/pgListener');
const { handleLeadCreated, sweepUnassignedLeads } = require('../utils/leadCreatedListener');

const PORT = process.env.PORT || 3003;

/* Shared-DB safety toggles. When dev-CRM and prod-CRM hit the SAME Postgres,
   every scheduler and the lead.created listener would fire twice — duplicate
   Tata CDR pulls, double WhatsApp link swaps, race-y lead assignment, double
   admin alert emails. Set these env flags to TRUE on the dev deployment so
   only prod-CRM owns these side-effects.

     DISABLE_SCHEDULERS      — skip all cron / interval jobs
     DISABLE_LEAD_LISTENER   — skip the 'lead.created' LISTEN + boot sweep

   Default is ENABLED (false-equivalent) so existing prod-CRM deployments are
   unchanged. */
const DISABLE_SCHEDULERS    = process.env.DISABLE_SCHEDULERS === 'true';
const DISABLE_LEAD_LISTENER = process.env.DISABLE_LEAD_LISTENER === 'true';

app.listen(PORT, () => {
  console.log(`[crm] running on port ${PORT}`);

  if (DISABLE_SCHEDULERS) {
    console.log('[crm] DISABLE_SCHEDULERS=true → skipping linkSwap, tataInboundSync, leadsAlert, sheetsSync, staleCallReaper, dailyReconciliation');
  } else {
    // All schedulers — race-prone if run in more than one process, so CRM owns
    // every one and the funnel services start none.
    startLinkSwapScheduler();
    startTataInboundSync({ intervalMs: 2 * 60 * 1000 });
    startLeadsAlert({ intervalMs: 5 * 60 * 1000 });
    cron.schedule('25 18 * * *', () => {
      console.log('[Sheets Sync] Starting daily sync...');
      syncLeadsToSheet();
    });
    console.log('[Sheets Sync] Daily sync scheduled at 11:55 PM IST');
    startStaleCallReaper();
    startDailyReconciliation();
  }

  if (DISABLE_LEAD_LISTENER) {
    console.log('[crm] DISABLE_LEAD_LISTENER=true → skipping lead.created LISTEN + boot sweep');
    // We still LISTEN for webinar.config.updated so admin edits propagate to
    // SSE clients connected to THIS service. That's a read-side broadcast and
    // is safe to run in both prod and dev.
  } else {
    // Cross-service signal: funnel-meta / funnel-yt fire pg_notify('lead.created')
    // after each lead INSERT. We LISTEN and run the round-robin assigner.
    startListener({
      'lead.created': handleLeadCreated,
    });

    // Recovery sweep: NOTIFY is fire-and-forget. If CRM was offline when funnels
    // fired, those leads sit with assigned_user_id = NULL. Catch them on boot.
    sweepUnassignedLeads().catch(e => console.error('[crm] sweep failed:', e.message));
  }
});
