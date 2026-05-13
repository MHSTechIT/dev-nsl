require('dotenv').config();

/* Prevent unhandled errors from crashing the server */
process.on('uncaughtException',  err => console.error('Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message || err));

const app  = require('./app');
const cron = require('node-cron');
const { startLinkSwapScheduler } = require('./utils/linkSwapScheduler');
const { syncLeadsToSheet }        = require('./utils/leadsSheetSync');
const { startScheduler: startTataInboundSync } = require('./utils/tataInboundSync');
const { startScheduler: startLeadsAlert }       = require('./utils/leadsAlertScheduler');
const { startStaleCallReaper }                  = require('./utils/staleCallReaper');
const { startDailyReconciliation }              = require('./utils/dailyReconciliation');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MHS server running on port ${PORT}`);

  // WhatsApp link auto-swap (every 30s)
  startLinkSwapScheduler();

  // Tata inbound CDR poll (every 2 min) — fills in missed calls when the
  // dashboard webhook isn't configured.
  startTataInboundSync({ intervalMs: 2 * 60 * 1000 });

  // Leads alert (every 5 min) — fires WATI WhatsApp templates when the
  // current webinar's registration deadline is approaching AND the upcoming
  // webinar isn't set up yet. Each template fires at most once per webinar.
  startLeadsAlert({ intervalMs: 5 * 60 * 1000 });

  // Google Sheets daily sync — runs every day at 11:55 PM IST (18:25 UTC)
  cron.schedule('25 18 * * *', () => {
    console.log('[Sheets Sync] Starting daily sync...');
    syncLeadsToSheet();
  });

  console.log('[Sheets Sync] Daily sync scheduled at 11:55 PM IST');

  // Stale-call watchdog — marks calls rows stuck in initiated/ringing/answered
  // for > 3 min as 'failed' and notifies the owning caller's CRM tab so the
  // modal can self-recover.
  startStaleCallReaper();

  // Daily reconciliation report — logs (per-caller) leads sitting with
  // last_note_outcome=NULL for > 24 h. Catches anything the save-on-close
  // guard missed (tab crash, network drop, etc.).
  startDailyReconciliation();
});
