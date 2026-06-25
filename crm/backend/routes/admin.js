const express  = require('express');
const { body, validationResult } = require('express-validator');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const router   = express.Router();
const pool     = require('../db');
const { adminAuth }                = require('../middleware/adminAuth');
const jwtUtil                      = require('../utils/jwt');
const { getPassword, writeConfig } = require('../utils/adminConfig');
const cache = require('../utils/webinarConfigCache');
const { broadcast } = require('../utils/sseClients');
const callerSse = require('../utils/callerSse');
const activityLogger = require('../utils/activityLogger');
const { syncLeadsToSheet } = require('../utils/leadsSheetSync');
const tata = require('../utils/tataClient');
const { rotateLink }       = require('../utils/linkRotation');
const { mirrorActiveLink } = require('../utils/whapiLinkRotation');
const { nextWebinarName, nextUpcomingWebinarName } = require('../utils/webinarName');
const {
  fetchLandingViewsByDay,
  fetchLandingViewsByDayFiltered,
  attributeViewsToWebinars,
  metaConfigured,
  fetchAllCampaigns,
  fetchAllPromotePages,
  fetchAllLeadgenForms,
  fetchFormLeads,
  clearMetaCache,
} = require('../utils/metaInsights');

router.use(adminAuth);

/* POST /api/admin/callers/:callerId/preview-token
   Mints a short-lived, READ-ONLY caller JWT (preview:true) for the given
   caller so an admin can render that caller's exact pages (Assigned /
   Untouched / Completed / Not Picked / Missed Calls / Next Batch) inside the
   New-Page "Move Leads" drawer. The token authenticates as the caller for
   GET reads only — the caller router rejects every write/telephony call made
   with a preview token (see routes/caller.js). It carries the same identity
   claims a real login would (so /api/caller queries scope correctly), plus
   preview:true. */
