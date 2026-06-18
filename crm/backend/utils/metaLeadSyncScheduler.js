/*
 * metaLeadSyncScheduler — runs the Meta lead RECONCILIATION sweep behind the
 * real-time webhook (routes/metaLeadgenWebhook). Two cadences:
 *
 *   1. Fast poll  — every 5 min, 15-min window. Catches the common misses
 *      (cold start, deploy mid-delivery, a dropped webhook retry). 3× overlap.
 *   2. Hourly backfill — every 60 min, 6-hour window. Catches leads dropped by
 *      a LONGER outage that the 15-min window can't reach back to. Dedup
 *      (leads.meta_lead_id) makes the re-seen leads free, so a wide sweep is
 *      almost pure reads + near-zero writes.
 *
 * Crash-safety guardrails:
 *   1. Errors caught — every run is wrapped; syncMetaLeadsForSource returns
 *      errors as values rather than throwing.
 *   2. No DB leak — pool.query() only (no manual connect()).
 *   3. No overlap — BOTH cadences share ONE re-entrancy mutex (`_running`), so
 *      the fast poll and the hourly backfill can never run at the same time and
 *      never pile up. If one is mid-flight the other simply skips that cycle;
 *      the 15-min overlap (fast) or the next hour (backfill) covers any gap.
 *   4. Token issues are logged, not fatal.
 *
 * Tunable via env (all optional):
 *   META_BACKFILL_INTERVAL_MS   default 3600000 (1 h)
 *   META_BACKFILL_WINDOW_MINUTES default 360 (6 h)
 *   META_BACKFILL_DISABLE=true   run only the fast poll, no hourly backfill
 */
const pool = require('../db');
const { syncMetaLeadsForSource } = require('./metaLeadSync');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // fast poll — every 5 minutes
const WINDOW_MINUTES      = 15;              // fast poll look-back (overlap is free — dedup)

const BACKFILL_INTERVAL_MS      = Number(process.env.META_BACKFILL_INTERVAL_MS)    || 60 * 60 * 1000; // hourly
const BACKFILL_WINDOW_MINUTES   = Number(process.env.META_BACKFILL_WINDOW_MINUTES) || 6 * 60;         // 6 h
const BACKFILL_DISABLED         = process.env.META_BACKFILL_DISABLE === 'true';

let _timer         = null;
let _backfillTimer = null;
let _running       = false;   // shared mutex — fast poll AND backfill both honour it

/* Sweep every workspace that has at least one lead form selected, over the
   given look-back window. Returns aggregate { inserted, skipped }. */
async function sweepWorkspaces(windowMinutes) {
  const { rows } = await pool.query(
    `SELECT source FROM webinar_config
      WHERE (current_form_id IS NOT NULL AND current_form_id <> '')
         OR (next_form_id    IS NOT NULL AND next_form_id    <> '')`);
  let inserted = 0, skipped = 0;
  for (const r of rows) {
    try {
      const res = await syncMetaLeadsForSource(r.source, { windowMinutes });
      inserted += res?.inserted || 0;
      skipped  += res?.skipped  || 0;
    } catch (e) { console.error(`[metaLeadSync:${r.source}]`, e.message); }
  }
  return { inserted, skipped };
}

/* Fast 5-min reconciliation poll (15-min window). */
async function tick() {
  if (_running) { console.warn('[metaLeadSync] sweep in progress — skipping this 5-min tick'); return; }
  _running = true;
  try { await sweepWorkspaces(WINDOW_MINUTES); }
  catch (e) { console.error('[metaLeadSync] tick error:', e.message); }
  finally { _running = false; }
}

/* Hourly wide backfill (6-hour window) — catches leads a longer outage dropped
   that the fast poll's 15-min window can no longer reach. */
async function backfillTick() {
  if (_running) { console.warn('[metaLeadSync] sweep in progress — skipping this hourly backfill (next hour covers it)'); return; }
  _running = true;
  try {
    const { inserted } = await sweepWorkspaces(BACKFILL_WINDOW_MINUTES);
    console.log(`[metaLeadSync] hourly backfill done — window ${Math.round(BACKFILL_WINDOW_MINUTES / 60)} h, recovered ${inserted} lead(s)`);
  } catch (e) {
    console.error('[metaLeadSync] backfill error:', e.message);
  } finally { _running = false; }
}

function startMetaLeadSyncScheduler({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (_timer)         { clearInterval(_timer);         _timer = null; }
  if (_backfillTimer) { clearInterval(_backfillTimer); _backfillTimer = null; }

  _timer = setInterval(tick, intervalMs);
  const backfillNote = BACKFILL_DISABLED
    ? ' (hourly backfill OFF)'
    : ` + hourly backfill (window ${Math.round(BACKFILL_WINDOW_MINUTES / 60)} h)`;
  console.log(`[metaLeadSync] reconciliation scheduler started — every ${Math.round(intervalMs / 60000)} min (window ${WINDOW_MINUTES} min)${backfillNote}`);

  // Kick off an immediate fast pull so leads flow on boot instead of after the
  // first full interval (avoids a "nothing's happening" gap right after restart).
  tick().catch(e => console.error('[metaLeadSync] initial tick:', e.message));

  if (!BACKFILL_DISABLED) {
    _backfillTimer = setInterval(backfillTick, BACKFILL_INTERVAL_MS);
    // First backfill ~90 s after boot — late enough that the immediate fast tick
    // has released the mutex, so they don't collide on startup. This run also
    // recovers anything dropped during the outage that just ended.
    setTimeout(() => backfillTick().catch(e => console.error('[metaLeadSync] initial backfill:', e.message)), 90 * 1000);
  }
}

function stopMetaLeadSyncScheduler() {
  if (_timer)         { clearInterval(_timer);         _timer = null; }
  if (_backfillTimer) { clearInterval(_backfillTimer); _backfillTimer = null; }
}

module.exports = { startMetaLeadSyncScheduler, stopMetaLeadSyncScheduler, tick, backfillTick };
