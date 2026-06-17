/*
 * whapiMemberScheduler — drives member-count WhatsApp link rotation for the
 * Whapi workspaces (Meta Temp / TagMango). Every tick it finds each such
 * workspace's active webinar, polls the current community's live member count
 * via Whapi and advances the link when it hits the threshold.
 *
 * If Whapi can't read a workspace's count, rotation FREEZES (no lead-count
 * fallback) and we send a throttled Telegram alert so operators can fix the
 * connection. The throttle (one alert per workspace per ALERT_THROTTLE_MS)
 * keeps a transient blip from spamming the chat.
 *
 * Only workspaces with a pinned whapi_channel_id participate; meta/yt/meta2
 * keep their lead-count rotation (linkSwapScheduler + linkRotation.js).
 */
const pool = require('../db');
const { rotateByMembers } = require('./whapiLinkRotation');
const { notifyLinkRotationFrozen } = require('./telegramNotifier');

const WHAPI_SOURCES = ['metatemp', 'tagmango'];
const DEFAULT_INTERVAL_MS = 60_000;
const ALERT_THROTTLE_MS   = 60 * 60 * 1000;   // 1 alert / workspace / hour

// Errors that mean "nothing to do", not "broken" — never alert on these.
const BENIGN = new Set(['no_links', 'no_channel', 'no_active_webinar', 'missing_args']);

let _timer = null;
const _lastAlertAt = {};   // source -> epoch ms

async function tickSource(source) {
  // Workspace must have a pinned Whapi channel to use member rotation.
  const { rows: cfg } = await pool.query(
    'SELECT whapi_channel_id FROM webinar_config WHERE source = $1', [source]);
  const channelId = cfg[0]?.whapi_channel_id;
  if (!channelId) return;   // not configured for Whapi rotation yet

  // The active webinar for this workspace.
  const { rows: w } = await pool.query(
    'SELECT id, name FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1', [source]);
  if (w.length === 0) return;

  const res = await rotateByMembers(w[0].id, source, channelId);

  if (!res.ok && !BENIGN.has(res.error)) {
    // Whapi couldn't read the count → frozen. Alert (throttled).
    const now = Date.now();
    if (!_lastAlertAt[source] || now - _lastAlertAt[source] > ALERT_THROTTLE_MS) {
      _lastAlertAt[source] = now;
      console.warn(`[whapiMemberScheduler:${source}] rotation frozen — ${res.error}; alerting operators`);
      await notifyLinkRotationFrozen(source, w[0].name, res.error);
    }
  } else if (res.ok) {
    // Recovered — clear the throttle so the next failure alerts promptly.
    delete _lastAlertAt[source];
  }
}

async function tick() {
  for (const src of WHAPI_SOURCES) {
    try { await tickSource(src); }
    catch (err) { console.error(`[whapiMemberScheduler:${src}]`, err.message); }
  }
}

function startWhapiMemberScheduler({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _timer = setInterval(tick, intervalMs);
  console.log(`[whapiMemberScheduler] started — every ${Math.round(intervalMs / 1000)}s (sources: ${WHAPI_SOURCES.join(', ')})`);
}

function stopWhapiMemberScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startWhapiMemberScheduler, stopWhapiMemberScheduler, tick };