router.post('/callers/:callerId/preview-token', async (req, res) => {
  const { callerId } = req.params;
  if (!callerId) return res.status(400).json({ error: 'callerId required' });
  // writable=true mints a FULL caller token (preview:false) so the admin can
  // edit the caller's leads (save notes / change outcome) from the preview. The
  // frontend still passes previewMode to suppress calls / heartbeat / activity
  // logging, so impersonating to edit never places paid calls or pollutes the
  // caller's activity log — only the deliberate note/outcome saves go through.
  const writable = req.query.writable === 'true' || req.body?.writable === true;
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, role, department, workspace, is_active
         FROM crm_users WHERE id = $1`,
      [callerId]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'caller_not_found' });
    const token = jwtUtil.sign({
      user_id:    u.id,
      role:       u.role,
      full_name:  u.full_name,
      department: u.department || null,
      // Scope reads to the caller's own workspace tables, mirroring login.
      workspace:  u.workspace || 'meta',
      preview:    !writable,
    });
    res.json({ token, writable, caller: { id: u.id, full_name: u.full_name, role: u.role } });
  } catch (err) {
    console.error('preview-token error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

const ALLOWED_SOURCES = new Set(['meta', 'yt', 'meta2', 'metatemp', 'tagmango']);
function getSource(req) {
  const v = req.query.source ?? req.body?.source;
  return ALLOWED_SOURCES.has(v) ? v : 'meta';
}

/* Like getSource but also accepts 'all' — used ONLY by the read-only
   data/report endpoints behind the Web Reminder dashboard so the workspace
   filter can aggregate across meta+yt+meta2. Queries that use this must guard
   their source/workspace conditions with `($N = 'all' OR <existing>)` so a
   concrete source behaves exactly as before. Config/write endpoints keep
   using getSource (where 'all' safely falls back to 'meta'). */
function getReportSource(req) {
  const v = req.query.source ?? req.body?.source;
  return (ALLOWED_SOURCES.has(v) || v === 'all') ? v : 'meta';
}

/* Top-2 recent webinars per source — the same window the caller-side
   Assigned / Untouched pages use to bucket leads. Inlined as a SQL
   sub-query so the sales-performance CTEs can reference it without a
   cross-file import. Mirrors routes/caller.js RECENT_WEBINARS. */
const RECENT_WEBINARS_SQL = `(
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

/* ── GET /api/admin/leads ── */
router.get('/leads', async (req, res) => {
  const source = getReportSource(req);   // allows 'all' (aggregate workspaces)
  // TL scope: only leads currently assigned to a caller on this TL's team.
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  const params = [source];
  let scopeSQL = '';
  if (tl) {
    params.push(req.adminUser.id);
    scopeSQL = `AND l.assigned_user_id IN (SELECT id FROM crm_users WHERE team_leader_id = $${params.length})`;
  }
  try {
    const { rows } = await pool.query(`
      SELECT l.*,
             u.full_name AS assigned_to_name,
             u.role      AS assigned_to_role
        FROM leads l
        LEFT JOIN crm_users u ON u.id = l.assigned_user_id
       WHERE ($1 = 'all' OR l.source = $1)
         AND COALESCE(l.is_duplicate, FALSE) = FALSE   -- quarantined dupes live on the Duplicates page
         ${scopeSQL}
       ORDER BY l.created_at DESC
    `, params);
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    // assigned_user_id column may be missing on a stale schema — fallback
    if (err.message && err.message.includes('column')) {
      try {
        // Stale-schema fallback can't TL-scope (no assigned_user_id column);
        // simplest correct behaviour is to return empty for TLs in that
        // case rather than leaking unscoped rows.
        if (tl) return res.json({ leads: [], total: 0 });
        const { rows } = await pool.query("SELECT * FROM leads WHERE ($1 = 'all' OR source = $1) AND COALESCE(is_duplicate, FALSE) = FALSE ORDER BY created_at DESC", [source]);
        return res.json({ leads: rows, total: rows.length });
      } catch (_) { /* fallthrough */ }
    }
    console.error('Fetch leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

/* ── GET /api/admin/duplicate-leads ──
   The quarantined duplicate leads (is_duplicate=TRUE) for the floating
   Duplicates page. These never appear in the Leads list and are never assigned
   to a caller — but nothing is deleted, so they can be inspected here. Each row
   carries the "kept" original (same phone + webinar) so the admin can see who
   the lead duplicates. */
router.get('/duplicate-leads', async (req, res) => {
  const source = getReportSource(req);
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  if (tl) return res.json({ leads: [], total: 0 });   // TL scope: dupes are admin/manager only
  try {
    const { rows } = await pool.query(`
      SELECT d.*,
             orig.id          AS original_lead_id,
             orig.full_name   AS original_name,
             ou.full_name     AS original_assigned_to
        FROM leads d
        LEFT JOIN LATERAL (
          SELECT e.id, e.full_name, e.assigned_user_id
            FROM leads e
           WHERE e.id <> d.id
             AND e.webinar_id = d.webinar_id
             AND RIGHT(regexp_replace(COALESCE(e.whatsapp_number,''),'[^0-9]','','g'),10)
               = RIGHT(regexp_replace(COALESCE(d.whatsapp_number,''),'[^0-9]','','g'),10)
           ORDER BY (e.assigned_user_id IS NOT NULL) DESC, e.created_at ASC
           LIMIT 1
        ) orig ON TRUE
        LEFT JOIN crm_users ou ON ou.id = orig.assigned_user_id
       WHERE COALESCE(d.is_duplicate, FALSE) = TRUE
         AND ($1 = 'all' OR d.source = $1)
       ORDER BY d.created_at DESC
    `, [source]);
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('Fetch duplicate-leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch duplicate leads' });
  }
});

/* ── POST /api/admin/duplicate-leads/delete ──
   Permanently delete ONLY the quarantined duplicate leads (is_duplicate=TRUE)
   for this workspace — the action behind the Delete button inside the floating
   Duplicates page. Scoped to is_duplicate so it can never touch a real lead in
   the main pipeline, and never the "kept" original. No id list is sent (avoids
   the request-size limit), so it works no matter how many duplicates there are. */
router.post('/duplicate-leads/delete', async (req, res) => {
  const source = getReportSource(req);
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  if (tl) return res.status(403).json({ error: 'Only an admin/manager can delete duplicates.' });
  try {
    const result = await pool.query(
      `DELETE FROM leads
        WHERE COALESCE(is_duplicate, FALSE) = TRUE
          AND ($1 = 'all' OR source = $1)`,
      [source]
    );
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('Delete duplicate-leads error:', err.message);
    res.status(500).json({ error: 'Failed to delete duplicate leads.' });
  }
});

/* ── GET /api/admin/completed-calls ──
   Powers the Sales → Completed Calls tab. Returns every lead whose
   latest call note has outcome = 'completed' or 'not_interested', joined
   with:
     • the most recent lead_call_notes row (so the caller's answers to
       every form question are returned as last_note_* columns)
     • the most recent calls row that holds a recording_url (so the
       admin can play it back via /api/caller/recordings/:id?token=ADMIN)
     • crm_users (so we can label which caller handled the lead).

   Limit defaults to 500 to keep the payload reasonable; the caller can
   pass ?limit=N to override (capped at 2000). */
router.get('/completed-calls', async (req, res) => {
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
  // TL scope: only leads handled by a caller on this TL's team. We push
  // the filter into the WHERE clause rather than mutating the SELECT
  // shape so the frontend response contract stays identical for every
  // role. Manager scope is currently NOT applied here (the existing
  // super-admin behaviour) — left untouched to avoid changing manager
  // semantics in this pass.
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  const source = getReportSource(req);            // workspace filter ('all' = every source)
  const params = [limit, source];                 // $1 = limit, $2 = source
  let scopeSQL = `AND ($2 = 'all' OR l.source = $2)`;
  if (tl) {
    params.push(req.adminUser.id);
    scopeSQL += ` AND l.assigned_user_id IN (SELECT id FROM crm_users WHERE id = $${params.length} OR team_leader_id = $${params.length})`;
  }
  try {
    const { rows } = await pool.query(`
      SELECT l.id, l.full_name, l.whatsapp_number, l.email, l.source,
             l.sugar_level, l.diabetes_duration, l.language_pref,
             l.lead_score, l.lead_tag,
             l.last_note_outcome, l.last_note_at, l.completed_at,
             l.last_note_interested, l.last_note_outcome_subtag,
             l.created_at,
             w.name AS webinar_name,
             u.id   AS caller_id,
             u.full_name AS caller_name,
             u.role      AS caller_role,
             latest_note.confirmed_range          AS last_note_confirmed_range,
             latest_note.range_for                AS last_note_range_for,
             latest_note.patient_age              AS last_note_patient_age,
             latest_note.takes_medicine           AS last_note_takes_medicine,
             latest_note.hba1c                    AS last_note_hba1c,
             latest_note.working_professional     AS last_note_working_professional,
             latest_note.location                 AS last_note_location,
             latest_note.webinar_attended         AS last_note_webinar_attended,
             latest_note.available_for_webinar    AS last_note_available_for_webinar,
             latest_note.next_batch_joining       AS last_note_next_batch_joining,
             latest_note.note                     AS last_note_text,
             latest_note.follow_up_at             AS last_note_follow_up_at,
             latest_call.id                       AS last_call_id,
             latest_call.duration_sec             AS last_call_duration,
             latest_call.recording_url            AS last_call_recording_url,
             latest_call.started_at               AS last_call_started_at
        FROM leads l
        LEFT JOIN webinars w  ON w.id = l.webinar_id
        LEFT JOIN crm_users u ON u.id = l.assigned_user_id
        LEFT JOIN LATERAL (
          SELECT id, confirmed_range, range_for, patient_age, takes_medicine,
                 hba1c, working_professional, location, webinar_attended,
                 available_for_webinar, next_batch_joining, note, follow_up_at
            FROM lead_call_notes n
           WHERE n.lead_id = l.id
           ORDER BY n.created_at DESC
           LIMIT 1
        ) latest_note ON TRUE
        LEFT JOIN LATERAL (
          SELECT id, duration_sec, recording_url, started_at
            FROM calls c
           WHERE c.lead_id = l.id
             AND c.recording_url IS NOT NULL
           ORDER BY c.started_at DESC
           LIMIT 1
        ) latest_call ON TRUE
       WHERE l.last_note_outcome IN ('completed', 'not_interested', 'incomplete')
         ${scopeSQL}
       ORDER BY l.last_note_at DESC NULLS LAST
       LIMIT $1
    `, params);
    res.json({ leads: rows, total: rows.length });
  } catch (err) {
    console.error('admin/completed-calls error:', err.message);
    res.status(500).json({ error: 'Failed to fetch completed calls.' });
  }
});

/* ── PUT /api/admin/webinar-config ── */
const configValidators = [
  body('next_webinar_at').optional().isISO8601(),
  body('backup_webinar_at').optional().isISO8601(),
  body('current_webinar_date').optional({ nullable: true }).isISO8601(),
  body('next_webinar_date').optional({ nullable: true }).isISO8601(),
  body('tuesday_whatsapp_link').optional().isString(),
  body('friday_whatsapp_link').optional().isString(),
  body('kill_switch').optional().isBoolean(),
  body('pending_whatsapp_link').optional().isString(),
  body('whatsapp_link_swap_at').optional({ nullable: true }).isISO8601(),
  body('pending_whatsapp_link_2').optional().isString(),
  body('whatsapp_link_swap_at_2').optional({ nullable: true }).isISO8601(),
  body('current_webinar_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('next_webinar_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
];

router.put('/webinar-config', configValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: 'validation_failed', fields: errors.array() });
  }

  const source = getSource(req);

  const allowed = ['next_webinar_at', 'backup_webinar_at', 'current_webinar_date', 'next_webinar_date', 'tuesday_whatsapp_link', 'friday_whatsapp_link', 'kill_switch', 'pending_whatsapp_link', 'whatsapp_link_swap_at', 'pending_whatsapp_link_2', 'whatsapp_link_swap_at_2', 'current_form_id', 'next_form_id', 'permanent_whatsapp_link', 'current_webinar_datetime', 'current_webinar_link', 'next_webinar_datetime', 'next_webinar_link'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // Custom webinar display names live on the webinars table (not webinar_config),
  // so they're applied separately from the `allowed` config fields. They can be
  // saved on their own — e.g. the inline pencil-rename sends just a name.
  const currentWebinarName = req.body.current_webinar_name;
  const nextWebinarName    = req.body.next_webinar_name;
  const hasNameUpdate = currentWebinarName !== undefined || nextWebinarName !== undefined;

  if (Object.keys(updates).length === 0 && !hasNameUpdate) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.updated_at = new Date().toISOString();

  // Build dynamic SET clause: SET col1=$1, col2=$2 ...
  const keys = Object.keys(updates);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => updates[k]);

  try {
    // Snapshot the previous next_webinar_at BEFORE we apply the update so we
    // can tell whether the caller actually started a NEW batch (cutover moved
    // forward in time) — that's the trigger that promotes parked Next-Batch
    // leads back to their callers' Assigned queue as follow-ups.
    let prevNextWebinarAt = null;
    if (updates.next_webinar_at !== undefined) {
      const { rows: prev } = await pool.query(
        'SELECT next_webinar_at FROM webinar_config WHERE source = $1',
        [source]
      );
      prevNextWebinarAt = prev[0]?.next_webinar_at || null;
    }

    values.push(source);
    await pool.query(
      `UPDATE webinar_config SET ${setClause} WHERE source = $${values.length}`,
      values
    );
    cache.invalidate(source);

    // Fetch fresh config and push to all connected clients (this source) immediately
    const { rows } = await pool.query(
      'SELECT next_webinar_at, backup_webinar_at, tuesday_whatsapp_link, friday_whatsapp_link, kill_switch, pending_whatsapp_link, whatsapp_link_swap_at, pending_whatsapp_link_2, whatsapp_link_swap_at_2, current_webinar_date, next_webinar_date FROM webinar_config WHERE source = $1',
      [source]
    );
    if (rows.length > 0) {
      const fresh = { ...rows[0] };
      cache.set(fresh, source);
      broadcast(fresh, source);
      // Cross-service: post-split, funnel-meta and funnel-yt run in different
      // processes than this CRM admin route, so the in-process broadcast above
      // only reaches admin SPA clients connected to THIS service. The funnels
      // receive the same payload via pg_notify -> their LISTEN handler.
      pool.query(`SELECT pg_notify('webinar.config.updated', $1)`, [source])
        .catch(e => console.error('[admin] webinar.config.updated notify error:', e.message));
    }

    // Promote parked "Next Batch" leads when the caller schedules a fresh
    // batch — i.e. next_webinar_at changed AND the new value is strictly
    // later than the previous value (a true "new batch" cutover, not just a
    // minor edit / earlier reschedule). Each promoted lead becomes a
    // follow-up due NOW so it sits at the top of its original caller's
    // Assigned page. SSE pushes the row so the caller's tab refreshes live.
    if (updates.next_webinar_at !== undefined) {
      const newAt = new Date(updates.next_webinar_at);
      const prevAt = prevNextWebinarAt ? new Date(prevNextWebinarAt) : null;
      const isNewBatch = !prevAt || newAt.getTime() > prevAt.getTime();
      if (isNewBatch) {
        try {
          const { rows: promoted } = await pool.query(
            `UPDATE leads
                SET next_batch_parked     = FALSE,
                    next_batch_parked_at  = NULL,
                    last_note_outcome     = 'follow_up',
                    follow_up_at          = NOW(),
                    last_note_at          = NOW()
              WHERE next_batch_parked = TRUE
              RETURNING id, assigned_user_id`
          );
          for (const r of promoted) {
            if (r.assigned_user_id) {
              callerSse.pushTo(r.assigned_user_id, {
                type: 'lead.assigned',
                lead: { id: r.id, promoted_from: 'next_batch' },
              });
            }
          }
          if (promoted.length > 0) {
            console.log(`[admin] Next-Batch promoted ${promoted.length} leads on new-batch cutover (source=${source})`);
          }
        } catch (promoteErr) {
          console.error('[admin] Next-Batch promote error:', promoteErr.message);
        }
      }
    }

    // Sync webinar sessions for this source — UPDATE existing row, only INSERT if none exists
    let webinarWarning = null;
    if (updates.next_webinar_at) {
      try {
        const { rowCount } = await pool.query(
          'UPDATE webinars SET date_time = $1 WHERE is_active = TRUE AND source = $2',
          [updates.next_webinar_at, source]
        );
        if (rowCount === 0) {
          const name = await nextWebinarName(source);
          await pool.query(
            'INSERT INTO webinars (date_time, is_active, name, source) VALUES ($1, TRUE, $2, $3)',
            [updates.next_webinar_at, name, source]
          );
          console.log(`[admin] Created active ${source} webinar: ${name}`);
        }
      } catch (webinarErr) {
        webinarWarning = `active webinar: ${webinarErr.message}${webinarErr.code ? ` [${webinarErr.code}]` : ''}`;
        console.error(`[admin] ${source} active webinar update error:`, webinarErr.message, webinarErr.code, webinarErr.detail);
      }
    }

    if (updates.backup_webinar_at) {
      try {
        // Reuse an existing "upcoming" webinar for this source (inactive, 0 leads)
        // and just bump its date.
        const { rowCount } = await pool.query(
          `UPDATE webinars SET date_time = $1
           WHERE id = (
             SELECT w.id FROM webinars w
             LEFT JOIN leads l ON l.webinar_id = w.id
             WHERE w.is_active = FALSE AND w.source = $2
             GROUP BY w.id
             HAVING COUNT(l.id) = 0
             ORDER BY w.created_at DESC LIMIT 1
           )`,
          [updates.backup_webinar_at, source]
        );

        if (rowCount === 0) {
          const name = await nextUpcomingWebinarName(source);
          await pool.query(
            'INSERT INTO webinars (date_time, is_active, name, source) VALUES ($1, FALSE, $2, $3)',
            [updates.backup_webinar_at, name, source]
          );
          console.log(`[admin] Created upcoming ${source} webinar: ${name}`);
        }
      } catch (webinarErr) {
        webinarWarning = (webinarWarning ? webinarWarning + '; ' : '') +
          `upcoming webinar: ${webinarErr.message}${webinarErr.code ? ` [${webinarErr.code}]` : ''}`;
        console.error(`[admin] ${source} upcoming webinar update error:`, webinarErr.message, webinarErr.code, webinarErr.detail);
      }
    }

    // ── Apply custom display names (independent of date changes) ──
    // Runs AFTER the webinars date-sync above, so a just-created row exists and
    // its auto-generated name gets overridden with the custom one. An empty
    // string clears the name → the card falls back to the date label.
    if (currentWebinarName !== undefined) {
      try {
        const { rowCount } = await pool.query(
          'UPDATE webinars SET name = $1 WHERE is_active = TRUE AND source = $2',
          [currentWebinarName.trim() || null, source]
        );
        // No active webinar to name (e.g. right after an end-of-webinar rollover
        // blanked the card) — CREATE a fresh active one so the admin can start a
        // new webinar by just typing a name. Date comes from the Start Date
        // (next_webinar_at, always set).
        if (rowCount === 0 && currentWebinarName.trim()) {
          const { rows: cfgRow } = await pool.query(
            'SELECT next_webinar_at FROM webinar_config WHERE source = $1', [source]);
          const dt = cfgRow[0]?.next_webinar_at || new Date();
          await pool.query(
            'INSERT INTO webinars (date_time, is_active, name, source) VALUES ($1, TRUE, $2, $3)',
            [dt, currentWebinarName.trim(), source]
          );
          console.log(`[admin] Created active ${source} webinar from name: ${currentWebinarName.trim()}`);
        }
      } catch (nameErr) {
        webinarWarning = (webinarWarning ? webinarWarning + '; ' : '') + `current name: ${nameErr.message}`;
        console.error(`[admin] ${source} current webinar name error:`, nameErr.message);
      }
    }
    if (nextWebinarName !== undefined) {
      try {
        // Target the same upcoming row the backup_webinar_at date-sync touches.
        await pool.query(
          `UPDATE webinars SET name = $1
           WHERE id = (
             SELECT w.id FROM webinars w
             LEFT JOIN leads l ON l.webinar_id = w.id
             WHERE w.is_active = FALSE AND w.source = $2
             GROUP BY w.id
             HAVING COUNT(l.id) = 0
             ORDER BY w.created_at DESC LIMIT 1
           )`,
          [nextWebinarName.trim() || null, source]
        );
      } catch (nameErr) {
        webinarWarning = (webinarWarning ? webinarWarning + '; ' : '') + `next name: ${nameErr.message}`;
        console.error(`[admin] ${source} next webinar name error:`, nameErr.message);
      }
    }

    // Adopt orphaned leads: any lead of this source with NO webinar (e.g. created
    // during a window where the webinar card was blanked and no active webinar
    // existed) gets attached to the current active webinar. Stops leads from
    // silently disappearing under the current-webinar filter.
    try {
      await pool.query(
        `UPDATE leads
            SET webinar_id = (SELECT id FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1)
          WHERE source = $1
            AND webinar_id IS NULL
            AND EXISTS (SELECT 1 FROM webinars WHERE is_active = TRUE AND source = $1)`,
        [source]
      );
    } catch (adoptErr) {
      console.error(`[admin] ${source} orphan-lead adopt error:`, adoptErr.message);
    }

    res.json({ success: true, updated_at: updates.updated_at, webinarWarning });
  } catch (err) {
    console.error('Update config error:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

/* ── GET /api/admin/timer-settings ──
   Returns the merged timer settings (stored values clamped over defaults). */
router.get('/timer-settings', async (req, res) => {
  try {
    const { mergeTimerSettings } = require('../utils/timerDefaults');
    const { rows } = await pool.query('SELECT settings FROM timer_settings WHERE id = 1');
    res.json({ settings: mergeTimerSettings(rows[0]?.settings || {}) });
  } catch (err) {
    console.error('Get timer-settings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch timer settings' });
  }
});

/* ── PUT /api/admin/timer-settings ──
   Clamps every value to BOUNDS, persists, restarts backend schedulers live,
   and broadcasts the change to every connected caller browser via SSE. */
router.put('/timer-settings', async (req, res) => {
  // Timer settings are global / department-level configuration. TLs see
  // them read-only in the UI; defense-in-depth: reject the PUT too.
  if (req.adminUser && req.adminUser.kind === 'tl') {
    return res.status(403).json({ error: 'Team leaders cannot modify timer settings.' });
  }
  try {
    const { mergeTimerSettings } = require('../utils/timerDefaults');
    const merged = mergeTimerSettings(req.body && req.body.settings);
    await pool.query(
      'UPDATE timer_settings SET settings = $1::jsonb, updated_at = NOW() WHERE id = 1',
      [JSON.stringify(merged)]
    );
    require('../utils/schedulerManager').applyTimerSettings(merged);
    callerSse.broadcastAll({ type: 'timer.settings.updated', settings: merged });
    res.json({ settings: merged });
  } catch (err) {
    console.error('Update timer-settings error:', err.message);
    res.status(500).json({ error: 'Failed to update timer settings' });
  }
});

/* ── GET /api/admin/webinars ── */
router.get('/webinars', async (req, res) => {
  const source = getReportSource(req);   // allows 'all' (aggregate workspaces)
  try {
    const { rows } = await pool.query(`
      SELECT
        w.id,
        w.date_time AS webinar_at,
        w.is_active,
        w.created_at,
        w.name,
        COUNT(l.id)::int AS lead_count
      FROM webinars w
      LEFT JOIN leads l ON l.webinar_id = w.id
      WHERE ($1 = 'all' OR w.source = $1)
      GROUP BY w.id
      ORDER BY w.created_at DESC
    `, [source]);
    res.json({ webinars: rows });
  } catch (err) {
    // webinar_id column or webinars table may not exist yet (async migration race)
    if (err.message && (err.message.includes('does not exist') || err.message.includes('column'))) {
      try {
        const { rows } = await pool.query(
          `SELECT id, date_time AS webinar_at, is_active, created_at, name, 0::int AS lead_count
           FROM webinars WHERE ($1 = 'all' OR source = $1) ORDER BY created_at DESC`,
          [source]
        );
        return res.json({ webinars: rows });
      } catch (_) {
        return res.json({ webinars: [] });
      }
    }
    console.error('Get webinars error:', err.message);
    res.status(500).json({ error: 'Failed to fetch webinars' });
  }
});

/* ── POST /api/admin/leads/import ──
   Bulk-insert leads uploaded from a CSV/Excel sheet (Meta Temp "Add Leads").
   Body: { source, leads: [{ full_name, whatsapp_number, email, sugar_level,
   diabetes_duration, utm_source }] }. Server-side guards:
     • require full_name + a 10-digit whatsapp_number
     • skip rows whose phone already exists for this source (current batch dup)
     • skip rows duplicated within the uploaded batch itself
   Returns { inserted, skipped_duplicates, skipped_invalid }. */
function importLeadScore(sugarLevel, duration) {
  if (duration === 'pre') return 2;
  const sugarScore = sugarLevel === '250+' ? 3 : 2;
  const durationBonus = { long: 2, mid: 1, new: 0 }[duration] ?? 0;
  return Math.min(5, sugarScore + durationBonus);
}
router.post('/leads/import', async (req, res) => {
  const source = getSource(req);
  const rowsIn = Array.isArray(req.body?.leads) ? req.body.leads : [];
  if (!rowsIn.length) return res.status(400).json({ error: 'No leads provided' });

  try {
    // Existing phones for this source = the "current batch" to dedup against.
    const { rows: existing } = await pool.query(
      'SELECT whatsapp_number FROM leads WHERE source = $1',
      [source]
    );
    const seen = new Set(existing.map(r => String(r.whatsapp_number || '').trim()));

    // Active webinar for this source (so imported leads attach to it like a
    // real registration would).
    let webinar_id = null;
    try {
      const { rows: wRows } = await pool.query(
        'SELECT id FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1',
        [source]
      );
      webinar_id = wRows[0]?.id ?? null;
    } catch { /* webinars table optional */ }

    let inserted = 0, skipped_duplicates = 0, skipped_invalid = 0;
    for (const r of rowsIn) {
      const full_name = String(r.full_name || '').trim();
      const phone     = String(r.whatsapp_number || '').replace(/\D/g, '').slice(-10);
      if (full_name.length < 1 || !/^\d{10}$/.test(phone)) { skipped_invalid++; continue; }
      if (seen.has(phone)) { skipped_duplicates++; continue; }
      seen.add(phone); // dedup within the uploaded batch too

      const email             = r.email ? String(r.email).trim() : null;
      const sugar_level       = ['150-250', '250+'].includes(r.sugar_level) ? r.sugar_level : null;
      const diabetes_duration = ['new', 'mid', 'long', 'pre'].includes(r.diabetes_duration) ? r.diabetes_duration : null;
      const utm_source        = r.utm_source ? String(r.utm_source).trim().slice(0, 120) : null;
      const lead_score        = importLeadScore(sugar_level, diabetes_duration);

      await pool.query(
        `INSERT INTO leads
           (full_name, whatsapp_number, email, sugar_level, diabetes_duration,
            lead_score, utm_source, webinar_id, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [full_name, phone, email, sugar_level, diabetes_duration, lead_score, utm_source, webinar_id, source]
      );
      inserted++;
    }
    res.json({ success: true, inserted, skipped_duplicates, skipped_invalid });
  } catch (err) {
    console.error('Leads import error:', err.message);
    res.status(500).json({ error: 'Failed to import leads' });
  }
});

/* ── POST /api/admin/leads/fetch-meta ──
   Pulls lead-gen leads from Meta for the given forms within [since, until]
   and inserts them into the leads table for this workspace. Each Meta lead's
   variable answers are stored verbatim in leads.field_data (JSONB) so the
   Leads page can render columns dynamically; name / phone / email are also
   mapped into the standard columns so the existing caller-assignment flow
   keeps working. Dedup is by Meta's leadgen id (meta_lead_id).
   Body: { source, form_ids: string[], since?: ISO, until?: ISO }.
   Returns { inserted, skipped_duplicates, forms_processed, errors }. */
const META_NAME_KEYS  = ['full_name', 'name', 'your_name', 'full name'];
const META_PHONE_KEYS = ['phone_number', 'phone', 'mobile_number', 'mobile', 'whatsapp_number', 'contact_number'];
const META_EMAIL_KEYS = ['email', 'email_address', 'e-mail'];
const toUnix = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
/* field_data → { lowercased_name: "joined, values" } */
function flattenFieldData(fd) {
  const out = {};
  for (const f of (Array.isArray(fd) ? fd : [])) {
    if (!f || !f.name) continue;
    out[String(f.name).toLowerCase()] = (Array.isArray(f.values) ? f.values : [f.values]).filter(v => v != null).join(', ');
  }
  return out;
}
/* Space/underscore-insensitive lookup so a Meta field named "phone number"
   (space) matches the 'phone_number' key — otherwise the phone is empty and
   every such lead collides on the empty-string dedup. */
const normKey = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '');
const pickKey = (map, keys) => {
  const nmap = {};
  for (const k in map) nmap[normKey(k)] = map[k];
  for (const k of keys) { const v = nmap[normKey(k)]; if (v) return v; }
  return '';
};

router.post('/leads/fetch-meta', async (req, res) => {
  const source = getSource(req);
  const formIds = (Array.isArray(req.body?.form_ids) ? req.body.form_ids : []).map(String).filter(Boolean);
  if (!formIds.length) return res.status(400).json({ error: 'No forms selected' });
  if (!metaConfigured()) return res.status(400).json({ error: 'Meta is not configured on the server' });

  const sinceUnix = req.body?.since ? toUnix(req.body.since) : null;
  const untilUnix = req.body?.until ? toUnix(req.body.until) : null;

  try {
    // Active webinar for this source, so imported leads attach to it (and the
    // lead.created assigner has a webinarId to scope round-robin to).
    let webinar_id = null;
    try {
      const { rows: wRows } = await pool.query(
        'SELECT id FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1', [source]);
      webinar_id = wRows[0]?.id ?? null;
    } catch { /* webinars table optional */ }

    // Dedup set: Meta leadgen ids already imported for this source.
    const { rows: seenRows } = await pool.query(
      'SELECT meta_lead_id FROM leads WHERE source = $1 AND meta_lead_id IS NOT NULL', [source]);
    const seen = new Set(seenRows.map(r => String(r.meta_lead_id)));

    let inserted = 0, skipped_duplicates = 0;
    const errors = [];
    const newLeadIds = [];

    for (const formId of formIds) {
      const { leads: metaLeads, error } = await fetchFormLeads(formId, sinceUnix, untilUnix);
      if (error) errors.push({ form_id: formId, error: String(error).slice(0, 160) });
      for (const ml of (metaLeads || [])) {
        const metaLeadId = String(ml.id || '');
        if (!metaLeadId || seen.has(metaLeadId)) { skipped_duplicates++; continue; }
        seen.add(metaLeadId);

        const map = flattenFieldData(ml.field_data);
        let full_name = pickKey(map, META_NAME_KEYS);
        if (!full_name && (map['first_name'] || map['last_name'])) {
          full_name = [map['first_name'], map['last_name']].filter(Boolean).join(' ').trim();
        }
        const phone = pickKey(map, META_PHONE_KEYS).replace(/\D/g, '').slice(-10);
        const email = pickKey(map, META_EMAIL_KEYS) || null;
        const created_at = ml.created_time ? new Date(ml.created_time) : new Date();

        const { rows } = await pool.query(
          `INSERT INTO leads
             (full_name, whatsapp_number, email, lead_score, webinar_id, source,
              field_data, meta_lead_id, meta_form_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
           RETURNING id`,
          [full_name || '', phone, email, 2, webinar_id, source,
           JSON.stringify(map), metaLeadId, formId, created_at]
        );
        inserted++;
        if (rows[0]?.id) newLeadIds.push(rows[0].id);
      }
    }

    // Feed the caller flow: fire the same notification the funnel fires on a
    // real registration, so the round-robin assigner picks these up. Best
    // effort — the recovery sweep also catches any that slip through.
    if (webinar_id) {
      for (const leadId of newLeadIds) {
        pool.query(`SELECT pg_notify('lead.created', $1)`,
          [JSON.stringify({ leadId, source, sugarLevel: null, webinarId: webinar_id })]
        ).catch(e => console.error('[fetch-meta notify]', e.message));
      }
    }

    res.json({ success: true, inserted, skipped_duplicates, forms_processed: formIds.length, errors });
  } catch (err) {
    console.error('Meta lead fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads from Meta' });
  }
});

/* ── POST /api/admin/leads/delete ── */
router.post('/leads/delete', async (req, res) => {
  // Use getReportSource (accepts 'all') to MATCH the /leads list endpoint. With
  // getSource, 'all' silently became 'meta', so deleting leads while viewing
  // "All workspaces" matched nothing (the selected metatemp/yt/… rows have a
  // different source) and silently deleted 0. The guard keeps a concrete source
  // scoped exactly as before.
  const source = getReportSource(req);
  // Accept ids from body (JSON) or query string as fallback
  const raw = [].concat(req.body?.ids || req.query.ids || []);
  const ids = raw.map(String).filter(s => s.length > 0);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'No valid lead IDs provided.' });
  }
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `DELETE FROM leads WHERE id IN (${placeholders}) AND ($${ids.length + 1} = 'all' OR source = $${ids.length + 1})`,
      [...ids, source]
    );
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('Delete leads error:', err.message);
    res.status(500).json({ error: 'Failed to delete leads.' });
  }
});

/* ── GET /api/admin/settings?source=meta ──
   Returns the per-source admin settings stored on webinar_config (just the
   alert phone number for now). */
router.get('/settings', async (req, res) => {
  const source = getSource(req);
  try {
    const { rows } = await pool.query(
      'SELECT alert_phone_number, alert_phone_numbers, meta_campaign_ids FROM webinar_config WHERE source = $1',
      [source]
    );
    // Multi-recipient migration: if the new array column is empty but the
    // legacy single column has a value, surface that single value as a
    // one-element array so the UI shows the migrated number. Once the admin
    // saves through the new UI, the array column will be populated.
    const arr = Array.isArray(rows[0]?.alert_phone_numbers) ? rows[0].alert_phone_numbers : [];
    const legacy = rows[0]?.alert_phone_number || '';
    const phones = (arr.length === 0 && legacy) ? [legacy] : arr;
    res.json({
      source,
      // Legacy field kept for callers still reading it; equals phones[0] || ''.
      alert_phone_number:  phones[0] || '',
      alert_phone_numbers: phones,
      meta_campaign_ids:   rows[0]?.meta_campaign_ids || [],
    });
  } catch (err) {
    console.error('Get settings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

/* ── PUT /api/admin/settings ──
   Body: { source, alert_phone_number?, meta_campaign_ids? }
   Saves admin preferences for the given source. Only the keys present in
   the body get updated — omit a field to leave it untouched. */
router.put('/settings', async (req, res) => {
  const source = getSource(req);
  const updates = [];
  const params  = [];

  // alert_phone_number (optional, legacy single-value field)
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'alert_phone_number')) {
    let phone = req.body.alert_phone_number;
    if (typeof phone !== 'string') {
      return res.status(422).json({ error: 'alert_phone_number must be a string' });
    }
    phone = phone.replace(/\D/g, '');
    if (phone && !/^\d{10,15}$/.test(phone)) {
      return res.status(422).json({ error: 'alert_phone_number must be 10–15 digits' });
    }
    params.push(phone || null);
    updates.push(`alert_phone_number = $${params.length}`);
  }

  // alert_phone_numbers (optional, multi-recipient array). Each entry is
  // validated to be 10–15 digits. When this field is supplied we also
  // mirror the first entry into the legacy single column so any back-end
  // code that hasn't been migrated yet (e.g. one-off scripts) still works.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'alert_phone_numbers')) {
    const list = req.body.alert_phone_numbers;
    if (!Array.isArray(list)) {
      return res.status(422).json({ error: 'alert_phone_numbers must be an array' });
    }
    const cleaned = [];
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const digits = entry.replace(/\D/g, '');
      if (!digits) continue;
      if (!/^\d{10,15}$/.test(digits)) {
        return res.status(422).json({ error: `phone "${entry}" must be 10–15 digits` });
      }
      if (!cleaned.includes(digits)) cleaned.push(digits);   // de-duplicate
    }
    params.push(JSON.stringify(cleaned));
    updates.push(`alert_phone_numbers = $${params.length}::jsonb`);
    // Mirror first entry into legacy column for back-compat readers.
    params.push(cleaned[0] || null);
    updates.push(`alert_phone_number = $${params.length}`);
  }

  // meta_campaign_ids (optional). Stored as JSONB array of campaign-id strings.
  let campaignFilterTouched = false;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'meta_campaign_ids')) {
    const ids = req.body.meta_campaign_ids;
    if (!Array.isArray(ids)) {
      return res.status(422).json({ error: 'meta_campaign_ids must be an array' });
    }
    const cleaned = ids.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    params.push(JSON.stringify(cleaned));
    updates.push(`meta_campaign_ids = $${params.length}::jsonb`);
    campaignFilterTouched = true;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields supplied' });
  }

  params.push(source);
  try {
    await pool.query(
      `UPDATE webinar_config SET ${updates.join(', ')}, updated_at = NOW() WHERE source = $${params.length}`,
      params
    );
    // If the admin changed the campaign filter, wipe the Meta cache so the
    // very next /meta-insights call hits Facebook fresh — the dashboard
    // reflects the new selection immediately instead of waiting 30 min.
    if (campaignFilterTouched) clearMetaCache();
    const { rows } = await pool.query(
      'SELECT alert_phone_number, alert_phone_numbers, meta_campaign_ids FROM webinar_config WHERE source = $1',
      [source]
    );
    const arr = Array.isArray(rows[0]?.alert_phone_numbers) ? rows[0].alert_phone_numbers : [];
    const legacy = rows[0]?.alert_phone_number || '';
    const phones = (arr.length === 0 && legacy) ? [legacy] : arr;
    res.json({
      success: true,
      alert_phone_number:  phones[0] || '',
      alert_phone_numbers: phones,
      meta_campaign_ids:   rows[0]?.meta_campaign_ids || [],
    });
  } catch (err) {
    console.error('Update settings error:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

/* ── GET /api/admin/daily-target ──
   The single GLOBAL daily call target (one number every caller shares). Drives
   the admin "Daily target" box on the Sales report and the caller-page cup. */
router.get('/daily-target', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT target FROM caller_daily_target WHERE id = 1');
    res.json({ target: rows[0]?.target ?? 0 });
  } catch (err) {
    console.error('Get daily-target error:', err.message);
    res.status(500).json({ error: 'Failed to fetch daily target' });
  }
});

/* ── PUT /api/admin/daily-target   body: { target } ──
   Sets the global daily call target. Clamped to 0–100000. */
router.put('/daily-target', async (req, res) => {
  let target = parseInt(req.body?.target, 10);
  if (!Number.isFinite(target) || target < 0) target = 0;
  target = Math.min(target, 100000);
  try {
    await pool.query('UPDATE caller_daily_target SET target = $1, updated_at = NOW() WHERE id = 1', [target]);
    res.json({ success: true, target });
  } catch (err) {
    console.error('Update daily-target error:', err.message);
    res.status(500).json({ error: 'Failed to save daily target' });
  }
});

/* ── POST /api/admin/settings/test-alert ──
   Triggers an immediate dry-run of the alert scheduler so admin can verify
   the WATI key + phone are wired up. Body: { source }
   Returns BOTH the leads-alert and wa-link-alert decisions for that source. */
router.post('/settings/test-alert', async (req, res) => {
  const source = getSource(req);
  try {
    const { runOnce } = require('../utils/leadsAlertScheduler');
    const result = await runOnce();
    const forSource = result.filter(r => r.source === source);
    res.json({
      ok: true,
      results: forSource,
      // Back-compat: first result keyed under `result` for older callers.
      result: forSource[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/admin/settings/send-test-template ──
   Bypasses all scheduler conditions and fires ONE WATI template to the
   saved phone right now. Used to verify the WATI integration end-to-end.
   Body: { source, template_name?, parameters? }
   - template_name defaults to 'leads_alert'
   - parameters is an optional array of strings passed as the template
     body variables (e.g. ['500'] for the {{1}} variable on wa_link_alert).
   Returns the full WATI response so the admin can see whether WATI
   accepted or rejected the call. */
router.post('/settings/send-test-template', async (req, res) => {
  const source = getSource(req);
  const templateName = (req.body?.template_name || 'leads_alert').trim();
  const parameters = Array.isArray(req.body?.parameters)
    ? req.body.parameters.map(v => String(v))
    : [];

  // Optional override — if the admin types a number in the UI and clicks
  // Test without saving first, the frontend passes that number here so the
  // test goes to what they just typed, not the previously-saved value.
  let overridePhone = null;
  if (typeof req.body?.override_phone === 'string') {
    const digits = req.body.override_phone.replace(/\D/g, '');
    if (digits) {
      if (!/^\d{10,15}$/.test(digits)) {
        return res.status(422).json({ error: 'override_phone must be 10–15 digits' });
      }
      overridePhone = digits;
    }
  }

  try {
    let phone = overridePhone;
    if (!phone) {
      const { rows } = await pool.query(
        'SELECT alert_phone_number FROM webinar_config WHERE source = $1',
        [source]
      );
      phone = rows[0]?.alert_phone_number || null;
    }
    if (!phone) {
      return res.status(422).json({ error: 'No phone supplied. Type a number or save one first.' });
    }
    const wati = require('../utils/watiClient');
    if (!wati.isConfigured()) {
      return res.status(503).json({ error: 'WATI_API_KEY is not set in backend env vars.' });
    }
    const result = await wati.sendTemplate({ phone, templateName, parameters });
    res.json({
      ok:        result.ok,
      phone,
      override:  !!overridePhone,
      template:  templateName,
      parameters,
      status:    result.status,
      urlUsed:   result.urlUsed,
      body:      result.body,
      error:     result.error,
      attempts:  result.attempts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/admin/sync-sheet ── */
router.post('/sync-sheet', async (_req, res) => {
  const result = await syncLeadsToSheet();
  if (result.skipped) {
    return res.status(503).json({ error: 'Google Sheets not configured. Add GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID env vars.' });
  }
  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }
  res.json({ success: true, count: result.count });
});

/* ── PATCH /api/admin/change-password ── */
router.patch('/change-password',
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 6 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ error: 'New password must be at least 6 characters.' });
    }

    const { current_password, new_password } = req.body;
    const expected = getPassword();

    const a = Buffer.alloc(Math.max(current_password.length, expected.length));
    const b = Buffer.alloc(Math.max(current_password.length, expected.length));
    Buffer.from(current_password).copy(a);
    Buffer.from(expected).copy(b);

    if (current_password.length !== expected.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    try {
      writeConfig({ password: new_password });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to save new password.' });
    }
  }
);

/* ── GET /api/admin/wa-links?webinar_id=X ── */
router.get('/wa-links', async (req, res) => {
  const { webinar_id } = req.query;
  const source = getSource(req);
  if (!webinar_id) return res.status(400).json({ error: 'webinar_id required' });

  try {
    // Inner join on webinars enforces the webinar belongs to this source.
    // member_count / member_count_at power the live "N / 950 members" readout
    // and active_index marks the current link for Whapi member-based rotation.
    const { rows } = await pool.query(
      `SELECT wl.id, wl.webinar_id, wl.link_url, wl.order_index,
              wl.member_count, wl.member_count_at,
              w.wa_active_index
         FROM whatsapp_links wl
         JOIN webinars w ON w.id = wl.webinar_id
        WHERE wl.webinar_id = $1 AND w.source = $2
        ORDER BY wl.order_index`,
      [webinar_id, source]
    );
    const activeIndex = rows[0]?.wa_active_index || 1;
    res.json({ links: rows, active_index: activeIndex });
  } catch (err) {
    // Table may not exist yet
    if (err.message && err.message.includes('does not exist')) {
      return res.json({ links: [] });
    }
    console.error('Get WA links error:', err.message);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

/* ── PUT /api/admin/wa-links — save all links for a webinar (upsert) ── */
router.put('/wa-links', async (req, res) => {
  const { webinar_id, links } = req.body;
  const source = getSource(req);
  if (!webinar_id || !Array.isArray(links)) {
    return res.status(400).json({ error: 'webinar_id and links[] required' });
  }

  const client = await pool.connect();
  try {
    // Verify the webinar belongs to this source before touching anything.
    const { rows: wOwn } = await client.query(
      'SELECT is_active FROM webinars WHERE id = $1 AND source = $2',
      [webinar_id, source]
    );
    if (wOwn.length === 0) {
      return res.status(404).json({ error: 'Webinar not found for this source.' });
    }

    await client.query('BEGIN');

    // Snapshot existing member counts so an admin save doesn't reset the live
    // "N / 950 members" readout to 0 for links whose URL is unchanged.
    const { rows: prevLinks } = await client.query(
      'SELECT link_url, member_count, member_count_at, whapi_group_id FROM whatsapp_links WHERE webinar_id = $1',
      [webinar_id]
    );
    const prevByUrl = {};
    for (const p of prevLinks) prevByUrl[(p.link_url || '').trim()] = p;

    // Delete existing links for this webinar
    await client.query('DELETE FROM whatsapp_links WHERE webinar_id = $1', [webinar_id]);

    // Insert new links, carrying over member counts for unchanged URLs.
    let inserted = 0;
    for (const link of links) {
      if (!link.link_url) continue;
      const url  = link.link_url.trim();
      const prev = prevByUrl[url];
      await client.query(
        `INSERT INTO whatsapp_links
           (webinar_id, link_url, order_index, source, member_count, member_count_at, whapi_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [webinar_id, url, link.order_index || 1, source,
         prev?.member_count || 0, prev?.member_count_at || null, prev?.whapi_group_id || null]
      );
      inserted++;
    }

    // Keep the rotation pointer within the new link range.
    await client.query(
      'UPDATE webinars SET wa_active_index = LEAST(GREATEST(wa_active_index, 1), GREATEST($2, 1)) WHERE id = $1',
      [webinar_id, inserted]
    );

    await client.query('COMMIT');

    // Re-point the served link immediately for the active webinar.
    if (wOwn[0].is_active) {
      // Whapi workspaces rotate by community members, not leads — mirror the
      // link at the current pointer instead of recomputing from lead count.
      const { rows: cfgRows } = await pool.query(
        'SELECT whapi_channel_id FROM webinar_config WHERE source = $1', [source]);
      if (cfgRows[0]?.whapi_channel_id) {
        const { rows: cur } = await pool.query(
          `SELECT wl.link_url
             FROM whatsapp_links wl JOIN webinars w ON w.id = wl.webinar_id
            WHERE wl.webinar_id = $1 AND wl.order_index = w.wa_active_index AND wl.link_url <> ''
            LIMIT 1`,
          [webinar_id]
        );
        if (cur[0]?.link_url) await mirrorActiveLink(source, cur[0].link_url);
      } else {
        await rotateLink(webinar_id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save WA links error:', err.message);
    res.status(500).json({ error: 'Failed to save links' });
  } finally {
    client.release();
  }
});

/* ── GET /api/admin/dashboard ──
   Filters and groups by webinar.id (UUID) instead of webinar_at, so admin
   edits to a webinar's deadline don't fragment its event history.
   Accepts `webinar_id` (preferred) or legacy `webinar_at` as the filter. */
router.get('/dashboard', async (req, res) => {
  const { from, to, webinar_id, webinar_at } = req.query;
  const source = getSource(req);
  const params = [source];
  const conditions = [`ce.source = $1`];

  if (from) {
    params.push(new Date(from + 'T00:00:00+05:30'));
    conditions.push(`ce.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(new Date(to + 'T23:59:59+05:30'));
    conditions.push(`ce.created_at <= $${params.length}`);
  }
  if (webinar_id) {
    params.push(webinar_id);
    conditions.push(`ce.webinar_id = $${params.length}`);
  } else if (webinar_at) {
    // Legacy fallback — match by deadline if no id provided
    params.push(new Date(webinar_at));
    conditions.push(`ce.webinar_at = $${params.length}`);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  try {
    const { rows } = await pool.query(
      `SELECT ce.event_name, COUNT(*)::int AS count
         FROM click_events ce
         ${where}
        GROUP BY ce.event_name`,
      params
    );

    // Sessions list = every webinar (this source) that has at least one
    // click_event tied to it.
    //
    // Per-webinar metrics:
    //   • visitors      = raw page_visited events (page-loads, not unique)
    //   • registrations = COUNT(leads where webinar_id = w.id) — reliable
    //                     because each lead row corresponds to one real
    //                     human form-submit. Avoids the click_events
    //                     "current-active webinar" attribution drift.
    //   • wa_clicks     = COUNT(leads where wa_clicked = TRUE) — also lead-
    //                     based, so it's always ≤ registrations.
    // Option-C unique-visitor count merges visitor_ids that map to the
    // same registered phone number. The `merged_id` CTE coalesces every
    // visitor_id to its lead's phone if there's a matching lead row;
    // otherwise it keeps the visitor_id as-is. Then we COUNT DISTINCT.
    const { rows: sessions } = await pool.query(
      `WITH visit_identity AS (
         SELECT ce.webinar_id,
                ce.is_meta,
                ce.event_name,
                COALESCE(l.whatsapp_number, ce.visitor_id) AS merged_id
           FROM click_events ce
           LEFT JOIN leads l ON l.visitor_id = ce.visitor_id
          WHERE ce.webinar_id IS NOT NULL
       )
       SELECT w.id           AS webinar_id,
              w.date_time    AS webinar_at,
              w.name,
              w.is_active,
              COALESCE(ce_agg.visitors, 0)::int           AS visitors,
              COALESCE(ce_agg.unique_visitors, 0)::int    AS unique_visitors,
              COALESCE(ce_agg.meta_visits, 0)::int        AS meta_verified_visits,
              COALESCE(lead_agg.regs, 0)::int             AS registrations,
              COALESCE(lead_agg.meta_regs, 0)::int        AS meta_verified_regs,
              COALESCE(lead_agg.wa_uniq, 0)::int          AS wa_clicks,
              COALESCE(lead_agg.meta_wa, 0)::int          AS meta_verified_wa
         FROM webinars w
         LEFT JOIN (
           SELECT webinar_id,
                  SUM(CASE WHEN event_name = 'page_visited' THEN 1 ELSE 0 END) AS visitors,
                  COUNT(DISTINCT merged_id) FILTER (WHERE event_name = 'page_visited' AND merged_id IS NOT NULL) AS unique_visitors,
                  SUM(CASE WHEN event_name = 'page_visited' AND is_meta = TRUE THEN 1 ELSE 0 END) AS meta_visits
             FROM visit_identity
            GROUP BY webinar_id
         ) ce_agg ON ce_agg.webinar_id = w.id
         LEFT JOIN (
           SELECT webinar_id,
                  COUNT(*)                                                AS regs,
                  COUNT(*) FILTER (WHERE fbclid IS NOT NULL OR utm_source = 'meta') AS meta_regs,
                  SUM(CASE WHEN wa_clicked THEN 1 ELSE 0 END)             AS wa_uniq,
                  SUM(CASE WHEN wa_clicked AND (fbclid IS NOT NULL OR utm_source = 'meta') THEN 1 ELSE 0 END) AS meta_wa
             FROM leads
            WHERE webinar_id IS NOT NULL
            GROUP BY webinar_id
         ) lead_agg ON lead_agg.webinar_id = w.id
        WHERE w.source = $1
          AND EXISTS (SELECT 1 FROM click_events ce2 WHERE ce2.webinar_id = w.id)
        ORDER BY w.date_time DESC
        LIMIT 50`,
      [source]
    );

    const counts = {};
    for (const row of rows) counts[row.event_name] = row.count;

    // Lead-based unique count of WhatsApp clickers — matches the per-webinar
    // wa_clicks field so the Reg → WA drop-off box uses consistent math
    // instead of inflated event counts. Scoped to the same filter window as
    // event counts above (by leads.created_at).
    const leadFilterClauses = ['l.source = $1'];
    const leadFilterParams  = [source];
    if (from) {
      leadFilterParams.push(new Date(from + 'T00:00:00+05:30'));
      leadFilterClauses.push(`l.created_at >= $${leadFilterParams.length}`);
    }
    if (to) {
      leadFilterParams.push(new Date(to + 'T23:59:59+05:30'));
      leadFilterClauses.push(`l.created_at <= $${leadFilterParams.length}`);
    }
    if (webinar_id) {
      leadFilterParams.push(webinar_id);
      leadFilterClauses.push(`l.webinar_id = $${leadFilterParams.length}`);
    }
    try {
      const { rows: leadCounts } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE l.wa_clicked = TRUE)::int                                                 AS wa_unique_leads,
                COUNT(*)::int                                                                                    AS lead_registrations,
                COUNT(*) FILTER (WHERE l.fbclid IS NOT NULL OR l.utm_source = 'meta')::int                       AS meta_verified_regs,
                COUNT(*) FILTER (WHERE l.wa_clicked = TRUE AND (l.fbclid IS NOT NULL OR l.utm_source = 'meta'))::int AS meta_verified_wa
           FROM leads l
          WHERE ${leadFilterClauses.join(' AND ')}`,
        leadFilterParams
      );
      counts.wa_unique_leads    = leadCounts[0]?.wa_unique_leads    ?? 0;
      counts.lead_registrations = leadCounts[0]?.lead_registrations ?? 0;
      counts.meta_verified_regs = leadCounts[0]?.meta_verified_regs ?? 0;
      counts.meta_verified_wa   = leadCounts[0]?.meta_verified_wa   ?? 0;
    } catch (_) {
      counts.wa_unique_leads    = 0;
      counts.lead_registrations = 0;
      counts.meta_verified_regs = 0;
      counts.meta_verified_wa   = 0;
    }

    // Verified Meta visits + unique visitor counts (lead-phone merged)
    // from click_events. Same filter window as event counts.
    try {
      const { rows: r } = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE ce.event_name = 'page_visited' AND ce.is_meta = TRUE)::int AS meta_verified_visits,
            COUNT(DISTINCT COALESCE(l.whatsapp_number, ce.visitor_id))
              FILTER (WHERE ce.event_name = 'page_visited' AND (ce.visitor_id IS NOT NULL OR l.whatsapp_number IS NOT NULL))::int AS unique_visitors
           FROM click_events ce
           LEFT JOIN leads l ON l.visitor_id = ce.visitor_id
           ${where}`,
        params
      );
      counts.meta_verified_visits = r[0]?.meta_verified_visits ?? 0;
      counts.unique_visitors      = r[0]?.unique_visitors      ?? 0;
    } catch (_) {
      counts.meta_verified_visits = 0;
      counts.unique_visitors      = 0;
    }

    res.json({
      counts,
      sessions: sessions.map(r => ({
        webinar_id:           r.webinar_id,
        webinar_at:           r.webinar_at,
        name:                 r.name,
        is_active:            r.is_active,
        visitors:             r.visitors,
        unique_visitors:      r.unique_visitors,
        meta_verified_visits: r.meta_verified_visits,
        registrations:        r.registrations,
        meta_verified_regs:   r.meta_verified_regs,
        wa_clicks:            r.wa_clicks,
        meta_verified_wa:     r.meta_verified_wa,
      })),
    });
  } catch (err) {
    console.error('Dashboard query error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

/* ── GET /api/admin/crm-users ──
   Returns user rows with the Smartflo API key MASKED — admins can see
   that a key is present (and what it looks like) but the raw secret is
   never sent over the wire after creation. The Users page form should
   show the masked value as a placeholder; if the admin submits the
   masked value unchanged, the PATCH endpoint treats it as a no-op and
   keeps the real key in the DB. */
router.get('/crm-users', async (req, res) => {
  try {
    // Three scopes:
    //   super  → every user
    //   mgr    → users in the manager's department
    //   tl     → the TL themselves + their direct reports (team_leader_id = self.id)
    const mgr = req.adminUser && req.adminUser.kind === 'manager';
    const tl  = req.adminUser && req.adminUser.kind === 'tl';
    let whereSQL = '';
    let params   = [];
    // Soft-deleted rows are never returned to the Users list. The
    // deleted_at IS NULL gate goes into the WHERE in every branch.
    if (mgr) {
      whereSQL = 'WHERE deleted_at IS NULL AND department = $1';
      params   = [req.adminUser.department];
    } else if (tl) {
      whereSQL = 'WHERE deleted_at IS NULL AND (id = $1 OR team_leader_id = $1)';
      params   = [req.adminUser.id];
    } else {
      whereSQL = 'WHERE deleted_at IS NULL';
    }
    // Optional workspace scope. When a workspace is requested, return every
    // non-caller (they work all workspaces) PLUS callers tagged to that
    // workspace or left untagged (workspace IS NULL = all workspaces).
    const reqWorkspace = req.query.workspace;
    if (reqWorkspace && ALLOWED_WORKSPACES.includes(String(reqWorkspace))) {
      params.push(String(reqWorkspace));
      whereSQL += ` AND (role NOT IN ('junior_caller','senior_caller') OR workspace IS NULL OR workspace = $${params.length})`;
    }
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, is_active, workspace,
              department, team_leader_id, manager_id, assistant_manager_id, password_plain,
              tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
              tata_smartflo_api_key, tata_outbound_route, custom_fields,
              page_access, avatar_url, created_at
         FROM crm_users
        ${whereSQL}
        ORDER BY created_at DESC`,
      params
    );
    const tata = require('../utils/tataClient');
    const users = rows.map(u => ({
      ...u,
      tata_smartflo_api_key: u.tata_smartflo_api_key ? tata.maskKey(u.tata_smartflo_api_key) : null,
      // Flag for the frontend so it knows a key is configured even when the
      // displayed value is masked. Avoids confusing "is this empty or just
      // hidden?" UX.
      tata_smartflo_api_key_set: !!u.tata_smartflo_api_key,
    }));
    res.json({ users, total: users.length });
  } catch (err) {
    console.error('Get crm_users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/* Returns true if `v` looks like a maskKey() output (e.g. "abcd…wxyz")
   rather than a real key. Used on PATCH to skip overwriting the real
   key when the admin saves the form without retyping it. */
function isMaskedKey(v) {
  return typeof v === 'string' && /…/.test(v);
}

/* ── POST /api/admin/crm-users ── */
const ALLOWED_ROLES = ['junior_caller','senior_caller','manager','assistant_manager','trainer','admin','team_leader','webinar','l1_sales'];
// Workspace tags a caller can be pinned to (mirrors the top-left switcher).
const ALLOWED_WORKSPACES = ['meta','yt','meta2','metatemp','tagmango'];
const CALLER_ROLES = new Set(['junior_caller','senior_caller']);

/* Resolve the workspace column value for a write.
   - Caller roles: store the submitted workspace (validated upstream; null = all).
   - Non-caller roles: always NULL (non-callers work in every workspace). */
function resolveWorkspace(role, rawWorkspace) {
  if (!CALLER_ROLES.has(role)) return null;
  if (rawWorkspace === undefined || rawWorkspace === null || rawWorkspace === '') return null;
  const v = String(rawWorkspace).trim();
  return ALLOWED_WORKSPACES.includes(v) ? v : null;
}

/* GET /api/admin/my-page-access — the page_access map ({ pageId: bool }) of the
   currently-logged-in CRM user (manager or team_leader). The Web Reminder
   dashboard reads this on mount to hide any tab turned OFF in the Access panel,
   mirroring how CallerShell gates a caller's pages. Super-admin sees everything
   (returns {} → every page defaults ON). */
router.get('/my-page-access', async (req, res) => {
  if (!req.adminUser || req.adminUser.kind === 'super') {
    return res.json({ page_access: {} });
  }
  try {
    const { rows } = await pool.query(
      'SELECT page_access FROM crm_users WHERE id = $1',
      [req.adminUser.id]
    );
    res.json({ page_access: rows[0]?.page_access || {} });
  } catch (err) {
    console.error('my-page-access read error:', err.message);
    res.json({ page_access: {} }); // safe default — never lock a user out
  }
});

/* PATCH /api/admin/crm-users/:id/page-access — store per-user marketing page
   access as a JSON map { pageId: bool }. Used by the Marketing → Access tab. */
router.patch('/crm-users/:id/page-access', async (req, res) => {
  const { id } = req.params;
  const access = req.body && typeof req.body.page_access === 'object' && req.body.page_access !== null
    ? req.body.page_access : {};
  try {
    const { rows } = await pool.query(
      'UPDATE crm_users SET page_access = $1::jsonb WHERE id = $2 RETURNING id, page_access',
      [JSON.stringify(access), id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'user_not_found' });
    res.json({ id: rows[0].id, page_access: rows[0].page_access });
  } catch (err) {
    console.error('page-access update error:', err.message);
    res.status(500).json({ error: 'Failed to save access.' });
  }
});

const crmUserValidators = [
  body('full_name').trim().notEmpty().withMessage('Full name is required.').isLength({ max: 120 }),
  body('email').trim().isEmail().withMessage('Valid email required.').isLength({ max: 200 }),
  body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 30 }),
  body('role').isIn(ALLOWED_ROLES).withMessage('Role must be one of the allowed values.'),
  body('workspace').optional({ nullable: true, checkFalsy: true }).isIn(ALLOWED_WORKSPACES).withMessage('Workspace must be "meta", "yt" or "meta2".'),
  body('password').isLength({ min: 6, max: 128 }).withMessage('Password must be 6–128 characters.'),
  body('department').optional({ nullable: true, checkFalsy: true }).isIn(['sales','marketing']).withMessage('Department must be "sales" or "marketing".'),
  body('team_leader_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Team leader must be a valid user.'),
  body('manager_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Manager must be a valid user.'),
  body('assistant_manager_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Assistant manager must be a valid user.'),
  body('tata_extension').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_account_type').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_agent_number').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_caller_id').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_smartflo_api_key')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage('Smartflo API key must be at least 10 characters.')
    .matches(/^\S+$/)
    .withMessage('Smartflo API key must not contain spaces.'),
  body('tata_outbound_route')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['did','agent','extension'])
    .withMessage('Outbound route must be "did", "agent" or "extension".'),
];

function hashPassword(plain) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(plain, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
    });
  });
}

router.post('/crm-users', crmUserValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg, fields: errors.array() });
  }

  const {
    full_name, email, phone, role, password, workspace,
    department, team_leader_id, manager_id, assistant_manager_id,
    tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
    tata_smartflo_api_key, tata_outbound_route,
  } = req.body;
  // Caller → store submitted workspace (null = all). Non-caller → always NULL.
  const effectiveWorkspace = resolveWorkspace(role, workspace);
  // TL guard: TLs may only create caller-level users — no managers, no
  // peer TLs, no admins. Reject early with a clear message so a leaked
  // /admin/crm-users POST from a TL JWT can't escalate privileges.
  const isTL = req.adminUser && req.adminUser.kind === 'tl';
  if (isTL && role !== 'junior_caller' && role !== 'senior_caller') {
    return res.status(403).json({ error: 'Team leaders can only create caller users.' });
  }
  // A manager can only create users in their OWN department — override
  // whatever the body sent. TLs same: their own department. Super-admin
  // uses the submitted department.
  const effectiveDept = (req.adminUser && (req.adminUser.kind === 'manager' || req.adminUser.kind === 'tl'))
    ? req.adminUser.department
    : (department ? String(department).trim() : null);
  // A manager-created user always reports to that manager; only super-admin
  // may assign a different manager. TLs don't set manager_id at all.
  const effectiveManagerId = (req.adminUser && req.adminUser.kind === 'manager')
    ? req.adminUser.id
    : (isTL ? null : (manager_id || null));
  // A TL-created caller is automatically assigned to that TL's team.
  // Super-admin / manager submissions honour the request body.
  const effectiveTeamLeaderId = isTL
    ? req.adminUser.id
    : (team_leader_id || null);
  // Assistant manager assignment — super-admin honours the body; TLs never set it.
  const effectiveAssistantManagerId = isTL ? null : (assistant_manager_id || null);
  try {
    const password_hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO crm_users
         (full_name, email, phone, role, password_hash,
          department, team_leader_id,
          tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
          tata_smartflo_api_key, tata_outbound_route, manager_id, password_plain,
          workspace, custom_fields, assistant_manager_id, avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)
       RETURNING id, full_name, email, phone, role, is_active, workspace,
                 department, team_leader_id, manager_id, assistant_manager_id, password_plain,
                 tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
                 tata_smartflo_api_key, tata_outbound_route, custom_fields, avatar_url,
                 created_at`,
      [
        full_name.trim(),
        email.trim().toLowerCase(),
        phone?.trim() || null,
        role,
        password_hash,
        effectiveDept,
        effectiveTeamLeaderId,
        tata_extension?.trim() || null,
        tata_account_type?.trim() || null,
        tata_agent_number?.trim() || null,
        tata_caller_id?.trim() || null,
        tata_smartflo_api_key?.trim() || null,
        tata_outbound_route === 'agent' || tata_outbound_route === 'did'
          ? tata_outbound_route
          : 'extension',
        effectiveManagerId,
        password,
        effectiveWorkspace,
        JSON.stringify(req.body.custom_fields || {}),
        effectiveAssistantManagerId,
        (typeof req.body.avatar_url === 'string' && req.body.avatar_url) ? req.body.avatar_url : null,
      ]
    );
    // Mask the API key in the response so the freshly-created secret
    // isn't echoed back into the admin UI / browser memory / network logs.
    const tata = require('../utils/tataClient');
    const created = {
      ...rows[0],
      tata_smartflo_api_key: rows[0].tata_smartflo_api_key
        ? tata.maskKey(rows[0].tata_smartflo_api_key) : null,
      tata_smartflo_api_key_set: !!rows[0].tata_smartflo_api_key,
    };
    res.status(201).json({ user: created });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }
    console.error('Create crm_user error:', err.message);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

/* ── PATCH /api/admin/crm-users/:id ── */
const crmUserPatchValidators = [
  body('full_name').optional().trim().notEmpty().withMessage('Full name cannot be empty.').isLength({ max: 120 }),
  body('email').optional().trim().isEmail().withMessage('Valid email required.').isLength({ max: 200 }),
  body('phone').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('role').optional().isIn(ALLOWED_ROLES).withMessage('Role must be one of the allowed values.'),
  body('workspace').optional({ nullable: true, checkFalsy: true }).isIn(ALLOWED_WORKSPACES).withMessage('Workspace must be "meta", "yt" or "meta2".'),
  body('password').optional({ checkFalsy: true }).isLength({ min: 6, max: 128 }).withMessage('Password must be 6–128 characters.'),
  body('department').optional({ nullable: true, checkFalsy: true }).isIn(['sales','marketing']).withMessage('Department must be "sales" or "marketing".'),
  body('team_leader_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Team leader must be a valid user.'),
  body('manager_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Manager must be a valid user.'),
  body('assistant_manager_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Assistant manager must be a valid user.'),
  body('tata_extension').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_account_type').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
  body('tata_agent_number').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_caller_id').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 30 }),
  body('tata_smartflo_api_key')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage('Smartflo API key must be at least 10 characters.')
    .matches(/^\S+$/)
    .withMessage('Smartflo API key must not contain spaces.'),
  body('tata_outbound_route')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['did','agent','extension'])
    .withMessage('Outbound route must be "did", "agent" or "extension".'),
  body('is_active').optional().isBoolean().withMessage('is_active must be a boolean.'),
];

router.patch('/crm-users/:id', crmUserPatchValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg, fields: errors.array() });
  }

  const { id } = req.params;
  const allowed = [
    'full_name', 'email', 'phone', 'role',
    'department', 'team_leader_id', 'manager_id', 'assistant_manager_id', 'workspace',
    'avatar_url',
    'tata_extension', 'tata_account_type', 'tata_agent_number', 'tata_caller_id',
    'tata_smartflo_api_key', 'tata_outbound_route',
    // is_active doubles as the "paused" flag — leadAssigner.js already skips
    // callers where is_active = FALSE; the Sales Performance kebab toggles it.
    'is_active',
  ];
  const tataKeys = new Set([
    'tata_extension', 'tata_account_type', 'tata_agent_number', 'tata_caller_id',
    'tata_smartflo_api_key', 'tata_outbound_route',
  ]);
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const raw = req.body[key];
      if (key === 'email') {
        updates[key] = String(raw).trim().toLowerCase();
      } else if (tataKeys.has(key)) {
        // If the frontend submitted the masked placeholder unchanged (e.g.
        // "abcd…wxyz"), treat it as "leave the stored value alone" — drop
        // the key from the updates set entirely instead of clobbering the
        // real secret with the mask.
        if (key === 'tata_smartflo_api_key' && isMaskedKey(raw)) continue;
        // tata_outbound_route is NOT NULL with default 'extension'; coerce
        // empty / null / unknown values to 'extension' so the CHECK
        // constraint never trips. 'agent' and 'did' are honoured verbatim.
        if (key === 'tata_outbound_route') {
          const v = typeof raw === 'string' ? raw.trim() : raw;
          updates[key] = (v === 'agent' || v === 'did') ? v : 'extension';
        } else {
          updates[key] = raw === null || raw === '' ? null : String(raw).trim() || null;
        }
      } else if (key === 'is_active') {
        updates[key] = !!raw;
      } else if (key === 'department' || key === 'team_leader_id' || key === 'manager_id' || key === 'assistant_manager_id' || key === 'workspace') {
        // All nullable — an empty string must become NULL (team_leader_id /
        // manager_id / assistant_manager_id are UUID columns; '' would trip a type error).
        const v = typeof raw === 'string' ? raw.trim() : raw;
        updates[key] = v ? v : null;
      } else if (typeof raw === 'string') {
        updates[key] = raw.trim();
      } else {
        updates[key] = raw;
      }
    }
  }

  // Custom fields (JSONB) — stored verbatim; cast applied in the SET clause.
  if (req.body.custom_fields !== undefined) {
    updates.custom_fields = JSON.stringify(req.body.custom_fields || {});
  }

  // Optional password update — hash for login verification, and keep the
  // plain text so the admin can view the user's current password.
  if (req.body.password) {
    try {
      updates.password_hash  = await hashPassword(req.body.password);
      updates.password_plain = String(req.body.password);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to hash password.' });
    }
  }

  // Workspace ↔ role reconciliation. Only callers may carry a workspace tag;
  // non-callers are always all-workspace (NULL). Determine the EFFECTIVE role
  // for this update (the submitted role if changing, else the stored role) and
  // force workspace = NULL whenever that role is not a caller. This also
  // catches a role demotion (caller → manager) that didn't touch workspace.
  if (
    Object.prototype.hasOwnProperty.call(updates, 'workspace') ||
    Object.prototype.hasOwnProperty.call(updates, 'role')
  ) {
    let effectiveRole = updates.role;
    if (effectiveRole === undefined) {
      try {
        const { rows: r } = await pool.query('SELECT role FROM crm_users WHERE id = $1', [id]);
        if (r.length === 0) return res.status(404).json({ error: 'User not found.' });
        effectiveRole = r[0].role;
      } catch (e) {
        return res.status(500).json({ error: 'Failed to verify user.' });
      }
    }
    if (!CALLER_ROLES.has(effectiveRole)) {
      updates.workspace = null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update.' });
  }

  // Manager scope: can only edit users in their own department, and can never
  // move a user to a different department.
  if (req.adminUser && req.adminUser.kind === 'manager') {
    try {
      const { rows: tgt } = await pool.query('SELECT department FROM crm_users WHERE id = $1', [id]);
      if (tgt.length === 0) return res.status(404).json({ error: 'User not found.' });
      if (tgt[0].department !== req.adminUser.department) {
        return res.status(403).json({ error: 'You can only manage users in your own department.' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Failed to verify user.' });
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'department')) {
      updates.department = req.adminUser.department;
    }
    // A manager cannot reassign who a user reports to — only super-admin can.
    delete updates.manager_id;
  }
  // TL scope: can only edit users on THEIR team (target.team_leader_id =
  // self.id, OR the TL editing their own profile). TLs cannot move
  // people between teams, change roles upward, change department, or
  // edit manager_id.
  if (req.adminUser && req.adminUser.kind === 'tl') {
    try {
      const { rows: tgt } = await pool.query(
        'SELECT id, role, team_leader_id, department FROM crm_users WHERE id = $1',
        [id]
      );
      if (tgt.length === 0) return res.status(404).json({ error: 'User not found.' });
      const t = tgt[0];
      const isSelf = t.id === req.adminUser.id;
      const isMyReport = t.team_leader_id === req.adminUser.id;
      if (!isSelf && !isMyReport) {
        return res.status(403).json({ error: 'You can only manage users on your team.' });
      }
      // Role escalations blocked: a TL can leave existing role intact
      // OR set a caller to the other caller level, but never to manager/
      // admin/team_leader/trainer.
      if (Object.prototype.hasOwnProperty.call(updates, 'role')) {
        const r = updates.role;
        if (r !== 'junior_caller' && r !== 'senior_caller') {
          delete updates.role;
        }
      }
      // Lock department / team membership / manager.
      if (Object.prototype.hasOwnProperty.call(updates, 'department')) {
        updates.department = t.department;
      }
      delete updates.team_leader_id;
      delete updates.manager_id;
    } catch (e) {
      return res.status(500).json({ error: 'Failed to verify user.' });
    }
  }

  // When the admin flips is_active back to TRUE, also clear the SmartFlow
  // auto-pause bookkeeping so the next system-driven pause starts from a
  // clean slate. The two columns are no-ops for any user that was paused
  // manually (they were never set).
  const setFragments = Object.keys(updates).map((k, i) => (k === 'custom_fields' ? `${k} = $${i + 1}::jsonb` : `${k} = $${i + 1}`));
  if (Object.prototype.hasOwnProperty.call(updates, 'is_active') && updates.is_active === true) {
    setFragments.push('auto_paused_at = NULL', 'auto_pause_reason = NULL');
  }
  const setClause = setFragments.join(', ');
  const values = Object.keys(updates).map(k => updates[k]);
  values.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE crm_users SET ${setClause}
       WHERE id = $${values.length}
       RETURNING id, full_name, email, phone, role, is_active, workspace,
                 auto_paused_at, auto_pause_reason,
                 department, team_leader_id, manager_id, password_plain,
                 tata_extension, tata_account_type, tata_agent_number, tata_caller_id,
                 tata_smartflo_api_key, tata_outbound_route, custom_fields, avatar_url,
                 created_at`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    // If is_active was in this PATCH, push an SSE so the caller's open tab
    // shows / hides the "paused by admin" overlay without a manual refresh.
    if (Object.prototype.hasOwnProperty.call(updates, 'is_active')) {
      try {
        callerSse.pushTo(id, {
          type: updates.is_active ? 'caller.resumed' : 'caller.paused',
          is_active: !!updates.is_active,
        });
      } catch (sseErr) {
        console.error('[admin] caller-paused SSE push error:', sseErr.message);
      }
      // Activity audit: record the admin-initiated pause/resume so the
      // activity drawer can show "Paused by admin" entries with timing.
      activityLogger.logPointEvent(
        id,
        updates.is_active ? 'UNPAUSED_BY_ADMIN' : 'PAUSED_BY_ADMIN'
      );
      // If admin/manager just PAUSED this caller, mark whatever lead
      // they had open as Incomplete so it surfaces in Completed Calls
      // for review. Same code path activitySpanReaper uses on stale
      // heartbeat, just triggered immediately instead of after the
      // 90-second timeout.
      if (updates.is_active === false) {
        try {
          const { markInFlightLeadIncomplete } = require('../utils/markInFlightLeadIncomplete');
          markInFlightLeadIncomplete({
            callerId: id,
            reason:   req.adminUser?.kind === 'manager' ? 'manager_pause' : 'admin_pause',
          }).catch(() => {});
        } catch (e) {
          console.error('[admin] markInFlightLeadIncomplete load error:', e.message);
        }
      }
    }
    // Mask the API key in the response (see GET /crm-users for the
    // reasoning — never echo the real secret back to the browser).
    const tataLib = require('../utils/tataClient');
    const updated = {
      ...rows[0],
      tata_smartflo_api_key: rows[0].tata_smartflo_api_key
        ? tataLib.maskKey(rows[0].tata_smartflo_api_key) : null,
      tata_smartflo_api_key_set: !!rows[0].tata_smartflo_api_key,
    };
    res.json({ user: updated });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }
    console.error('Update crm_user error:', err.message);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

/* ── GET /api/admin/auto-paused-callers ──
   Notifications feed for the Sales dashboard. Returns every caller the
   SYSTEM auto-paused — robot-nudge self-pause or the SmartFlow retry-cap.
   Admin pauses are excluded: they leave auto_paused_at NULL. The card's
   Resume button calls PATCH /crm-users/:id { is_active: true }, which
   clears auto_paused_at + auto_pause_reason so the row drops off this feed. */
router.get('/auto-paused-callers', async (req, res) => {
  try {
    // TL scope: only the auto-paused callers on this TL's team.
    // Manager + super-admin: department-wide / global as before.
    const tl  = req.adminUser && req.adminUser.kind === 'tl';
    const mgr = req.adminUser && req.adminUser.kind === 'manager';
    // Workspace filter: scope to callers tagged to this workspace (+ untagged).
    // 'all' (or default) keeps every caller.
    const source = getReportSource(req);
    let params     = [source];   // $1 = workspace
    let whereExtra = `AND ($1 = 'all' OR workspace IS NULL OR workspace = $1)`;
    if (tl) {
      params.push(req.adminUser.id);
      whereExtra += ` AND team_leader_id = $${params.length}`;
    } else if (mgr) {
      params.push(req.adminUser.department);
      whereExtra += ` AND department = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT id, full_name, role, auto_paused_at, auto_pause_reason
         FROM crm_users
        WHERE is_active = FALSE
          AND auto_paused_at IS NOT NULL
          AND deleted_at IS NULL
          ${whereExtra}
        ORDER BY auto_paused_at DESC`,
      params
    );
    res.json({ callers: rows });
  } catch (err) {
    console.error('auto-paused-callers error:', err.message);
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

/* ── GET /api/admin/empty-queue-callers ──
   Active callers whose ASSIGNED page is empty — the exact "No leads in your
   queue" state the caller sees. The assigned-queue predicate mirrors
   routes/caller.js GET /leads (not parked, no outcome or follow-up due, recent
   webinar or pinned). Surfaced on the Notifications page so the admin can refill
   them. Same workspace / TL / manager scoping as auto-paused-callers. */
router.get('/empty-queue-callers', async (req, res) => {
  try {
    const tl  = req.adminUser && req.adminUser.kind === 'tl';
    const mgr = req.adminUser && req.adminUser.kind === 'manager';
    const source = getReportSource(req);
    const params     = [source];   // $1 = workspace
    let   whereExtra = `AND ($1 = 'all' OR u.workspace IS NULL OR u.workspace = $1)`;
    if (tl) {
      params.push(req.adminUser.id);
      whereExtra += ` AND u.team_leader_id = $${params.length}`;
    } else if (mgr) {
      params.push(req.adminUser.department);
      whereExtra += ` AND u.department = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.role
         FROM crm_users u
        WHERE u.role IN ('junior_caller','senior_caller')
          AND u.is_active = TRUE
          AND u.deleted_at IS NULL
          ${whereExtra}
          AND NOT EXISTS (
            SELECT 1 FROM leads l
             WHERE l.assigned_user_id = u.id
               AND ($1 = 'all' OR l.source = $1)
               AND l.next_batch_parked = FALSE
               AND (
                 l.last_note_outcome IS NULL
                 OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW())
               )
               AND (
                 l.webinar_id IS NULL
                 OR l.webinar_id IN ${RECENT_WEBINARS_SQL}
                 OR l.pinned_at IS NOT NULL
               )
          )
        ORDER BY u.full_name ASC`,
      params
    );
    res.json({ callers: rows });
  } catch (err) {
    console.error('empty-queue-callers error:', err.message);
    res.status(500).json({ error: 'Failed to load empty-queue alerts.' });
  }
});

/* ── GET /api/admin/lead-share-config?webinar_id=<uuid> | ?source=<workspace> ──
   Two modes:
   • webinar_id → that webinar's saved rotation (per-webinar override). Where a
     webinar has no saved row for a caller, the default comes from the workspace
     TEMPLATE (so a freshly-created webinar already shows the saved logic).
   • source     → the WORKSPACE TEMPLATE itself (used on the Web Reminder page
     when no webinar exists yet). caller eligibility = workspace match / untagged. */
router.get('/lead-share-config', async (req, res) => {
  const { webinar_id } = req.query;
  const sourceParam = req.query.source;

  // ── Source (template) mode — no webinar required ──────────────────────────
  if (!webinar_id && sourceParam) {
    try {
      const callersRes = await pool.query(
        `SELECT id, full_name, email, role, is_active
           FROM crm_users
          WHERE role IN ('junior_caller','senior_caller')
            AND deleted_at IS NULL
            AND (workspace IS NULL OR workspace = $1)
          ORDER BY created_at ASC`,
        [sourceParam]
      );
      const tplRes = await pool.query(
        `SELECT caller_id, enabled, allowed_lead_types, position
           FROM lead_share_template WHERE source = $1`,
        [sourceParam]
      );
      const tplByCaller = {};
      for (const row of tplRes.rows) tplByCaller[row.caller_id] = row;
      const config = callersRes.rows.map((c, idx) => {
        const saved = tplByCaller[c.id];
        return {
          caller_id: c.id, full_name: c.full_name, email: c.email, role: c.role, is_active: c.is_active,
          enabled:            saved ? saved.enabled            : true,
          allowed_lead_types: saved ? saved.allowed_lead_types : ['all'],
          position:           saved ? saved.position           : idx,
          has_saved_config:   !!saved,
          assigned_count:     0,   // no webinar context → no per-webinar counts
        };
      });
      return res.json({ callers: config, mode: 'template', source: sourceParam });
    } catch (err) {
      if (err.message && err.message.includes('does not exist')) return res.json({ callers: [], mode: 'template' });
      console.error('Get lead-share-config (template) error:', err.message);
      return res.status(500).json({ error: 'Failed to load configuration' });
    }
  }

  if (!webinar_id) return res.status(400).json({ error: 'webinar_id or source required' });

  try {
    // Callers eligible to be in THIS webinar's rotation (junior + senior
    // caller roles). Soft-deleted callers (deleted_at IS NOT NULL) are excluded
    // so they don't appear in the Leads Logic rotation list — the entire
    // point of soft-delete is that they're gone from active workflows.
    //
    // Workspace scoping: a caller only appears for a webinar whose source
    // matches the caller's workspace tag, OR the caller is untagged
    // (workspace IS NULL) and therefore serves every workspace. This mirrors
    // exactly the eligibility filter in utils/leadAssigner.js, so the Leads
    // Logic queue shows precisely the callers who can actually receive these
    // leads — e.g. the Meta Temp dashboard lists only Meta-Temp + all-workspace
    // callers, not callers tagged to other workspaces.
    const callersQuery = pool.query(
      `SELECT id, full_name, email, role, is_active
         FROM crm_users
        WHERE role IN ('junior_caller','senior_caller')
          AND deleted_at IS NULL
          AND (workspace IS NULL
               OR workspace = (SELECT source FROM webinars WHERE id = $1))
        ORDER BY created_at ASC`,
      [webinar_id]
    );
    // Existing config rows for this webinar
    const configQuery = pool.query(
      `SELECT caller_id, enabled, allowed_lead_types, position
         FROM lead_share_config
        WHERE webinar_id = $1`,
      [webinar_id]
    );
    // How many leads in THIS webinar have already been handed out to each
    // caller. Powers the "Assigned" column in the admin view so the operator
    // can eyeball whether round-robin is distributing fairly.
    const countsQuery = pool.query(
      `SELECT assigned_user_id::text AS caller_id, COUNT(*)::int AS count
         FROM leads
        WHERE webinar_id = $1
          AND assigned_user_id IS NOT NULL
        GROUP BY assigned_user_id`,
      [webinar_id]
    );
    // Workspace template — the fallback default for any caller this webinar has
    // not explicitly configured (so a brand-new webinar already shows the saved
    // Leads-Logic the admin set on the Web Reminder page).
    const templateQuery = pool.query(
      `SELECT caller_id, enabled, allowed_lead_types, position
         FROM lead_share_template
        WHERE source = (SELECT source FROM webinars WHERE id = $1)`,
      [webinar_id]
    );
    const [callersRes, configRes, countsRes, templateRes] = await Promise.all([callersQuery, configQuery, countsQuery, templateQuery]);

    const configByCaller = {};
    for (const row of configRes.rows) configByCaller[row.caller_id] = row;
    const tplByCaller = {};
    for (const row of templateRes.rows) tplByCaller[row.caller_id] = row;
    const countByCaller = {};
    for (const row of countsRes.rows) countByCaller[row.caller_id] = row.count;

    const config = callersRes.rows.map((c, idx) => {
      const saved = configByCaller[c.id];       // per-webinar override
      const tpl   = tplByCaller[c.id];           // workspace template default
      return {
        caller_id: c.id,
        full_name: c.full_name,
        email:     c.email,
        role:      c.role,
        is_active: c.is_active,
        // Per-webinar value wins; else the workspace template; else hard default.
        enabled:            saved ? saved.enabled            : (tpl ? tpl.enabled            : true),
        allowed_lead_types: saved ? saved.allowed_lead_types : (tpl ? tpl.allowed_lead_types : ['all']),
        position:           saved ? saved.position           : (tpl ? tpl.position           : idx),
        has_saved_config:   !!saved,
        assigned_count:     countByCaller[c.id] || 0,
      };
    });
    res.json({ callers: config });
  } catch (err) {
    if (err.message && err.message.includes('does not exist')) {
      // Tables not migrated yet — return empty
      return res.json({ callers: [] });
    }
    console.error('Get lead-share-config error:', err.message);
    res.status(500).json({ error: 'Failed to load configuration' });
  }
});

/* ── PUT /api/admin/lead-share-config ── */
const ALLOWED_LEAD_TYPES = ['250+', '150-250', 'all'];

async function writeShareTemplate(client, source, callers) {
  await client.query('DELETE FROM lead_share_template WHERE source = $1', [source]);
  for (let i = 0; i < callers.length; i++) {
    const c = callers[i];
    await client.query(
      `INSERT INTO lead_share_template
         (source, caller_id, enabled, allowed_lead_types, position, updated_at)
       VALUES ($1, $2, $3, $4::TEXT[], $5, NOW())`,
      [source, c.caller_id, c.enabled, c.allowed_lead_types, typeof c.position === 'number' ? c.position : i]
    );
  }
}

router.put('/lead-share-config', async (req, res) => {
  const { webinar_id, callers } = req.body;
  const sourceParam = req.body.source;
  if ((!webinar_id && !sourceParam) || !Array.isArray(callers)) {
    return res.status(400).json({ error: 'webinar_id or source, plus callers[], required' });
  }
  // Validate every row
  for (const c of callers) {
    if (!c.caller_id) return res.status(422).json({ error: 'caller_id required on every row' });
    if (typeof c.enabled !== 'boolean') return res.status(422).json({ error: 'enabled must be boolean' });
    if (!Array.isArray(c.allowed_lead_types) || c.allowed_lead_types.length === 0) {
      return res.status(422).json({ error: 'allowed_lead_types must be a non-empty array' });
    }
    for (const t of c.allowed_lead_types) {
      if (!ALLOWED_LEAD_TYPES.includes(t)) {
        return res.status(422).json({ error: `Invalid lead type: ${t}` });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Template (workspace) mode — no webinar needed ──────────────────────
    if (!webinar_id && sourceParam) {
      await writeShareTemplate(client, sourceParam, callers);
      await client.query('COMMIT');
      return res.json({ success: true, mode: 'template' });
    }

    // ── Per-webinar mode (override) ────────────────────────────────────────
    // Wipe + reinsert is the simplest correctness model
    await client.query('DELETE FROM lead_share_config WHERE webinar_id = $1', [webinar_id]);

    for (let i = 0; i < callers.length; i++) {
      const c = callers[i];
      await client.query(
        `INSERT INTO lead_share_config
           (webinar_id, caller_id, enabled, allowed_lead_types, position, updated_at)
         VALUES ($1, $2, $3, $4::TEXT[], $5, NOW())`,
        [webinar_id, c.caller_id, c.enabled, c.allowed_lead_types, typeof c.position === 'number' ? c.position : i]
      );
    }

    // Reset round-robin cursor — eligible list may have changed
    await client.query(
      `INSERT INTO round_robin_state (webinar_id, last_position)
       VALUES ($1, -1)
       ON CONFLICT (webinar_id) DO UPDATE SET last_position = -1, updated_at = NOW()`,
      [webinar_id]
    );

    // Mirror this logic into the workspace TEMPLATE so the SAME setup
    // automatically applies to the NEXT webinar created/promoted for this
    // source. (The admin sets it once; every future webinar inherits it.)
    const { rows: wsrc } = await client.query('SELECT source FROM webinars WHERE id = $1', [webinar_id]);
    if (wsrc[0] && wsrc[0].source) {
      await writeShareTemplate(client, wsrc[0].source, callers);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save lead-share-config error:', err.message);
    res.status(500).json({ error: 'Failed to save configuration' });
  } finally {
    client.release();
  }
});

/* ── DELETE /api/admin/crm-users/:id ──
   Soft-delete. A physical DELETE would fail Postgres FK checks because
   lead_assignments / lead_call_notes / leads.assigned_user_id all have
   ON DELETE NO ACTION (intentional — those rows are historical and
   shouldn't lose their caller attribution). Instead we stamp
   deleted_at = NOW() and flip is_active = FALSE. The user disappears
   from the Users list, the assignment pool, and the performance grid;
   call history retains the name pointer for audit.

   To restore a soft-deleted user later: UPDATE crm_users SET
   deleted_at = NULL WHERE id = '<uuid>'. No UI for undelete yet —
   admin can do it via psql / a follow-up endpoint if needed. */
router.delete('/crm-users/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    // Manager scope: can only delete users in their own department.
    if (req.adminUser && req.adminUser.kind === 'manager') {
      const { rows: tgt } = await pool.query('SELECT department FROM crm_users WHERE id = $1', [id]);
      if (tgt.length === 0) return res.status(404).json({ error: 'User not found.' });
      if (tgt[0].department !== req.adminUser.department) {
        return res.status(403).json({ error: 'You can only manage users in your own department.' });
      }
    }
    // TL has no delete permission at all — would let them remove their
    // own reports unilaterally, which is a manager+ decision.
    if (req.adminUser && req.adminUser.kind === 'tl') {
      return res.status(403).json({ error: 'Team leaders cannot delete users.' });
    }
    const result = await pool.query(
      `UPDATE crm_users
          SET deleted_at = NOW(),
              is_active  = FALSE
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING id`,
      [id]
    );
    if (result.rowCount === 0) {
      // Either the user doesn't exist or was already deleted. Either
      // way the UI's effect is the same (row should disappear).
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete crm_user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

/* ── GET /api/admin/caller-workload?date=YYYY-MM-DD ──
   Per-caller load snapshot. The date filters follow-ups + completions to that
   IST day; "open" leads (pending or due-now follow-ups) are date-independent.
   Used to spot overloaded callers and reassign when someone is absent. */
router.get('/caller-workload', async (req, res) => {
  const date = (req.query.date || '').toString().slice(0, 10);
  // Bound the IST day window: 00:00 IST = previous day 18:30 UTC.
  // If no date passed, default to "today" in IST.
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const ymd = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : istNow.toISOString().slice(0, 10);
  const dayStart = new Date(`${ymd}T00:00:00+05:30`).toISOString();
  const dayEnd   = new Date(`${ymd}T23:59:59.999+05:30`).toISOString();
  // Workspace scope — count only this source's leads per caller.
  const source = getSource(req);

  try {
    const { rows } = await pool.query(
      `SELECT
         u.id, u.full_name, u.role, u.is_active,
         COUNT(l.id) FILTER (
           WHERE l.last_note_outcome IS NULL
              OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW())
         )::int AS pending_count,
         COUNT(l.id) FILTER (
           WHERE l.last_note_outcome = 'follow_up'
             AND l.follow_up_at >= $1 AND l.follow_up_at <= $2
         )::int AS followups_for_date,
         COUNT(l.id) FILTER (
           WHERE l.last_note_outcome IN ('completed','not_interested')
             AND l.last_note_at >= $1 AND l.last_note_at <= $2
         )::int AS completed_for_date,
         COUNT(l.id) FILTER (
           WHERE l.last_note_outcome IS NULL
              OR l.last_note_outcome = 'follow_up'
         )::int AS total_open
       FROM crm_users u
       LEFT JOIN leads l ON l.assigned_user_id = u.id AND l.source = $3
       WHERE u.role IN ('junior_caller','senior_caller')
         AND u.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY u.is_active DESC, u.full_name ASC`,
      [dayStart, dayEnd, source]
    );
    res.json({ date: ymd, callers: rows });
  } catch (err) {
    console.error('caller-workload error:', err.message);
    res.status(500).json({ error: 'Failed to load workload.' });
  }
});

/* ── GET /api/admin/meta-debug ──
   Diagnostic: asks Meta which ad accounts the configured token actually has
   access to, and tests an insights call on each configured account. Helps
   pin down which accounts are missing permissions vs which ones work. */
router.get('/meta-debug', async (req, res) => {
  const token = (process.env.META_ACCESS_TOKEN || '').trim();
  const accounts = (process.env.META_AD_ACCOUNTS || '').trim().split(',').map(s => s.trim()).filter(Boolean);
  if (!token) return res.json({ configured: false, error: 'META_ACCESS_TOKEN missing in .env' });

  const out = { configured: true, configured_accounts: accounts, token_sees: [], probe: {} };

  // 1) Which accounts does this token *actually* see?
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=id,account_id,name,account_status&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    if (j.error) {
      out.token_sees_error = j.error.message;
    } else {
      out.token_sees = (j.data || []).map(a => ({ id: a.account_id, name: a.name, status: a.account_status }));
    }
  } catch (e) { out.token_sees_error = e.message; }

  // 2) Probe each configured account directly. Two-step:
  //    a) Try a metadata read — proves the token at least sees the account
  //    b) Try an insights call — proves it has ads_read scope on the account
  for (const accId of accounts) {
    const tok = (process.env[`META_ACCESS_TOKEN_${accId}`] || token).trim();
    const probe = { metadata: null, insights: null };

    try {
      const rm = await fetch(`https://graph.facebook.com/v23.0/act_${accId}?fields=id,name,account_status,business&access_token=${encodeURIComponent(tok)}`);
      const jm = await rm.json();
      probe.metadata = jm.error
        ? { ok: false, message: jm.error.message, code: jm.error.code }
        : { ok: true, name: jm.name, status: jm.account_status, business: jm.business?.name || null, business_id: jm.business?.id || null };
    } catch (e) {
      probe.metadata = { ok: false, message: e.message };
    }

    try {
      const ri = await fetch(`https://graph.facebook.com/v23.0/act_${accId}/insights?fields=impressions&date_preset=last_7d&access_token=${encodeURIComponent(tok)}`);
      const ji = await ri.json();
      probe.insights = ji.error
        ? { ok: false, message: ji.error.message, code: ji.error.code }
        : { ok: true, rows: (ji.data || []).length };
    } catch (e) {
      probe.insights = { ok: false, message: e.message };
    }

    out.probe[accId] = probe;
  }

  // 3) Who owns this token?
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    out.token_owner = j.error ? { error: j.error.message } : { id: j.id, name: j.name };
  } catch (e) {
    out.token_owner = { error: e.message };
  }

  res.json(out);
});

/* ── GET /api/admin/meta-raw?from=YYYY-MM-DD&to=YYYY-MM-DD ──
   Diagnostic: dumps every action_type + count Meta returns for the saved
   campaign filter over the given date range, plus each account's
   configured timezone. Lets us spot which metric the user is actually
   comparing against in Ads Manager. */
router.get('/meta-raw', async (req, res) => {
  if (!metaConfigured()) return res.json({ configured: false });
  const source = getSource(req);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to   || '') ? req.query.to   : null;
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });

  const { rows } = await pool.query(
    'SELECT meta_campaign_ids FROM webinar_config WHERE source = $1',
    [source]
  );
  const campaignIds = Array.isArray(rows[0]?.meta_campaign_ids) ? rows[0].meta_campaign_ids : [];

  const accounts = (process.env.META_AD_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = { from, to, campaign_filter_count: campaignIds.length, accounts: {} };

  for (const accId of accounts) {
    const tok = (process.env[`META_ACCESS_TOKEN_${accId}`] || process.env.META_ACCESS_TOKEN || '').trim();
    if (!tok) { out.accounts[accId] = { error: 'no token' }; continue; }

    // 1) Account timezone
    let timezone_name = null, timezone_offset_hours_utc = null;
    try {
      const r = await fetch(`https://graph.facebook.com/v23.0/act_${accId}?fields=timezone_name,timezone_offset_hours_utc&access_token=${encodeURIComponent(tok)}`);
      const j = await r.json();
      timezone_name = j.timezone_name; timezone_offset_hours_utc = j.timezone_offset_hours_utc;
    } catch (_) { /* ignore */ }

    // 2) Daily insights over the range — every action type
    const u = new URL(`https://graph.facebook.com/v23.0/act_${accId}/insights`);
    u.searchParams.set('level', 'account');
    u.searchParams.set('fields', 'actions,inline_link_clicks,impressions,clicks');
    u.searchParams.set('time_increment', '1');
    u.searchParams.set('time_range', JSON.stringify({ since: from, until: to }));
    u.searchParams.set('action_attribution_windows', JSON.stringify(['1d_view', '7d_click', '28d_click']));
    if (campaignIds.length > 0) {
      u.searchParams.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]));
    }
    u.searchParams.set('access_token', tok);

    try {
      const r = await fetch(u.toString());
      const j = await r.json();
      if (j.error) {
        out.accounts[accId] = { timezone_name, timezone_offset_hours_utc, error: j.error.message };
        continue;
      }
      const action_totals = {};
      let inline_link_clicks_total = 0, impressions_total = 0, clicks_total = 0;
      for (const row of (j.data || [])) {
        if (row.inline_link_clicks) inline_link_clicks_total += parseInt(row.inline_link_clicks, 10) || 0;
        if (row.impressions)        impressions_total        += parseInt(row.impressions, 10) || 0;
        if (row.clicks)             clicks_total             += parseInt(row.clicks, 10) || 0;
        for (const a of (row.actions || [])) {
          action_totals[a.action_type] = (action_totals[a.action_type] || 0) + (parseInt(a.value, 10) || 0);
        }
      }
      out.accounts[accId] = {
        timezone_name, timezone_offset_hours_utc,
        days_returned: (j.data || []).length,
        inline_link_clicks_total, impressions_total, clicks_total,
        action_totals,
      };
    } catch (e) {
      out.accounts[accId] = { timezone_name, timezone_offset_hours_utc, error: e.message };
    }
  }
  res.json(out);
});

/* ── GET /api/admin/meta-campaigns ──
   Returns every Meta Ads campaign across all configured accounts so the
   admin can choose a subset to scope the landing-view dashboards. */
router.get('/meta-campaigns', async (_req, res) => {
  if (!metaConfigured()) return res.json({ configured: false, campaigns: [] });
  try {
    const campaigns = await fetchAllCampaigns();
    res.json({ configured: true, campaigns });
  } catch (err) {
    console.error('meta-campaigns error:', err.message);
    res.status(500).json({ error: 'Failed to load campaigns.' });
  }
});

/* ── WhatsApp message templates (Meta Temp scheduling) ──
   Stored per source in wa_templates. day_offset is relative to the webinar
   ('webinar_day','1_before',…); msg_type is the content type (text/image/
   video/document); send_time is 'HH:MM' IST. Auto-send is a separate job. */
router.get('/wa-templates', async (req, res) => {
  const source = getSource(req);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM wa_templates WHERE source = $1 ORDER BY created_at DESC',
      [source]
    );
    res.json({ templates: rows });
  } catch (err) {
    console.error('wa-templates list error:', err.message);
    res.json({ templates: [] });
  }
});

/* Template media upload — disk storage under backend/uploads/templates,
   served statically at /uploads/templates (see app.js). 25 MB cap (>= the
   15 MB minimum requested). Returns a relative URL stored on the template. */
const TEMPLATE_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'templates');
try { fs.mkdirSync(TEMPLATE_UPLOAD_DIR, { recursive: true }); } catch (_) {}
const templateUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TEMPLATE_UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || '').slice(0, 12);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post('/wa-templates/upload', (req, res) => {
  templateUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB).' : 'Upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    res.json({ url: `/uploads/templates/${req.file.filename}`, name: req.file.originalname, size: req.file.size });
  });
});

