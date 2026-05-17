/**
 * funnel-yt service entry.
 *
 * Mirror of servers/funnel-meta.js — the route handlers are source-agnostic
 * (they read source from query/body), so the same code serves the YT funnel.
 * Different process, different default port, separate failure domain.
 *
 * Default port: 3002. Override via PORT env.
 */
require('dotenv').config();

const {
  buildApp, publicLimiter, authLimiter, leadsLimiter, installCrashGuards,
} = require('./_shared');

const { startListener }              = require('../utils/pgListener');
const { handleWebinarConfigUpdated } = require('../utils/webinarConfigListener');

installCrashGuards('funnel-yt');

const app = buildApp();

app.use('/api',          require('../routes/webinarConfig'));
app.use('/api/leads',    leadsLimiter());
app.use('/api/events',   publicLimiter());
app.use('/api',          require('../routes/leads'));
app.use('/api',          require('../routes/events'));
app.use('/api/auth',     authLimiter(), require('../routes/auth'));
app.use('/api/admin',    require('../routes/admin'));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`[funnel-yt] running on port ${PORT}`);
  startListener({
    'webinar.config.updated': handleWebinarConfigUpdated,
  });
});
