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
const callerRouter        = require('./routes/caller');
const callsRouter         = require('./routes/calls');
const webhooksRouter      = require('./routes/webhooks');
const recordingsRouter    = require('./routes/recordings');

const app = express();

// Auto-migrate: add slot-2 columns if they don't exist yet
const _migrationResult = pool.query(`
  ALTER TABLE webinar_config
    ADD COLUMN IF NOT EXISTS pending_whatsapp_link_2 TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS whatsapp_link_swap_at_2 TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS current_webinar_date TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS next_webinar_date    TIMESTAMPTZ DEFAULT NULL
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

// Auto-migrate: add `name` column to webinars + backfill AWS-101+ in date_time order
_webinarTableMigration.then(() =>
  pool.query(`ALTER TABLE webinars ADD COLUMN IF NOT EXISTS name TEXT`)
).then(() =>
  pool.query(`
    WITH numbered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY date_time ASC, id ASC) + 100 AS num
      FROM webinars
      WHERE name IS NULL OR name = ''
    )
    UPDATE webinars w
    SET name = 'AWS-' || numbered.num
    FROM numbered
    WHERE w.id = numbered.id
  `)
).then(() =>
  // Repair any out-of-order names: inactive empty rows whose AWS-N is less
  // than the active webinar's number get renamed to active_max + 1, +2, …
  // so the "Next Webinar" label always advances forward (e.g. current
  // AWS-103 → next is AWS-104, not a stale AWS-101 left over from earlier).
  pool.query(`
    WITH active_max AS (
      SELECT COALESCE(MAX((substring(name FROM 'AWS-(\\d+)'))::int), 0) AS n
      FROM webinars
      WHERE is_active = TRUE AND name ~ '^AWS-\\d+$'
    ),
    empties AS (
      SELECT w.id, ROW_NUMBER() OVER (ORDER BY w.date_time ASC NULLS LAST, w.id ASC) AS rn
      FROM webinars w
      LEFT JOIN leads l ON l.webinar_id = w.id
      WHERE w.is_active = FALSE
        AND w.name ~ '^AWS-\\d+$'
        AND (substring(w.name FROM 'AWS-(\\d+)'))::int <= (SELECT n FROM active_max)
        AND (SELECT n FROM active_max) > 0
      GROUP BY w.id, w.date_time
      HAVING COUNT(l.id) = 0
    )
    UPDATE webinars w
    SET name = 'AWS-' || ((SELECT n FROM active_max) + e.rn)
    FROM empties e
    WHERE w.id = e.id
  `)
).catch(err => console.error('[Migration] webinars.name error:', err.message));

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

// Auto-migrate: create crm_users table (CRM staff directory)
const _crmUsersMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS crm_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name     TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT,
    role          TEXT NOT NULL CHECK (role IN ('junior_caller','senior_caller','manager','trainer','admin','team_leader')),
    password_hash TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
  CREATE INDEX IF NOT EXISTS idx_crm_users_role ON crm_users (role);
`);
if (_crmUsersMigration && typeof _crmUsersMigration.catch === 'function') {
  _crmUsersMigration.catch(err => console.error('[Migration] crm_users error:', err.message));
}