router.post('/wa-templates', async (req, res) => {
  const source = getSource(req);
  const { name, send_time, day_offset, msg_type, media_url, body, is_active } = req.body || {};
  try {
    const { rows } = await pool.query(
      `INSERT INTO wa_templates (source, name, send_time, day_offset, msg_type, media_url, body, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [source, (name || '').trim(), send_time || '', day_offset || '', msg_type || 'text',
       media_url || '', body || '', is_active !== false]
    );
    res.status(201).json({ template: rows[0] });
  } catch (err) {
    console.error('wa-templates create error:', err.message);
    res.status(500).json({ error: 'Failed to save template.' });
  }
});

router.patch('/wa-templates/:id', async (req, res) => {
  const source = getSource(req);
  const { id } = req.params;
  const fields = ['name', 'send_time', 'day_offset', 'msg_type', 'media_url', 'body', 'is_active'];
  const set = [], vals = [];
  for (const f of fields) if (req.body[f] !== undefined) { vals.push(req.body[f]); set.push(`${f} = $${vals.length}`); }
  if (set.length === 0) return res.status(400).json({ error: 'No fields' });
  vals.push(id); vals.push(source);
  try {
    const { rows } = await pool.query(
      `UPDATE wa_templates SET ${set.join(', ')}, updated_at = NOW() WHERE id = $${vals.length - 1} AND source = $${vals.length} RETURNING *`,
      vals
    );
    res.json({ template: rows[0] });
  } catch (err) {
    console.error('wa-templates update error:', err.message);
    res.status(500).json({ error: 'Failed to update template.' });
  }
});

router.delete('/wa-templates/:id', async (req, res) => {
  const source = getSource(req);
  try {
    await pool.query('DELETE FROM wa_templates WHERE id = $1 AND source = $2', [req.params.id, source]);
    res.json({ success: true });
  } catch (err) {
    console.error('wa-templates delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete.' });
  }
});

/* ── GET /api/admin/wa-templates/:id/history ──
   This month's send history for one template: which WhatsApp groups it was sent
   to (name + invite link), when, and the outcome. Auto-clears logs older than
   the current month on each view, so the History page only ever shows the
   current month ("every month once it auto-clears"). */
router.get('/wa-templates/:id/history', async (req, res) => {
  try {
    // Monthly auto-clear: purge anything before the start of the current month.
    await pool.query("DELETE FROM template_sends WHERE created_at < date_trunc('month', NOW())");
    const { rows } = await pool.query(
      `SELECT group_name, group_link, status, detail, created_at, webinar_key
         FROM template_sends
        WHERE template_id = $1
          AND status = 'sent'
          AND created_at >= date_trunc('month', NOW())
        ORDER BY created_at DESC`,
      [req.params.id]);
    const groups = new Set(rows.map(r => r.group_link || r.group_name).filter(Boolean));
    const month = new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    res.json({ month, group_count: groups.size, total: rows.length, history: rows });
  } catch (err) {
    console.error('wa-templates history error:', err.message);
    res.status(500).json({ error: 'Failed to load history.' });
  }
});

/* ── Create-User form configuration (per-role field on/off + custom fields) ──
   Stored as one JSONB blob: { [role]: { builtins: {field:bool}, custom:
   [{ key, label, type, enabled }] } }. The Users page Create/Edit form reads
   this to show/hide built-in fields and render custom fields. */
router.get('/user-form-config', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT config FROM user_form_config WHERE id = 1');
    res.json({ config: rows[0]?.config || {} });
  } catch (err) {
    console.error('user-form-config get:', err.message);
    res.json({ config: {} });
  }
});

router.put('/user-form-config', async (req, res) => {
  try {
    const config = req.body && req.body.config ? req.body.config : {};
    await pool.query(
      `INSERT INTO user_form_config (id, config, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET config = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(config)]
    );
    res.json({ success: true, config });
  } catch (err) {
    console.error('user-form-config put:', err.message);
    res.status(500).json({ error: 'Failed to save configuration.' });
  }
});

