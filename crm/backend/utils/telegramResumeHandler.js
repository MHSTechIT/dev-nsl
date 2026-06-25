/*
 * telegramResumeHandler — incoming-message dispatcher.
 *
 * Handles:
 *   • /start          — friendly greeting + echoes the chat_id so admins
 *                       can copy it into the CRM Alerts page.
 *   • /list  or  list — lists currently auto-paused callers in the
 *                       sender's scope (TL → their team; Manager → their
 *                       department; Manager-all → everyone).
 *   • resume          — resumes the MOST RECENTLY auto-paused caller in
 *                       the sender's scope. No-op if none are paused.
 *   • Resume button   — inline-keyboard callback. `callback_data` is
 *                       'resume:<callerId>'; this is the cleanest UX and
 *                       removes ambiguity if multiple callers are paused.
 *
 * Authorization: the sender's chat_id must be registered in
 * telegram_alert_recipients AND the targeted caller must fall within
 * that recipient's scope. Unregistered chats get a short refusal.
 */
const pool   = require('../db');
const callerSse = require('./callerSse');
const {
  sendTelegram,
  editTelegramMessage,
  answerCallback,
  escapeHtml,
} = require('./telegramNotifier');

const ROLE_LABEL = {
  junior_caller: 'Junior Caller',
  senior_caller: 'Senior Caller',
  manager:       'Manager',
  trainer:       'Trainer',
  team_leader:   'Team Leader',
  admin:         'Admin',
};

/* ──────────────────────────────────────────────────────────────────────
   Core resume operation. Single-source-of-truth for what "resume" means.
   The /api/admin/crm-users PATCH path does the same UPDATE; if either
   evolves, mirror the change here.
   ────────────────────────────────────────────────────────────────────── */
async function resumeCaller(callerId, sourceLabel) {
  // Only act when the caller is currently auto-paused. Returning RETURNING
  // rows tells us whether this was a real transition or a no-op (which
  // matters for the user-facing message).
  const { rows } = await pool.query(
    `UPDATE crm_users
        SET is_active              = TRUE,
            auto_paused_at         = NULL,
            auto_pause_reason      = NULL,
            -- 10-min grace: the break-overrun watchdog won't re-pause until this
            -- passes, so a caller still mid-break isn't re-blocked instantly.
            auto_pause_grace_until = NOW() + INTERVAL '10 minutes'
      WHERE id = $1
        AND auto_paused_at IS NOT NULL
   RETURNING id, full_name, role, department`,
    [callerId]
  );
  if (rows.length === 0) return { ok: false, reason: 'not_paused' };
  const caller = rows[0];

  try { callerSse.pushTo(callerId, { type: 'caller.resumed' }); } catch (_) {}
  console.log(JSON.stringify({
    type:      'caller.resume',
    source:    sourceLabel,
    caller_id: callerId,
    at:        new Date().toISOString(),
  }));

  return { ok: true, caller };
}

/* Find recipient + check whether a given chat is allowed to act on a
   given caller. Returns the recipient row when authorized, null otherwise.
   Multiple rows for the same chat_id are merged: a single chat can act
   on the union of their scopes (rare but legal). */
async function authorizeChatForCaller(chatId, callerId) {
  const { rows } = await pool.query(
    `SELECT r.target_type, r.team_leader_id, r.department,
            c.team_leader_id AS caller_tl,
            c.department     AS caller_dept,
            c.full_name      AS caller_name,
            c.auto_paused_at AS caller_paused_at
       FROM telegram_alert_recipients r
       CROSS JOIN crm_users c
      WHERE r.telegram_chat_id = $1
        AND c.id = $2`,
    [String(chatId), callerId]
  );

  for (const r of rows) {
    if (r.target_type === 'team_leader' && r.team_leader_id === r.caller_tl) {
      return { authorized: true, callerName: r.caller_name, paused: !!r.caller_paused_at };
    }
    if (r.target_type === 'manager') {
      if (!r.department || r.department === r.caller_dept) {
        return { authorized: true, callerName: r.caller_name, paused: !!r.caller_paused_at };
      }
    }
  }
  return { authorized: false };
}

/* List paused callers in the chat's scope. Used by `list` and as the
   data source for the "resume the most recent" path. */
async function pausedCallersForChat(chatId, limit = 20) {
  const { rows } = await pool.query(
    `WITH recipient AS (
       SELECT target_type, team_leader_id, department
         FROM telegram_alert_recipients
        WHERE telegram_chat_id = $1
     )
     SELECT u.id, u.full_name, u.role, u.department, u.auto_paused_at,
            u.auto_pause_reason
       FROM crm_users u
      WHERE u.auto_paused_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM recipient r
           WHERE (r.target_type = 'team_leader' AND u.team_leader_id = r.team_leader_id)
              OR (r.target_type = 'manager' AND (r.department IS NULL OR u.department = r.department))
        )
      ORDER BY u.auto_paused_at DESC
      LIMIT $2`,
    [String(chatId), limit]
  );
  return rows;
}

