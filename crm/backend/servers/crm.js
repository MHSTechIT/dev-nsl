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
const nsmLeadsSync                              = require('../utils/nsmLeadsSync');
const nsmWhatsappScheduler                      = require('../utils/nsmWhatsappScheduler');
const nsmIvrLeadsSync                           = require('../utils/nsmIvrLeadsSync');
const nsmIvrWhatsappScheduler                   = require('../utils/nsmIvrWhatsappScheduler');
const nsmIvrCallScheduler                       = require('../utils/nsmIvrCallScheduler');

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
    console.log('[crm] DISABLE_SCHEDULERS=true → skipping linkSwap, tataInboundSync, leadsAlert, sheetsSync, staleCallReaper, activitySpanReaper, dailyReconciliation');
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

    cron.schedule('25 18 * * *', () => {
      console.log('[Sheets Sync] Starting daily sync...');
      syncLeadsToSheet();
    });
    console.log('[Sheets Sync] Daily sync scheduled at 11:55 PM IST');
    startDailyReconciliation();

    // NSM-IVR CloudShope before/after voice calls — a real, paid, person-
    // reaching mutation, so it is GATED (only the prod instance dials; local
    // dev with DISABLE_SCHEDULERS=true never places calls). Exactly-once across
    // instances is also guaranteed by the per-lead DB claim.
    nsmIvrCallScheduler.startScheduler();
    // NSM-Caller IVR (same Cloudshope engine, scheduled from the caller
    // workspace's own IVR page against nsm_leads). Also gated.
    nsmIvrCallScheduler.startCallerScheduler();
  }

  // Local NSM-IVR test dialing: when DISABLE_SCHEDULERS=true (dev) but
  // NSM_IVR_LOCAL_DIAL=true, start ONLY the NSM-IVR Cloudshope scheduler on this
  // box so calls can be tested end-to-end. NSM-Caller + Meta stay off. These are
  // real, paid, person-reaching calls — enable deliberately in .env.
  if (DISABLE_SCHEDULERS && process.env.NSM_IVR_LOCAL_DIAL === 'true') {
    console.log('[crm] NSM_IVR_LOCAL_DIAL=true → starting NSM-IVR Cloudshope scheduler locally (NSM-IVR ONLY; places REAL calls)');
    nsmIvrCallScheduler.startScheduler();
  }

  // NSM-Caller lead sync runs on EVERY instance (NOT gated by
  // DISABLE_SCHEDULERS) because it's idempotent: it only reads from Meta and
  // upserts into nsm_leads keyed by meta_lead_id, so double-running across
  // dev + prod is harmless (just redundant Meta reads). Pulls every 30s and is
  // incremental, so steady-state ticks are cheap.
  nsmLeadsSync.startScheduler();
  // WhatsApp reminder scheduler — also idempotent (DB-locked per template), so
  // it runs on every instance too.
  nsmWhatsappScheduler.startScheduler();
  // NSM-IVR (independent) — same idempotent, DB-locked schedulers on nsm_ivr_* tables.
  nsmIvrLeadsSync.startScheduler();
  nsmIvrWhatsappScheduler.startScheduler();

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