/* ── Workspace on/off flags (Settings → Workspace card) ──
   Stored as one JSONB map { [workspaceId]: boolean }. A workspace is hidden
   from the CRM's workspace switchers only when its value is explicitly false;
   a missing key (e.g. a brand-new workspace) is treated as enabled. */
router.get('/workspace-flags', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT flags FROM workspace_flags WHERE id = 1');
    res.json({ flags: rows[0]?.flags || {} });
  } catch (err) {
    console.error('workspace-flags get:', err.message);
    res.json({ flags: {} });
  }
});

router.put('/workspace-flags', async (req, res) => {
  try {
    const raw = req.body && req.body.flags ? req.body.flags : {};
    // Coerce to a clean { id: bool } map — ignore anything non-boolean.
    const flags = {};
    for (const [k, v] of Object.entries(raw)) flags[k] = v !== false;
    await pool.query(
      `INSERT INTO workspace_flags (id, flags, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET flags = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(flags)]
    );
    res.json({ success: true, flags });
  } catch (err) {
    console.error('workspace-flags put:', err.message);
    res.status(500).json({ error: 'Failed to save workspace settings.' });
  }
});

/* ── GET /api/admin/meta-leadgen-forms ──
   Lists Meta (Facebook) lead-gen forms across all reachable pages, for the
   Meta Temp Timer & Controls form dropdowns. Returns { configured, forms:
   [{ id, name, page_name?, status? }] }. Empty (not an error) when Meta
   isn't configured, so the dropdown can show a graceful "none" state. */
router.get('/meta-leadgen-forms', async (req, res) => {
  if (!metaConfigured()) return res.json({ configured: false, forms: [] });
  try {
    // ?refresh=true bypasses the 30-min cache so a just-created form shows now.
    const force = req.query.refresh === 'true' || req.query.force === 'true';
    const forms = await fetchAllLeadgenForms(force);
    res.json({ configured: true, forms: forms || [] });
  } catch (err) {
    console.error('meta-leadgen-forms error:', err.message);
    res.json({ configured: true, forms: [] });
  }
});

/* ── GET /api/admin/tagmango-memberships ──
   Lists the creator's TagMango "mangos" (memberships) for the TagMango Timer &
   Controls dropdowns — the TagMango analogue of meta-leadgen-forms. Calls the
   TagMango external API server-side (key + whitelabel host from .env, never
   exposed to the browser). Returns { configured, memberships: [{ id, title }] }.
   Empty (not an error) when TagMango isn't configured. */
router.get('/tagmango-memberships', async (_req, res) => {
  const key  = (process.env.TAGMANGO_API_KEY || '').trim();
  const host = (process.env.TAGMANGO_WHITELABEL_HOST || '').trim();
  if (!key || !host) return res.json({ configured: false, memberships: [] });
  try {
    const r = await fetch('https://api-prod-new.tagmango.com/api/v1/external/mangos', {
      headers: { Authorization: `Bearer ${key}`, 'x-whitelabel-host': host },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[tagmango-memberships]', r.status, JSON.stringify(d).slice(0, 200));
      return res.json({ configured: true, memberships: [], error: d.message || `tagmango_${r.status}` });
    }
    // TagMango wraps payloads in `result`; the list may be the array itself or
    // nested under a common key. Normalise id/title defensively.
    const arr = Array.isArray(d.result) ? d.result
      : (d.result?.mangoes || d.result?.mangos || d.result?.data || d.data || []);
    const memberships = (arr || [])
      .filter(m => !m.isDeleted)
      .map(m => ({ id: String(m._id || m.id || ''), title: m.title || m.name || m.mangoName || '(untitled)' }))
      .filter(m => m.id);
    res.json({ configured: true, memberships });
  } catch (err) {
    console.error('tagmango-memberships error:', err.message);
    res.json({ configured: true, memberships: [], error: 'request_failed' });
  }
});

/* ── GET /api/admin/meta-insights?source=meta&from=YYYY-MM-DD&to=YYYY-MM-DD&webinar_at=<iso>&webinar_id=<uuid> ──
   Returns Meta-attributed landing_page_view counts summed across every ad
   account in META_AD_ACCOUNTS. A "landing view" = an ad click that
   successfully loaded our funnel page.

   Response shape:
     {
       configured: bool,
       window: { from, to },
       total_landing_views: int,                  // filtered sum (drives the stat box)
       webinars: [{ webinar_id, name, landing_views }, …]   // per-webinar (always full 180-day attribution)
     }

   Filters:
     • from / to     — narrow the fetched window (defaults to last 180 days)
     • webinar_id    — restrict total to just that webinar
     • webinar_at    — alternate way to pick a webinar (by its date_time)
   The per-webinar `webinars` array is always built from the full 180-day
   window so the per-card metrics stay stable when filters change. */
router.get('/meta-insights', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({ configured: false, webinars: [], total_landing_views: 0 });
  }
  const source = getSource(req);
  const { from, to, webinar_at, webinar_id } = req.query;
  const fmt = d => d.toISOString().slice(0, 10);

  try {
    const today = new Date();
    const defaultFrom = new Date(today); defaultFrom.setDate(defaultFrom.getDate() - 180);
    const fullFromYmd = fmt(defaultFrom);
    const fullToYmd   = fmt(today);

    const filterFromYmd = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : fullFromYmd;
    const filterToYmd   = /^\d{4}-\d{2}-\d{2}$/.test(to   || '') ? to   : fullToYmd;

    const { rows: webinars } = await pool.query(
      `SELECT id AS webinar_id, name, date_time
         FROM webinars
        WHERE source = $1 AND date_time IS NOT NULL
        ORDER BY date_time ASC`,
      [source]
    );

    // Read the admin-selected campaign filter (per source). Empty/null
    // means "include every campaign" — same as today's behaviour.
    let selectedCampaignIds = [];
    try {
      const { rows } = await pool.query(
        'SELECT meta_campaign_ids FROM webinar_config WHERE source = $1',
        [source]
      );
      const stored = rows[0]?.meta_campaign_ids;
      if (Array.isArray(stored)) selectedCampaignIds = stored;
    } catch (_) { /* column may be missing on stale schemas */ }

    // Both LPV and Link Clicks respect the dashboard's date-range filter
    // and the saved campaign selection.
    const dailyFiltered = await fetchLandingViewsByDayFiltered(filterFromYmd, filterToYmd, selectedCampaignIds);
    const byWebinarLpv    = attributeViewsToWebinars(dailyFiltered.lpv,    webinars);
    const byWebinarClicks = attributeViewsToWebinars(dailyFiltered.clicks, webinars);

    function resolveWebinarTotal(map) {
      if (webinar_id) return map[webinar_id] || 0;
      if (webinar_at) {
        const target = webinars.find(w => new Date(w.date_time).getTime() === new Date(webinar_at).getTime());
        return target ? (map[target.webinar_id] || 0) : 0;
      }
      return null; // signal "sum the date range" to caller
    }

    function sumDaily(daily) {
      return Object.values(daily).reduce((s, n) => s + n, 0);
    }

    const total_landing_views = resolveWebinarTotal(byWebinarLpv)    ?? sumDaily(dailyFiltered.lpv);
    const total_link_clicks   = resolveWebinarTotal(byWebinarClicks) ?? sumDaily(dailyFiltered.clicks);

    res.json({
      configured: true,
      window: { from: filterFromYmd, to: filterToYmd },
      total_landing_views,
      total_link_clicks,
      webinars: webinars.map(w => ({
        webinar_id:    w.webinar_id,
        name:          w.name,
        landing_views: byWebinarLpv[w.webinar_id]    || 0,
        link_clicks:   byWebinarClicks[w.webinar_id] || 0,
      })),
    });
  } catch (err) {
    console.error('meta-insights error:', err.message);
    res.status(500).json({ error: 'Failed to load Meta insights.' });
  }
});

/* ── GET /api/admin/sales-performance?from=YYYY-MM-DD&to=YYYY-MM-DD&salesperson_id=<uuid> ──
   Per-salesperson dashboard aggregating lead counts (assigned/hot/warm/
   touched/untouched/enrolled) and call activity (total/incoming/outgoing/
   connected/duration). Trend data (`*_prev`) comes from a same-span window
   shifted back so the frontend can show ▲/▼ arrows.

   Defaults: from = to = today (IST). */
/* ── GET /api/admin/caller-activity/:id?date=YYYY-MM-DD ──
   Returns the chronological activity audit log for one caller for one
   IST day. Used by the Performance grid's Status pill → activity drawer.
   Each row carries: tag, started_at, ended_at, duration_sec, context.
   Open events (ended_at IS NULL) are returned as ongoing — the frontend
   shows them with a live ticking duration. */
router.get('/caller-activity/:id', async (req, res) => {
  const id = String(req.params.id || '');
  // crm_users.id is a UUID — accept the standard 36-char format.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  // Date is the IST calendar day. Default = today (IST).
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const dateYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayYmd;

  // IST day window → UTC bounds. IST is UTC+5:30, so the IST day Y-M-D
  // runs from (Y-M-D 00:00 IST) = (Y-M-D 18:30 prev-UTC) to next-day 18:30 UTC.
  const dayStartUtc = new Date(`${dateYmd}T00:00:00+05:30`);
  const dayEndUtc   = new Date(dayStartUtc.getTime() + 24 * 3600 * 1000);

  try {
    const { rows: caller } = await pool.query(
      'SELECT id, full_name, role, is_active FROM crm_users WHERE id = $1',
      [id]
    );
    if (caller.length === 0) return res.status(404).json({ error: 'caller not found' });

    // Single-tag cutover — pre-redesign rows used three overlapping channels,
    // so a day summed past 24h. Only rows at/after the cutover are returned.
    const { rows: flag } = await pool.query(
      'SELECT applied_at FROM activity_log_redesign_flag ORDER BY applied_at ASC LIMIT 1'
    );
    const cutover = flag[0]?.applied_at
      ? new Date(flag[0].applied_at).toISOString()
      : '1970-01-01T00:00:00.000Z';

    // `day_duration_sec` clamps each event to the selected IST day — the
    // overlap of [started_at, ended_at ?? now] with [dayStart, dayEnd]. This
    // is what the drawer sums, so a span crossing midnight (or an event left
    // open for days) can never inflate the day's totals past 24h.
    const { rows } = await pool.query(
      `SELECT id, tag, started_at, ended_at, duration_sec, context,
              GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(COALESCE(ended_at, NOW()), $3::timestamptz)
                - GREATEST(started_at, $2::timestamptz)
              ))::int) AS day_duration_sec
         FROM caller_activity_events
        WHERE caller_id = $1
          AND started_at < $3
          AND started_at >= $4
          AND (ended_at IS NULL OR ended_at >= $2)
        ORDER BY started_at ASC`,
      [id, dayStartUtc.toISOString(), dayEndUtc.toISOString(), cutover]
    );

    res.json({
      caller: caller[0],
      date: dateYmd,
      day_start: dayStartUtc.toISOString(),
      day_end: dayEndUtc.toISOString(),
      events: rows,
    });
  } catch (err) {
    console.error('[admin] caller-activity error:', err.message);
    res.status(500).json({ error: 'failed to load activity' });
  }
});

/* ── GET /api/admin/sales-performance/leads-export ──
   Returns the deduplicated set of leads that match ANY of the requested
   categories within the date window, optionally scoped to a single
   webinar. Used by the Performance "Export CSV" modal so admins can
   download lead-level rows (not per-caller aggregates) for any
   combination of buckets like hot, warm, touched, connected, etc.

   Each lead appears exactly once. A `matched_categories` array on each
   row shows which buckets that lead falls into. Categories map:
     • assigned     → l.assigned_at in window
     • hot          → l.lead_score >= 4   AND assigned in window
     • warm         → l.lead_score IN (2,3) AND assigned in window
     • touched      → l.last_note_at in window AND assigned in window
     • untouched    → l.last_note_at IS NULL AND l.assigned_at < NOW() - 24h
     • follow_up    → l.last_note_outcome = 'follow_up'
     • total_calls  → has ANY call in window
     • incoming     → has inbound  call in window
     • outgoing     → has outbound call in window
     • connected    → has connected (duration_sec > 0) call in window  */
router.get('/sales-performance/leads-export', async (req, res) => {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const fromYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayYmd;
  const toYmd   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : fromYmd;
  const dayStart = new Date(`${fromYmd}T00:00:00+05:30`).toISOString();
  const dayEnd   = new Date(`${toYmd}T23:59:59.999+05:30`).toISOString();
  const webinarId = req.query.webinar_id ? String(req.query.webinar_id) : null;

  const validCats = new Set([
    'assigned', 'hot', 'warm', 'touched', 'untouched', 'follow_up',
    'total_calls', 'incoming', 'outgoing', 'connected',
    'completed', 'not_picked', 'next_batch',
  ]);
  const requested = String(req.query.categories || '')
    .split(',').map(s => s.trim()).filter(c => validCats.has(c));
  // Dashboard filters (optional): restrict to the visible salespeople and/or a
  // selected team leader, so the export matches exactly what's on screen.
  const callerIds = String(req.query.caller_ids || '')
    .split(',').map(s => s.trim()).filter(s => /^[0-9a-f-]{36}$/i.test(s));
  const tlId = /^[0-9a-f-]{36}$/i.test(req.query.tl_id || '') ? req.query.tl_id : null;

  // Build the per-category boolean expression. Each one tags the lead row
  // with `1` if it matches the bucket, `0` if not. The outer SELECT then
  // returns leads where ANY bucket = 1, and aggregates the matched buckets
  // into a text[] so the CSV can show which categories each lead fell into.
  try {
    const { rows } = await pool.query(
      `
      WITH w AS (
        SELECT $1::timestamptz AS d_start, $2::timestamptz AS d_end
      ),
      base AS (
        SELECT l.*,
               u.full_name AS assigned_to_name,
               u.role      AS assigned_to_role,
               wb.name     AS webinar_name,
               n.patient_age          AS note_age,
               n.location             AS note_location,
               n.working_professional AS note_occupation,
               n.webinar_attended     AS note_webinar_attended,
               n.available_for_webinar AS note_available,
               n.note                 AS note_text
          FROM leads l
          LEFT JOIN crm_users u  ON u.id  = l.assigned_user_id
          LEFT JOIN webinars  wb ON wb.id = l.webinar_id
          LEFT JOIN LATERAL (
            SELECT patient_age, location, working_professional,
                   webinar_attended, available_for_webinar, note
              FROM lead_call_notes ncn
             WHERE ncn.lead_id = l.id
             ORDER BY created_at DESC
             LIMIT 1
          ) n ON TRUE
         WHERE l.assigned_user_id IS NOT NULL
           AND ($3::text IS NULL OR l.webinar_id::text = $3::text)
           AND ($4::uuid[] IS NULL OR l.assigned_user_id = ANY($4::uuid[]))
           AND ($5::uuid  IS NULL OR u.team_leader_id    = $5::uuid)
      ),
      tagged AS (
        SELECT b.*,
               (b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_assigned,
               (b.lead_score >= 4 AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_hot,
               (b.lead_score IN (2,3) AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_warm,
               (b.last_note_at IS NOT NULL AND b.last_note_at >= w.d_start AND b.last_note_at <= w.d_end AND b.assigned_at >= w.d_start AND b.assigned_at <= w.d_end)::int AS c_touched,
               (b.last_note_at IS NULL AND b.assigned_at < NOW() - INTERVAL '24 hours')::int AS c_untouched,
               (b.last_note_outcome = 'follow_up')::int AS c_follow_up,
               (b.last_note_outcome = 'completed')::int AS c_completed,
               (b.last_note_outcome IN ('not_picked','auto_paused'))::int AS c_not_picked,
               (b.next_batch_parked = TRUE)::int AS c_next_batch,
               (EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = b.id AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_total_calls,
               (EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = b.id AND c.direction = 'inbound'  AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_incoming,
               (EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = b.id AND c.direction = 'outbound' AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_outgoing,
               (EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = b.id AND c.duration_sec > 0 AND c.started_at >= w.d_start AND c.started_at <= w.d_end))::int AS c_connected
          FROM base b CROSS JOIN w
      )
      SELECT id, full_name, whatsapp_number, email, language_pref, sugar_level,
             diabetes_duration, lead_score, lead_tag, last_note_outcome,
             next_batch_parked,
             assigned_to_name, assigned_to_role,
             webinar_name, age_group, occupation, source, utm_source, created_at,
             note_age, note_location, note_occupation, note_webinar_attended,
             note_available, note_text,
             assigned_at, last_note_at, completed_at,
             c_assigned, c_hot, c_warm, c_touched, c_untouched, c_follow_up,
             c_completed, c_not_picked, c_next_batch,
             c_total_calls, c_incoming, c_outgoing, c_connected
        FROM tagged
       WHERE ${requested.length ? `(${requested.map(c => `c_${c} = 1`).join(' OR ')})` : 'TRUE'}
       ORDER BY assigned_at DESC NULLS LAST
       LIMIT 50000
      `,
      [dayStart, dayEnd, webinarId, callerIds.length ? callerIds : null, tlId]
    );

    res.json({ leads: rows });
  } catch (err) {
    console.error('[admin] sales-performance/leads-export error:', err.message);
    res.status(500).json({ error: 'failed to load leads' });
  }
});

/* ── GET /api/admin/caller-leads/:callerId ──
   Returns every lead assigned to one caller, grouped client-side by
   bucket. Used by the "Caller page" drawer in the admin so an admin can
   see what the caller sees and reopen completed leads back to assigned.

   Buckets are derived from `last_note_outcome`:
     • assigned   — no outcome yet (or follow_up scheduled in the future)
     • completed  — last_note_outcome IN ('completed','not_interested')
     • not_picked — last_note_outcome IN ('not_picked','auto_paused')
   The frontend re-buckets the same payload so we don't need three queries. */
router.get('/caller-leads/:callerId', async (req, res) => {
  const { callerId } = req.params;
  if (!callerId) return res.status(400).json({ error: 'callerId required' });
  // Workspace scope — keep YT / Meta 2.0 leads off the Meta caller page.
  const source = getSource(req);
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.full_name, l.whatsapp_number, l.email, l.sugar_level,
              l.diabetes_duration, l.on_medication, l.age_group, l.occupation,
              l.lead_score, l.lead_tag, l.last_note_outcome, l.last_note_at,
              l.last_note_interested, l.last_note_outcome_subtag,
              l.follow_up_at, l.completed_at, l.assigned_at, l.created_at,
              l.wa_clicked, l.utm_content, l.next_batch_parked,
              l.webinar_id,
              (l.webinar_id IS NULL OR l.webinar_id IN ${RECENT_WEBINARS_SQL}) AS on_recent_webinar,
              w.name AS webinar_name
         FROM leads l
         LEFT JOIN webinars w ON w.id = l.webinar_id
        WHERE l.assigned_user_id = $1
          AND l.source = $2
        ORDER BY COALESCE(l.last_note_at, l.assigned_at, l.created_at) DESC
        LIMIT 1000`,
      [callerId, source]
    );
    res.json({ leads: rows });
  } catch (err) {
    console.error('[admin] caller-leads error:', err.message);
    res.status(500).json({ error: 'failed to load caller leads' });
  }
});

/* ── GET /api/admin/caller-missed-calls/:callerId ──
   The caller's Missed Calls page (inbound calls that weren't answered), for the
   New Page → Caller page drawer. Mirrors GET /api/caller/calls/missed-inbound
   but scoped to the given callerId (read-only — these are call records, not
   movable leads). */
router.get('/caller-missed-calls/:callerId', async (req, res) => {
  const { callerId } = req.params;
  if (!callerId) return res.status(400).json({ error: 'callerId required' });
  try {
    const { rows: meRows } = await pool.query(
      `SELECT RIGHT(REGEXP_REPLACE(COALESCE(tata_caller_id, ''),    '\\D', '', 'g'), 10) AS caller_did,
              RIGHT(REGEXP_REPLACE(COALESCE(tata_agent_number, ''), '\\D', '', 'g'), 10) AS agent_did
         FROM crm_users WHERE id = $1`,
      [callerId]
    );
    const myDids = [meRows[0]?.caller_did, meRows[0]?.agent_did].filter(d => d && d.length === 10);
    const { rows } = await pool.query(
      `SELECT c.id, c.lead_id, c.status, c.started_at, c.duration_sec, c.recording_url,
              c.caller_phone,
              l.full_name AS lead_full_name, l.whatsapp_number AS lead_phone, l.sugar_level AS lead_sugar_level
         FROM calls c
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.direction = 'inbound'
          AND (c.caller_id = $1 OR (c.caller_id IS NULL AND c.did_number = ANY($2::text[])))
          AND (
            c.status IN ('missed','failed')
            OR (c.status = 'ringing' AND c.started_at < NOW() - INTERVAL '2 minutes')
            OR (c.status = 'ended' AND c.agent_answered_at IS NULL)
          )
        ORDER BY c.started_at DESC NULLS LAST
        LIMIT 200`,
      [callerId, myDids]
    );
    const out = rows.map(r => ({
      id: r.id, lead_id: r.lead_id, is_known: !!r.lead_id,
      full_name: r.lead_full_name || 'Unknown caller',
      phone: (r.caller_phone || r.lead_phone) ? String(r.caller_phone || r.lead_phone).replace(/\D/g, '').slice(-10) : null,
      sugar_level: r.lead_sugar_level, status: r.status,
      started_at: r.started_at, duration_sec: r.duration_sec, recording_url: r.recording_url,
    }));
    res.json({ calls: out, total: out.length });
  } catch (err) {
    console.error('[admin] caller-missed-calls error:', err.message);
    res.status(500).json({ error: 'failed to load missed calls' });
  }
});

/* ── GET /api/admin/caller-calls/:callerId ──
   Full call history (both inbound + outbound) for one caller, newest first,
   each row carrying its recording_url when available. Powers the New Page →
   ⋮ → "View call log" drawer. Read-only — these are call records, not
   movable leads. Recordings play back through /api/caller/recordings/:id
   (the proxy accepts the same ADMIN_PASSWORD bearer via ?token=). */
router.get('/caller-calls/:callerId', async (req, res) => {
  const { callerId } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callerId || '')) {
    return res.status(400).json({ error: 'invalid callerId' });
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.lead_id, c.direction, c.status,
              c.started_at, c.duration_sec, c.recording_url, c.caller_phone,
              l.full_name      AS lead_full_name,
              l.whatsapp_number AS lead_phone,
              l.sugar_level    AS lead_sugar_level
         FROM calls c
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.caller_id = $1
        ORDER BY c.started_at DESC NULLS LAST
        LIMIT $2`,
      [callerId, limit]
    );
    const calls = rows.map(r => ({
      id: r.id,
      lead_id: r.lead_id,
      direction: r.direction || 'outbound',
      status: r.status,
      full_name: r.lead_full_name || 'Unknown',
      phone: (r.caller_phone || r.lead_phone)
        ? String(r.caller_phone || r.lead_phone).replace(/\D/g, '').slice(-10)
        : null,
      sugar_level: r.lead_sugar_level,
      started_at: r.started_at,
      duration_sec: r.duration_sec,
      recording_url: r.recording_url,
      has_recording: !!r.recording_url,
    }));
    res.json({ calls, total: calls.length });
  } catch (err) {
    console.error('[admin] caller-calls error:', err.message);
    res.status(500).json({ error: 'failed to load calls' });
  }
});

/* ── GET /api/admin/caller-active-call/:callerId ──
   The caller's CURRENT in-progress call (if any), for the live monitor at
   the top of the "View call log" drawer. A call is "live" when it hasn't
   ended and is still ringing/answered within a recent window (the 30-min
   guard stops a stale 'answered' row — one whose ended webhook never
   arrived — from showing as live forever; in prod staleCallReaper closes
   these, but the guard makes the panel correct even when it doesn't). */
router.get('/caller-active-call/:callerId', async (req, res) => {
  const { callerId } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callerId || '')) {
    return res.status(400).json({ error: 'invalid callerId' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.direction, c.status, c.started_at, c.answered_at,
              c.agent_answered_at, c.provider_call_id, c.caller_phone,
              l.full_name      AS lead_full_name,
              l.whatsapp_number AS lead_phone
         FROM calls c
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.caller_id = $1
          AND c.ended_at IS NULL
          AND c.status IN ('initiated','ringing','answered')
          AND c.started_at > NOW() - INTERVAL '30 minutes'
        ORDER BY c.started_at DESC
        LIMIT 1`,
      [callerId]
    );
    if (rows.length === 0) return res.json({ active: null });
    const r = rows[0];
    const connected = r.status === 'answered' || !!r.agent_answered_at;
    res.json({
      active: {
        id: r.id,
        direction: r.direction || 'outbound',
        status: r.status,
        connected,
        full_name: r.lead_full_name || 'Unknown',
        phone: (r.caller_phone || r.lead_phone)
          ? String(r.caller_phone || r.lead_phone).replace(/\D/g, '').slice(-10)
          : null,
        started_at: r.started_at,
        // Tick the live timer from when the conversation actually connected,
        // falling back to ring-start so a ringing call still shows elapsed time.
        since: r.answered_at || r.agent_answered_at || r.started_at,
        provider_call_id: r.provider_call_id,
      },
    });
  } catch (err) {
    console.error('[admin] caller-active-call error:', err.message);
    res.status(500).json({ error: 'failed to load active call' });
  }
});

