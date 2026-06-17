/*
 * metaLeadSyncScheduler — runs the Meta lead RECONCILIATION sweep every few
 * minutes as a safety net behind the real-time webhook (routes/metaLeadgenWebhook).
 *
 * Crash-safety guardrails (the four that actually matter at any poll interval):
 *   1. Errors caught — each run is wrapped in try/catch; nothing bubbles to an
 *      unhandled rejection, and syncMetaLeadsForSource itself returns errors as
 *      values rather than throwing.
 *   2. No DB leak — the sync path uses pool.query() only (no manual connect()).
 *   3. No overlap — a re-entrancy guard skips a tick if the previous run is
 *      still going (e.g. Meta is slow), so runs can never pile up.
 *   4. Token issues are logged, not fatal.
 */
const pool = require('../db');
const { syncMetaLeadsForSource } = require('./metaLeadSync');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // every 5 minutes
const WINDOW_MINUTES      = 15;              // look back 15 min (overlap is free — dedup)

let _timer   = null;
let _running = false;   // re-entrancy guard

async function tick() {
  if (_running) { console.warn('[metaLeadSync] previous run still in progress — skipping this tick'); return; }
  _running = true;
  try {
    // Sweep every workspace that has at least one lead form selected.
    const { rows } = await pool.query(
      `SELECT source FROM webinar_config
        WHERE (current_form_id IS NOT NULL AND current_form_id <> '')
           OR (next_form_id    IS NOT NULL AND next_form_id    <> '')`);
    for (const r of rows) {
      try { await syncMetaLeadsForSource(r.source, { windowMinutes: WINDOW_MINUTES }); }
      catch (e) { console.error(`[metaLeadSync:${r.source}]`, e.message); }
    }
  } catch (e) {
    console.error('[metaLeadSync] tick error:', e.message);
  } finally {
    _running = false;
  }
}

function startMetaLeadSyncScheduler({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _timer = setInterval(tick, intervalMs);
  console.log(`[metaLeadSync] reconciliation scheduler started — every ${Math.round(intervalMs / 60000)} min (window ${WINDOW_MINUTES} min)`);
}

function stopMetaLeadSyncScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startMetaLeadSyncScheduler, stopMetaLeadSyncScheduler, tick };
