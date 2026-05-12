/**
 * Leads-alert scheduler.
 *
 * Every 5 minutes, for each source (meta/yt):
 *   1. Read webinar_config: registration deadline, upcoming slot, alert phone
 *   2. Skip if no alert_phone_number configured.
 *   3. Check completeness of the UPCOMING slot:
 *        – backup_webinar_at set
 *        – next_webinar_date set
 *        – at least one whatsapp_links row for the upcoming webinar
 *      If any is missing → "upcoming incomplete"
 *   4. If upcoming is incomplete, compute hours-to-deadline of the current
 *      webinar. Fire the matching template ONCE (dedup via alert_log unique
 *      key on webinar_id + template_name):
 *
 *        ≤24h, >12h   → leads_alert
 *        ≤12h, >8h    → leads_alert_12hrs
 *        ≤8h,  >4h    → leads_alret_8hrs     (typo retained per request)
 *        ≤4h,  >2h    → leads_alret_4hrs     (typo retained per request)
 *        ≤2h,  >1h    → leads_alert_2hrs
 *        ≤1h,  >0h    → leads_alert_1hr
 *
 *   Each template fires at most once per (webinar_id, template_name) — the
 *   alert_log table has a UNIQUE constraint on that pair, so a duplicate
 *   INSERT fails silently and we just skip the WATI call.
 */

const pool = require('../db');
const wati = require('./watiClient');

const SOURCES = ['meta', 'yt'];

/** Window definitions in hours. Order matters — first match wins.
 *  `leads_alert` is the broad "any time before 12h" first-warning window —
 *  fires once per current webinar as soon as the upcoming slot is detected
 *  incomplete, regardless of how far away the deadline is. Tighter windows
 *  fire as escalating reminders as the deadline approaches. */
const ALERT_WINDOWS = [
  { name: 'leads_alert',         lt: Infinity, gt: 12 },
  { name: 'leads_alert_12hrs',   lt: 12,       gt: 8  },
  { name: 'leads_alret_8hrs',    lt: 8,        gt: 4  },
  { name: 'leads_alret_4hrs',    lt: 4,        gt: 2  },
  { name: 'leads_alert_2hrs',    lt: 2,        gt: 1  },
  { name: 'leads_alert_1hr',     lt: 1,        gt: 0  },
];

async function checkSource(source) {
  // 1. Read config
  const { rows: cfgRows } = await pool.query(
    `SELECT next_webinar_at, backup_webinar_at, next_webinar_date,
            alert_phone_number
       FROM webinar_config
      WHERE source = $1`,
    [source]
  );
  const cfg = cfgRows[0];
  if (!cfg) return { source, skipped: 'no_config_row' };
  if (!cfg.alert_phone_number) return { source, skipped: 'no_alert_phone' };
  if (!cfg.next_webinar_at)    return { source, skipped: 'no_current_deadline' };

  // 2. Hours to current deadline
  const hours = (new Date(cfg.next_webinar_at).getTime() - Date.now()) / 3_600_000;
  if (hours <= 0) return { source, skipped: 'deadline_passed' };

  // 3. Find matching alert window. `leads_alert` (lt:Infinity, gt:12) catches
  //    everything from "right now" down to 12h before the deadline, then
  //    tighter templates take over as the cascade.
  const win = ALERT_WINDOWS.find(w => hours <= w.lt && hours > w.gt);
  if (!win) return { source, skipped: 'between_windows' };

  // 4. Check upcoming-slot completeness
  let upcomingComplete = !!cfg.backup_webinar_at && !!cfg.next_webinar_date;
  let upcomingHasLinks = false;
  if (cfg.backup_webinar_at) {
    try {
      const { rows: wRows } = await pool.query(
        `SELECT id FROM webinars
          WHERE source = $1 AND date_time = $2
          ORDER BY created_at DESC LIMIT 1`,
        [source, cfg.backup_webinar_at]
      );
      const upcomingWebinarId = wRows[0]?.id;
      if (upcomingWebinarId) {
        const { rows: lRows } = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM whatsapp_links
            WHERE webinar_id = $1 AND link_url <> ''`,
          [upcomingWebinarId]
        );
        upcomingHasLinks = (lRows[0]?.cnt || 0) > 0;
      }
    } catch (_) { /* keep upcomingHasLinks=false */ }
  }
  const upcomingIncomplete = !upcomingComplete || !upcomingHasLinks;
  if (!upcomingIncomplete) return { source, skipped: 'upcoming_ready' };

  // 5. Find the current active webinar (for dedup key)
  const { rows: actRows } = await pool.query(
    `SELECT id FROM webinars
      WHERE source = $1 AND is_active = TRUE
      ORDER BY date_time DESC LIMIT 1`,
    [source]
  );
  const currentWebinarId = actRows[0]?.id || null;
  if (!currentWebinarId) return { source, skipped: 'no_active_webinar' };

  // 6. Dedup — claim the alert row first, send only if claim succeeded.
  const claim = await pool.query(
    `INSERT INTO alert_log (webinar_id, source, template_name, sent_to)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (webinar_id, template_name) DO NOTHING
     RETURNING id`,
    [currentWebinarId, source, win.name, cfg.alert_phone_number]
  );
  if (claim.rows.length === 0) return { source, skipped: 'already_sent', template: win.name };

  // 7. Send WATI
  const result = await wati.sendTemplate({
    phone:        cfg.alert_phone_number,
    templateName: win.name,
  });
  await pool.query(
    `UPDATE alert_log SET success = $1, response = $2 WHERE id = $3`,
    [result.ok, result.body || { error: result.error }, claim.rows[0].id]
  );
  console.log(`[leadsAlert:${source}] sent ${win.name} to ${cfg.alert_phone_number} (${hours.toFixed(2)}h remaining) — ok=${result.ok}`);
  return { source, sent: win.name, ok: result.ok, hoursRemaining: hours };
}

async function runOnce() {
  const results = [];
  for (const src of SOURCES) {
    try {
      const r = await checkSource(src);
      results.push(r);
      // Log every decision so it's easy to see why an alert did or didn't fire.
      if (r.sent) {
        // success path already logs inside checkSource
      } else if (r.skipped) {
        console.log(`[leadsAlert:${src}] skipped — ${r.skipped}${r.template ? ` (${r.template})` : ''}`);
      }
    } catch (e) {
      console.error(`[leadsAlert:${src}] error:`, e.message);
      results.push({ source: src, error: e.message });
    }
  }
  return results;
}

function startScheduler({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (!wati.isConfigured()) {
    console.log('[leadsAlert] WATI_API_KEY not set; scheduler disabled');
    return;
  }
  setInterval(() => {
    runOnce().catch(e => console.error('[leadsAlert] tick error:', e.message));
  }, intervalMs);
  console.log(`[leadsAlert] scheduler started — every ${intervalMs / 1000}s`);
}

module.exports = { startScheduler, runOnce, checkSource };
