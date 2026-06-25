/*
 * webinarRollover — clear/advance a webinar once its End Date has passed.
 *
 * When the current webinar's End Date (current_webinar_date, falling back to the
 * webinar datetime) is in the past:
 *   • if an UPCOMING webinar is configured → promote it into the current slot and
 *     blank the upcoming (the normal roll-over), and
 *   • if there's NO upcoming → BLANK the current webinar so the admin can enter a
 *     fresh one. New-lead auto-assignment for that workspace pauses until they do
 *     (the active webinars row is deactivated); EXISTING assigned leads + the
 *     callers working them are untouched.
 *
 * Runs as a self-heal on GET /api/webinar-config (per source) — same pattern as
 * the pending link-swap check — so it fires promptly without a dedicated job, and
 * it's idempotent: after firing, the end marker is null/future so it no-ops.
 * Deliberately isolated from the WhatsApp link-swap logic.
 */
const pool = require('../db');

async function rolloverWebinarIfEnded(source) {
  try {
    const { rows } = await pool.query(
      `SELECT current_webinar_date, current_webinar_datetime, next_webinar_at,
              backup_webinar_at, next_webinar_datetime, next_webinar_date,
              next_webinar_link, next_form_id
         FROM webinar_config WHERE source = $1`,
      [source]
    );
    const cfg = rows[0];
    if (!cfg) return false;

    // "Ended" = the End Date has passed (fall back to the webinar datetime).
    const endMarker = cfg.current_webinar_date || cfg.current_webinar_datetime;
    if (!endMarker || new Date(endMarker) >= new Date()) return false;

    const hasUpcoming = !!(cfg.backup_webinar_at || cfg.next_webinar_datetime || cfg.next_webinar_date);

    if (hasUpcoming) {
      // Promote the upcoming webinar into the current slot; blank the upcoming.
      await pool.query(
        `UPDATE webinar_config SET
            next_webinar_at          = COALESCE(backup_webinar_at, next_webinar_at),
            current_webinar_date     = next_webinar_date,
            current_webinar_datetime = COALESCE(next_webinar_datetime, current_webinar_datetime),
            current_webinar_link     = COALESCE(NULLIF(next_webinar_link, ''), current_webinar_link),
            current_form_id          = COALESCE(next_form_id, current_form_id),
            backup_webinar_at        = NULL,
            next_webinar_date        = NULL,
            next_webinar_datetime    = NULL,
            next_webinar_link        = '',
            next_form_id             = NULL,
            updated_at               = NOW()
          WHERE source = $1`,
        [source]
      );
      // Activate the promoted webinar row (matched by datetime), deactivate the rest.
      const promoted = cfg.next_webinar_datetime || cfg.current_webinar_datetime;
      if (promoted) {
        await pool.query(
          `UPDATE webinars SET is_active = (date_time = $2)
            WHERE source = $1 AND (is_active OR date_time = $2)`,
          [source, promoted]
        );
      }
      console.log(`[webinarRollover] ${source}: webinar ended → promoted upcoming into current`);
    } else {
      // No upcoming → DO NOTHING. The current webinar persists (stays active)
      // until the admin sets a new one. Leads keep getting worked after the
      // webinar datetime passes, so we must NOT deactivate/blank the current
      // webinar just because its date is in the past — that orphaned leads and
      // made Leads Logic fall back to a stale past webinar.
      return false;
    }
    return true;
  } catch (e) {
    console.error('[webinarRollover]', source, e.message);
    return false;
  }
}

module.exports = { rolloverWebinarIfEnded };
