/*
 * hourlyCallerReportScheduler — sends an hourly caller-performance report over
 * WhatsApp (Whapi) to the Team Leaders + (Assistant) Managers configured on the
 * Web Reminder → Alerts page (telegram_alert_recipients, telegram_chat_id reused
 * as the WhatsApp number).
 *
 * Cadence:  on the hour, 9 AM–6 PM IST, Monday–Saturday (Sunday is a holiday).
 * Content:  one compact line per caller with today-so-far totals (resets at
 *           12 AM IST), plus a team-totals footer.
 * Scope:    a team_leader recipient gets only their own team's callers; a
 *           manager / assistant_manager recipient gets every caller.
 * Channel:  the pinned Web-Reminder Whapi channel (webinar_config.source =
 *           'webreminder') — the same channel as the auto-pause alerts.
 *
 * The per-caller atoms mirror the admin "Caller 360" report (routes/admin.js
 * GET /caller-report): outbound calls from `calls`, dispositions from the
 * append-only `lead_call_notes` history.
 */
const pool = require('../db');
const { sendTelegram } = require('./telegramNotifier');

const TICK_MS    = 60 * 1000;   // check every minute; the hour-key guard de-dupes
const WINDOW_FROM = 9;          // 9 AM IST (inclusive)
const WINDOW_TO   = 18;         // 6 PM IST (inclusive)

let _timer = null;
let _sentHourKey = null;        // "YYYY-MM-DD-HH" (IST) of the last report sent
let _running = false;           // re-entrancy guard for a single send pass

/* IST clock parts (we shift UTC by +5:30 and read it as if it were UTC). */
function istParts() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return {
    ymd:    ist.toISOString().slice(0, 10),
    hour:   ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    dow:    ist.getUTCDay(),          // 0 = Sunday
  };
}

/* Per-caller today-so-far summary atoms (IST midnight → now). */
async function buildReportRows() {
  const { ymd } = istParts();
  const dayStart = new Date(`${ymd}T00:00:00+05:30`).toISOString();
  const dayEnd   = new Date().toISOString();
  const { rows } = await pool.query(`
    WITH w AS (SELECT $1::timestamptz AS d_start, $2::timestamptz AS d_end),
    caller_base AS (
      SELECT u.id AS caller_id, u.full_name AS name, u.team_leader_id, u.is_active
        FROM crm_users u
       WHERE u.role IN ('junior_caller','senior_caller')
         AND u.deleted_at IS NULL
    ),
    call_agg AS (
      SELECT c.caller_id,
             COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS dialed,
             COUNT(*) FILTER (WHERE c.direction = 'outbound' AND c.customer_answered_at IS NOT NULL)::int AS connected
        FROM calls c CROSS JOIN w
       WHERE c.caller_id IS NOT NULL
         AND c.started_at >= w.d_start AND c.started_at <= w.d_end
       GROUP BY c.caller_id
    ),
    note_agg AS (
      SELECT n.caller_id,
             COUNT(*)::int AS worked,
             COUNT(*) FILTER (WHERE n.lead_tag = 'HOT')::int  AS hot,
             COUNT(*) FILTER (WHERE n.lead_tag = 'WARM')::int AS warm,
             COUNT(*) FILTER (WHERE n.lead_tag = 'COLD')::int AS cold,
             COUNT(*) FILTER (WHERE n.lead_tag = 'JUNK')::int AS junk,
             COUNT(*) FILTER (WHERE n.outcome = 'not_picked')::int AS dnp,
             COUNT(*) FILTER (WHERE n.outcome = 'completed')::int  AS completed
        FROM lead_call_notes n CROSS JOIN w
       WHERE n.caller_id IS NOT NULL
         AND n.created_at >= w.d_start AND n.created_at <= w.d_end
       GROUP BY n.caller_id
    )
    SELECT cb.caller_id, cb.name, cb.team_leader_id, cb.is_active,
           COALESCE(ca.dialed, 0)    AS dialed,
           COALESCE(ca.connected, 0) AS connected,
           COALESCE(na.worked, 0)    AS worked,
           COALESCE(na.hot, 0)       AS hot,
           COALESCE(na.warm, 0)      AS warm,
           COALESCE(na.cold, 0)      AS cold,
           COALESCE(na.junk, 0)      AS junk,
           COALESCE(na.dnp, 0)       AS dnp,
           COALESCE(na.completed, 0) AS completed
      FROM caller_base cb
      LEFT JOIN call_agg ca ON ca.caller_id = cb.caller_id
      LEFT JOIN note_agg na ON na.caller_id = cb.caller_id
     ORDER BY cb.name ASC
  `, [dayStart, dayEnd]);
  return rows;
}

