const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const pool      = require('./db');

const webinarConfigRouter = require('./routes/webinarConfig');
const leadsRouter         = require('./routes/leads');
const adminRouter         = require('./routes/admin');
const authRouter          = require('./routes/auth');
const eventsRouter        = require('./routes/events');

const app = express();

// Auto-migrate: add slot-2 columns if they don't exist yet
const _migrationResult = pool.query(`
  ALTER TABLE webinar_config
    ADD COLUMN IF NOT EXISTS pending_whatsapp_link_2 TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS whatsapp_link_swap_at_2 TIMESTAMPTZ DEFAULT NULL
`);
if (_migrationResult && typeof _migrationResult.catch === 'function') {
  _migrationResult.catch(err => console.error('[Migration] slot-2 columns error:', err.message));
}

// Auto-migrate: create webinars table
const _webinarTableMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS webinars (
    id          BIGSERIAL PRIMARY KEY,
    webinar_at  TIMESTAMPTZ NOT NULL,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
if (_webinarTableMigration && typeof _webinarTableMigration.catch === 'function') {
  _webinarTableMigration.catch(err => console.error('[Migration] webinars table error:', err.message));
}

// Auto-migrate: add webinar_id to leads (runs after webinars table exists)
_webinarTableMigration.then(() =>
  pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS webinar_id BIGINT REFERENCES webinars(id)`)
).then(() => {
  // Backfill: if webinars table is empty, seed it from the existing webinar_config row
  return pool.query(`
    INSERT INTO webinars (date_time, is_active)
    SELECT next_webinar_at, TRUE
    FROM webinar_config
    WHERE id = 1
      AND next_webinar_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM webinars)
  `);
}).catch(err => console.error('[Migration] leads.webinar_id / backfill error:', err.message));

// Auto-migrate: create whatsapp_links table (per-webinar link management)
_webinarTableMigration.then(() =>
  pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_links (
      id          BIGSERIAL PRIMARY KEY,
      webinar_id  UUID NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
      link_url    TEXT NOT NULL DEFAULT '',
      order_index INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wa_links_webinar ON whatsapp_links (webinar_id, order_index);
  `)
).catch(err => console.error('[Migration] whatsapp_links table error:', err.message));

// Auto-migrate: create click_events table for button analytics
const _clickMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS click_events (
    id          BIGSERIAL PRIMARY KEY,
    event_name  TEXT        NOT NULL,
    webinar_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_click_events_name       ON click_events (event_name);
  CREATE INDEX IF NOT EXISTS idx_click_events_webinar_at ON click_events (webinar_at);
  CREATE INDEX IF NOT EXISTS idx_click_events_created_at ON click_events (created_at);
`);
if (_clickMigration && typeof _clickMigration.catch === 'function') {
  _clickMigration.catch(err => console.error('[Migration] click_events error:', err.message));
}

// ── Security middleware ──
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '50kb' }));

// ── Rate limiters ──
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 30,               // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,               // 10 auth attempts per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a minute.' },
});

const leadsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,               // 20 registrations per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registrations. Please try again shortly.' },
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api',       webinarConfigRouter);
app.use('/api',       leadsLimiter, leadsRouter);
app.use('/api',       publicLimiter, eventsRouter);
app.use('/api/auth',  authLimiter, authRouter);
app.use('/api/admin', adminRouter);

module.exports = app;