/* ── POST /api/admin/caller-active-call/:callerId/monitor ──
   Supervisor LIVE LISTEN on the caller's in-progress call (Smartflo Monitor,
   type=1 — silent, the agent & customer don't know). Smartflo rings the
   supervisor's own Smartflo number (`supervisor_number`) and bridges them in to
   listen. The monitor uses the CALLER's Smartflo account (the live call_id lives
   there). Body: { supervisor_number }. */
router.post('/caller-active-call/:callerId/monitor', async (req, res) => {
  const { callerId } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callerId || '')) {
    return res.status(400).json({ error: 'invalid callerId' });
  }
  const supNum = String(req.body?.supervisor_number || '').replace(/\D/g, '');
  if (supNum.length < 10) {
    return res.status(400).json({ error: 'Enter your Smartflo number first — that phone will ring so you can listen.' });
  }
  try {
    // The live call belongs to the caller's Smartflo account — monitor with
    // that same account's API key, and grab the live provider_call_id.
    const { rows } = await pool.query(
      `SELECT c.provider_call_id, u.tata_account_type, u.tata_smartflo_api_key
         FROM calls c
         JOIN crm_users u ON u.id = c.caller_id
        WHERE c.caller_id = $1
          AND c.ended_at IS NULL
          AND c.status IN ('initiated','ringing','answered')
          AND c.started_at > NOW() - INTERVAL '30 minutes'
        ORDER BY c.started_at DESC
        LIMIT 1`,
      [callerId]
    );
    const live = rows[0];
    if (!live || !live.provider_call_id) {
      return res.status(409).json({ error: 'No live call to listen to right now.' });
    }
    const result = await tata.monitorCall({
      callId:      live.provider_call_id,
      agentId:     supNum,
      accountType: live.tata_account_type || undefined,
      perUserKey:  live.tata_smartflo_api_key || undefined,
    });
    res.json({ ok: true, raw: result.raw });
  } catch (err) {
    console.error('[admin] caller-active-call monitor error:', err.message);
    const status = err.status && err.status < 500 ? err.status : 502;
    res.status(status).json({ error: err.message || 'Live listen failed — try again.' });
  }
});