/* Is this chat_id known to us at all? Used to refuse strangers politely. */
async function chatIsRegistered(chatId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM telegram_alert_recipients WHERE telegram_chat_id = $1 LIMIT 1`,
    [String(chatId)]
  );
  return rows.length > 0;
}

/* ──────────────────────────────────────────────────────────────────────
   Update → action dispatch.
   ────────────────────────────────────────────────────────────────────── */

async function handleMessage(update) {
  const msg    = update.message;
  if (!msg || !msg.from || !msg.text) return;
  const chatId = msg.from.id;
  const text   = String(msg.text).trim();
  const lower  = text.toLowerCase();

  // /start works for anyone — it's how a new recipient learns their chat_id.
  if (lower === '/start' || lower === 'start') {
    await sendTelegram(chatId, [
      `👋 Hi! I'm <b>MHS Eva</b>.`,
      ``,
      `I'll DM you when a caller you supervise is auto-paused. Tap the <b>Resume</b> button on those messages — or reply <code>resume</code> — to put them back on the floor.`,
      ``,
      `Your chat_id: <code>${chatId}</code>`,
      `Paste that into the CRM → Alerts page to start receiving alerts.`,
    ].join('\n'));
    return;
  }

  // Everyone past this point must be a registered alert recipient.
  if (!(await chatIsRegistered(chatId))) {
    await sendTelegram(chatId, [
      `⛔ This chat (<code>${chatId}</code>) isn't registered as an MHS CRM alert recipient.`,
      ``,
      `Ask an admin to add this chat_id on the CRM → Alerts page.`,
    ].join('\n'));
    return;
  }

  // Commands accepted as either '/cmd' or bare 'cmd' since most people
  // forget the slash.
  if (lower === '/list' || lower === 'list' || lower === '/paused' || lower === 'paused') {
    const list = await pausedCallersForChat(chatId);
    if (list.length === 0) {
      await sendTelegram(chatId, `🟢 No auto-paused callers in your scope right now.`);
      return;
    }
    const lines = list.map((c, i) =>
      `${i + 1}. <b>${escapeHtml(c.full_name)}</b> — ${ROLE_LABEL[c.role] || c.role}${c.department ? ` · ${c.department}` : ''}`
    );
    await sendTelegram(chatId, [
      `<b>Paused callers in your scope (${list.length}):</b>`,
      ``,
      ...lines,
      ``,
      `Reply <code>resume</code> to resume the most recent.`,
    ].join('\n'));
    return;
  }

  if (lower === 'resume' || lower === '/resume') {
    const list = await pausedCallersForChat(chatId, 1);
    if (list.length === 0) {
      await sendTelegram(chatId, `🟢 No paused callers in your scope right now.`);
      return;
    }
    const target = list[0];
    const result = await resumeCaller(target.id, `telegram-text:${chatId}`);
    if (!result.ok) {
      await sendTelegram(chatId, `Couldn't resume <b>${escapeHtml(target.full_name)}</b> — they may already be active.`);
      return;
    }
    await sendTelegram(chatId, `✅ Resumed <b>${escapeHtml(result.caller.full_name)}</b>.`);
    return;
  }

  // Fall-through: unknown command. Keep this terse so it doesn't feel spammy.
  await sendTelegram(chatId, [
    `I didn't catch that. Try:`,
    `• <code>resume</code> — resume the most recently paused caller`,
    `• <code>list</code> — show paused callers in your scope`,
  ].join('\n'));
}

async function handleCallback(update) {
  const cb = update.callback_query;
  if (!cb || !cb.from) return;
  const chatId = cb.from.id;
  const data   = String(cb.data || '');

  if (!data.startsWith('resume:')) {
    await answerCallback(cb.id, 'Unknown action.', true);
    return;
  }
  const callerId = data.slice('resume:'.length);

  // Authorization + paused-state check.
  const auth = await authorizeChatForCaller(chatId, callerId);
  if (!auth.authorized) {
    await answerCallback(cb.id, '⛔ Not authorized to resume this caller.', true);
    return;
  }
  if (!auth.paused) {
    await answerCallback(cb.id, 'Caller is already active.', true);
    // Still strip the button so the chat stays tidy.
    if (cb.message) {
      await editTelegramMessage(
        cb.message.chat.id,
        cb.message.message_id,
        `${cb.message.text || ''}\n\n<i>Already active when checked.</i>`,
        { reply_markup: { inline_keyboard: [] } }
      );
    }
    return;
  }

  const result = await resumeCaller(callerId, `telegram-button:${chatId}`);
  if (!result.ok) {
    await answerCallback(cb.id, 'Resume failed. Try again.', true);
    return;
  }

  // Cheap toast inside the user's chat.
  await answerCallback(cb.id, `✅ Resumed ${result.caller.full_name}`);

  // Permanent record in the chat history — replace the buttons with a
  // "resumed by X at HH:MM" footer so the original alert reflects the
  // outcome forever.
  if (cb.message) {
    const who = cb.from.first_name
      ? `${cb.from.first_name}${cb.from.username ? ` (@${cb.from.username})` : ''}`
      : `chat ${chatId}`;
    const when = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
    await editTelegramMessage(
      cb.message.chat.id,
      cb.message.message_id,
      `${cb.message.text || ''}\n\n✅ <b>Resumed</b> by ${escapeHtml(who)} · ${when} IST`,
      { reply_markup: { inline_keyboard: [] } }
    );
  }
}

module.exports = {
  handleMessage,
  handleCallback,
  resumeCaller,
};
