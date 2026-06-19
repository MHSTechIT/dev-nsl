/*
 * whatsappAlerts — auto-pause alerts over WhatsApp (Whapi), replacing Telegram.
 *
 * Flow:
 *   1. A caller auto-pauses → notifyAutoPauseWhatsApp() sends a WhatsApp message
 *      to each alert recipient's number (telegram_alert_recipients.telegram_chat_id
 *      now holds a WhatsApp number) with a "✅ Resume caller" quick-reply button.
 *      The button id encodes "resume:<callerId>".
 *   2. The recipient taps the button (or replies "resume") → Whapi delivers the
 *      inbound message to our webhook → handleInboundResume() resumes the caller
 *      (resumeCaller pushes a live SSE so the app releases them instantly).
 *
 * Send channel: the "Web Reminder" Whapi channel pinned at
 * webinar_config.source='webreminder' (the card on the Web Reminder → Alerts page).
 */
const pool = require('../db');
const { sendButtonsToNumber, sendTextToNumber, waNumber } = require('./whapiSend');
const { resumeCaller } = require('./telegramResumeHandler');

const ROLE_LABEL = { junior_caller: 'Junior Caller', senior_caller: 'Senior Caller', team_leader: 'Team Leader', manager: 'Manager' };
const prettyReason = (r) => ({
  idle_nudge_exhausted: 'Idle — never pressed Start Call',
  ext_alert_exhausted:  'SmartFlow extension not confirmed',
  agent_reason_exhausted: 'Repeated SmartFlow misses',
}[r] || r || 'Auto-paused');

/* The pinned Web-Reminder Whapi channel id (the "leadgenx alert" channel). */
async function alertChannelId() {
  const { rows } = await pool.query("SELECT whapi_channel_id FROM webinar_config WHERE source = 'webreminder'");
  return rows[0]?.whapi_channel_id || null;
}

/* Recipients to alert for this caller (TLs over them + matching managers).
   telegram_chat_id is reused as the WhatsApp number. */
async function recipientsForCaller(caller) {
  const { rows } = await pool.query(
    `SELECT telegram_chat_id AS wa_number, target_type, label
       FROM telegram_alert_recipients
      WHERE (target_type = 'team_leader' AND team_leader_id = $1)
         OR (target_type = 'manager' AND (department = $2 OR department IS NULL))`,
    [caller.team_leader_id || null, caller.department || null]
  );
  return rows.filter(r => waNumber(r.wa_number).length >= 10);   // only real WhatsApp numbers
}

/* Send the auto-pause alert (with a Resume button) over WhatsApp. */
async function notifyAutoPauseWhatsApp(callerId, reason) {
  try {
    const channelId = await alertChannelId();
    if (!channelId) { console.warn('[whatsappAlerts] no Web-Reminder Whapi channel pinned — skipping'); return; }

    const { rows } = await pool.query(
      'SELECT id, full_name, role, department, team_leader_id FROM crm_users WHERE id = $1', [callerId]);
    const caller = rows[0];
    if (!caller) return;
    const recipients = await recipientsForCaller(caller);
    if (recipients.length === 0) return;

    const body = [
      `🛑 Auto-pause alert`,
      ``,
      `${caller.full_name} (${ROLE_LABEL[caller.role] || caller.role}) was auto-paused.`,
      `Department: ${caller.department || '—'}`,
      `Reason: ${prettyReason(reason)}`,
      ``,
      `Tap "Resume caller" below (or reply: resume:${caller.id}).`,
    ].join('\n');

    const buttons = [{ id: `resume:${caller.id}`, title: '✅ Resume caller' }];
    await Promise.all(recipients.map(r =>
      sendButtonsToNumber(channelId, r.wa_number, body, buttons)
        .catch(e => console.error(`[whatsappAlerts] send to ${r.wa_number} failed: ${e.message}`))
    ));
  } catch (err) {
    console.error('[whatsappAlerts] notifyAutoPauseWhatsApp error:', err.message);
  }
}

/* Handle an inbound Whapi message (webhook). Looks for a "resume:<callerId>"
   token in the button reply id OR the text body, verifies the sender is a
   registered recipient, resumes the caller, and replies with a confirmation. */
async function handleInboundResume(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    if (m.from_me) continue;                              // ignore our own echoes
    const from = waNumber(m.from || m.chat_id);
    // The button id (quick-reply) or text body — scan the whole message so we're
    // resilient to Whapi's exact reply shape across plans.
    const blob = JSON.stringify(m);
    const match = blob.match(/resume:([0-9a-fA-F-]{6,})/);
    if (!match) continue;
    const callerId = match[1];

    // Only a registered alert recipient may resume. Compare the LAST 10 digits
    // so a stored "9176753253" matches an inbound "919176753253" (country code).
    const { rows: rec } = await pool.query(
      "SELECT 1 FROM telegram_alert_recipients WHERE RIGHT(regexp_replace(telegram_chat_id, '\\D', '', 'g'), 10) = RIGHT($1, 10) LIMIT 1",
      [from]);
    if (rec.length === 0) { console.warn(`[whatsappAlerts] resume from unregistered number ${from} — ignored`); continue; }

    const channelId = await alertChannelId();
    const result = await resumeCaller(callerId, `whatsapp:${from}`);
    if (channelId && from) {
      const reply = result.ok
        ? `✅ Resumed ${result.caller.full_name}.`
        : (result.reason === 'not_paused' ? 'That caller is already active.' : 'Resume failed — try again.');
      try { await sendTextToNumber(channelId, from, reply); } catch (_) {}
    }
    console.log(`[whatsappAlerts] resume via WhatsApp from ${from} → caller ${callerId}: ${result.ok ? 'OK' : result.reason}`);
  }
}

module.exports = { notifyAutoPauseWhatsApp, handleInboundResume, alertChannelId };
