/**
 * Long-lived Postgres LISTEN client.
 *
 * The pg `Pool` recycles connections, which is no good for LISTEN — the
 * listener has to stay on one open socket for the lifetime of the process.
 * This wrapper owns its own `pg.Client`, reconnects with exponential backoff
 * if the socket drops, and dispatches notifications to handler functions
 * keyed by channel name.
 *
 * Used by the split entry files (servers/funnel-meta.js, servers/funnel-yt.js,
 * servers/crm.js) plus the legacy single-process app.js for dev mode.
 *
 * Usage:
 *   const { startListener } = require('./utils/pgListener');
 *   startListener({
 *     'lead.created':            (payload) => handleLeadCreated(payload),
 *     'webinar.config.updated':  (payload) => handleWebinarConfigUpdated(payload),
 *   });
 */
const { Client } = require('pg');

let _client = null;
let _handlers = {};
let _connecting = false;
let _stopped    = false;
let _backoffMs  = 1_000;
const MAX_BACKOFF_MS = 30_000;

function clientConfig() {
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  };
}

async function connect() {
  if (_stopped) return;
  if (_connecting) return;
  _connecting = true;
  try {
    _client = new Client(clientConfig());
    _client.on('error', (err) => {
      console.error('[pgListener] client error:', err.message);
      // Don't reconnect from here — pg emits 'error' alongside 'end' on socket
      // failures, so the 'end' handler is the canonical reconnect trigger.
    });
    _client.on('end', () => {
      console.warn('[pgListener] connection ended — scheduling reconnect');
      _client = null;
      if (!_stopped) scheduleReconnect();
    });
    _client.on('notification', (msg) => {
      const fn = _handlers[msg.channel];
      if (!fn) return;
      try { fn(msg.payload || ''); }
      catch (e) { console.error(`[pgListener] handler '${msg.channel}' threw:`, e.message); }
    });
    await _client.connect();
    for (const channel of Object.keys(_handlers)) {
      await _client.query(`LISTEN "${channel}"`);
    }
    console.log(`[pgListener] connected, LISTENing on:`, Object.keys(_handlers).join(', '));
    _backoffMs = 1_000;  // reset on successful connect
  } catch (e) {
    console.error('[pgListener] connect failed:', e.message);
    _client = null;
    scheduleReconnect();
  } finally {
    _connecting = false;
  }
}

function scheduleReconnect() {
  const delay = _backoffMs;
  _backoffMs = Math.min(_backoffMs * 2, MAX_BACKOFF_MS);
  setTimeout(() => { connect().catch(() => {}); }, delay);
}

/**
 * Register channel handlers and open a long-lived LISTEN connection.
 * Safe to call multiple times — additional handlers are merged.
 */
function startListener(handlers) {
  _handlers = { ..._handlers, ...handlers };
  if (!_client && !_connecting) connect().catch(() => {});
  else if (_client) {
    // Connection already open — register any new channels on the existing socket.
    for (const channel of Object.keys(handlers)) {
      _client.query(`LISTEN "${channel}"`).catch(e => {
        console.error(`[pgListener] LISTEN ${channel} failed:`, e.message);
      });
    }
  }
}

function stopListener() {
  _stopped = true;
  if (_client) {
    try { _client.end(); } catch (_) { /* ignore */ }
    _client = null;
  }
}

module.exports = { startListener, stopListener };