/* ── GET /api/admin/tata-numbers?days=7 ──
   Each caller's Tata Tele number (the outbound DID shown to customers) plus a
   SPAM-RISK signal. Tata exposes no spam flag — but when a DID gets flagged as
   spam, customers stop answering, so its pickup (answer) rate collapses. We
   surface that rate over the window and classify:
     healthy      → answer rate ≥ 30%
     at_risk      → 15% ≤ rate < 30%
     likely_spam  → rate < 15% (with enough volume)
     no_data      → fewer than MIN_CALLS dials in the window
   Thresholds are heuristic, not a guarantee — a low rate strongly correlates
   with a flagged DID but can also mean a bad lead batch. */
router.get('/tata-numbers', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const MIN_CALLS = 10;   // below this we don't judge — too little signal
  try {
    const { rows } = await pool.query(`
      WITH stats AS (
        SELECT c.caller_id,
               COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS dialed,
               COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL)::int AS answered,
               MAX(c.started_at) AS last_call_at
          FROM calls c
         WHERE c.caller_id IS NOT NULL
           AND c.started_at > NOW() - make_interval(days => $1)
         GROUP BY c.caller_id
      )
      SELECT u.id, u.full_name, u.role,
             u.tata_caller_id, u.tata_agent_number, u.tata_extension, u.tata_account_type,
             u.is_active,
             COALESCE(s.dialed, 0)   AS dialed,
             COALESCE(s.answered, 0) AS answered,
             s.last_call_at
        FROM crm_users u
        LEFT JOIN stats s ON s.caller_id = u.id
       WHERE u.deleted_at IS NULL
         AND (u.tata_caller_id IS NOT NULL OR u.tata_agent_number IS NOT NULL OR u.tata_extension IS NOT NULL)
       ORDER BY u.full_name ASC
    `, [days]);

    const numbers = rows.map(r => {
      const dialed = Number(r.dialed) || 0;
      const answered = Number(r.answered) || 0;
      const rate = dialed > 0 ? Math.round((answered / dialed) * 100) : null;
      let risk;
      if (dialed < MIN_CALLS) risk = 'no_data';
      else if (rate < 15)     risk = 'likely_spam';
      else if (rate < 30)     risk = 'at_risk';
      else                    risk = 'healthy';
      return {
        caller_id: r.id, name: r.full_name, role: r.role, is_active: r.is_active,
        did: r.tata_caller_id || null,
        agent_number: r.tata_agent_number || null,
        extension: r.tata_extension || null,
        account_type: r.tata_account_type || null,
        dialed, answered, answer_rate: rate, risk,
        last_call_at: r.last_call_at || null,
      };
    });
    res.json({ days, min_calls: MIN_CALLS, numbers, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error('[admin] tata-numbers error:', err.message);
    res.status(500).json({ error: 'Failed to load Tata numbers.' });
  }
});

/* ── POST /api/admin/leads/reopen ──
   Bulk-reopen leads — moves them back to the caller's Assigned bucket
   by clearing every closing-state column (outcome, follow_up, completed_at).
   Mirrors the existing caller-side reopen path used by /caller/leads/reopen
   but accepts an explicit list of IDs so the admin can pick exactly which
   completed leads to bring back to active.

   Body: { lead_ids: ["uuid", "uuid", ...] }
   Returns: { reopened: <count> }
*/
router.post('/leads/reopen', async (req, res) => {
  const ids = Array.isArray(req.body?.lead_ids)
    ? req.body.lead_ids.filter(x => typeof x === 'string' && x.length > 0)
    : [];
  if (ids.length === 0) return res.status(400).json({ error: 'lead_ids required' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE leads
          SET last_note_outcome        = NULL,
              last_note_interested     = NULL,
              last_note_outcome_subtag = NULL,
              last_note_at             = NULL,
              follow_up_at             = NULL,
              completed_at             = NULL,
              assigned_at              = NOW(),
              pinned_at                = NOW(),
              -- Fresh assignment ⇒ no tag. Tag is reapplied by the
              -- LeadCallNoteModal classifier only AFTER the next call's
              -- form is submitted. Without this reset, the badge from the
              -- previous completion (HOT/WARM/COLD/JUNK) would linger
              -- through the new Assigned cycle and mislead the caller.
              lead_tag                 = NULL
        WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    res.json({ reopened: rowCount });
  } catch (err) {
    console.error('[admin] leads/reopen error:', err.message);
    res.status(500).json({ error: 'failed to reopen leads' });
  }
});

/* ── POST /api/admin/leads/move ──
   Admin lead mover (New Page → Caller page drawer). Moves a list of leads to a
   target bucket (rewrites their state columns) and/or reassigns them to another
   caller (assigned_user_id). Either or both may be supplied. This only touches
   lead data — it does NOT change any caller's interface.

   Body: { lead_ids: ["uuid",...],
           target_bucket?: 'assigned'|'completed'|'not_picked'|'next_batch'|'untouched',
           target_caller_id?: "uuid" }
   Returns: { moved: <count> }
*/
router.post('/leads/move', async (req, res) => {
  const ids = Array.isArray(req.body?.lead_ids)
    ? req.body.lead_ids.filter(x => typeof x === 'string' && x.length > 0)
    : [];
  const targetBucket = req.body?.target_bucket || null;
  const targetCaller = (typeof req.body?.target_caller_id === 'string' && req.body.target_caller_id)
    ? req.body.target_caller_id : null;
  if (ids.length === 0) return res.status(400).json({ error: 'lead_ids required' });
  if (!targetBucket && !targetCaller) return res.status(400).json({ error: 'target_bucket or target_caller_id required' });

  // column → raw SQL value. The bucket keywords/strings are controlled here
  // (NOT user input) so they're safe to inline; only the caller id + ids are
  // bound parameters.
  const cols = {};
  if (targetBucket === 'assigned') {
    // A lead that was ALREADY worked (has any outcome — e.g. moved back from
    // Completed / Not Picked) returns as a "2nd call" follow-up due now and
    // KEEPS its lead_tag, so it shows as a completed/returning call rather than
    // a brand-new lead. A never-worked lead (no outcome) stays genuinely fresh.
    Object.assign(cols, {
      last_note_outcome: `CASE WHEN last_note_outcome IS NOT NULL THEN 'follow_up' ELSE NULL END`,
      follow_up_at:      `CASE WHEN last_note_outcome IS NOT NULL THEN NOW() ELSE NULL END`,
      completed_at:      'NULL',
      next_batch_parked: 'FALSE',
      assigned_at:       'NOW()',
      pinned_at:         'NOW()',
      // lead_tag / last_note_interested / last_note_outcome_subtag / last_note_at
      // are intentionally PRESERVED so the completed-call classification survives.
    });
  } else if (targetBucket === 'completed') {
    Object.assign(cols, {
      last_note_outcome: `'completed'`, completed_at: 'NOW()', last_note_at: 'NOW()',
      follow_up_at: 'NULL', next_batch_parked: 'FALSE',
    });
  } else if (targetBucket === 'not_picked') {
    Object.assign(cols, {
      last_note_outcome: `'not_picked'`, last_note_at: 'NOW()',
      completed_at: 'NULL', follow_up_at: 'NULL', next_batch_parked: 'FALSE',
    });
  } else if (targetBucket === 'next_batch') {
    Object.assign(cols, { next_batch_parked: 'TRUE', next_batch_parked_at: 'NOW()' });
  } else if (targetBucket === 'untouched') {
    // Reset to a fresh, no-outcome state and drop any park/pin so the lead
    // re-enters Untouched (when it's on a past webinar) or Assigned (recent).
    Object.assign(cols, {
      last_note_outcome: 'NULL', completed_at: 'NULL', follow_up_at: 'NULL',
      next_batch_parked: 'FALSE', pinned_at: 'NULL',
    });
  } else if (targetBucket) {
    return res.status(422).json({ error: 'invalid target_bucket' });
  }

  const params = [];
  if (targetCaller) {
    params.push(targetCaller);
    cols.assigned_user_id = `$${params.length}`;
    if (!cols.assigned_at) cols.assigned_at = 'NOW()';
  }
  const setClause = Object.entries(cols).map(([k, v]) => `${k} = ${v}`).join(', ');
  params.push(ids);
  try {
    const { rowCount } = await pool.query(
      `UPDATE leads SET ${setClause} WHERE id = ANY($${params.length}::uuid[])`,
      params
    );
    // Caller-report (cumulative): a move INTO the Assigned page, or a reassign to
    // another caller, is an assignment EVENT — log it as kind='reassign' so the
    // "Assigned" count goes up (and never down). "Actual Leads" ignores these
    // (only kind='fresh' counts). Best-effort; never fail the move on log error.
    if (targetBucket === 'assigned' || targetCaller) {
      pool.query(
        `INSERT INTO lead_assignments (lead_id, caller_id, webinar_id, reason, kind)
         SELECT l.id, l.assigned_user_id, l.webinar_id, 'admin_move', 'reassign'
           FROM leads l
          WHERE l.id = ANY($1::uuid[])
            AND l.assigned_user_id IS NOT NULL
            AND l.webinar_id IS NOT NULL`,
        [ids]
      ).catch(e => console.error('[admin] leads/move assignment-log error:', e.message));
    }
    res.json({ moved: rowCount });
  } catch (err) {
    console.error('[admin] leads/move error:', err.message);
    res.status(500).json({ error: 'failed to move leads' });
  }
});

router.get('/sales-performance', async (req, res) => {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const fromYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayYmd;
  const toYmd   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : fromYmd;
  const salespersonId = req.query.salesperson_id || null;

  // Current window
  const dayStart = new Date(`${fromYmd}T00:00:00+05:30`).toISOString();
  const dayEnd   = new Date(`${toYmd}T23:59:59.999+05:30`).toISOString();

  // Previous window of the same span (inclusive day count)
  const spanDays = Math.max(1, Math.round(
    (new Date(`${toYmd}T00:00:00+05:30`) - new Date(`${fromYmd}T00:00:00+05:30`)) / 86_400_000
  ) + 1);
  const prevToDate = new Date(`${fromYmd}T00:00:00+05:30`);
  prevToDate.setDate(prevToDate.getDate() - 1);
  const prevFromDate = new Date(prevToDate);
  prevFromDate.setDate(prevFromDate.getDate() - (spanDays - 1));
  const prevStart = new Date(prevFromDate.setHours(0, 0, 0, 0)).toISOString();
  const prevEnd   = new Date(prevToDate.setHours(23, 59, 59, 999)).toISOString();

  const params = [dayStart, dayEnd, prevStart, prevEnd];
  let salespersonFilter = '';
  if (salespersonId) {
    params.push(salespersonId);
    salespersonFilter = `WHERE cb.caller_id = $${params.length}`;
  }
  // Optional webinar filter — scopes lead + call aggregates to a single
  // webinar so each caller row reflects their numbers for that batch only.
  // We compare as text so the column's underlying type (BIGINT vs UUID)
  // doesn't matter to the SQL.
  const webinarId = req.query.webinar_id ? String(req.query.webinar_id) : null;
  params.push(webinarId);
  const webinarParamIdx = params.length;  // e.g. $5 if no salesperson filter
  // Workspace scope — with "All webinars" (no webinar_id) keep the report
  // within this source; YT / Meta 2.0 leads & their calls never count here.
  const source = getSource(req);
  params.push(source);
  const sourceParamIdx = params.length;

  try {
    // Predicted-enrollments coefficient: enrolled-hot / total-hot over last 30 days, globally.
    const ratioRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN last_note_outcome = 'completed' AND lead_score >= 4 THEN 1 ELSE 0 END), 0)::float
        / NULLIF(SUM(CASE WHEN lead_score >= 4 THEN 1 ELSE 0 END), 0) AS ratio
      FROM leads
      WHERE assigned_at >= NOW() - INTERVAL '30 days'
    `);
    const hotToEnrollRatio = ratioRes.rows[0]?.ratio ?? 0;

    const { rows } = await pool.query(`
      WITH w AS (
        SELECT $1::timestamptz AS d_start, $2::timestamptz AS d_end,
               $3::timestamptz AS p_start, $4::timestamptz AS p_end
      ),
      caller_base AS (
        -- Include paused (is_active = FALSE) callers in the result so the
        -- admin's Sales Performance kebab can show a Paused pill and a
        -- Resume action. The frontend reads is_active per row.
        -- Soft-deleted callers (deleted_at IS NOT NULL) are excluded —
        -- they shouldn't appear in the grid even though their historical
        -- calls / leads still reference them.
        -- Also surfaces the heartbeat columns so the Status column can render
        -- live green/orange/red badges per caller.
        SELECT u.id AS caller_id, u.full_name AS name, u.role, u.is_active,
               u.last_heartbeat_at, u.activity_status, u.activity_break,
               u.rest_started_at
          FROM crm_users u
         WHERE u.role IN ('junior_caller','senior_caller','team_leader','manager')
           AND u.deleted_at IS NULL
      ),
      lead_agg AS (
        -- Per-caller lead counts mirror each caller-side page exactly
        -- (Assigned / Completed / Untouched / etc.). These are
        -- CURRENT-STATE metrics, NOT date-windowed, so admins see the
        -- same number on the dashboard as the caller sees on their
        -- own page. The only exception is the enrolled field (still
        -- date-windowed for the conversion-rate / predicted-enrollments
        -- math the dashboard renders alongside the per-caller cards).
        SELECT l.assigned_user_id AS caller_id,
               -- ASSIGNED: leads on caller's Assigned page right now.
               COUNT(*) FILTER (
                 WHERE l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IS NULL
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()))
                   AND (l.webinar_id IS NULL OR l.webinar_id IN ${RECENT_WEBINARS_SQL})
               )::int AS assigned,
               -- HOT / WARM: leads on Completed page whose lead_tag
               -- (set by classifyLeadTag) matches.
               COUNT(*) FILTER (
                 WHERE l.lead_tag = 'HOT'
                   AND l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IN ('completed','not_interested','incomplete')
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW()))
               )::int AS hot,
               COUNT(*) FILTER (
                 WHERE l.lead_tag = 'WARM'
                   AND l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IN ('completed','not_interested','incomplete')
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW()))
               )::int AS warm,
               -- TOUCHED: total count of rows on caller's Completed
               -- Calls page. Mirrors GET /api/caller/leads/completed.
               COUNT(*) FILTER (
                 WHERE l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IN ('completed','not_interested','incomplete')
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW()))
               )::int AS touched,
               -- UNTOUCHED: count of caller's Untouched Leads page
               -- (uncompleted leads on OLDER webinars). Mirrors
               -- GET /api/caller/leads/untouched.
               COUNT(*) FILTER (
                 WHERE l.next_batch_parked = FALSE
                   AND (l.last_note_outcome IS NULL
                        OR (l.last_note_outcome = 'follow_up' AND l.follow_up_at <= NOW()))
                   AND l.webinar_id IS NOT NULL
                   AND l.webinar_id NOT IN ${RECENT_WEBINARS_SQL}
               )::int AS untouched,
               -- FOLLOW-UPS: leads currently scheduled to come back as
               -- a follow-up. Shows up on caller's Completed page until
               -- follow_up_at hits, then moves to Assigned.
               COUNT(*) FILTER (
                 WHERE l.last_note_outcome = 'follow_up'
                   AND l.follow_up_at > NOW()
                   AND l.next_batch_parked = FALSE
               )::int AS followups,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed' AND l.completed_at >= w.d_start AND l.completed_at <= w.d_end)::int AS enrolled,
               -- INCOMPLETE: leads on Completed page with the
               -- "incomplete" outcome (caller was paused / disconnected
               -- mid-form). Current-state count, no date filter.
               COUNT(*) FILTER (
                 WHERE l.last_note_outcome = 'incomplete'
                   AND l.next_batch_parked = FALSE
               )::int AS incomplete
          FROM leads l CROSS JOIN w
         WHERE l.assigned_user_id IS NOT NULL
           AND ($${webinarParamIdx}::text IS NULL OR l.webinar_id::text = $${webinarParamIdx}::text)
           AND ($${webinarParamIdx}::text IS NOT NULL OR l.source = $${sourceParamIdx}::text)
         GROUP BY l.assigned_user_id
      ),
      lead_prev AS (
        SELECT l.assigned_user_id AS caller_id,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed' AND l.completed_at >= w.p_start AND l.completed_at <= w.p_end)::int AS enrolled_prev,
               COUNT(*) FILTER (WHERE l.assigned_at >= w.p_start AND l.assigned_at <= w.p_end)::int AS assigned_prev
          FROM leads l CROSS JOIN w
         WHERE l.assigned_user_id IS NOT NULL
           AND ($${webinarParamIdx}::text IS NULL OR l.webinar_id::text = $${webinarParamIdx}::text)
           AND ($${webinarParamIdx}::text IS NOT NULL OR l.source = $${sourceParamIdx}::text)
         GROUP BY l.assigned_user_id
      ),
      call_agg AS (
        SELECT c.caller_id,
               -- TOTAL CALLS: every outbound dial including ones that
               -- never connected (missed by agent OR customer). Date-
               -- windowed since calls accrue over time.
               COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS total_calls,
               -- CONNECTED: outbound calls where Tata stamped
               -- customer_answered_at (true customer pickup, not
               -- agent-only-leg).
               COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL)::int AS connected,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound'), 0)::int AS total_duration_sec,
               MAX(c.started_at) FILTER (WHERE c.direction = 'outbound') AS last_call_at
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.webinar_id::text = $${webinarParamIdx}::text
               ))
           AND ($${webinarParamIdx}::text IS NOT NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.source = $${sourceParamIdx}::text
               ))
         GROUP BY c.caller_id
      ),
      -- INCOMING: count of rows in the caller's Missed Calls page.
      -- Mirrors GET /api/caller/calls/missed-inbound. Current-state
      -- count (no date filter) so the dashboard reflects whatever
      -- the caller would see on that page right now.
      missed_in_agg AS (
        SELECT c.caller_id, COUNT(*)::int AS incoming
          FROM calls c
         WHERE c.caller_id IS NOT NULL
           AND c.direction = 'inbound'
           AND (
             c.status IN ('missed','failed')
             OR (c.status = 'ringing' AND c.started_at < NOW() - INTERVAL '2 minutes')
             OR (c.status = 'ended' AND c.agent_answered_at IS NULL)
           )
         GROUP BY c.caller_id
      ),
      -- 1ST / 2ND CALL TRIGGERED: ROW_NUMBER() over (lead_id) ranks
      -- outbound calls in time order. attempt_num=1 = the original
      -- trigger, attempt_num=2 = the auto-redial (agent_ringing_2
      -- flow). We count how many calls answered the customer at each
      -- attempt level, per caller, within the date window.
      attempt_ranked AS (
        SELECT c.id, c.caller_id, c.lead_id, c.customer_answered_at,
               c.started_at, c.direction,
               ROW_NUMBER() OVER (PARTITION BY c.lead_id ORDER BY c.started_at) AS attempt_num
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.direction = 'outbound'
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.webinar_id::text = $${webinarParamIdx}::text
               ))
           AND ($${webinarParamIdx}::text IS NOT NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.source = $${sourceParamIdx}::text
               ))
      ),
      attempt_agg AS (
        SELECT caller_id,
               COUNT(*) FILTER (WHERE attempt_num = 1 AND customer_answered_at IS NOT NULL)::int AS first_call_answered,
               COUNT(*) FILTER (WHERE attempt_num = 2 AND customer_answered_at IS NOT NULL)::int AS second_call_answered
          FROM attempt_ranked
         GROUP BY caller_id
      ),
      call_prev AS (
        SELECT c.caller_id,
               COUNT(*)::int AS total_calls_prev
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.p_start AND c.started_at <= w.p_end
           AND ($${webinarParamIdx}::text IS NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.webinar_id::text = $${webinarParamIdx}::text
               ))
           AND ($${webinarParamIdx}::text IS NOT NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id
                    AND ll.source = $${sourceParamIdx}::text
               ))
         GROUP BY c.caller_id
      )
      SELECT cb.caller_id, cb.name, cb.role, cb.is_active,
             cb.last_heartbeat_at, cb.activity_status, cb.activity_break, cb.rest_started_at,
             COALESCE(la.assigned, 0)            AS assigned,
             COALESCE(la.hot, 0)                 AS hot,
             COALESCE(la.warm, 0)                AS warm,
             COALESCE(la.touched, 0)             AS touched,
             COALESCE(la.untouched, 0)           AS untouched,
             COALESCE(la.followups, 0)           AS followups,
             COALESCE(la.incomplete, 0)          AS incomplete,
             COALESCE(ca.total_calls, 0)         AS total_calls,
             COALESCE(mi.incoming, 0)            AS incoming,
             COALESCE(ca.connected, 0)           AS connected,
             COALESCE(ca.total_duration_sec, 0)  AS total_duration_sec,
             ca.last_call_at                     AS last_call_at,
             COALESCE(la.enrolled, 0)            AS enrolled,
             COALESCE(lp.enrolled_prev, 0)       AS enrolled_prev,
             COALESCE(cp.total_calls_prev, 0)    AS total_calls_prev,
             -- Per-attempt customer-pickup counts.
             COALESCE(att.first_call_answered, 0)  AS first_call_answered,
             COALESCE(att.second_call_answered, 0) AS second_call_answered
        FROM caller_base cb
        LEFT JOIN lead_agg  la ON la.caller_id = cb.caller_id
        LEFT JOIN lead_prev lp ON lp.caller_id = cb.caller_id
        LEFT JOIN call_agg     ca  ON ca.caller_id  = cb.caller_id
        LEFT JOIN call_prev    cp  ON cp.caller_id  = cb.caller_id
        LEFT JOIN missed_in_agg mi ON mi.caller_id = cb.caller_id
        LEFT JOIN attempt_agg  att ON att.caller_id = cb.caller_id
        ${salespersonFilter}
       ORDER BY enrolled DESC, name ASC
    `, params);

    // Compute derived percentages + team totals in JS to keep the SQL simple.
    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

    const enrichedRows = rows.map(r => ({
      ...r,
      conversion_pct:      pct(r.enrolled, r.assigned),
      connection_rate_pct: pct(r.connected, r.total_calls),
      avg_duration_sec:    r.connected > 0 ? Math.round(r.total_duration_sec / r.connected) : 0,
      conversion_pct_prev: pct(r.enrolled_prev, r.assigned_prev || 0),
    }));

    const sum = (k) => enrichedRows.reduce((s, r) => s + (r[k] || 0), 0);
    const teamAssigned   = sum('assigned');
    const teamConnected  = sum('connected');
    const teamCalls      = sum('total_calls');
    const teamDuration   = sum('total_duration_sec');
    const teamEnrolled   = sum('enrolled');

    const team_totals = {
      assigned:            teamAssigned,
      hot:                 sum('hot'),
      warm:                sum('warm'),
      touched:             sum('touched'),
      untouched:           sum('untouched'),
      followups:           sum('followups'),
      incomplete:          sum('incomplete'),
      total_calls:         teamCalls,
      incoming:            sum('incoming'),
      connected:           teamConnected,
      total_duration_sec:  teamDuration,
      enrolled:            teamEnrolled,
      first_call_answered:  sum('first_call_answered'),
      second_call_answered: sum('second_call_answered'),
      conversion_pct:      pct(teamEnrolled, teamAssigned),
      connection_rate_pct: pct(teamConnected, teamCalls),
      avg_duration_sec:    teamConnected > 0 ? Math.round(teamDuration / teamConnected) : 0,
    };

    res.json({
      rows: enrichedRows,
      team_totals,
      hot_to_enroll_ratio: hotToEnrollRatio,
      window: { from: fromYmd, to: toYmd, prev_from: prevStart.slice(0, 10), prev_to: prevEnd.slice(0, 10) },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('sales-performance error:', err.message);
    res.status(500).json({ error: 'Failed to load sales performance.' });
  }
});

/* ── GET /api/admin/caller-report?from=YYYY-MM-DD&to=YYYY-MM-DD&webinar_id=<id> ──
   "Caller 360" combined report — one row per caller merging telephony activity
   (the Intern Hourly Report) with lead-disposition breakdown (the Lead Outcome
   Report). Returns RAW atoms (per-outcome / per-subtag counts); the frontend
   composes the human-facing categories + conversion % (see
   crm/frontend/src/modules/callerReportCategories.js) so the business rules for
   a few fuzzy categories can be tuned without touching SQL.

   `from`/`to` are IST day bounds and drive the CALL activity window. An optional
   `webinar_id` scopes BOTH the calls and the lead dispositions to one webinar /
   batch. TL / salesperson / category filtering is done client-side (same as the
   Performance tab) so this endpoint just returns every caller. */
router.get('/caller-report', async (req, res) => {
  const istNow   = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayYmd = istNow.toISOString().slice(0, 10);
  const fromYmd  = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayYmd;
  const toYmd    = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to   || '') ? req.query.to   : fromYmd;
  // Optional time-of-day filter (HH:MM, IST). Defaults to the whole day, so
  // omitting them keeps the previous full-day behaviour.
  const fromTime = /^\d{2}:\d{2}$/.test(req.query.from_time || '') ? req.query.from_time : '00:00';
  const toTime   = /^\d{2}:\d{2}$/.test(req.query.to_time   || '') ? req.query.to_time   : '23:59';
  const dayStart = new Date(`${fromYmd}T${fromTime}:00+05:30`).toISOString();
  const dayEnd   = new Date(`${toYmd}T${toTime}:59.999+05:30`).toISOString();
  const webinarId = req.query.webinar_id ? String(req.query.webinar_id) : null;
  // Workspace scope. With "All webinars" (no webinar_id) the report must stay
  // within the current workspace's source — otherwise a caller who also works
  // YT / Meta 2.0 leads would have those counted on the Meta page. Defaults to
  // 'meta' (see getSource), or 'all' to aggregate every workspace (the
  // Web Reminder workspace filter). Each source/workspace condition below is
  // guarded with `$4 = 'all' OR …` so a concrete source behaves as before.
  const source = getReportSource(req);
  const params = [dayStart, dayEnd, webinarId, source]; // $1, $2, $3, $4

  try {
    const { rows } = await pool.query(`
      WITH w AS (
        SELECT $1::timestamptz AS d_start, $2::timestamptz AS d_end
      ),
      caller_base AS (
        -- Report shows only the callers themselves (junior + senior) —
        -- team leaders and managers are intentionally excluded.
        SELECT u.id AS caller_id, u.full_name AS name, u.role, u.is_active,
               u.tata_extension, u.team_leader_id,
               u.activity_status, u.last_heartbeat_at, u.activity_break, u.rest_started_at
          FROM crm_users u
         WHERE u.role IN ('junior_caller','senior_caller')
           AND u.deleted_at IS NULL
           -- Workspace scope: only this source's callers (plus untagged).
           AND ($4::text = 'all' OR u.workspace IS NULL OR u.workspace = $4::text)
      ),
      call_agg AS (
        -- Telephony activity, date-windowed, outbound only. "answered" =
        -- customer truly picked up (customer_answered_at), matching the
        -- Performance tab's "connected" definition.
        SELECT c.caller_id,
               COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS touched,
               COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL)::int AS answered,
               COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NULL)::int AS missed,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL), 0)::int AS answered_dur_sec,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NULL), 0)::int AS missed_dur_sec,
               COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'outbound'), 0)::int AS total_dur_sec
          FROM calls c CROSS JOIN w
         WHERE c.caller_id IS NOT NULL
           AND c.started_at >= w.d_start AND c.started_at <= w.d_end
           AND ($3::text IS NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id AND ll.webinar_id::text = $3::text
               ))
           -- With no specific webinar, keep activity within the workspace
           -- source: only count calls tied to a lead of this source.
           AND ($3::text IS NOT NULL OR EXISTS (
                 SELECT 1 FROM leads ll
                  WHERE ll.id = c.lead_id AND ($4::text = 'all' OR ll.source = $4::text)
               ))
         GROUP BY c.caller_id
      ),
      note_agg AS (
        -- CUMULATIVE work from call-note HISTORY (lead_call_notes is append-only),
        -- date-windowed by the note's created_at. Grouped by the caller WHO DID
        -- the work, so re-worked / reassigned leads are counted again and totals
        -- only ever rise within the window. Drives Touched, Answered, Interested,
        -- Hot/Warm/Cold/Junk, DNP, and every subtag.
        SELECT n.caller_id,
               COUNT(*)::int AS touched,
               COUNT(*) FILTER (WHERE n.outcome IN ('completed','follow_up'))::int AS answered,
               COUNT(*) FILTER (WHERE n.lead_tag = 'HOT')::int  AS hot,
               COUNT(*) FILTER (WHERE n.lead_tag = 'WARM')::int AS warm,
               COUNT(*) FILTER (WHERE n.lead_tag = 'COLD')::int AS cold,
               COUNT(*) FILTER (WHERE n.lead_tag = 'JUNK')::int AS junk,
               COUNT(*) FILTER (WHERE n.lead_tag IN ('HOT','WARM','COLD'))::int AS interested,
               COUNT(*) FILTER (WHERE n.outcome = 'not_picked')::int AS o_not_picked,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'other_languages')::int          AS st_other_languages,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'already_paid')::int             AS st_already_paid,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'not_available_for_webinar')::int AS st_not_available_for_webinar,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'no_diabetes')::int              AS st_no_diabetes,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'no_sugar_interested')::int      AS st_no_sugar_interested,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'no_sugar_not_interested')::int  AS st_no_sugar_not_interested,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'not_register')::int             AS st_not_register,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'just_for_knowledge')::int       AS st_just_for_knowledge,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'call_disconnected')::int        AS st_call_disconnected,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'wrong_number')::int             AS st_wrong_number,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'already_attended')::int         AS st_already_attended,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'switch_off')::int               AS st_switch_off,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'out_of_service')::int           AS st_out_of_service,
               COUNT(*) FILTER (WHERE n.outcome_subtag = 'no_ring')::int                  AS st_no_ring
          FROM lead_call_notes n CROSS JOIN w
          JOIN leads l ON l.id = n.lead_id
         WHERE n.caller_id IS NOT NULL
           AND n.created_at >= w.d_start AND n.created_at <= w.d_end
           AND ($3::text IS NULL OR l.webinar_id::text = $3::text)
           AND ($3::text IS NOT NULL OR $4::text = 'all' OR l.source = $4::text)
         GROUP BY n.caller_id
      ),
      break_agg AS (
        -- BREAK / not-making-auto-call time per caller, OFFICE HOURS ONLY
        -- (9 AM-6 PM IST), summed over the report window. "Working" tags
        -- (ON_CALL / IN_FORM / REASON_CARD / EDITING_COMPLETED) are excluded;
        -- everything else the caller sits in while logged in counts as break:
        -- ON_BREAK, BREAK_PICKER, BLOCKED, PAUSED_BY_ADMIN, and the idle ON_PAGE_*
        -- tabs (sitting on a page, not auto-calling). Each span is clipped to BOTH
        -- the report window AND the 9-18 IST office window of its own IST day, so
        -- off-hours time never counts and a span can't exceed real elapsed time.
        -- Only single-tag-model rows (>= the activity-log redesign cutover) count.
        SELECT e.caller_id,
               COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                     LEAST(COALESCE(e.ended_at, NOW()), w.d_end,
                           ((e.started_at AT TIME ZONE 'Asia/Kolkata')::date + TIME '18:00') AT TIME ZONE 'Asia/Kolkata')
                   - GREATEST(e.started_at, w.d_start,
                           ((e.started_at AT TIME ZONE 'Asia/Kolkata')::date + TIME '09:00') AT TIME ZONE 'Asia/Kolkata')
                 ))::int)), 0)::int AS break_sec
          FROM caller_activity_events e CROSS JOIN w
         WHERE e.tag IN ('ON_BREAK','BREAK_PICKER','BLOCKED','PAUSED_BY_ADMIN',
                         'ON_PAGE_CALL','ON_PAGE_ASSIGNED','ON_PAGE_COMPLETED',
                         'ON_PAGE_NOT_PICKED','ON_PAGE_MISSED_CALLS','ON_PAGE_UNTOUCHED','ON_PAGE_NEXT_BATCH')
           AND e.started_at < w.d_end
           AND (e.ended_at IS NULL OR e.ended_at >= w.d_start)
           AND e.started_at >= COALESCE((SELECT MIN(applied_at) FROM activity_log_redesign_flag), '1970-01-01'::timestamptz)
         GROUP BY e.caller_id
      ),
      assign_agg AS (
        -- CUMULATIVE assignment EVENTS from lead_assignments history, windowed by
        -- created_at. assigned = every event (fresh + reassign back into Assigned);
        -- actual_leads = fresh assignments only (excludes moved-back leads).
        SELECT a.caller_id,
               COUNT(*)::int AS assigned,
               COUNT(*) FILTER (WHERE a.kind = 'fresh')::int AS actual_leads
          FROM lead_assignments a CROSS JOIN w
          JOIN leads l ON l.id = a.lead_id
         WHERE a.created_at >= w.d_start AND a.created_at <= w.d_end
           AND ($3::text IS NULL OR l.webinar_id::text = $3::text)
           AND ($3::text IS NOT NULL OR $4::text = 'all' OR l.source = $4::text)
         GROUP BY a.caller_id
      ),
      disp_agg AS (
        -- CURRENT-STATE snapshot — only for the "current page" counts that must
        -- reflect right-now (Untouched / Follow-up / Next Batch), the batch label,
        -- and the snapshot outcome atoms used by the detail row.
        SELECT l.assigned_user_id AS caller_id,
               mode() WITHIN GROUP (ORDER BY web.name) AS batch,
               -- current_assigned = every lead currently assigned to this caller
               -- (the caller's whole book) — the denominator for L→C %.
               COUNT(*)::int AS current_assigned,
               COUNT(*) FILTER (WHERE l.last_note_outcome IS NULL)::int AS new_leads,
               COUNT(*) FILTER (WHERE l.next_batch_parked = TRUE)::int AS next_batch,
               COUNT(*) FILTER (
                 WHERE l.last_note_outcome IS NULL
                   AND l.next_batch_parked = FALSE
                   AND l.webinar_id IS NOT NULL
                   AND l.webinar_id NOT IN ${RECENT_WEBINARS_SQL}
               )::int AS untouched,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'completed')::int AS o_completed,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'follow_up' AND l.follow_up_at > NOW())::int AS o_follow_up,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'not_interested')::int AS o_not_interested,
               COUNT(*) FILTER (WHERE l.last_note_outcome = 'incomplete')::int AS o_incomplete
          FROM leads l
          LEFT JOIN webinars web ON web.id = l.webinar_id
         WHERE l.assigned_user_id IS NOT NULL
           AND ($3::text IS NULL OR l.webinar_id::text = $3::text)
           -- "All webinars" means "all webinars of THIS source" — exclude
           -- YT / Meta 2.0 (and test) leads from the Meta page.
           AND ($3::text IS NOT NULL OR $4::text = 'all' OR l.source = $4::text)
         GROUP BY l.assigned_user_id
      )
      SELECT cb.caller_id, cb.name, cb.role, cb.is_active, cb.tata_extension, cb.team_leader_id,
             cb.activity_status, cb.last_heartbeat_at, cb.activity_break, cb.rest_started_at,
             da.batch,
             COALESCE(na.touched, 0)          AS touched,
             -- "Answered" = calls the CUSTOMER actually picked up (telephony
             -- customer_answered_at), so it lines up with Missed / Ans Talk
             -- which are also call-based. (Was the completed/follow_up note
             -- count, which read 0 even when a call clearly connected.)
             COALESCE(ca.answered, 0)         AS answered,
             COALESCE(ca.missed, 0)           AS missed,
             COALESCE(ca.answered_dur_sec, 0) AS answered_dur_sec,
             COALESCE(ca.missed_dur_sec, 0)   AS missed_dur_sec,
             COALESCE(ca.total_dur_sec, 0)    AS total_dur_sec,
             COALESCE(bka.break_sec, 0)       AS break_sec,
             COALESCE(ag.assigned, 0)         AS assigned,
             COALESCE(da.current_assigned, 0) AS current_assigned,
             COALESCE(ag.actual_leads, 0)     AS actual_leads,
             COALESCE(da.new_leads, 0)        AS new_leads,
             COALESCE(na.interested, 0)       AS interested,
             COALESCE(da.next_batch, 0)       AS next_batch,
             COALESCE(na.hot, 0)              AS hot,
             COALESCE(na.warm, 0)             AS warm,
             COALESCE(na.cold, 0)             AS cold,
             COALESCE(na.junk, 0)             AS junk,
             COALESCE(da.untouched, 0)        AS untouched,
             COALESCE(da.o_completed, 0)      AS o_completed,
             COALESCE(da.o_follow_up, 0)      AS o_follow_up,
             COALESCE(da.o_not_interested, 0) AS o_not_interested,
             COALESCE(na.o_not_picked, 0)     AS o_not_picked,
             COALESCE(da.o_incomplete, 0)     AS o_incomplete,
             COALESCE(na.st_other_languages, 0)          AS st_other_languages,
             COALESCE(na.st_already_paid, 0)             AS st_already_paid,
             COALESCE(na.st_not_available_for_webinar, 0) AS st_not_available_for_webinar,
             COALESCE(na.st_no_diabetes, 0)              AS st_no_diabetes,
             COALESCE(na.st_no_sugar_interested, 0)      AS st_no_sugar_interested,
             COALESCE(na.st_no_sugar_not_interested, 0)  AS st_no_sugar_not_interested,
             COALESCE(na.st_not_register, 0)             AS st_not_register,
             COALESCE(na.st_just_for_knowledge, 0)       AS st_just_for_knowledge,
             COALESCE(na.st_call_disconnected, 0)        AS st_call_disconnected,
             COALESCE(na.st_wrong_number, 0)             AS st_wrong_number,
             COALESCE(na.st_already_attended, 0)         AS st_already_attended,
             COALESCE(na.st_switch_off, 0)               AS st_switch_off,
             COALESCE(na.st_out_of_service, 0)           AS st_out_of_service,
             COALESCE(na.st_no_ring, 0)                  AS st_no_ring
        FROM caller_base cb
        LEFT JOIN call_agg   ca ON ca.caller_id = cb.caller_id
        LEFT JOIN note_agg   na ON na.caller_id = cb.caller_id
        LEFT JOIN assign_agg ag ON ag.caller_id = cb.caller_id
        LEFT JOIN break_agg  bka ON bka.caller_id = cb.caller_id
        LEFT JOIN disp_agg   da ON da.caller_id = cb.caller_id
       ORDER BY cb.name ASC
    `, params);

    // Numeric atom keys — summed into the totals footer in one place.
    const NUM_KEYS = [
      'touched','answered','missed','answered_dur_sec','missed_dur_sec','total_dur_sec','break_sec',
      'assigned','current_assigned','actual_leads','new_leads','interested','next_batch',
      'hot','warm','cold','junk','untouched',
      'o_completed','o_follow_up','o_not_interested','o_not_picked','o_incomplete',
      'st_other_languages','st_already_paid','st_not_available_for_webinar','st_no_diabetes',
      'st_no_sugar_interested','st_no_sugar_not_interested','st_not_register','st_just_for_knowledge',
      'st_call_disconnected','st_wrong_number','st_already_attended','st_switch_off',
      'st_out_of_service','st_no_ring',
    ];
    const totals = {};
    for (const k of NUM_KEYS) totals[k] = rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

    res.json({
      rows,
      totals,
      window: { from: fromYmd, to: toYmd },
      webinar_id: webinarId,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('caller-report error:', err.message);
    res.status(500).json({ error: 'Failed to load caller report.' });
  }
});

/* ── GET /api/admin/calls?caller_id=<uuid>&limit=50 ──
   Drill-down feed: recent calls for one salesperson with the linked lead's
   name + phone for context. */
router.get('/calls', async (req, res) => {
  const callerId = req.query.caller_id;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  if (!callerId) return res.status(400).json({ error: 'caller_id required' });

  try {
    const { rows } = await pool.query(`
      SELECT c.id,
             c.started_at,
             c.direction,
             c.status,
             c.duration_sec,
             l.full_name      AS lead_name,
             l.whatsapp_number AS lead_phone
        FROM calls c
        LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.caller_id = $1
       ORDER BY c.started_at DESC
       LIMIT $2
    `, [callerId, limit]);
    res.json({ calls: rows });
  } catch (err) {
    console.error('admin/calls error:', err.message);
    res.status(500).json({ error: 'Failed to load calls.' });
  }
});

/* ── GET /api/admin/leads/assignment-pool?from=ISO&to=ISO&webinar_id=UUID ──
   Used by the "Manual Assign Leads" modal in Sales → Leads.
   `webinar_id` is optional — when supplied the pool is restricted to leads
   tied to that webinar.
   Returns:
     - available:   count of unassigned leads whose created_at falls in the
                    given datetime range.
     - callers:     active junior/senior callers (id, full_name, role)
                    with their current open-lead count for context. */
router.get('/leads/assignment-pool', async (req, res) => {
  const { from, to, webinar_id } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to ISO datetime params are required' });
  }
  // Workspace scope — the manual-assign pool must only ever offer THIS source's
  // leads, so YT / Meta 2.0 leads can never be handed to a Meta caller.
  const source = getSource(req);
  try {
    const { rows: poolRows } = await pool.query(
      `SELECT COUNT(*)::int AS available
         FROM leads
        WHERE assigned_user_id IS NULL
          AND source = $4::text
          AND created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
          AND ($3::text IS NULL OR webinar_id::text = $3::text)`,
      [from, to, webinar_id || null, source]
    );
    const { rows: callers } = await pool.query(
      `SELECT u.id, u.full_name, u.role, u.is_active,
              COUNT(l.id) FILTER (
                WHERE l.last_note_outcome IS NULL
                   OR l.last_note_outcome = 'follow_up'
              )::int AS open_count
         FROM crm_users u
         LEFT JOIN leads l ON l.assigned_user_id = u.id AND l.source = $1
        WHERE u.is_active = TRUE
          AND u.role IN ('junior_caller','senior_caller')
          AND u.deleted_at IS NULL
        GROUP BY u.id
        ORDER BY u.role DESC, u.full_name ASC`,
      [source]
    );
    res.json({ available: poolRows[0]?.available || 0, callers });
  } catch (err) {
    console.error('assignment-pool error:', err.message);
    res.status(500).json({ error: 'Failed to load assignment pool.' });
  }
});

/* ── POST /api/admin/leads/manual-assign ──
   Hands a custom-count distribution of unassigned leads (within a datetime
   window) to a chosen set of callers. Each entry in `distribution` says
   "give caller X exactly N leads".

   Body:
     {
       from:         ISO datetime (created_at >=),
       to:           ISO datetime (created_at <=),
       webinar_id:   UUID (optional — restrict the pool to one webinar),
       distribution: [{ user_id: UUID, count: integer ≥ 1 }, …]
     }

   Leads are pulled in created_at ASC order so the OLDEST unassigned leads
   are handed out first. The caller distribution is processed in the order
   supplied. If the requested total exceeds availability, the LAST callers
   in the list get short rations or zero — we never error half-way.

   Wrapped in a transaction with row-level locks so a concurrent manual /
   auto assign cannot grab the same leads. */
router.post('/leads/manual-assign', async (req, res) => {
  const { from, to, webinar_id } = req.body || {};
  const distribution = Array.isArray(req.body?.distribution) ? req.body.distribution : null;

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to ISO datetime params are required' });
  }
  if (!distribution || distribution.length === 0) {
    return res.status(400).json({ error: 'distribution must be a non-empty array' });
  }

  // Validate distribution shape — UUID + integer count ≥ 1 per row, no dupes.
  const seen = new Set();
  for (const row of distribution) {
    if (!row || typeof row !== 'object') {
      return res.status(400).json({ error: 'distribution rows must be objects' });
    }
    if (!row.user_id || typeof row.user_id !== 'string') {
      return res.status(400).json({ error: 'each distribution row needs user_id' });
    }
    if (seen.has(row.user_id)) {
      return res.status(400).json({ error: 'distribution user_ids must be distinct' });
    }
    seen.add(row.user_id);
    if (!Number.isInteger(row.count) || row.count < 1) {
      return res.status(400).json({ error: 'each count must be an integer ≥ 1' });
    }
  }

  const totalRequested = distribution.reduce((s, r) => s + r.count, 0);
  // Workspace scope — only ever hand out THIS source's leads. Without this a
  // manual "assign all" on the Meta page would pull YT / Meta 2.0 unassigned
  // leads into Meta callers' queues.
  const source = getSource(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify every destination is an active junior/senior caller.
    const userIds = distribution.map(r => r.user_id);
    const { rows: tgt } = await client.query(
      `SELECT id FROM crm_users
        WHERE id = ANY($1::uuid[])
          AND is_active = TRUE
          AND role IN ('junior_caller','senior_caller')`,
      [userIds]
    );
    if (tgt.length !== userIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or more destination callers not found or not active.' });
    }

    // Lock the available unassigned leads in the window, oldest first.
    const { rows: pool_ } = await client.query(
      `SELECT id FROM leads
        WHERE assigned_user_id IS NULL
          AND source = $5::text
          AND created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
          AND ($4::text IS NULL OR webinar_id::text = $4::text)
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3`,
      [from, to, totalRequested, webinar_id || null, source]
    );
    const available = pool_.length;

    // Walk distribution in order, slicing leads off the front of the pool.
    let cursor = 0;
    const actual = [];
    for (const row of distribution) {
      const ask = Math.min(row.count, available - cursor);
      if (ask <= 0) {
        actual.push({ user_id: row.user_id, requested: row.count, assigned: 0 });
        continue;
      }
      const chunkIds = pool_.slice(cursor, cursor + ask).map(r => r.id);
      cursor += ask;
      await client.query(
        `UPDATE leads
            SET assigned_user_id = $1::uuid,
                assigned_at      = NOW()
          WHERE id = ANY($2::uuid[])`,
        [row.user_id, chunkIds]
      );
      actual.push({ user_id: row.user_id, requested: row.count, assigned: ask });
    }

    await client.query('COMMIT');

    res.json({
      total_requested: totalRequested,
      total_assigned:  cursor,
      available,
      distribution:    actual,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('manual-assign error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to assign leads.' });
  } finally {
    client.release();
  }
});

/* ── POST /api/admin/leads/reassign ──
   Spread one caller's open leads across N teammates with custom counts.
   Body: {
     from_caller_id,
     scope: 'all_open' | 'followups_for_date',
     date?: 'YYYY-MM-DD'         (required when scope = followups_for_date),
     distribution: [{ to_caller_id, count }, …]   custom counts per teammate
   }
   Backward-compat: legacy { to_caller_id } is treated as a single-row
   distribution that takes the full source count.
   Returns { moved, distribution: [{to_caller_id, count}, …] }. */
router.post('/leads/reassign', async (req, res) => {
  const { from_caller_id, scope, date } = req.body || {};
  let { distribution } = req.body || {};

  if (!from_caller_id) return res.status(400).json({ error: 'from_caller_id required' });

  // Backward-compat: legacy single-destination shape
  if (!distribution && req.body?.to_caller_id) {
    distribution = [{ to_caller_id: req.body.to_caller_id, count: null }]; // null → "take all"
  }

  if (!Array.isArray(distribution) || distribution.length === 0) {
    return res.status(400).json({ error: 'distribution must be a non-empty array' });
  }

  const allowedScopes = ['all_open', 'followups_for_date'];
  const scp = allowedScopes.includes(scope) ? scope : 'all_open';

  // Validate distribution shape
  const seen = new Set();
  for (const row of distribution) {
    if (!row || typeof row !== 'object') {
      return res.status(400).json({ error: 'distribution rows must be objects' });
    }
    if (!row.to_caller_id) {
      return res.status(400).json({ error: 'each distribution row needs to_caller_id' });
    }
    if (row.to_caller_id === from_caller_id) {
      return res.status(400).json({ error: 'destination cannot equal source' });
    }
    if (seen.has(row.to_caller_id)) {
      return res.status(400).json({ error: 'destination callers must be distinct' });
    }
    seen.add(row.to_caller_id);
    // count must be ≥ 1 unless null (legacy compat path)
    if (row.count !== null && (!Number.isInteger(row.count) || row.count < 1)) {
      return res.status(400).json({ error: 'each count must be an integer ≥ 1' });
    }
  }

  let dayStart = null, dayEnd = null;
  if (scp === 'followups_for_date') {
    const ymd = (date || '').toString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      return res.status(400).json({ error: 'date (YYYY-MM-DD) required for followups_for_date scope' });
    }
    dayStart = new Date(`${ymd}T00:00:00+05:30`).toISOString();
    dayEnd   = new Date(`${ymd}T23:59:59.999+05:30`).toISOString();
  }

  const client = await pool.connect();
  try {
    // Verify all destinations exist + are active junior/senior callers
    const destIds = distribution.map(d => d.to_caller_id);
    const { rows: tgt } = await client.query(
      `SELECT id FROM crm_users
         WHERE id = ANY($1::uuid[])
           AND is_active = TRUE
           AND role IN ('junior_caller','senior_caller')`,
      [destIds]
    );
    if (tgt.length !== destIds.length) {
      return res.status(404).json({ error: 'One or more destination callers not found or not active.' });
    }

    await client.query('BEGIN');

    // Lock the leads we're about to move so a concurrent reassignment / auto-assign
    // can't shift them out from under us.
    let leadRows;
    if (scp === 'followups_for_date') {
      ({ rows: leadRows } = await client.query(
        `SELECT id FROM leads
            WHERE assigned_user_id = $1
              AND last_note_outcome = 'follow_up'
              AND follow_up_at >= $2 AND follow_up_at <= $3
            ORDER BY assigned_at ASC NULLS LAST, id ASC
            FOR UPDATE`,
        [from_caller_id, dayStart, dayEnd]
      ));
    } else {
      ({ rows: leadRows } = await client.query(
        `SELECT id FROM leads
            WHERE assigned_user_id = $1
              AND (last_note_outcome IS NULL OR last_note_outcome = 'follow_up')
            ORDER BY assigned_at ASC NULLS LAST, id ASC
            FOR UPDATE`,
        [from_caller_id]
      ));
    }
    const totalAvailable = leadRows.length;

    // Resolve legacy "take all" entries: a single null-count row absorbs the full pile.
    const hasLegacy = distribution.some(d => d.count === null);
    if (hasLegacy) {
      if (distribution.length !== 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'legacy single-destination cannot mix with explicit counts' });
      }
      distribution[0].count = totalAvailable;
    }

    const requested = distribution.reduce((s, d) => s + d.count, 0);
    if (requested > totalAvailable) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Lead count changed: source has ${totalAvailable} lead${totalAvailable === 1 ? '' : 's'} but you allocated ${requested}. Please reload and retry.`,
        available: totalAvailable,
        allocated: requested,
      });
    }
    // requested < totalAvailable is allowed — leftover leads stay with the source caller.

    // Walk the queue and hand out chunks in the order admin specified.
    let cursor = 0;
    for (const slot of distribution) {
      if (slot.count === 0) continue;
      const ids = leadRows.slice(cursor, cursor + slot.count).map(r => r.id);
      cursor += slot.count;
      if (ids.length === 0) continue;
      await client.query(
        `UPDATE leads
            SET assigned_user_id = $1, assigned_at = NOW()
          WHERE id = ANY($2::uuid[])`,
        [slot.to_caller_id, ids]
      );
      // Caller-report (cumulative): log each reassign as an assignment EVENT so
      // the destination caller's "Assigned" count rises (kind='reassign' → not
      // counted as a fresh "Actual Lead").
      await client.query(
        `INSERT INTO lead_assignments (lead_id, caller_id, webinar_id, reason, kind)
         SELECT id, $1, webinar_id, 'admin_reassign', 'reassign'
           FROM leads WHERE id = ANY($2::uuid[]) AND webinar_id IS NOT NULL`,
        [slot.to_caller_id, ids]
      );
    }

    await client.query('COMMIT');
    res.json({
      moved: requested,
      remaining: totalAvailable - requested,
      distribution: distribution.map(d => ({ to_caller_id: d.to_caller_id, count: d.count })),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('leads/reassign error:', err.message);
    res.status(500).json({ error: 'Failed to reassign leads.' });
  } finally {
    client.release();
  }
});

module.exports = router;
