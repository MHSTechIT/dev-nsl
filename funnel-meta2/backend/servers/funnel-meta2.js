/**
 * funnel-meta2 service entry.
 *
 * Serves API for apps/funnel-meta2, apps/whatsapp-meta2, apps/disqualified-meta2
 * plus the embedded admin pages those apps include. Does NOT run any scheduler
 * and does NOT run schema migrations — CRM owns those.
 *
 * Independent clone of funnel-meta. All leads it creates are tagged
 * source='meta2' (see routes/leads.js). Shares the same Postgres DB.
 *
 * LISTENs on 'webinar.config.updated' so admin (in the CRM service) edits
 * the config and this service rebroadcasts to its own SSE subscribers.
 *
 * Default port: 3004. Override via PORT env.
 */
require('dotenv').config();

const {
  buildApp, publicLimiter, authLimiter, leadsLimiter, installCrashGuards,
} = require('./_shared');

const { startListener }            = require('../utils/pgListener');
const { handleWebinarConfigUpdated } = require('../utils/webinarConfigListener');

installCrashGuards('funnel-meta2');

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
app.use('/api/meta',     require('../routes/meta'));                  // Meta Pixel/CAPI server-side mirror

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  console.log(`[funnel-meta2] running on port ${PORT}`);

  // Cross-service signal: admin config edits fire pg_notify; this funnel
  // service picks it up and rebroadcasts to its locally connected SPAs.
  startListener({
    'webinar.config.updated': handleWebinarConfigUpdated,
  });
});
