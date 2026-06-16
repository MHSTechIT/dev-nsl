/**
 * webinar.config.updated NOTIFY handler.
 *
 * Runs on the funnel-meta and funnel-yt services (and on the single-process
 * app.js in dev mode). The CRM admin route fires pg_notify with the source
 * tag whenever webinar_config is updated. Each funnel service LISTENs, fetches
 * the fresh row for the matching source, invalidates its local cache, and
 * rebroadcasts the new config to its connected SPA clients via sseClients —
 * so funnel landing pages see the change within ~1 second without polling.
 */
const pool        = require('../db');
const cache       = require('./webinarConfigCache');
const sseClients  = require('./sseClients');

const SOURCES = new Set(['meta', 'yt', 'meta2', 'metatemp', 'tagmango']);

async function handleWebinarConfigUpdated(rawPayload) {
  const source = (rawPayload || '').trim();
  if (!SOURCES.has(source)) {
    console.error('[webinar.config.updated listener] invalid source:', rawPayload);
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT next_webinar_at, backup_webinar_at,
              tuesday_whatsapp_link, friday_whatsapp_link, kill_switch,
              pending_whatsapp_link, whatsapp_link_swap_at,
              pending_whatsapp_link_2, whatsapp_link_swap_at_2,
              current_webinar_date, next_webinar_date
         FROM webinar_config
        WHERE source = $1`,
      [source]
    );
    if (rows.length === 0) {
      console.warn('[webinar.config.updated listener] no row for source', source);
      return;
    }
    const fresh = { ...rows[0] };
    cache.set(fresh, source);
    sseClients.broadcast(fresh, source);
    console.log(`[webinar.config.updated listener] rebroadcast source=${source}`);
  } catch (e) {
    console.error('[webinar.config.updated listener] query failed:', e.message);
  }
}

module.exports = { handleWebinarConfigUpdated };