/* Build the WhatsApp text for one recipient from their scoped caller rows. */
function formatReportMessage(rows, scopeLabel) {
  const { ymd, hour, minute } = istParts();
  const hh = ((hour + 11) % 12) + 1;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const mm = String(minute).padStart(2, '0');
  const [, mo, da] = ymd.split('-');
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const stamp = `${da} ${MON[Number(mo) - 1]}, ${hh}:${mm} ${ampm} IST`;

  const lines = [
    `📊 *Hourly Caller Report*`,
    `🕐 ${stamp} · today so far`,
    `👥 ${scopeLabel}`,
    ``,
  ];

  if (rows.length === 0) {
    lines.push(`_No callers in scope._`);
    return lines.join('\n');
  }

  const t = { dialed: 0, connected: 0, worked: 0, hot: 0, warm: 0, cold: 0, junk: 0, dnp: 0, completed: 0 };
  rows.forEach((r, i) => {
    // Paused caller → show ONLY the paused line, skip all metrics.
    if (r.is_active === false) {
      lines.push(`${i + 1}. *${r.name}*  —  ⏸ Paused`, ``);
      return;
    }
    for (const k of Object.keys(t)) t[k] += Number(r[k]) || 0;
    // One metric per line for easy reading on a phone.
    lines.push(
      `${i + 1}. *${r.name}*`,
      `   📞 Dialed: ${r.dialed}`,
      `   ✅ Connected: ${r.connected}`,
      `   📝 Worked: ${r.worked}`,
      `   🔥 Hot: ${r.hot}`,
      `   🌤 Warm: ${r.warm}`,
      `   ❄️ Cold: ${r.cold}`,
      `   🗑 Junk: ${r.junk}`,
      `   🚫 DNP: ${r.dnp}`,
      `   🎯 Enrolled: ${r.completed}`,
      ``
    );
  });

  lines.push(
    `— *Team totals* —`,
    `📞 Dialed: ${t.dialed}`,
    `✅ Connected: ${t.connected}`,
    `📝 Worked: ${t.worked}`,
    `🔥 Hot: ${t.hot}`,
    `🌤 Warm: ${t.warm}`,
    `❄️ Cold: ${t.cold}`,
    `🗑 Junk: ${t.junk}`,
    `🚫 DNP: ${t.dnp}`,
    `🎯 Enrolled: ${t.completed}`
  );
  return lines.join('\n');
}

/* Recipients who should receive the hourly report (TLs + managers + assistant
   managers), with a valid WhatsApp number. */
async function reportRecipients() {
  const { rows } = await pool.query(`
    SELECT r.telegram_chat_id AS wa_number, r.target_type, r.team_leader_id, r.label,
           tl.full_name AS team_leader_name
      FROM telegram_alert_recipients r
      LEFT JOIN crm_users tl ON tl.id = r.team_leader_id
     WHERE r.target_type IN ('team_leader','manager','assistant_manager')`);
  return rows.filter(r => String(r.wa_number || '').trim().length > 0);
}

/* Send the report to every configured recipient. Returns a small summary. */
async function sendHourlyReports({ force = false } = {}) {
  if (_running) return { ok: false, reason: 'already_running' };
  _running = true;
  try {
    const recipients = await reportRecipients();
    if (recipients.length === 0) return { ok: true, sent: 0, reason: 'no_recipients' };

    const allRows = await buildReportRows();
    let sent = 0;
    for (const r of recipients) {
      const isTL = r.target_type === 'team_leader';
      const scoped = isTL ? allRows.filter(row => row.team_leader_id === r.team_leader_id) : allRows;
      const scopeLabel = isTL
        ? `Team: ${r.team_leader_name || r.label || 'your team'}`
        : 'All callers';
      // A TL with no callers in scope gets nothing (avoids an empty ping); a
      // manager always gets the org-wide roll-up.
      if (isTL && scoped.length === 0) continue;
      const body = formatReportMessage(scoped, scopeLabel);
      try {
        await sendTelegram(r.wa_number, body);
        sent++;
      } catch (e) {
        console.error(`[hourlyReport] send to ${r.wa_number} failed: ${e.message}`);
      }
    }
    console.log(`[hourlyReport] sent ${sent}/${recipients.length} report(s)${force ? ' (manual)' : ''}`);
    return { ok: true, sent, recipients: recipients.length };
  } finally {
    _running = false;
  }
}

/* One scheduler tick: send once per clock-hour inside the office window. */
async function tick() {
  const { ymd, hour, dow } = istParts();
  if (dow === 0) return;                              // Sunday holiday
  if (hour < WINDOW_FROM || hour > WINDOW_TO) return; // outside 9 AM–6 PM IST
  const key = `${ymd}-${hour}`;
  if (_sentHourKey === key) return;                   // already sent this hour
  _sentHourKey = key;                                 // claim before awaiting (no double-fire)
  try {
    await sendHourlyReports({ force: false });
  } catch (err) {
    console.error('[hourlyReport] tick error:', err.message);
    _sentHourKey = null;                              // allow a retry next tick on failure
  }
}

function startScheduler() {
  if (_timer) return;
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  console.log('[hourlyReport] scheduler started (hourly 9 AM–6 PM IST, Mon–Sat)');
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startScheduler, stopScheduler, sendHourlyReports, buildReportRows, formatReportMessage };
