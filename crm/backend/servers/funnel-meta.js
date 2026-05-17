/**
 * funnel-meta service entry.
 *
 * Serves API for apps/funnel, apps/whatsapp, apps/disqualified plus the
 * embedded "Web Reminder" admin pages those apps include. Does NOT run any
 * scheduler and does NOT run schema migrations — CRM owns those.
 *
 * LISTENs on 'webinar.config.updated' so admin (in the CRM service) edits
 * the config and this service rebroadcasts to its own SSE subscribers.
 *
 * Default port: 3001. Override via PORT env.
 */
require('dotenv').config();

const {
  buildApp, publicLimiter, authLimiter, leadsLimiter, installCrashGuards,
} = require('./_shared');

const { startListener }            = require('../utils/pgListener');
const { handleWebinarConfigUpdated } = require('../utils/webinarConfigListener');

installCrashGuards('funnel-meta');

const app = buildApp();

// Same mount order as the legacy app.js — webinar-config first so the SSE
// endpoint's headers don't get clobbered by later JSON middleware.
app.use('/api',          require('../routes/webinarConfig'));
app.use('/api/leads',    leadsLimiter());
app.use('/api/events',   publicLimiter());
app.use('/api',          require('../routes/leads'));
app.use('/api',          require('../routes/events'));
app.use('/api/auth',     authLimiter(), require('../routes/auth'));   // duplicated for embedded admin
app.use('/api/admin',    require('../routes/admin'));                 // duplicated for embedded admin

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[funnel-meta] running on port ${PORT}`);

  // Cross-service signal: admin config edits fire pg_notify; this funnel
  // service picks it up and rebroadcasts to its locally connected SPAs.
  startListener({
    'webinar.config.updated': handleWebinarConfigUpdated,
  });
});
