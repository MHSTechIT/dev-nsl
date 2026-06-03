const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const pool      = require('./db');

const webinarConfigRouter = require('./routes/webinarConfig');
const leadsRouter         = require('./routes/leads');
const adminRouter         = require('./routes/admin');
const nsmDashboardRouter  = require('./routes/nsmDashboard');
const authRouter          = require('./routes/auth');
const eventsRouter        = require('./routes/events');
const callerRouter        = require('./routes/caller');
const callsRouter         = require('./routes/calls');
const createWebhooksRouter = require('./routes/webhooks');
const recordingsRouter    = require('./routes/recordings');
const telegramAlertsRouter = require('./routes/telegramAlerts');
const nsmCallerRouter      = require('./routes/nsmCaller');
const nsmIvrRouter         = require('./routes/nsmIvr');

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
    role          TEXT NOT NULL CHECK (role IN ('junior_caller','senior_caller','manager','trainer','admin','team_leader','webinar','l1_sales')),
    password_hash TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
  CREATE INDEX IF NOT EXISTS idx_crm_users_role ON crm_users (role);
  -- Keep the role CHECK in sync with ALLOWED_ROLES (routes/admin.js). Drop +
  -- recreate so newly-added roles (webinar, l1_sales) are accepted on existing DBs.
  ALTER TABLE crm_users DROP CONSTRAINT IF EXISTS crm_users_role_check;
  ALTER TABLE crm_users ADD CONSTRAINT crm_users_role_check CHECK (role IN ('junior_caller','senior_caller','manager','trainer','admin','team_leader','webinar','l1_sales'));