// Auto-migrate: lead-share-config + round-robin state + leads.assigned_user_id + audit log
const _shareConfigMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS lead_share_config (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webinar_id         UUID NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    caller_id          UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    allowed_lead_types TEXT[] NOT NULL DEFAULT ARRAY['all']::TEXT[],
    position           INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (webinar_id, caller_id)
  );
  CREATE INDEX IF NOT EXISTS idx_share_config_webinar ON lead_share_config (webinar_id, position);

  CREATE TABLE IF NOT EXISTS round_robin_state (
    webinar_id    UUID PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
    last_position INTEGER NOT NULL DEFAULT -1,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES crm_users(id);
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_leads_assigned_user ON leads (assigned_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS lead_assignments (
    id         BIGSERIAL PRIMARY KEY,
    lead_id    UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    caller_id  UUID NOT NULL REFERENCES crm_users(id),
    webinar_id UUID NOT NULL REFERENCES webinars(id),
    reason     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_lead_assignments_caller ON lead_assignments (caller_id, created_at DESC);
`);
if (_shareConfigMigration && typeof _shareConfigMigration.catch === 'function') {
  _shareConfigMigration.catch(err => console.error('[Migration] lead-share-config error:', err.message));
}

// Auto-migrate: create calls table (Tata Smartflo click-to-call records)
const _callsMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS calls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
    caller_id       UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    provider        TEXT NOT NULL DEFAULT 'tata',
    provider_call_id TEXT,
    status          TEXT NOT NULL DEFAULT 'initiated',
      -- initiated | ringing | answered | ended | missed | failed
    direction       TEXT NOT NULL DEFAULT 'outbound',
    duration_sec    INTEGER,
    recording_url   TEXT,
    error_message   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at     TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    raw_payload     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_calls_lead       ON calls (lead_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_calls_caller     ON calls (caller_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_calls_provider_id ON calls (provider, provider_call_id);
`);
if (_callsMigration && typeof _callsMigration.catch === 'function') {
  _callsMigration.catch(err => console.error('[Migration] calls table error:', err.message));
}

// Auto-migrate: add Smartflo fields to crm_users (per-agent Tata Tele settings)
const _agentExtMigration = pool.query(`
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS tata_extension TEXT;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS tata_account_type TEXT;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS tata_agent_number TEXT;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS tata_caller_id TEXT;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS tata_smartflo_api_key TEXT;
`);
if (_agentExtMigration && typeof _agentExtMigration.catch === 'function') {
  _agentExtMigration.catch(err => console.error('[Migration] crm_users smartflo fields error:', err.message));
}

// Auto-migrate: lead_call_notes table + denormalized columns on leads
const _callNotesMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS lead_call_notes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    caller_id           UUID NOT NULL REFERENCES crm_users(id),
    call_id             UUID REFERENCES calls(id) ON DELETE SET NULL,
    sugar_confirmation  TEXT,    -- 'same' | 'different'
    confirmed_range     TEXT,    -- '250+' | '200-250' | '100-200' | 'no_diabetes'
    range_for           TEXT,    -- 'personal' | 'family'
    patient_age         TEXT,    -- '0-18' | '19-24' | '25-34' | '35-44' | '45-54' | 'above-54'
    diet_status         TEXT,    -- 'yes' | 'not_interested'
    takes_medicine      TEXT,    -- 'yes' | 'no'
    note                TEXT,
    outcome             TEXT NOT NULL CHECK (outcome IN ('completed','follow_up','not_interested')),
    follow_up_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Migrate existing CHECK constraint to allow 'not_interested' + 'not_picked'
  -- (no-op if already correct). 'not_picked' = caller dialed but lead didn't answer.
  ALTER TABLE lead_call_notes DROP CONSTRAINT IF EXISTS lead_call_notes_outcome_check;
  ALTER TABLE lead_call_notes ADD CONSTRAINT lead_call_notes_outcome_check
    CHECK (outcome IN ('completed','follow_up','not_interested','not_picked'));
  CREATE INDEX IF NOT EXISTS idx_lead_call_notes_lead   ON lead_call_notes (lead_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lead_call_notes_caller ON lead_call_notes (caller_id, created_at DESC);
  -- Independent "interested" flag captured alongside the outcome
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS interested TEXT;
  ALTER TABLE leads          ADD COLUMN IF NOT EXISTS last_note_interested TEXT;

  ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_note_outcome TEXT;   -- 'completed' | 'follow_up'
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_note_at      TIMESTAMPTZ;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_at      TIMESTAMPTZ;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads (follow_up_at) WHERE last_note_outcome = 'follow_up';
`);
if (_callNotesMigration && typeof _callNotesMigration.catch === 'function') {
  _callNotesMigration.catch(err => console.error('[Migration] lead_call_notes error:', err.message));
}

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

app.use('/api',        webinarConfigRouter);
app.use('/api/leads',  leadsLimiter);
app.use('/api/events', publicLimiter);
app.use('/api',        leadsRouter);
app.use('/api',        eventsRouter);
app.use('/api/auth',   authLimiter, authRouter);
app.use('/api/admin',  adminRouter);
app.use('/api/caller', callerRouter);
app.use('/api/caller', callsRouter);
app.use('/api/caller/recordings', recordingsRouter);
app.use('/api/webhooks', webhooksRouter);

module.exports = app;
