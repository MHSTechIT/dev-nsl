require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const webinarsRouter = require('./routes/webinars');
const authRouter = require('./routes/auth');
const requireAuth = require('./middleware/requireAuth');

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'webinar-dashboard-backend' }));
app.use('/api/auth', authRouter);                       // public — login
app.use('/api/webinars', requireAuth, webinarsRouter);  // protected — needs Bearer token

/* ── Auto-migrations (idempotent) — ISOLATED wd_* tables only. ──────────────
   This backend never alters funnel/CRM tables; it owns just these three. */
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wd_webinars (
      id                    BIGSERIAL PRIMARY KEY,
      name                  TEXT NOT NULL,
      batch_name            TEXT,
      category              TEXT,
      start_at              TIMESTAMPTZ NOT NULL,
      host_id               TEXT,
      zoom_meeting_id       TEXT,
      zoom_join_url         TEXT,
      zoom_start_url        TEXT,
      zoom_registration_url TEXT,
      zoom_status           TEXT DEFAULT 'pending',
      zoom_error            TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wd_participants (
      id           BIGSERIAL PRIMARY KEY,
      webinar_id   BIGINT REFERENCES wd_webinars(id) ON DELETE CASCADE,
      name         TEXT,
      email        TEXT,
      phone        TEXT,
      join_at      TIMESTAMPTZ,
      leave_at     TIMESTAMPTZ,
      duration_sec INT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wd_chat_messages (
      id          BIGSERIAL PRIMARY KEY,
      webinar_id  BIGINT REFERENCES wd_webinars(id) ON DELETE CASCADE,
      sender_name TEXT,
      message     TEXT,
      sent_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Extra webinar fields captured from the Schedule-a-Webinar form.
  await pool.query(`ALTER TABLE wd_webinars
    ADD COLUMN IF NOT EXISTS duration_min INT,
    ADD COLUMN IF NOT EXISTS agenda       TEXT,
    ADD COLUMN IF NOT EXISTS passcode     TEXT`);
  await pool.query('CREATE INDEX IF NOT EXISTS wd_participants_webinar_idx ON wd_participants(webinar_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS wd_chat_webinar_idx ON wd_chat_messages(webinar_id)');
}

module.exports = { app, migrate };
