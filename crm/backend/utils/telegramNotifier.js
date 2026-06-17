/*
 * telegramNotifier — push CRM events to Telegram chats.
 *
 * Recipients live in the `telegram_alert_recipients` table and are managed
 * by admins via the Alerts tab. Each row says either:
 *   target_type='team_leader' → forward events about callers reporting to
 *                               team_leader_id
 *   target_type='manager'     → forward events about callers in `department`
 *                               (NULL department = subscribe to all depts)
 *
 * Set TELEGRAM_BOT_TOKEN in .env. If it's missing every send becomes a
 * no-op + warning log — the CRM keeps working, alerts just don't deliver.
 *
 * All sends are fire-and-forget so a Telegram outage never blocks the
 * underlying CRM action (pause, resume, etc.).
 */
const pool = require('../db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_API    = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

const ROLE_LABEL = {
  junior_caller: 'Junior Caller',
  senior_caller: 'Senior Caller',
  manager:       'Manager',
  trainer:       'Trainer',
  team_leader:   'Team Leader',
  admin:         'Admin',
};

const REASON_LABEL = {
  smartflow_cap_exceeded: 'SmartFlow retry cap exceeded — agent leg unanswered 5 times',
  'robot nudge ignored':  'Ignored repeated robot nudges',
  break_overrun:          'Break ran over the allowed window',
};
function prettyReason(r) {
  if (!r) return 'Auto-paused — no reason recorded';
  return REASON_LABEL[r] || r;
}

/* ──────────────────────────────────────────────────────────────────────
   Low-level send. Returns { ok, error?, message_id? }. Never throws.
   `opts.reply_markup` lets callers attach inline keyboards (Resume button).
   ────────────────────────────────────────────────────────────────────── */
async function sendTelegram(chatId, text, opts = {}) {
  if (!BOT_TOKEN) {
    console.warn('[telegramNotifier] TELEGRAM_BOT_TOKEN missing — skipping send.');
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  }
  if (!chatId) return { ok: false, error: 'chat_id missing' };

  try {
    const body = {
      chat_id:    String(chatId),
      text:       text,
      parse_mode: 'HTML',
    };
    if (opts.reply_markup) body.reply_markup = opts.reply_markup;

    const res = await fetch(TG_API('sendMessage'), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = data.description || `Telegram API ${res.status}`;
      console.error('[telegramNotifier] sendTelegram failed:', err);
      return { ok: false, error: err };
    }
    return { ok: true, message_id: data.result?.message_id };
  } catch (err) {
    console.error('[telegramNotifier] sendTelegram threw:', err.message);
    return { ok: false, error: err.message };
  }
}

/* Edit a previously-sent message in place — used to swap the "Resume"
   button for a "Resumed by X at HH:MM" confirmation. */
async function editTelegramMessage(chatId, messageId, text, opts = {}) {
  if (!BOT_TOKEN || !chatId || !messageId) return { ok: false };
  try {
    const body = {
      chat_id:    String(chatId),
      message_id: messageId,
      text:       text,
      parse_mode: 'HTML',
    };
    if (opts.reply_markup !== undefined) body.reply_markup = opts.reply_markup;

    const res = await fetch(TG_API('editMessageText'), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: !!data.ok, error: data.description };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* Acknowledge an inline-keyboard tap so Telegram's spinner clears.
   `text` (≤200 chars) is shown as a toast in the user's chat. */
async function answerCallback(callbackQueryId, text, asAlert = false) {
  if (!BOT_TOKEN || !callbackQueryId) return { ok: false };
  try {
    const res = await fetch(TG_API('answerCallbackQuery'), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        callback_query_id: callbackQueryId,
        text:              text || '',
        show_alert:        !!asAlert,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: !!data.ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Pick the recipient rows for an event about `caller` (a crm_users row).
   Returns the list of telegram_alert_recipients to push to.
   ────────────────────────────────────────────────────────────────────── */
async function recipientsForCaller(caller) {
  // SQL: any TL row whose team_leader_id equals THIS caller's team_leader_id,
  //      plus any manager row whose department matches the caller's
  //      department (or whose department is NULL = subscribes to everything).
  const { rows } = await pool.query(
    `SELECT id, telegram_chat_id, target_type, team_leader_id, department, label
       FROM telegram_alert_recipients
      WHERE (target_type = 'team_leader' AND team_leader_id = $1)
         OR (target_type = 'manager' AND (department = $2 OR department IS NULL))`,
    [caller.team_leader_id || null, caller.department || null]
  );
  return rows;
}

/* ──────────────────────────────────────────────────────────────────────
   Public: notify TLs + managers about an auto-pause event.
   Hooked from routes/caller.js at every UPDATE that sets auto_paused_at.
   ────────────────────────────────────────────────────────────────────── */
async function notifyAutoPause(callerId, reason) {
  try {
    // Pull the up-to-date crm_users row so we have full_name, role, dept,
    // and the team_leader_id needed to route the alert.
    const { rows } = await pool.query(
      `SELECT id, full_name, role, department, team_leader_id
         FROM crm_users
        WHERE id = $1`,
      [callerId]
    );
    const caller = rows[0];
    if (!caller) return;

    const recipients = await recipientsForCaller(caller);
    if (recipients.length === 0) return;

    const text = [
      `🛑 <b>Auto-pause alert</b>`,
      ``,
      `<b>${escapeHtml(caller.full_name)}</b> (${ROLE_LABEL[caller.role] || caller.role}) was auto-paused.`,
      `Department: ${caller.department || '—'}`,
      `Reason: ${escapeHtml(prettyReason(reason))}`,
      ``,
      `Tap <b>Resume</b> below, or reply <code>resume</code>.`,
    ].join('\n');

    // Inline button: callback_data is namespaced so the handler can route.
    const reply_markup = {
      inline_keyboard: [[
        { text: '✅ Resume caller', callback_data: `resume:${caller.id}` },
      ]],
    };

    // Fire-and-forget all sends in parallel.
    await Promise.all(recipients.map(r =>
      sendTelegram(r.telegram_chat_id, text, { reply_markup })
    ));
  } catch (err) {
    console.error('[telegramNotifier] notifyAutoPause error:', err.message);
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Public: notify MANAGERS that a caller's Assigned page has been empty for
   the configured delay (mgrEmptyLeadsAlertDelayMs on the TL & Assistant
   Timer sub-page). The TL/assistant see the empty state immediately on the
   Notifications page; the manager is pinged only after this delay.
   Sent to manager recipients only (target_type='manager'); fired by
   emptyQueueAlertScheduler.
   ────────────────────────────────────────────────────────────────────── */
async function notifyEmptyQueue(caller, minutesEmpty) {
  try {
    const recipients = (await recipientsForCaller(caller)).filter(r => r.target_type === 'manager');
    if (recipients.length === 0) return;

    const text = [
      `⚠️ <b>Empty queue alert</b>`,
      ``,
      `<b>${escapeHtml(caller.full_name)}</b> (${ROLE_LABEL[caller.role] || caller.role}) has had <b>zero</b> assigned leads for <b>${minutesEmpty} min</b>.`,
      `Department: ${caller.department || '—'}`,
      ``,
      `Please refill their queue.`,
    ].join('\n');

    await Promise.all(recipients.map(r => sendTelegram(r.telegram_chat_id, text)));
  } catch (err) {
    console.error('[telegramNotifier] notifyEmptyQueue error:', err.message);
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Public: system alert that member-based WhatsApp link rotation is FROZEN
   for a workspace because Whapi couldn't read the community member count
   (admin number not in the group, channel disconnected, etc.). Per product
   decision the link does NOT rotate until this is fixed, so we ping the
   operators. Sent to every manager recipient (or all recipients if none are
   tagged as managers). Fire-and-forget.
   ────────────────────────────────────────────────────────────────────── */
async function notifyLinkRotationFrozen(source, webinarName, reason) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT telegram_chat_id, target_type FROM telegram_alert_recipients
        WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id <> ''`
    );
    if (rows.length === 0) return;
    const managers = rows.filter(r => r.target_type === 'manager');
    const targets = (managers.length ? managers : rows);

    const text = [
      `🔗 <b>WhatsApp link rotation FROZEN</b>`,
      ``,
      `Workspace: <b>${escapeHtml(source)}</b>${webinarName ? ` — ${escapeHtml(webinarName)}` : ''}`,
      `The community member count couldn't be read from Whapi, so the link will NOT rotate to the next group.`,
      `Reason: <code>${escapeHtml(reason || 'unknown')}</code>`,
      ``,
      `Fix the Whapi connection (make sure the admin number is still in the community and the channel is connected), then rotation resumes automatically.`,
    ].join('\n');

    await Promise.all(targets.map(r => sendTelegram(r.telegram_chat_id, text)));
  } catch (err) {
    console.error('[telegramNotifier] notifyLinkRotationFrozen error:', err.message);
  }
}

/* Tiny HTML-escaper for Telegram's `parse_mode: HTML`. Keep this in sync
   with any new tag we use (b, i, code, etc.). */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  sendTelegram,
  editTelegramMessage,
  answerCallback,
  notifyAutoPause,
  notifyEmptyQueue,
  notifyLinkRotationFrozen,
  escapeHtml,
  prettyReason,
};
