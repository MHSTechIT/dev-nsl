/**
 * Telegram alert config for the NSM workspaces — a single JSONB row per
 * workspace (nsm_tele_config for NSM-Caller, nsm_ivr_tele_config for NSM-IVR).
 * Shape: { enabled, bot_token, chat_id }. The "Tele" page edits it; alerts can
 * send via sendTeleMessage() once the bot token + chat id are filled in.
 */
const pool = require('../db');

const TELE_TABLES = new Set(['nsm_tele_config', 'nsm_ivr_tele_config']);

function mergeTeleConfig(stored) {
  stored = stored && typeof stored === 'object' ? stored : {};
  return {
    enabled:   stored.enabled != null ? !!stored.enabled : false,
    bot_token: stored.bot_token != null ? String(stored.bot_token).trim() : '',
    chat_id:   stored.chat_id != null ? String(stored.chat_id).trim() : '',
  };
}

async function loadTeleConfig(table = 'nsm_tele_config') {
  const T = TELE_TABLES.has(table) ? table : 'nsm_tele_config';
  try {
    const { rows } = await pool.query(`SELECT config FROM ${T} WHERE id = 1`);
    return mergeTeleConfig(rows[0] && rows[0].config);
  } catch (e) { return mergeTeleConfig(null); }
}

async function saveTeleConfig(table, incoming) {
  const T = TELE_TABLES.has(table) ? table : 'nsm_tele_config';
  const merged = mergeTeleConfig(incoming);
  await pool.query(
    `INSERT INTO ${T} (id, config, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
    [JSON.stringify(merged)]
  );
  return merged;
}

/** Send a message via a bot token to a chat id (Telegram Bot API). */
async function sendTeleMessage({ bot_token, chat_id, text }) {
  if (!bot_token || !chat_id) throw new Error('Bot token and chat/user ID are required.');
  const res = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text: text || '✅ Test alert from MHS CRM', disable_web_page_preview: true }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.description || `Telegram error ${res.status}`);
  return j;
}

module.exports = { TELE_TABLES, mergeTeleConfig, loadTeleConfig, saveTeleConfig, sendTeleMessage };
