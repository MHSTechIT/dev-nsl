/**
 * NSM-IVR WhatsApp reminder scheduler — independent clone of
 * nsmWhatsappScheduler for the nsm_ivr_* tables / nsm_ivr_settings.
 */
const pool = require('../db');
const whapi = require('./whapiClient');
const { mergeNsmSettings } = require('./nsmSettingsDefaults');

const GRACE_MIN = 24 * 60;

function fmtIST(dt, opts) { return new Date(dt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...opts }); }

function fillPlaceholders(text, batch) {
  const wa = batch.webinar_at;
  const date = wa ? fmtIST(wa, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const time = wa ? fmtIST(wa, { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
  return String(text || '')
    .replace(/\{batch_name\}/g, batch.batch_name || '')
    .replace(/\{webinar_date\}/g, date)
    .replace(/\{webinar_time\}/g, time)
    .replace(/\{webinar_link\}/g, batch.webinar_link || '')
    .replace(/\{meeting_id\}/g, batch.webinar_meeting_id || '');
}

async function loadSettings() {
  try {
    const { rows } = await pool.query('SELECT settings FROM nsm_ivr_settings WHERE id = 1');
    return mergeNsmSettings(rows[0] && rows[0].settings);
  } catch { return mergeNsmSettings(null); }
}

async function sendTemplate(batch, tpl) {
  const to = batch.whatsapp_group_id;
  const text = fillPlaceholders(tpl.content, batch);
  if (tpl.type === 'poll') {
    if (text.trim()) await whapi.sendText({ to, body: text });
    const opts = ((tpl.poll && tpl.poll.options) || []).map(o => fillPlaceholders(o, batch)).filter(Boolean);
    const title = fillPlaceholders((tpl.poll && tpl.poll.title) || 'Poll', batch);
    return whapi.sendPoll({ to, title, options: opts });
  }
  if ((tpl.type === 'image' || tpl.type === 'video') && tpl.media_url) {
    return whapi.sendMedia({ to, type: tpl.type, mediaUrl: tpl.media_url, caption: text });
  }
  return whapi.sendText({ to, body: text });
}

async function tick() {
  if (!whapi.isConfigured()) return;
  const settings = await loadSettings();
  if (!settings.whatsapp.enabled) return;
  const templates = (settings.whatsapp.templates || []).filter(t => t && t.enabled);
  if (templates.length === 0) return;

  const { rows: batches } = await pool.query(
    `SELECT id, batch_name, webinar_at, webinar_link, webinar_meeting_id, whatsapp_group_id
       FROM nsm_ivr_batches
      WHERE whatsapp_group_id IS NOT NULL AND webinar_at IS NOT NULL`
  );
  const now = Date.now();
  for (const batch of batches) {
    const wa = new Date(batch.webinar_at).getTime();
    for (const tpl of templates) {
      const sendAt = wa + (Number(tpl.offset_minutes) || 0) * 60000;
      if (now < sendAt) continue;
      if (now > sendAt + GRACE_MIN * 60000) continue;
      let claimId;
      try {
        const cl = await pool.query(
          `INSERT INTO nsm_ivr_batch_messages (batch_id, template_key) VALUES ($1, $2)
           ON CONFLICT (batch_id, template_key) DO NOTHING RETURNING id`,
          [batch.id, tpl.key]
        );
        claimId = cl.rowCount > 0 ? cl.rows[0].id : null;
      } catch { continue; }
      if (!claimId) continue;
      try {
        const resp = await sendTemplate(batch, tpl);
        await pool.query(`UPDATE nsm_ivr_batch_messages SET sent_at = NOW(), status = 'sent', response = $1::jsonb WHERE id = $2`, [JSON.stringify(resp || {}), claimId]);
        console.log(`[nsmIvrWhatsapp] sent ${tpl.key} → ${batch.batch_name}`);
      } catch (e) {
        await pool.query(`UPDATE nsm_ivr_batch_messages SET status = 'error', response = $1::jsonb WHERE id = $2`, [JSON.stringify({ error: e.message }), claimId]).catch(() => {});
        console.error(`[nsmIvrWhatsapp] send ${tpl.key} failed:`, e.message);
      }
    }
  }
}

let _timer = null, _running = false;
function startScheduler(intervalMs = 60 * 1000) {
  if (_timer) return;
  const run = async () => {
    if (_running) return;
    _running = true;
    try { await tick(); } catch (e) { console.error('[nsmIvrWhatsapp] tick error:', e.message); }
    finally { _running = false; }
  };
  run();
  _timer = setInterval(run, intervalMs);
  console.log(`[nsmIvrWhatsapp] message scheduler every ${Math.round(intervalMs / 1000)}s`);
}

module.exports = { startScheduler, sendTemplate, fillPlaceholders, tick };