`);
if (_crmUsersMigration && typeof _crmUsersMigration.catch === 'function') {
  _crmUsersMigration.catch(err => console.error('[Migration] crm_users error:', err.message));
}

// Auto-migrate: create timer_settings table (admin-tunable timing values)
const _timerSettingsMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS timer_settings (
    id          SMALLINT PRIMARY KEY DEFAULT 1,
    settings    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO timer_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
`);
if (_timerSettingsMigration && typeof _timerSettingsMigration.catch === 'function') {
  _timerSettingsMigration.catch(err => console.error('[Migration] timer_settings error:', err.message));
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

// Auto-migrate: org-structure fields on crm_users.
//   department      — 'sales' | 'marketing' (enforced in the API validator).
//   team_leader_id  — the team_leader user this person reports to.
//   manager_id      — the manager user this person reports to.
//                     Both FKs are ON DELETE SET NULL so removing a manager
//                     or team leader doesn't orphan rows.
const _crmOrgMigration = pool.query(`
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS department     TEXT;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS team_leader_id UUID REFERENCES crm_users(id) ON DELETE SET NULL;
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS manager_id     UUID REFERENCES crm_users(id) ON DELETE SET NULL;
  -- password_plain: the plain-text password, kept alongside the scrypt hash
  -- so the admin can view a user's current password on the Users page.
  -- (Admin-explicit choice — the hash in password_hash is still what login
  -- verifies against.)
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS password_plain TEXT;
  -- deleted_at: soft-delete tombstone. Set instead of running a physical
  -- DELETE so that historical attribution on leads / calls / notes /
  -- assignments stays intact (the FKs from those tables are ON DELETE
  -- NO ACTION and would otherwise block deletion). All caller-list +
  -- assignment-pool queries filter WHERE deleted_at IS NULL.
  ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
`);
if (_crmOrgMigration && typeof _crmOrgMigration.catch === 'function') {
  _crmOrgMigration.catch(err => console.error('[Migration] crm_users org fields error:', err.message));
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

  -- Single-tag model: at most ONE open span per caller. First close any
  -- pre-existing dangling duplicates (keep only the newest open row per
  -- caller), then enforce it with a partial unique index. Point events
  -- carry ended_at, so they never count against this constraint.
  UPDATE caller_activity_events
     SET ended_at     = NOW(),
         duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
   WHERE ended_at IS NULL
     AND id NOT IN (
       SELECT DISTINCT ON (caller_id) id
         FROM caller_activity_events
        WHERE ended_at IS NULL
        ORDER BY caller_id, started_at DESC, id DESC
     );
  CREATE UNIQUE INDEX IF NOT EXISTS caller_activity_events_one_open
    ON caller_activity_events (caller_id) WHERE ended_at IS NULL;

  -- Single-tag cutover. Pre-redesign rows used three overlapping channels
  -- (status / page / call), so a single day summed well past 24h. That data
  -- cannot be projected onto the single-tag model. We stamp a cutover time
  -- ONCE (guarded by a marker table) and close any span still open from the
  -- old code; the activity endpoint only returns rows at/after the cutover,
  -- so the old overlapping history is hidden (not deleted) and the log reads
  -- cleanly from here on.
  CREATE TABLE IF NOT EXISTS activity_log_redesign_flag (applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM activity_log_redesign_flag) THEN
      UPDATE caller_activity_events
         SET ended_at     = NOW(),
             duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
       WHERE ended_at IS NULL;
      INSERT INTO activity_log_redesign_flag DEFAULT VALUES;
    END IF;
  END $$;
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
    CHECK (outcome IN ('completed','follow_up','not_interested','not_picked','auto_paused','incomplete'));
  --   incomplete = caller hit the X button and confirmed in CloseConfirmDialog
  --                that the lead should move to Completed Calls with the
  --                INCOMPLETE tag. The auto-call stops; partial form values
  --                are preserved on the note row.
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

  -- outcome_subtag refines an outcome with a specific reason. Examples:
  --   outcome=not_interested + outcome_subtag=wrong_number   (caller picked subtag)
  --   outcome=not_interested + outcome_subtag=switch_off     (second-DNP card pick)
  -- A NULL subtag means no refinement; every pre-change row stays valid.
  -- last_note_outcome_subtag on the leads table is the denormalized latest
  -- value, used by Completed Calls to render the secondary chip.
  ALTER TABLE lead_call_notes ADD COLUMN IF NOT EXISTS outcome_subtag           TEXT;
  ALTER TABLE leads           ADD COLUMN IF NOT EXISTS last_note_outcome_subtag TEXT;

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

// Auto-migrate (isolated): re-assert the lead_call_notes outcome CHECK
// constraint so it includes 'incomplete'. This was originally part of the
// big _callNotesMigration block above but that batch is a 100-line
// multi-statement query; when ANY single statement in the batch errors
// out the whole batch rolls back atomically and this constraint stays
// stuck at its previous version (which is exactly how the 'incomplete'
// outcome got silently rejected for half a day). Isolating this single
// DDL into its own pool.query() makes it independent of every other
// migration's success.
const _incompleteConstraintMigration = pool.query(`
  ALTER TABLE lead_call_notes DROP CONSTRAINT IF EXISTS lead_call_notes_outcome_check;
  ALTER TABLE lead_call_notes ADD CONSTRAINT lead_call_notes_outcome_check
    CHECK (outcome IN ('completed','follow_up','not_interested','not_picked','auto_paused','incomplete'));
`);
if (_incompleteConstraintMigration && typeof _incompleteConstraintMigration.catch === 'function') {
  _incompleteConstraintMigration.catch(err => console.error('[Migration] outcome_check (incomplete) error:', err.message));
}

// Auto-migrate: telegram_alert_recipients — recipients of Telegram push alerts.
//   target_type = 'team_leader' → notifications about callers reporting to
//                 team_leader_id are forwarded to telegram_chat_id.
//   target_type = 'manager'     → notifications about callers in `department`
//                 (or all departments if NULL) are forwarded.
const _telegramAlertsMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS telegram_alert_recipients (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_chat_id TEXT        NOT NULL,
    target_type      TEXT        NOT NULL CHECK (target_type IN ('team_leader','manager')),
    team_leader_id   UUID        REFERENCES crm_users(id) ON DELETE CASCADE,
    department       TEXT,
    label            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (target_type = 'team_leader' AND team_leader_id IS NOT NULL) OR
      (target_type = 'manager')
    )
  );
  CREATE INDEX IF NOT EXISTS idx_tg_alerts_tl   ON telegram_alert_recipients (team_leader_id);
  CREATE INDEX IF NOT EXISTS idx_tg_alerts_dept ON telegram_alert_recipients (department);
`);
if (_telegramAlertsMigration && typeof _telegramAlertsMigration.catch === 'function') {
  _telegramAlertsMigration.catch(err => console.error('[Migration] telegram_alert_recipients error:', err.message));
}

// Auto-migrate: telegram_poll_state — singleton row that tracks the highest
// Telegram update_id we've processed via long-polling. Persisting this in
// Postgres (not memory) means restarts don't replay messages.
const _telegramPollMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS telegram_poll_state (
    id              INTEGER     PRIMARY KEY DEFAULT 1,
    last_update_id  BIGINT      NOT NULL    DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
    CHECK (id = 1)
  );
  INSERT INTO telegram_poll_state (id, last_update_id)
       VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;
`);
if (_telegramPollMigration && typeof _telegramPollMigration.catch === 'function') {
  _telegramPollMigration.catch(err => console.error('[Migration] telegram_poll_state error:', err.message));
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
).then(() =>
  // Seed Meta 2.0 config row (independent WhatsApp links + webinar timing).
  // Explicit id=3 — id=1 is Meta, id=2 is YT. Blank defaults; admin sets
  // values via CRM → Meta 2.0 workspace → Marketing → Timer / WhatsApp Links.
  pool.query(`
    INSERT INTO webinar_config (id, source, kill_switch, tuesday_whatsapp_link, friday_whatsapp_link)
    VALUES (3, 'meta2', false, '', '')
    ON CONFLICT (source) DO NOTHING
  `)
).then(() =>
  // Baseline active webinar for meta2 so new meta2 leads get a webinar_id and
  // the admin's first timer save can UPDATE. 'M2-101' avoids colliding with
  // Meta's 'AWS-N' and YT's 'YT-N' name spaces.
  pool.query(`
    INSERT INTO webinars (date_time, is_active, name, source)
    SELECT NOW() + INTERVAL '4 days', TRUE, 'M2-101', 'meta2'
    WHERE NOT EXISTS (SELECT 1 FROM webinars WHERE source = 'meta2')
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

// Auto-migrate: nsm_batches — NSM-Caller "Webinar" batches. Each batch is a
// named window (start_at → end_at) bound to a set of selected Meta Lead Gen
// FORMS (stored as JSONB [{id,name}]). Stand-alone table owned by the
// NSM-Caller workspace; no `source` column — it's its own pipeline.
const _nsmBatchesMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_batches (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_name  TEXT        NOT NULL,
    start_at    TIMESTAMPTZ,
    end_at      TIMESTAMPTZ,
    meta_forms  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Selection switched from Meta pages → Meta lead forms. Rename the original
  -- meta_pages column to meta_forms if an earlier build created it. Idempotent.
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'nsm_batches' AND column_name = 'meta_pages')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'nsm_batches' AND column_name = 'meta_forms') THEN
      ALTER TABLE nsm_batches RENAME COLUMN meta_pages TO meta_forms;
    END IF;
  END $$;
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS meta_forms JSONB NOT NULL DEFAULT '[]'::jsonb;
  -- webinar_at: when the webinar itself happens (distinct from the start_at →
  -- end_at lead-collection window).
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS webinar_at TIMESTAMPTZ;
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS webinar_link TEXT;
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS webinar_meeting_id TEXT;
  -- WhatsApp (whapi.cloud) community bookkeeping for the batch. whatsapp_group_id
  -- holds the community's ANNOUNCE group (used to add members + send messages);
  -- whatsapp_community_id is the community itself (used for cleanup).
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS whatsapp_community_id TEXT;
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS whatsapp_group_id TEXT;
  -- The community's member sub-group (leads are added here; announce group is messaging only).
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS whatsapp_member_group_id TEXT;
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS whatsapp_group_invite TEXT;
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS whatsapp_group_count INT NOT NULL DEFAULT 0;
  ALTER TABLE nsm_batches ADD COLUMN IF NOT EXISTS whatsapp_group_error TEXT;
  CREATE INDEX IF NOT EXISTS idx_nsm_batches_created ON nsm_batches (created_at DESC);
`);
if (_nsmBatchesMigration && typeof _nsmBatchesMigration.catch === 'function') {
  _nsmBatchesMigration.catch(err => console.error('[Migration] nsm_batches error:', err.message));
}

// Auto-migrate: nsm_leads — leads pulled from the Meta Lead Gen forms attached
// to each NSM-Caller batch (synced by utils/nsmLeadsSync.js). meta_lead_id is
// the Graph leadgen id — UNIQUE so re-syncs upsert instead of duplicating.
// Common fields (name/phone/email/city) are denormalised for fast columns +
// search; the full per-form answer set lives in field_data JSONB.
const _nsmLeadsMigration = _nsmBatchesMigration.then(() => pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_leads (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    meta_lead_id  TEXT        NOT NULL UNIQUE,
    batch_id      UUID        REFERENCES nsm_batches(id) ON DELETE CASCADE,
    form_id       TEXT,
    form_name     TEXT,
    created_time  TIMESTAMPTZ,
    full_name     TEXT,
    phone         TEXT,
    email         TEXT,
    city          TEXT,
    field_data    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Soft-delete tombstone. The sync's upsert is guarded so a deleted lead is
  -- never resurrected, and every list/assignment query filters deleted_at.
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- WhatsApp: set once when the lead's phone has been added to the batch group
  -- (atomic claim so dev+prod never double-add the same lead).
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS whatsapp_added_at TIMESTAMPTZ;
  -- Set when a force-add was rejected by WhatsApp and we DM'd the invite link
  -- instead (so we don't re-DM every tick).
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS whatsapp_invited_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_nsm_leads_batch ON nsm_leads (batch_id, created_time DESC);
  CREATE INDEX IF NOT EXISTS idx_nsm_leads_form  ON nsm_leads (form_id);
`));
if (_nsmLeadsMigration && typeof _nsmLeadsMigration.catch === 'function') {
  _nsmLeadsMigration.catch(err => console.error('[Migration] nsm_leads error:', err.message));
}

// Auto-migrate: nsm_users — NSM-Caller's OWN independent staff directory.
// Mirrors crm_users (same roles, telephony fields, scrypt password_hash +
// viewable password_plain, soft-delete) but is a separate table so it shares
// nothing with Meta's crm_users. Self-referencing FKs for the team hierarchy.
const _nsmUsersMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_users (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name             TEXT        NOT NULL,
    email                 TEXT        NOT NULL UNIQUE,
    phone                 TEXT,
    role                  TEXT        NOT NULL CHECK (role IN ('junior_caller','senior_caller','manager','trainer','admin','team_leader','webinar','l1_sales')),
    password_hash         TEXT,
    password_plain        TEXT,
    is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
    department            TEXT,
    team_leader_id        UUID        REFERENCES nsm_users(id) ON DELETE SET NULL,
    manager_id            UUID        REFERENCES nsm_users(id) ON DELETE SET NULL,
    tata_extension        TEXT,
    tata_account_type     TEXT,
    tata_agent_number     TEXT,
    tata_caller_id        TEXT,
    tata_smartflo_api_key TEXT,
    tata_outbound_route   TEXT        NOT NULL DEFAULT 'extension',
    auto_paused_at        TIMESTAMPTZ,
    auto_pause_reason     TEXT,
    deleted_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_users_role ON nsm_users (role);
`);
if (_nsmUsersMigration && typeof _nsmUsersMigration.catch === 'function') {
  _nsmUsersMigration.catch(err => console.error('[Migration] nsm_users error:', err.message));
}

// Auto-migrate: NSM-Caller lead → caller assignment (independent of Meta's
// crm_users / lead_share_config). nsm_leads gets assigned_user_id; a per-batch
// share-config picks which NSM callers receive that batch's leads, round-robin.
const _nsmAssignMigration = Promise.all([_nsmLeadsMigration, _nsmUsersMigration]).then(() => pool.query(`
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES nsm_users(id) ON DELETE SET NULL;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_nsm_leads_assigned ON nsm_leads (assigned_user_id, created_time DESC);

  CREATE TABLE IF NOT EXISTS nsm_lead_share_config (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id   UUID        NOT NULL REFERENCES nsm_batches(id) ON DELETE CASCADE,
    caller_id  UUID        NOT NULL REFERENCES nsm_users(id)   ON DELETE CASCADE,
    enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
    position   INTEGER     NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (batch_id, caller_id)
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_share_batch ON nsm_lead_share_config (batch_id, position);

  CREATE TABLE IF NOT EXISTS nsm_round_robin_state (
    batch_id      UUID        PRIMARY KEY REFERENCES nsm_batches(id) ON DELETE CASCADE,
    last_position INTEGER     NOT NULL DEFAULT -1,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`));
if (_nsmAssignMigration && typeof _nsmAssignMigration.catch === 'function') {
  _nsmAssignMigration.catch(err => console.error('[Migration] nsm assignment error:', err.message));
}

// Auto-migrate: NSM caller call-workflow tables — the independent equivalents
// of Meta's calls / lead_call_notes / caller_activity_events, scoped to the NSM
// caller pool (nsm_users) + NSM leads (nsm_leads). The SHARED caller routes
// resolve these table names from the JWT's workspace ('nsm'); there is no
// cloned route code. Schema mirrors Meta column-for-column so the
// workspace-aware queries stay uniform (only the table names differ).
const _nsmCallerWorkflowMigration = Promise.all([_nsmLeadsMigration, _nsmUsersMigration]).then(() => pool.query(`
  -- nsm_calls — Tata click-to-call records (mirror of calls)
  CREATE TABLE IF NOT EXISTS nsm_calls (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id          UUID REFERENCES nsm_leads(id) ON DELETE SET NULL,
    caller_id        UUID REFERENCES nsm_users(id) ON DELETE SET NULL,
    provider         TEXT NOT NULL DEFAULT 'tata',
    provider_call_id TEXT,
    status           TEXT NOT NULL DEFAULT 'initiated',
      -- initiated | ringing | answered | ended | missed | failed
    direction        TEXT NOT NULL DEFAULT 'outbound',
    duration_sec     INTEGER,
    recording_url    TEXT,
    error_message    TEXT,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at      TIMESTAMPTZ,
    ended_at         TIMESTAMPTZ,
    raw_payload      JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agent_answered_at    TIMESTAMPTZ,
    customer_answered_at TIMESTAMPTZ,
    customer_missed_at   TIMESTAMPTZ,
    hangup_by            TEXT,
    caller_phone         TEXT,
    did_number           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_calls_lead         ON nsm_calls (lead_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_nsm_calls_caller       ON nsm_calls (caller_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_nsm_calls_provider_id  ON nsm_calls (provider, provider_call_id);
  CREATE INDEX IF NOT EXISTS idx_nsm_calls_caller_phone ON nsm_calls (caller_phone);
  CREATE INDEX IF NOT EXISTS idx_nsm_calls_did_number   ON nsm_calls (did_number);

  -- nsm_users — heartbeat / activity columns (mirror of crm_users).
  -- auto_paused_at / auto_pause_reason already exist on nsm_users.
  ALTER TABLE nsm_users ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
  ALTER TABLE nsm_users ADD COLUMN IF NOT EXISTS activity_status   TEXT;
  ALTER TABLE nsm_users ADD COLUMN IF NOT EXISTS activity_break    JSONB;
  ALTER TABLE nsm_users ADD COLUMN IF NOT EXISTS rest_started_at   TIMESTAMPTZ;

  -- nsm_caller_activity_events — append-only activity audit (mirror of
  -- caller_activity_events). One open span per caller, DB-enforced.
  CREATE TABLE IF NOT EXISTS nsm_caller_activity_events (
    id            BIGSERIAL PRIMARY KEY,
    caller_id     UUID NOT NULL REFERENCES nsm_users(id) ON DELETE CASCADE,
    tag           TEXT NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at      TIMESTAMPTZ,
    duration_sec  INT,
    context       JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS nsm_caller_activity_events_caller_idx
    ON nsm_caller_activity_events(caller_id, started_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS nsm_caller_activity_events_one_open
    ON nsm_caller_activity_events(caller_id) WHERE ended_at IS NULL;

  -- nsm_lead_call_notes — post-call form rows (mirror of lead_call_notes)
  CREATE TABLE IF NOT EXISTS nsm_lead_call_notes (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id               UUID NOT NULL REFERENCES nsm_leads(id) ON DELETE CASCADE,
    caller_id             UUID NOT NULL REFERENCES nsm_users(id),
    call_id               UUID REFERENCES nsm_calls(id) ON DELETE SET NULL,
    sugar_confirmation    TEXT,
    confirmed_range       TEXT,
    range_for             TEXT,
    patient_age           TEXT,
    diet_status           TEXT,
    takes_medicine        TEXT,
    note                  TEXT,
    outcome               TEXT NOT NULL
      CHECK (outcome IN ('completed','follow_up','not_interested','not_picked','auto_paused','incomplete')),
    follow_up_at          TIMESTAMPTZ,
    interested            TEXT,
    hba1c                 TEXT,
    other_languages       TEXT,
    working_professional  TEXT,
    location              TEXT,
    already_paid          TEXT,
    webinar_attended      TEXT,
    available_for_webinar TEXT,
    next_batch_joining    TEXT,
    outcome_subtag        TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_notes_lead   ON nsm_lead_call_notes (lead_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_nsm_notes_caller ON nsm_lead_call_notes (caller_id, created_at DESC);

  -- nsm_leads — denormalized latest-note + workflow columns (mirror of leads).
  -- The per-field "last_note_*" values the form prefills from come from the
  -- LATERAL note join in the shared LEAD_SELECT, not physical columns; only the
  -- filter/sort denorms below are stored on the lead row.
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS last_note_interested     TEXT;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS last_note_outcome        TEXT;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS last_note_at             TIMESTAMPTZ;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS last_note_outcome_subtag TEXT;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS follow_up_at             TIMESTAMPTZ;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS completed_at             TIMESTAMPTZ;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS lead_tag                 TEXT;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS next_batch_parked        BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS next_batch_parked_at     TIMESTAMPTZ;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS pinned_at                TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_nsm_leads_followup ON nsm_leads (follow_up_at) WHERE last_note_outcome = 'follow_up';

  -- NSM-Caller IVR reminders (Cloudshope), scheduled from the caller workspace's
  -- own IVR page against nsm_leads. Mirrors the NSM-IVR engine; per-(lead,campaign)
  -- once-only claim lives in nsm_lead_ivr_calls. ivr_attempts is a global cap.
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS ivr_attempts INT NOT NULL DEFAULT 0;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS ivr_status   TEXT;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS last_ivr_at  TIMESTAMPTZ;
  ALTER TABLE nsm_leads ADD COLUMN IF NOT EXISTS opted_out    BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE TABLE IF NOT EXISTS nsm_lead_ivr_calls (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id     UUID        NOT NULL REFERENCES nsm_leads(id) ON DELETE CASCADE,
    campaign_id TEXT        NOT NULL,
    status      TEXT,
    response    JSONB,
    fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lead_id, campaign_id)
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_lead_ivr_calls_lead ON nsm_lead_ivr_calls (lead_id);
`));
if (_nsmCallerWorkflowMigration && typeof _nsmCallerWorkflowMigration.catch === 'function') {
  _nsmCallerWorkflowMigration.catch(err => console.error('[Migration] nsm caller workflow error:', err.message));
}

// Auto-migrate: NSM Web-Reminder admin config tables — independent equivalents
// of Meta's timer_settings (caller-page timings) and the telegram alert
// recipients, scoped to the NSM caller workspace.
const _nsmDashboardMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_timer_settings (
    id          SMALLINT    PRIMARY KEY DEFAULT 1,
    settings    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (id = 1)
  );
  INSERT INTO nsm_timer_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;

  CREATE TABLE IF NOT EXISTS nsm_telegram_alerts (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_chat_id TEXT        NOT NULL,
    target_type      TEXT        NOT NULL DEFAULT 'team_leader',  -- team_leader | manager
    team_leader_id   UUID,
    department       TEXT,
    label            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- nsm_media — uploaded WhatsApp template media (image/video). Stored in
  -- Postgres (not disk) because Render's filesystem is ephemeral; served
  -- publicly at /api/nsm-media/:id so whapi can fetch it as a media URL.
  CREATE TABLE IF NOT EXISTS nsm_media (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    mime       TEXT        NOT NULL,
    size       INTEGER     NOT NULL,
    data       BYTEA       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- nsm_call_config — NSM-Caller IVR campaigns (mirrors nsm_ivr_call_config but
  -- for the caller workspace; same dynamic-campaigns JSONB shape).
  CREATE TABLE IF NOT EXISTS nsm_call_config (
    id          SMALLINT    PRIMARY KEY DEFAULT 1,
    config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (id = 1)
  );
  INSERT INTO nsm_call_config (id, config) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;

  -- Telegram alert config (bot token + chat id) — one row per NSM workspace.
  CREATE TABLE IF NOT EXISTS nsm_tele_config (
    id SMALLINT PRIMARY KEY DEFAULT 1, config JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (id = 1)
  );
  INSERT INTO nsm_tele_config (id, config) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS nsm_ivr_tele_config (
    id SMALLINT PRIMARY KEY DEFAULT 1, config JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (id = 1)
  );
  INSERT INTO nsm_ivr_tele_config (id, config) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
`);
if (_nsmDashboardMigration && typeof _nsmDashboardMigration.catch === 'function') {
  _nsmDashboardMigration.catch(err => console.error('[Migration] nsm dashboard config error:', err.message));
}

// Auto-migrate: nsm_settings — single-row JSONB config for the NSM-Caller
// workspace (WhatsApp message templates, etc.). Mirrors timer_settings.
const _nsmSettingsMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_settings (
    id          SMALLINT    PRIMARY KEY DEFAULT 1,
    settings    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (id = 1)
  );
  INSERT INTO nsm_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
`);
if (_nsmSettingsMigration && typeof _nsmSettingsMigration.catch === 'function') {
  _nsmSettingsMigration.catch(err => console.error('[Migration] nsm_settings error:', err.message));
}

// Auto-migrate: nsm_batch_messages — send-once log for the WhatsApp reminder
// cadence. The UNIQUE(batch_id, template_key) doubles as a cross-process lock:
// the scheduler INSERTs ON CONFLICT DO NOTHING and only the winner sends.
const _nsmBatchMsgMigration = _nsmBatchesMigration.then(() => pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_batch_messages (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id     UUID        NOT NULL REFERENCES nsm_batches(id) ON DELETE CASCADE,
    template_key TEXT        NOT NULL,
    status       TEXT,
    response     JSONB,
    sent_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (batch_id, template_key)
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_batch_messages_batch ON nsm_batch_messages (batch_id);
`));
if (_nsmBatchMsgMigration && typeof _nsmBatchMsgMigration.catch === 'function') {
  _nsmBatchMsgMigration.catch(err => console.error('[Migration] nsm_batch_messages error:', err.message));
}

// Auto-migrate: NSM-IVR — a fully independent clone of the NSM-Caller marketing
// data (own nsm_ivr_* tables, no callers/assignment). Webinar batches + Meta
// leads + WhatsApp community + reminder templates. Shares nothing with nsm_*.
const _nsmIvrMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_ivr_batches (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_name               TEXT        NOT NULL,
    start_at                 TIMESTAMPTZ,
    end_at                   TIMESTAMPTZ,
    webinar_at               TIMESTAMPTZ,
    webinar_link             TEXT,
    webinar_meeting_id       TEXT,
    meta_forms               JSONB       NOT NULL DEFAULT '[]'::jsonb,
    whatsapp_community_id    TEXT,
    whatsapp_group_id        TEXT,
    whatsapp_member_group_id TEXT,
    whatsapp_group_invite    TEXT,
    whatsapp_group_count     INT         NOT NULL DEFAULT 0,
    whatsapp_group_error     TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_ivr_batches_created ON nsm_ivr_batches (created_at DESC);

  CREATE TABLE IF NOT EXISTS nsm_ivr_settings (
    id          SMALLINT    PRIMARY KEY DEFAULT 1,
    settings    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (id = 1)
  );
  INSERT INTO nsm_ivr_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
`);
if (_nsmIvrMigration && typeof _nsmIvrMigration.catch === 'function') {
  _nsmIvrMigration.catch(err => console.error('[Migration] nsm_ivr error:', err.message));
}

const _nsmIvrChildMigration = _nsmIvrMigration.then(() => pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_ivr_leads (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    meta_lead_id  TEXT        NOT NULL UNIQUE,
    batch_id      UUID        REFERENCES nsm_ivr_batches(id) ON DELETE CASCADE,
    form_id       TEXT,
    form_name     TEXT,
    created_time  TIMESTAMPTZ,
    full_name     TEXT,
    phone         TEXT,
    email         TEXT,
    city          TEXT,
    field_data    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    whatsapp_added_at TIMESTAMPTZ,
    deleted_at    TIMESTAMPTZ,
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_ivr_leads_batch ON nsm_ivr_leads (batch_id, created_time DESC);

  CREATE TABLE IF NOT EXISTS nsm_ivr_batch_messages (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id     UUID        NOT NULL REFERENCES nsm_ivr_batches(id) ON DELETE CASCADE,
    template_key TEXT        NOT NULL,
    status       TEXT,
    response     JSONB,
    sent_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (batch_id, template_key)
  );

  -- CloudShope IVR call-fire tracking (one timestamp per trigger per lead so
  -- each call fires at most once).
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS ivr_immediate_at TIMESTAMPTZ;
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS ivr_before_at    TIMESTAMPTZ;
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS ivr_after_at     TIMESTAMPTZ;
  -- Numbers WhatsApp won't let us force-add get an invite link DM instead;
  -- this records that so we don't re-DM every tick.
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS whatsapp_invited_at TIMESTAMPTZ;

  -- Cloudshope reminder model (WF-06): three campaigns — immediate (on lead
  -- arrival), before_day (7PM the day before webinar), live_day (1:30PM on the
  -- webinar day). Each lead is dialled at most once per campaign (claim cols).
  -- ivr_attempts is a hard safety cap (< 10); opted_out respects do-not-call;
  -- Cloudshope auto-retries unconnected calls on its side via retry_did.
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS ivr_before_day_at TIMESTAMPTZ;
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS ivr_live_day_at   TIMESTAMPTZ;
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS ivr_attempts      INT NOT NULL DEFAULT 0;
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS ivr_status        TEXT;
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS last_ivr_at       TIMESTAMPTZ;
  ALTER TABLE nsm_ivr_leads ADD COLUMN IF NOT EXISTS opted_out         BOOLEAN NOT NULL DEFAULT FALSE;

  -- Dynamic IVR campaigns: admins add/remove their own reminder campaigns in
  -- the IVR page (stored in nsm_ivr_call_config.config.campaigns). Because
  -- campaign count is no longer fixed, "already called" tracking lives here
  -- instead of fixed claim columns. UNIQUE(lead_id, campaign_id) + INSERT ...
  -- ON CONFLICT DO NOTHING = atomic once-per-(lead, campaign) claim.
  CREATE TABLE IF NOT EXISTS nsm_ivr_lead_calls (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id     UUID        NOT NULL REFERENCES nsm_ivr_leads(id) ON DELETE CASCADE,
    campaign_id TEXT        NOT NULL,
    status      TEXT,                     -- 'called' | 'failed'
    response    JSONB,
    fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lead_id, campaign_id)
  );
  CREATE INDEX IF NOT EXISTS idx_nsm_ivr_lead_calls_lead ON nsm_ivr_lead_calls (lead_id);
`));
if (_nsmIvrChildMigration && typeof _nsmIvrChildMigration.catch === 'function') {
  _nsmIvrChildMigration.catch(err => console.error('[Migration] nsm_ivr child error:', err.message));
}

// Auto-migrate: nsm_ivr_call_config — single-row JSONB config for the NSM-IVR
// "IVR" page (CloudShope voice-call triggers: immediate / before webinar /
// after webinar — each with a voice id + offset + enabled flag).
const _nsmIvrCallCfgMigration = pool.query(`
  CREATE TABLE IF NOT EXISTS nsm_ivr_call_config (
    id          SMALLINT    PRIMARY KEY DEFAULT 1,
    config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (id = 1)
  );
  INSERT INTO nsm_ivr_call_config (id, config) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
`);
if (_nsmIvrCallCfgMigration && typeof _nsmIvrCallCfgMigration.catch === 'function') {
  _nsmIvrCallCfgMigration.catch(err => console.error('[Migration] nsm_ivr_call_config error:', err.message));
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
app.use('/api/admin/telegram-alerts', telegramAlertsRouter);
// Public: serve uploaded NSM WhatsApp template media (image/video) by id so
// whapi can fetch it. No auth — ids are unguessable UUIDs.
app.get('/api/nsm-media/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT mime, data FROM nsm_media WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).end();
    res.set('Content-Type', rows[0].mime || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(rows[0].data);
  } catch (e) {
    return res.status(500).end();
  }
});

app.use('/api/admin/nsm-ivr', nsmIvrRouter);   // NSM-IVR marketing (independent of nsm)
app.use('/api/admin/nsm', nsmDashboardRouter); // NSM Web-Reminder dashboard (perf/report/timer/alerts) — specific paths; rest fall through to adminRouter's /nsm/*
app.use('/api/admin',  adminRouter);
// Recordings MUST be mounted before /api/caller — callerRouter uses
// the bearer-JWT callerAuth middleware which rejects any request that
// doesn't carry an Authorization header. The recordings proxy
// authenticates via a query-string token (?token=...) instead because
// the <audio> element can't send Authorization headers. Mounting after
// /api/caller meant every recording request was hitting callerAuth
// first and getting a 401 before the recordings auth could even run —
// which made admin Completed Calls audio players show 0:00 / 0:00.
app.use('/api/caller/recordings', recordingsRouter);
app.use('/api/caller', callerRouter);
app.use('/api/caller', callsRouter);
// Tata posts call-status/recording callbacks with NO auth and NO workspace
// marker, so each workspace gets its OWN public mount running the same handler
// against its own tables. Meta's /api/webhooks/* is byte-identical to before
// (default factory args reproduce the Meta literals); NSM gets a parallel
// /api/nsm-webhooks/* mount bound to nsm_calls / nsm_leads / nsm_users.
app.use('/api/webhooks',     createWebhooksRouter({ calls: 'calls',     leads: 'leads',     users: 'crm_users' }));
app.use('/api/nsm-webhooks', createWebhooksRouter({ calls: 'nsm_calls', leads: 'nsm_leads', users: 'nsm_users' }));
// NSM-Caller's independent caller-facing API (own scoped JWT, own nsm_* data).
app.use('/api/nsm-caller', nsmCallerRouter);

module.exports = app;
