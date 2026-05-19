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

  -- Per-leg timestamps so the auto-call state machine can distinguish
  -- "agent (caller) picked up" from "customer picked up". The legacy
  -- single 'answered_at' column collapsed both legs.
  ALTER TABLE calls ADD COLUMN IF NOT EXISTS agent_answered_at    TIMESTAMPTZ;
  ALTER TABLE calls ADD COLUMN IF NOT EXISTS customer_answered_at TIMESTAMPTZ;
  ALTER TABLE calls ADD COLUMN IF NOT EXISTS customer_missed_at   TIMESTAMPTZ;
  ALTER TABLE calls ADD COLUMN IF NOT EXISTS hangup_by            TEXT;
  -- Dedicated caller-phone column — last-10 digits of the inbound number.
  -- Stored explicitly so the Missed Calls page doesn't need to grep through
  -- raw_payload's varying field names every render.
  ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_phone TEXT;
  CREATE INDEX IF NOT EXISTS idx_calls_caller_phone ON calls (caller_phone);
  -- One-time backfill from raw_payload (idempotent — only fills NULL rows).
  UPDATE calls
     SET caller_phone = RIGHT(REGEXP_REPLACE(
           COALESCE(
             raw_payload->>'caller_id_number',
             raw_payload->>'client_number',
             raw_payload->>'from',
             raw_payload->>'callerIdNumber',
             raw_payload->>'from_number',
             raw_payload->>'source',
             ''
           ), '\D', '', 'g'), 10)
   WHERE caller_phone IS NULL
     AND raw_payload IS NOT NULL;

  -- DID number — last-10 digits of the line the customer dialed IN to.
  -- Lets the Missed Calls page filter to only the calls that hit THIS
  -- caller's Tata caller-id / agent number, instead of every account-wide
  -- unassigned miss.
  ALTER TABLE calls ADD COLUMN IF NOT EXISTS did_number TEXT;
  CREATE INDEX IF NOT EXISTS idx_calls_did_number ON calls (did_number);
  UPDATE calls
     SET did_number = RIGHT(REGEXP_REPLACE(
           COALESCE(
             raw_payload->>'called_number',
             raw_payload->>'did_number',
             raw_payload->>'destination_number',
             raw_payload->>'to',
             raw_payload->>'to_number',
             raw_payload->>'destination',
             ''
           ), '\D', '', 'g'), 10)
   WHERE did_number IS NULL
     AND raw_payload IS NOT NULL;
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

  -- Real-time activity heartbeat. Caller's browser POSTs /api/caller/heartbeat
  -- every ~30s with current state. Sales Performance column renders the
  -- live green/orange/red status from these columns.
  --
  --   activity_status:   'working' | 'on_break' | 'idle'
  --   activity_break:    { reason, minutes, startedAt, endsAt }  (only when on_break)
  --   last_heartbeat_at: NOW() on every heartbeat — admin treats >90s old as Offline
  --   rest_started_at:   set when status transitions from 'working' → anything else.
  --                      Used to display "Resting Xh Ym" for the red badge across
  --                      orange-then-overrun transitions. Cleared when caller
  --                      returns to 'working'.
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS activity_status   TEXT;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS activity_break    JSONB;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS rest_started_at   TIMESTAMPTZ;

  -- SmartFlow auto-pause bookkeeping. Set together with is_active=FALSE
  -- inside POST /api/caller/leads/:id/note when the caller submits a note
  -- with outcome='auto_paused' (frontend trips this at AGENT_RETRY_CAP misses).
  -- Only the super-admin PATCH /api/admin/crm-users/:id flow can clear these
  -- (the PATCH endpoint requires ADMIN_PASSWORD bearer auth).
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS auto_paused_at    TIMESTAMPTZ;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS auto_pause_reason TEXT;
`);
if (_agentExtMigration && typeof _agentExtMigration.catch === 'function') {
  _agentExtMigration.catch(err => console.error('[Migration] crm_users smartflo fields error:', err.message));
}

// Auto-migrate: caller_activity_events — append-only audit log of every
// status transition for a caller. Admin opens this via the Performance
// status pill to see who was active / on break / on call / paused, with
// timings and durations. One open row per (caller_id, tag) until ended.
//
// caller_id is UUID to match crm_users.id (NOT integer). If an earlier
// build accidentally created the table with INT, drop it first — this
// is safe because activity events are not load-bearing.
const _activityEventsMigration = pool.query(`
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'caller_activity_events'
         AND column_name = 'caller_id'
         AND data_type IN ('integer','bigint','smallint')
    ) THEN
      DROP TABLE caller_activity_events CASCADE;
    END IF;
  END $$;
  CREATE TABLE IF NOT EXISTS caller_activity_events (
    id            BIGSERIAL PRIMARY KEY,
    caller_id     UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
    tag           TEXT NOT NULL,           -- LOGGED_IN | LOGGED_OUT | ACTIVE | ON_CALL |
                                          -- AFTER_CALL_FORM | ON_REASON_FORM | BREAK |
                                          -- BREAK_OVER | RESUMED | IDLE | PAUSED_BY_ADMIN |
                                          -- UNPAUSED_BY_ADMIN | OFFLINE
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at      TIMESTAMPTZ,             -- NULL = ongoing
    duration_sec  INT,                     -- denormalized at end-time
    context       JSONB,                   -- { lead_id, lead_name, break_minutes, over_by_sec, ... }
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS caller_activity_events_caller_idx
    ON caller_activity_events(caller_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS caller_activity_events_open_idx
    ON caller_activity_events(caller_id, tag) WHERE ended_at IS NULL;
`);
if (_activityEventsMigration && typeof _activityEventsMigration.catch === 'function') {
  _activityEventsMigration.catch(err => console.error('[Migration] caller_activity_events error:', err.message));
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
  -- Migrate existing CHECK constraint to allow 'not_interested' + 'not_picked' +
  -- 'auto_paused' (no-op if already correct).
  --   not_picked  = caller dialed but lead didn't answer.
  --   auto_paused = auto-call workflow exhausted the 5-attempt cap on the agent leg
  --                 (caller's SmartFlow phone never picked); lead parked for retry later.
  ALTER TABLE lead_call_notes DROP CONSTRAINT IF EXISTS lead_call_notes_outcome_check;
  ALTER TABLE lead_call_notes ADD CONSTRAINT lead_call_notes_outcome_check
    CHECK (outcome IN ('completed','follow_up','not_interested','not_picked','auto_paused'));
  CREATE INDEX IF NOT EXISTS idx_lead_call_notes_lead   ON lead_call_notes (lead_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lead_call_notes_caller ON lead_call_notes (caller_id, created_at DESC);
  -- Independent "interested" flag captured alongside the outcome
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS interested TEXT;
  ALTER TABLE leads          ADD COLUMN IF NOT EXISTS last_note_interested TEXT;

  -- Extended discovery fields captured during the call
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS hba1c                 TEXT;
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS other_languages       TEXT;
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS working_professional  TEXT;
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS location              TEXT;
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS already_paid          TEXT;
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS webinar_attended      TEXT;
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS available_for_webinar TEXT;
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS next_batch_joining    TEXT;

  ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_note_outcome TEXT;   -- 'completed' | 'follow_up'
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_note_at      TIMESTAMPTZ;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_at      TIMESTAMPTZ;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMPTZ;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_tag          TEXT;   -- 'HOT' | 'WARM' | 'COLD' | 'JUNK' (set by LeadCallNoteModal classifier)
  CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads (follow_up_at) WHERE last_note_outcome = 'follow_up';

  -- "Next Batch" bucket: parked when the caller answers Q14
  -- (next_batch_joining = 'yes'). Promoted back to the caller's Assigned
  -- queue as a follow-up when admin starts a new batch (updates
  -- next_webinar_at to a fresh future date).
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_batch_parked     BOOLEAN     NOT NULL DEFAULT FALSE;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_batch_parked_at  TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_leads_next_batch_parked ON leads (assigned_user_id) WHERE next_batch_parked = TRUE;

  -- "Pinned" leads: set by POST /api/caller/leads/reopen when the caller pulls
  -- leads from DNP / Missed / Untouched into the Assigned queue via the empty-
  -- state refill modal. The Assigned list sorts pinned_at DESC FIRST so these
  -- reopened leads bubble to the TOP. Organic SSE-assigned leads keep pinned_at
  -- NULL and sort by assigned_at ASC (newest at the bottom row).
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_leads_pinned_at ON leads (assigned_user_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

  -- Single-page Meta Funnel qualification fields (NEW). The new funnel asks
  -- three additional questions beyond sugar_level / diabetes_duration:
  --   on_medication: 'insulin' | 'tablets' | 'none'
  --   age_group:     '35-45'   | '45-55'   | '55+'
  --   occupation:    'working' | 'housewife' | 'retired'
  -- Used for richer lead scoring + Meta Pixel custom audience matching.
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS on_medication TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS age_group     TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS occupation    TEXT;

  -- Meta Conversions API (CAPI) deduplication fields. The browser fires
  -- fbq('track', 'Lead', {...}, { eventID }) with a minted UUID, and the
  -- backend fires the matching server-side Lead event via Graph API with
  -- the same event_id. Meta dedupes by (event_name, event_id).
  --   meta_event_id    — for the Lead event
  --   meta_event_id_cr — for the CompleteRegistration event (fires alongside)
  --   fbp / fbc        — Meta's first-party browser cookies, forwarded so
  --                       server events get attributed to the same user
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_event_id    TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_event_id_cr TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS fbp              TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS fbc              TEXT;
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
  -- Stable attribution: capture which webinar the visitor was registering for.
  -- webinar_at alone is brittle because admins can edit the deadline.
  ALTER TABLE click_events ADD COLUMN IF NOT EXISTS webinar_id UUID REFERENCES webinars(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_click_events_webinar_id ON click_events (webinar_id);
  -- Bulletproof Meta attribution: TRUE when the visit URL contained an
  -- fbclid or utm_source=meta. Used by the dashboard to count verified
  -- Meta-driven visits without relying on the lossy Meta Pixel.
  ALTER TABLE click_events ADD COLUMN IF NOT EXISTS is_meta BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE INDEX IF NOT EXISTS idx_click_events_is_meta ON click_events (webinar_id, is_meta);
  -- Anonymous visitor ID stored in the client's localStorage. Lets the
  -- dashboard count UNIQUE people via COUNT(DISTINCT visitor_id) instead
  -- of total page-load events. NULL on legacy events that fired before
  -- this column existed.
  ALTER TABLE click_events ADD COLUMN IF NOT EXISTS visitor_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_click_events_visitor_id ON click_events (webinar_id, visitor_id);
  -- Mirror the visitor_id onto every lead row so we can merge a single
  -- person's pre-registration visits + their lead together (Option C
  -- cross-device dedupe via the lead's phone number).
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS visitor_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_leads_visitor_id ON leads (visitor_id);
  -- Supports the same-webinar duplicate guard in utils/leadAssigner.js:
  -- "another lead with same whatsapp_number + webinar_id already assigned?"
  CREATE INDEX IF NOT EXISTS idx_leads_webinar_whatsapp ON leads (webinar_id, whatsapp_number);
`);
if (_clickMigration && typeof _clickMigration.catch === 'function') {
  _clickMigration.catch(err => console.error('[Migration] click_events error:', err.message));
}

// One-shot backfill of click_events.webinar_id (idempotent — only fills NULLs).
// Runs after both webinars and click_events tables exist.
Promise.all([_webinarTableMigration, _clickMigration]).then(() =>
  // Step 1: exact match — webinar_at matches some webinar's date_time
  pool.query(`
    UPDATE click_events ce
       SET webinar_id = w.id
      FROM webinars w
     WHERE ce.webinar_id IS NULL
       AND ce.webinar_at = w.date_time
  `)
).then(() =>
  // Step 2: orphans — pick the webinar whose date_time is closest to the
  // click's stored webinar_at, restricted to webinars that already existed
  // at click time. This recovers attribution after admins edited deadlines.
  pool.query(`
    UPDATE click_events ce
       SET webinar_id = (
         SELECT w.id FROM webinars w
          WHERE w.created_at <= ce.created_at
          ORDER BY ABS(EXTRACT(EPOCH FROM (w.date_time - ce.webinar_at))) ASC
          LIMIT 1
       )
     WHERE ce.webinar_id IS NULL
       AND ce.webinar_at IS NOT NULL
  `)
).catch(err => console.error('[Migration] click_events.webinar_id backfill error:', err.message));

// Auto-migrate: add `source` dimension ('meta' | 'yt') to all source-tagged tables.
// Existing rows backfill to 'meta'; new YT pipeline starts empty.
const _sourceMigration = Promise.all([_webinarTableMigration, _clickMigration]).then(() =>
  pool.query(`
    ALTER TABLE leads          ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'meta';
    ALTER TABLE click_events   ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'meta';
    ALTER TABLE webinars       ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'meta';
    ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'meta';
    CREATE INDEX IF NOT EXISTS idx_leads_source        ON leads        (source);
    CREATE INDEX IF NOT EXISTS idx_click_events_source ON click_events (source);
    CREATE INDEX IF NOT EXISTS idx_webinars_source     ON webinars     (source);
    CREATE INDEX IF NOT EXISTS idx_wa_links_source     ON whatsapp_links (source);

    -- webinar_config: turn into one row per source. Existing id=1 row is Meta;
    -- a new YT row is seeded with blank defaults so the YT pipeline has a
    -- config target on first deploy. The original schema enforced single_row
    -- via CHECK (id = 1) — drop it so we can have a second row.
    ALTER TABLE webinar_config DROP CONSTRAINT IF EXISTS single_row;
    ALTER TABLE webinar_config ADD COLUMN IF NOT EXISTS source TEXT;
    UPDATE webinar_config SET source = 'meta' WHERE source IS NULL;
    ALTER TABLE webinar_config ALTER COLUMN source SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS webinar_config_source_uniq ON webinar_config (source);

    -- webinars: a legacy partial-unique index "webinars_one_active_idx" was
    -- added in production to enforce one active webinar globally. With the
    -- source dimension, each source needs its own active webinar — replace
    -- the old constraint with one scoped per source.
    DROP INDEX IF EXISTS webinars_one_active_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS webinars_one_active_per_source_idx
      ON webinars (source) WHERE is_active = TRUE;
  `)
).then(() =>
  // Seed YT row (uses defaults for everything; admin will set values via CRM).
  // Explicit id=2 since the column has no SERIAL/sequence — id=1 is the
  // pre-existing Meta row.
  pool.query(`
    INSERT INTO webinar_config (id, source, kill_switch, tuesday_whatsapp_link, friday_whatsapp_link)
    VALUES (2, 'yt', false, '', '')
    ON CONFLICT (source) DO NOTHING
  `)
).then(() =>
  // Seed a baseline active webinar row per source so the admin's first timer
  // save can UPDATE (instead of relying on a dynamic INSERT that historically
  // failed silently in production). 'YT-101' picked to avoid colliding with
  // Meta's 'AWS-N' name space.
  pool.query(`
    INSERT INTO webinars (date_time, is_active, name, source)
    SELECT NOW() + INTERVAL '4 days', TRUE, 'YT-101', 'yt'
    WHERE NOT EXISTS (SELECT 1 FROM webinars WHERE source = 'yt')
  `)
).catch(err => console.error('[Migration] source dimension error:', err.message));

// Auto-migrate: alert phone + alert log for leads-alert scheduler
//   + meta_campaign_ids (selected Meta Ads campaigns to scope landing-view
//     analytics; stored as JSONB array of campaign-id strings, NULL = no
//     filter = include every campaign in every account).
const _alertMigration = pool.query(`
  ALTER TABLE webinar_config ADD COLUMN IF NOT EXISTS alert_phone_number TEXT;
  ALTER TABLE webinar_config ADD COLUMN IF NOT EXISTS alert_phone_numbers JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE webinar_config ADD COLUMN IF NOT EXISTS meta_campaign_ids JSONB;
  CREATE TABLE IF NOT EXISTS alert_log (
    id            BIGSERIAL PRIMARY KEY,
    webinar_id    UUID,
    source        TEXT NOT NULL DEFAULT 'meta',
    template_name TEXT NOT NULL,
    sent_to       TEXT,
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    success       BOOLEAN NOT NULL DEFAULT FALSE,
    response      JSONB,
    UNIQUE (webinar_id, template_name)
  );
  CREATE INDEX IF NOT EXISTS idx_alert_log_webinar ON alert_log (webinar_id, sent_at DESC);
`);
if (_alertMigration && typeof _alertMigration.catch === 'function') {
  _alertMigration.catch(err => console.error('[Migration] alert log error:', err.message));
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
