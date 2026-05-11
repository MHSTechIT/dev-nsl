require('dotenv').config();

/* Prevent unhandled errors from crashing the server */
process.on('uncaughtException',  err => console.error('Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message || err));

const app  = require('./app');
const cron = require('node-cron');
const { startLinkSwapScheduler } = require('./utils/linkSwapScheduler');
const { syncLeadsToSheet }        = require('./utils/leadsSheetSync');
const { startScheduler: startTataInboundSync } = require('./utils/tataInboundSync');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MHS server running on port ${PORT}`);

  // WhatsApp link auto-swap (every 30s)
  startLinkSwapScheduler();

  // Tata inbound CDR poll (every 2 min) — fills in missed calls when the
  // dashboard webhook isn't configured.
  startTataInboundSync({ intervalMs: 2 * 60 * 1000 });

  // Google Sheets daily sync — runs every day at 11:55 PM IST (18:25 UTC)
  cron.schedule('25 18 * * *', () => {
    console.log('[Sheets Sync] Starting daily sync...');
    syncLeadsToSheet();
  });

  console.log('[Sheets Sync] Daily sync scheduled at 11:55 PM IST');
});
