/**
 * Shared Express bootstrap — applies the same security, CORS, JSON parsing,
 * rate limiters, and health endpoint to every service entry. Each entry then
 * mounts only the route files it needs.
 *
 * Used by servers/funnel-meta.js, servers/funnel-yt.js, servers/crm.js.
 * The legacy app.js continues to work for single-process dev.
 */
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

function buildApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
  app.use(express.json({ limit: '50kb' }));

  // Health probe — every service exposes this so deploy/health checks work
  // regardless of which split target is hit.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  return app;
}

/* Rate limiter factories — exported so each entry can attach the right
   limiter to its own routes. Per-process limits (not shared across services). */
const publicLimiter = () => rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});

const authLimiter = () => rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a minute.' },
});

const leadsLimiter = () => rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many registrations. Please try again shortly.' },
});

/* Process-level safety nets — same as index.js today. */
function installCrashGuards(serviceName) {
  process.on('uncaughtException',  err => console.error(`[${serviceName}] uncaught:`, err?.message || err));
  process.on('unhandledRejection', err => console.error(`[${serviceName}] unhandledRejection:`, err?.message || err));
}

module.exports = {
  buildApp,
  publicLimiter,
  authLimiter,
  leadsLimiter,
  installCrashGuards,
};
