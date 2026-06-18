/*
 * templateSendScheduler — auto-send Saved Templates to the WhatsApp community
 * group, scheduled relative to the workspace's current webinar date/time.
 *
 * Each minute, for every workspace that has active templates + a current webinar:
 *   1. Resolve the target: the workspace's pinned Whapi channel + the active
 *      link's group id (where the Whapi number is a member/admin).
 *   2. For each active template, compute its absolute send instant
 *      (templateSchedule.computeSendAt) off current_webinar_datetime.
 *   3. If it's due (now ≥ send_at) and not already handled for THIS webinar
 *      cycle, send it via Whapi and record the outcome.
 *
 * Safety:
 *   • webinar_key = the current_webinar_datetime — when the admin sets a NEW
 *     webinar date, the key changes and every template re-arms for that cycle.
 *   • template_sends(template_id, webinar_key) UNIQUE → a template is sent at
 *     most once per webinar. Re-checked each tick, so restarts never double-send.
 *   • Catch-up window: a template missed by < CATCHUP still sends (late); older
 *     than that is recorded 'skipped' so changing the webinar date can't blast
 *     a backlog of long-past reminders.
 *   • Single-instance assumption (this box is prod). All sends are gated by the
 *     UNIQUE row written AFTER a successful send; a transient failure is left
 *     unrecorded so the next tick retries within the catch-up window.
 */
const pool = require('../db');
const { computeSendAt } = require('./templateSchedule');
const { sendTemplateToGroup } = require('./whapiSend');
const { getMemberCount } = require('./whapiMembers');

const TICK_MS    = 60 * 1000;            // evaluate every minute
const CATCHUP_MS = 60 * 60 * 1000;       // send if missed by < 1h, else skip

let _timer = null;
let _running = false;

/* Resolve the send target for a workspace: pinned channel + active group id +
   the current webinar datetime. Returns null when nothing is set up yet. */
async function resolveTarget(source) {
  const { rows: cfg } = await pool.query(
    'SELECT whapi_channel_id, current_webinar_datetime FROM webinar_config WHERE source = $1', [source]);
  const channelId = cfg[0]?.whapi_channel_id;
  const webinarDatetime = cfg[0]?.current_webinar_datetime;
  if (!channelId || !webinarDatetime) return null;

  const { rows: w } = await pool.query(
    'SELECT id, wa_active_index FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1', [source]);
  const webinarId = w[0]?.id;
  if (!webinarId) return null;
  const activeIndex = Math.max(1, w[0]?.wa_active_index || 1);

  const { rows: links } = await pool.query(
    'SELECT id, link_url, whapi_group_id, order_index FROM whatsapp_links WHERE webinar_id = $1 ORDER BY order_index', [webinarId]);
  const active = links.find(l => l.order_index === activeIndex) || links[activeIndex - 1] || links[0];
  if (!active) return null;

  let groupId = active.whapi_group_id;
  if (!groupId && active.link_url) {
    // Not cached yet — resolve via the invite. getMemberCount throws if the
    // number isn't in the group (in which case a send couldn't work anyway).
    try { groupId = (await getMemberCount(channelId, active.link_url)).groupId; }
    catch (e) { return { channelId, webinarDatetime, error: `group_unresolved:${e.code || e.message}` }; }
  }
  if (!groupId) return { channelId, webinarDatetime, error: 'no_group_id' };
  return { channelId, groupId, webinarDatetime };
}

async function recordSend(templateId, webinarKey, source, status, detail) {
  try {
    await pool.query(
      `INSERT INTO template_sends (template_id, webinar_key, source, status, detail)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (template_id, webinar_key) DO NOTHING`,
      [templateId, webinarKey, source, status, (detail || '').slice(0, 240)]);
  } catch (e) { console.error('[templateSend] record error:', e.message); }
}

async function processSource(source, now) {
  const { rows: templates } = await pool.query(
    'SELECT id, name, day_offset, send_time, msg_type, media_url, body FROM wa_templates WHERE source = $1 AND is_active = TRUE',
    [source]);
  if (!templates.length) return;

  const target = await resolveTarget(source);
  if (!target) return;                        // no webinar/channel configured yet
  const webinarKey = new Date(target.webinarDatetime).toISOString();

  // Templates already handled (sent OR skipped) for this webinar cycle.
  const { rows: doneRows } = await pool.query(
    'SELECT template_id FROM template_sends WHERE webinar_key = $1 AND status IN (\'sent\',\'skipped\')', [webinarKey]);
  const done = new Set(doneRows.map(r => String(r.template_id)));

  for (const t of templates) {
    if (done.has(String(t.id))) continue;
    const sendAt = computeSendAt(target.webinarDatetime, t.day_offset, t.send_time);
    if (!sendAt) continue;
    if (now < sendAt.getTime()) continue;                       // not due yet
    if (now - sendAt.getTime() > CATCHUP_MS) {                  // long past → don't blast
      await recordSend(t.id, webinarKey, source, 'skipped', `past catch-up (due ${sendAt.toISOString()})`);
      continue;
    }
    // Due now. If the target couldn't be resolved (number not in group, etc.),
    // leave it UNrecorded so it retries next tick while still in the window.
    if (target.error) { console.warn(`[templateSend:${source}] ${t.name}: target ${target.error} — will retry`); continue; }
    try {
      const res = await sendTemplateToGroup(target.channelId, target.groupId, t);
      await recordSend(t.id, webinarKey, source, 'sent', `${res.mode}${res.note ? ' · ' + res.note : ''}`);
      console.log(`[templateSend:${source}] sent "${t.name}" (${res.mode}) → group ${target.groupId}`);
    } catch (e) {
      // Transient (or not-in-group) failure → don't record, retry next tick.
      console.error(`[templateSend:${source}] "${t.name}" failed: ${e.message}${e.data ? ' ' + JSON.stringify(e.data).slice(0, 160) : ''}`);
    }
  }
}

async function tick() {
  if (_running) return;
  _running = true;
  const now = Date.now();
  try {
    const { rows } = await pool.query('SELECT DISTINCT source FROM wa_templates WHERE is_active = TRUE');
    for (const r of rows) {
      try { await processSource(r.source, now); }
      catch (e) { console.error(`[templateSend:${r.source}]`, e.message); }
    }
  } catch (e) {
    console.error('[templateSend] tick error:', e.message);
  } finally { _running = false; }
}

function startTemplateSendScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _timer = setInterval(tick, TICK_MS);
  console.log('[templateSend] scheduler started — every 1 min, sends Saved Templates to the WhatsApp group per webinar schedule');
  tick().catch(e => console.error('[templateSend] initial tick:', e.message));
}

function stopTemplateSendScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startTemplateSendScheduler, stopTemplateSendScheduler, tick, resolveTarget };
