/**
 * Workspace resolver for the SHARED caller routes (routes/caller.js,
 * routes/calls.js, routes/recordings.js, routes/webhooks.js).
 *
 * A caller's JWT carries `workspace`:
 *   'meta' (default) → crm_users / leads / calls / lead_call_notes / caller_activity_events
 *   'nsm'            → nsm_users / nsm_leads / nsm_calls / nsm_lead_call_notes / nsm_caller_activity_events
 *
 * Every caller route resolves its table names + lead projection from here, so
 * ONE codebase serves all workspaces — no cloned route files. The Meta config
 * reproduces the pre-refactor SQL byte-for-byte (the table names below are the
 * exact literals that were inlined before), so Meta behavior is unchanged.
 *
 * The NSM lead table has a different shape than Meta's `leads`; its LEAD_SELECT
 * aliases nsm_leads columns into the identical output column contract the
 * caller frontend expects (whatsapp_number←phone, created_at←created_time,
 * webinar_name←batch_name, and NULLs for the Meta-only funnel fields).
 */

/* ── "Current + previous" webinars per source (Meta). For NSM the leads carry
   webinar_id = NULL so this never matches — it stays valid SQL (references the
   real `webinars` table) and the `webinar_id IS NULL` short-circuit keeps every
   NSM lead in the Assigned bucket. Shared verbatim by both workspaces. ── */
const RECENT_WEBINARS = `(
  SELECT ranked.id FROM (
    SELECT w.id,
           ROW_NUMBER() OVER (
             PARTITION BY w.source
             ORDER BY w.date_time DESC NULLS LAST, w.id DESC
           ) AS rn
      FROM webinars w
      JOIN (
        SELECT source,
               COALESCE(MAX(date_time) FILTER (WHERE is_active), MAX(date_time)) AS cap
          FROM webinars
         GROUP BY source
      ) caps ON caps.source = w.source
     WHERE w.date_time <= caps.cap
  ) ranked
  WHERE ranked.rn <= 2
)`;

/* The latest-call LATERAL is identical across workspaces except the source
   table (calls vs nsm_calls). Tata fragments one click-to-call across multiple
   rows; this picks the best value per field across the recent ~30-min session
   window. `callsTable` is an allowlisted literal. */
function latestCallLateral(callsTable) {
  return `LEFT JOIN LATERAL (
      WITH recent AS (
        SELECT id, status, duration_sec, recording_url, started_at,
               agent_answered_at, customer_answered_at, customer_missed_at,
               ended_at, hangup_by
          FROM ${callsTable} c
         WHERE c.lead_id = l.id
         ORDER BY c.started_at DESC
         LIMIT 6
      ),
      session AS (
        SELECT * FROM recent
         WHERE started_at >= (SELECT MAX(started_at) FROM recent) - INTERVAL '30 minutes'
      )
      SELECT
        COALESCE(
          (SELECT id FROM session WHERE recording_url IS NOT NULL
             ORDER BY started_at DESC LIMIT 1),
          (SELECT id FROM session ORDER BY started_at DESC LIMIT 1)
        ) AS id,
        COALESCE(
          (SELECT 'ended' WHERE EXISTS (
             SELECT 1 FROM session
              WHERE recording_url IS NOT NULL
                 OR customer_answered_at IS NOT NULL
                 OR (duration_sec IS NOT NULL AND duration_sec > 0)
          )),
          (SELECT status FROM session ORDER BY started_at DESC LIMIT 1)
        ) AS status,
        (SELECT duration_sec FROM session
           WHERE duration_sec IS NOT NULL AND duration_sec > 0
           ORDER BY started_at DESC LIMIT 1) AS duration_sec,
        (SELECT recording_url FROM session
           WHERE recording_url IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS recording_url,
        (SELECT MIN(started_at) FROM session) AS started_at,
        (SELECT agent_answered_at FROM session
           WHERE agent_answered_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS agent_answered_at,
        (SELECT customer_answered_at FROM session
           WHERE customer_answered_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS customer_answered_at,
        (SELECT customer_missed_at FROM session
           WHERE customer_missed_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS customer_missed_at,
        (SELECT ended_at FROM session
           WHERE ended_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS ended_at,
        (SELECT hangup_by FROM session
           WHERE hangup_by IS NOT NULL
           ORDER BY started_at DESC LIMIT 1) AS hangup_by
    ) latest_call ON TRUE`;
}

function latestNoteLateral(notesTable) {
  return `LEFT JOIN LATERAL (
      SELECT id, sugar_confirmation, confirmed_range, range_for,
             patient_age, diet_status, takes_medicine, note,
             hba1c, other_languages, working_professional, location,
             already_paid, webinar_attended, available_for_webinar,
             next_batch_joining, interested, follow_up_at
        FROM ${notesTable} n
       WHERE n.lead_id = l.id
       ORDER BY n.created_at DESC
       LIMIT 1
    ) latest_note ON TRUE`;
}

/* Shared projection of the latest_call / latest_note LATERALs (identical column
   list across workspaces). */
