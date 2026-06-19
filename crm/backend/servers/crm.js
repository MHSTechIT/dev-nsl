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
const pool                                      = require('../db');
const { syncLeadsToSheet }                      = require('../utils/leadsSheetSync');
const { startDailyReconciliation }              = require('../utils/dailyReconciliation');
const schedulerManager                          = require('../utils/schedulerManager');
const { mergeTimerSettings }                    = require('../utils/timerDefaults');
const leadsAlertScheduler                       = require('../utils/leadsAlertScheduler');
const { startLinkSwapScheduler }                = require('../utils/linkSwapScheduler');
const { startWhapiMemberScheduler }             = require('../utils/whapiMemberScheduler');
const { startTemplateSendScheduler }            = require('../utils/templateSendScheduler');
const { startMetaLeadSyncScheduler }            = require('../utils/metaLeadSyncScheduler');
const emptyQueueAlertScheduler                  = require('../utils/emptyQueueAlertScheduler');
const dnpReassignScheduler                      = require('../utils/dnpReassignScheduler');
const hourlyCallerReportScheduler               = require('../utils/hourlyCallerReportScheduler');

const { startListener }                         = require('../utils/pgListener');
const { handleLeadCreated, sweepUnassignedLeads } = require('../utils/leadCreatedListener');
const telegramPoller                            = require('../utils/telegramPoller');

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
    console.log('[crm] DISABLE_SCHEDULERS=true → skipping linkSwap, whapiMemberRotation, templateSend, tataInboundSync, leadsAlert, emptyQueueAlert, dnpReassign, hourlyCallerReport, sheetsSync, staleCallReaper, activitySpanReaper, dailyReconciliation (metaLeadSync still runs — idempotent)');
  } else {
    // All schedulers — race-prone if run in more than one process, so CRM owns
    // every one and the funnel services start none.
    //
    // The 3 caller-facing watchdogs (activitySpanReaper, staleCallReaper,
    // tataInboundSync) are admin-tunable via the caller Timer Settings page —
    // they route through schedulerManager so PUT /timer-settings can restart
    // them live. Read the saved intervals from timer_settings and hand the
    // merged values to applyTimerSettings.
    pool.query('SELECT settings FROM timer_settings WHERE id = 1')
      .then(({ rows }) => {
        schedulerManager.applyTimerSettings(mergeTimerSettings(rows[0]?.settings));
      })
      .catch(e => {
        console.error('[crm] timer_settings read failed; starting schedulers with defaults:', e.message);
        schedulerManager.applyTimerSettings(mergeTimerSettings());
      });

    // leadsAlert + linkSwap are funnel/marketing schedulers (WhatsApp link
    // swaps, deadline alerts) — NOT caller-page jobs, so they are deliberately
    // kept off the caller Timer Settings page and run on fixed intervals.
    leadsAlertScheduler.startScheduler();
    startLinkSwapScheduler();

    // Member-count WhatsApp link rotation for Whapi workspaces (Meta Temp /
    // TagMango): advance the link when the current community hits 950 live
    // members (counted via the Whapi admin number). Freezes + alerts if Whapi
    // can't read the count. meta/yt/meta2 keep lead-count rotation above.
    startWhapiMemberScheduler();

    // Auto-send Saved Templates to the WhatsApp community group on the schedule
    // derived from current_webinar_datetime (e.g. "3 Days To Go", "8 Hours To
    // Go"). One send per template per webinar cycle (template_sends UNIQUE).
    startTemplateSendScheduler();

    // Delayed manager alert when a caller's Assigned queue stays empty past the
    // admin-configured delay (TL & Assistant Timer sub-page). Fixed 60s tick;
    // the delay itself is read from timer_settings each run.
    emptyQueueAlertScheduler.startScheduler();

    // Auto-reopen DNP (Not Picked) leads into Assigned at 11:00/13:00/16:00 IST,
    // Mon–Sat (skips Sunday) — so callers retry unreached customers.
    dnpReassignScheduler.startScheduler();

    // Hourly caller-performance report over WhatsApp (Whapi) to the TLs +
    // (Assistant) Managers on the Alerts page. On the hour, 9 AM–6 PM IST,
    // Mon–Sat (Sunday holiday). today-so-far totals per caller.
    hourlyCallerReportScheduler.startScheduler();

    cron.schedule('25 18 * * *', () => {
      console.log('[Sheets Sync] Starting daily sync...');
      syncLeadsToSheet();
    });
    console.log('[Sheets Sync] Daily sync scheduled at 11:55 PM IST');
    startDailyReconciliation();
  }

  // Meta lead-gen reconciliation sweep — every 5 min, pull any leads the webhook
  // missed (cold start, deploy, dropped retry) for each workspace's selected
  // forms, dedup on meta_lead_id, and assign directly via round-robin. Runs in
  // EVERY environment (even when DISABLE_SCHEDULERS=true) because it's idempotent
  // and assigns directly — unlike the non-idempotent schedulers above it can't
  // double-insert or race, so it's safe to run on a local box sharing the prod DB.
  // Opt out with DISABLE_META_LEAD_SYNC=true.
  if (process.env.DISABLE_META_LEAD_SYNC === 'true') {
    console.log('[crm] DISABLE_META_LEAD_SYNC=true → Meta lead reconciliation poller off');
  } else {
    startMetaLeadSyncScheduler();
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

  // Telegram long-poll worker — listens for Resume button taps + typed
  // 'resume' replies. No-ops without TELEGRAM_BOT_TOKEN and respects
  // DISABLE_TELEGRAM_POLLER=true (handy for tests).
  telegramPoller.start();
});
