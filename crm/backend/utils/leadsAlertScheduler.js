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

/* Returns the recipient phones for a source as an array. Prefers the
   new alert_phone_numbers JSONB column; falls back to the legacy
   alert_phone_number single string if the array is empty. */
function getAlertPhones(cfg) {
  const arr = Array.isArray(cfg?.alert_phone_numbers) ? cfg.alert_phone_numbers : [];
  if (arr.length) return arr.filter(Boolean);
  return cfg?.alert_phone_number ? [cfg.alert_phone_number] : [];
}

async function checkSource(source) {
  // 1. Read config
  const { rows: cfgRows } = await pool.query(
    `SELECT next_webinar_at, backup_webinar_at, next_webinar_date,
            alert_phone_number, alert_phone_numbers
       FROM webinar_config
      WHERE source = $1`,
    [source]
  );
  const cfg = cfgRows[0];
  if (!cfg) return { source, skipped: 'no_config_row' };
  const phones = getAlertPhones(cfg);
  if (phones.length === 0) return { source, skipped: 'no_alert_phone' };
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

  // 6. Dedup — claim ONE alert row first; the single claim covers the
  // fan-out send so we don't double-fire on a re-run.
  const claim = await pool.query(
    `INSERT INTO alert_log (webinar_id, source, template_name, sent_to)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (webinar_id, template_name) DO NOTHING
     RETURNING id`,
    [currentWebinarId, source, win.name, phones.join(',')]
  );
  if (claim.rows.length === 0) return { source, skipped: 'already_sent', template: win.name };

  // 7. Send WATI — one request per recipient so each saved number gets
  // its own message. We collect per-phone results and stamp an aggregate
  // success flag on the single alert_log row (true iff ALL recipients
  // accepted; otherwise the response JSON has the per-phone detail).
  const sendResults = [];
  for (const ph of phones) {
    const r = await wati.sendTemplate({ phone: ph, templateName: win.name });
    sendResults.push({ phone: ph, ok: r.ok, status: r.status, error: r.error });
    console.log(`[leadsAlert:${source}] sent ${win.name} to ${ph} (${hours.toFixed(2)}h remaining) — ok=${r.ok}`);
  }
  const allOk = sendResults.every(r => r.ok);
  await pool.query(
    `UPDATE alert_log SET success = $1, response = $2 WHERE id = $3`,
    [allOk, { recipients: sendResults }, claim.rows[0].id]
  );
  return { source, sent: win.name, ok: allOk, recipients: sendResults, hoursRemaining: hours };
}

/**
 * `wa_link_alert` — fires every time the current webinar's lead count
 * crosses a 50-member bucket (500, 550, 600, … 950) AND no 2nd pending
 * WhatsApp link is configured yet. Catches admins who forget to schedule
 * the next link before the active group fills.
 *
 * Dedup: each bucket uses a distinct `template_name` in alert_log
 * (`wa_link_alert_500`, `wa_link_alert_550`, …), so the existing
 * UNIQUE (webinar_id, template_name) constraint guarantees each bucket
 * fires exactly once per webinar. The real WATI template sent is always
 * `wa_link_alert`; the bucket value is passed as parameter {{1}}.
 */
const WA_LINK_BUCKET_START = 500;
const WA_LINK_BUCKET_STEP  = 50;
const WA_LINK_BUCKET_END   = 950;

async function checkWaLinkAlert(source) {
  // 1. Read config
  const { rows: cfgRows } = await pool.query(
    `SELECT alert_phone_number, alert_phone_numbers, pending_whatsapp_link_2, whatsapp_link_swap_at_2
       FROM webinar_config
      WHERE source = $1`,
    [source]
  );
  const cfg = cfgRows[0];
  if (!cfg) return { source, kind: 'wa_link', skipped: 'no_config_row' };
  const phones = getAlertPhones(cfg);
  if (phones.length === 0) return { source, kind: 'wa_link', skipped: 'no_alert_phone' };

  // 2. Gate: skip entirely if the admin already configured a 2nd link.
  const pending2 = (cfg.pending_whatsapp_link_2 || '').trim();
  if (pending2) return { source, kind: 'wa_link', skipped: 'pending_link_set' };

  // 3. Find the currently active webinar for this source.
  const { rows: actRows } = await pool.query(
    `SELECT id FROM webinars
      WHERE source = $1 AND is_active = TRUE
      ORDER BY date_time DESC LIMIT 1`,
    [source]
  );
  const currentWebinarId = actRows[0]?.id || null;
  if (!currentWebinarId) return { source, kind: 'wa_link', skipped: 'no_active_webinar' };

  // 4. Count leads for that webinar (same source of truth used by link rotation).
  const { rows: cntRows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM leads WHERE webinar_id = $1`,
    [currentWebinarId]
  );
  const leadCount = cntRows[0]?.cnt || 0;
  if (leadCount < WA_LINK_BUCKET_START) {
    return { source, kind: 'wa_link', skipped: 'below_threshold', count: leadCount };
  }

  // 5. Highest bucket crossed (capped at 950).
  const highestBucket = Math.min(
    WA_LINK_BUCKET_END,
    Math.floor(leadCount / WA_LINK_BUCKET_STEP) * WA_LINK_BUCKET_STEP
  );

  // 6. Fire every un-fired bucket from 500 up to highestBucket (in order).
  const sent = [];
  for (let b = WA_LINK_BUCKET_START; b <= highestBucket; b += WA_LINK_BUCKET_STEP) {
    const logName = `wa_link_alert_${b}`;
    const claim = await pool.query(
      `INSERT INTO alert_log (webinar_id, source, template_name, sent_to)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (webinar_id, template_name) DO NOTHING
       RETURNING id`,
      [currentWebinarId, source, logName, phones.join(',')]
    );
    if (claim.rows.length === 0) continue; // already fired this bucket
    // Fan out — one WATI send per saved phone number.
    const bucketResults = [];
    for (const ph of phones) {
      const r = await wati.sendTemplate({
        phone:         ph,
        templateName:  'wa_link_alert',
        parameters:    [String(b)],
        broadcastName: 'wa_link_alert',
      });
      bucketResults.push({ phone: ph, ok: r.ok });
      console.log(`[wa_link_alert:${source}] sent bucket=${b} to ${ph} (count=${leadCount}) ok=${r.ok}`);
    }
    const bucketAllOk = bucketResults.every(r => r.ok);
    await pool.query(
      `UPDATE alert_log SET success = $1, response = $2 WHERE id = $3`,
      [bucketAllOk, { recipients: bucketResults }, claim.rows[0].id]
    );
    sent.push({ bucket: b, ok: bucketAllOk, recipients: bucketResults });
  }

  if (sent.length === 0) {
    return { source, kind: 'wa_link', skipped: 'all_buckets_already_sent', count: leadCount, highestBucket };
  }
  return { source, kind: 'wa_link', sent, count: leadCount };
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

    // wa_link_alert runs alongside the deadline-based cascade.
    try {
      const r = await checkWaLinkAlert(src);
      results.push(r);
      if (r.skipped) {
        console.log(`[wa_link_alert:${src}] skipped — ${r.skipped}${r.count != null ? ` (count=${r.count})` : ''}`);
      }
    } catch (e) {
      console.error(`[wa_link_alert:${src}] error:`, e.message);
      results.push({ source: src, kind: 'wa_link', error: e.message });
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

module.exports = { startScheduler, runOnce, checkSource, checkWaLinkAlert };