const LATERAL_PROJECTION = `
         latest_call.id                   AS last_call_id,
         latest_call.status               AS last_call_status,
         latest_call.duration_sec         AS last_call_duration,
         latest_call.recording_url        AS last_call_recording_url,
         latest_call.started_at           AS last_call_started_at,
         latest_call.agent_answered_at    AS last_call_agent_answered_at,
         latest_call.customer_answered_at AS last_call_customer_answered_at,
         latest_call.customer_missed_at   AS last_call_customer_missed_at,
         latest_call.ended_at             AS last_call_ended_at,
         latest_call.hangup_by            AS last_call_hangup_by,
         latest_note.id                       AS last_note_id,
         latest_note.sugar_confirmation       AS last_note_sugar_confirmation,
         latest_note.confirmed_range          AS last_note_confirmed_range,
         latest_note.range_for                AS last_note_range_for,
         latest_note.patient_age              AS last_note_patient_age,
         latest_note.diet_status              AS last_note_diet_status,
         latest_note.takes_medicine           AS last_note_takes_medicine,
         latest_note.note                     AS last_note_text,
         latest_note.hba1c                    AS last_note_hba1c,
         latest_note.other_languages          AS last_note_other_languages,
         latest_note.working_professional     AS last_note_working_professional,
         latest_note.location                 AS last_note_location,
         latest_note.already_paid             AS last_note_already_paid,
         latest_note.webinar_attended         AS last_note_webinar_attended,
         latest_note.available_for_webinar    AS last_note_available_for_webinar,
         latest_note.next_batch_joining       AS last_note_next_batch_joining,
         latest_note.interested               AS last_note_interested_in_note,
         latest_note.follow_up_at             AS last_note_follow_up_at`;

/* Meta LEAD_SELECT — byte-identical to the original inline constant. */
const META_LEAD_SELECT = `
  SELECT l.id, l.full_name, l.whatsapp_number, l.email, l.sugar_level, l.diabetes_duration,
         l.language_pref, l.lead_score, l.wa_clicked, l.webinar_id, l.source,
         l.assigned_user_id, l.assigned_at, l.created_at,
         l.last_note_outcome, l.last_note_at, l.follow_up_at, l.completed_at,
         l.last_note_interested, l.last_note_outcome_subtag, l.lead_tag,
         l.next_batch_parked, l.next_batch_parked_at,
         w.name AS webinar_name,${LATERAL_PROJECTION}
    FROM leads l
    LEFT JOIN webinars w ON w.id = l.webinar_id
    ${latestCallLateral('calls')}
    ${latestNoteLateral('lead_call_notes')}
`;

/* NSM LEAD_SELECT — same output columns, sourced from nsm_leads. The derived
   table provides the Meta-only columns the WHERE/ORDER clauses reference
   (webinar_id → NULL so every NSM lead stays in Assigned; created_at ←
   created_time) and filters soft-deleted rows up front. Funnel-only display
   fields are NULL; phone maps to whatsapp_number; batch name to webinar_name. */
const NSM_LEAD_SELECT = `
  SELECT l.id, l.full_name, l.phone AS whatsapp_number, l.email,
         NULL::text AS sugar_level, NULL::text AS diabetes_duration,
         NULL::text AS language_pref, NULL::int AS lead_score, FALSE AS wa_clicked,
         l.webinar_id, 'nsm'::text AS source,
         l.assigned_user_id, l.assigned_at, l.created_at,
         l.last_note_outcome, l.last_note_at, l.follow_up_at, l.completed_at,
         l.last_note_interested, l.last_note_outcome_subtag, l.lead_tag,
         l.next_batch_parked, l.next_batch_parked_at,
         b.batch_name AS webinar_name,${LATERAL_PROJECTION}
    FROM (
      SELECT nl.*, NULL::uuid AS webinar_id, nl.created_time AS created_at
        FROM nsm_leads nl
       WHERE nl.deleted_at IS NULL
    ) l
    LEFT JOIN nsm_batches b ON b.id = l.batch_id
    ${latestCallLateral('nsm_calls')}
    ${latestNoteLateral('nsm_lead_call_notes')}
`;

const CONFIGS = {
  meta: {
    workspace: 'meta',
    users:    'crm_users',
    leads:    'leads',
    calls:    'calls',
    notes:    'lead_call_notes',
    activity: 'caller_activity_events',
    timer:    'timer_settings',
    leadSelect:     META_LEAD_SELECT,
    recentWebinars: RECENT_WEBINARS,
    // Missed-inbound lead-join column expressions (Meta has these columns).
    leadPhoneExpr: 'l.whatsapp_number',
    leadSugarExpr: 'l.sugar_level',
    // Bare lead-phone column name (no alias prefix) for the dial lookup.
    leadPhoneCol: 'whatsapp_number',
  },
  nsm: {
    workspace: 'nsm',
    users:    'nsm_users',
    leads:    'nsm_leads',
    calls:    'nsm_calls',
    notes:    'nsm_lead_call_notes',
    activity: 'nsm_caller_activity_events',
    timer:    'nsm_timer_settings',
    leadSelect:     NSM_LEAD_SELECT,
    recentWebinars: RECENT_WEBINARS,
    leadPhoneExpr: 'l.phone',
    leadSugarExpr: 'NULL::text',
    leadPhoneCol: 'phone',
  },
};

function workspaceConfig(workspace) {
  return CONFIGS[workspace] || CONFIGS.meta;
}

module.exports = { workspaceConfig };
