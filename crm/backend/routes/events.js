const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const pool    = require('../db');

/**
 * Build a stable per-device fallback visitor_id when the client failed
 * to provide one (incognito, ad-blocker, very-first-request race). Hash
 * IP + user-agent into a short string so the same device gets the same
 * fallback id across events even without localStorage.
 *
 * Prefixed `ipua_` so it can never collide with a localStorage UUID.
 */
function ipUaFallbackId(req) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || '').split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').slice(0, 200);
    if (!ip && !ua) return null;
    const h = crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 24);
    return `ipua_${h}`;
  } catch (_) { return null; }
}

const VALID_EVENTS = new Set([
  'page_visited',
  'cta_clicked',
  'sugar_150_250',
  'sugar_250_plus',
  'disqualified_no_diabetes',
  'tamil_yes',
  'tamil_no',
  'duration_new',
  'duration_mid',
  'duration_long',
  'registration_submitted',
  'wa_join_clicked',
  'youtube_clicked',
  'explore_product_clicked',
]);

const ALLOWED_SOURCES = new Set(['meta', 'yt', 'meta2', 'metatemp', 'tagmango']);

/* POST /api/events — public, fire-and-forget click tracking */
router.post('/events', async (req, res) => {
  // Respond immediately — never block the user
  res.json({ ok: true });

  const { event_name, webinar_at } = req.body || {};
  if (!VALID_EVENTS.has(event_name)) return;

  const source = ALLOWED_SOURCES.has(req.body?.source) ? req.body.source : 'meta';
  const ts = webinar_at ? new Date(webinar_at) : null;
  // Bulletproof Meta attribution: client sets this true when the funnel
  // URL contained fbclid or utm_source=meta. Doesn't depend on Meta Pixel.
  const isMeta = req.body?.is_meta === true;
  // Anonymous visitor id. Primary source: client localStorage UUID.
  // Fallback: hash of IP + user-agent (catches incognito / cleared storage).
  // Cap at 64 chars to avoid abuse.
  let visitorId = typeof req.body?.visitor_id === 'string'
    ? req.body.visitor_id.slice(0, 64)
    : null;
  if (!visitorId) visitorId = ipUaFallbackId(req);
  // Resolve webinar_id by FIRST trying to match the timestamp the frontend
  // sent (so events stay glued to the webinar the visitor actually saw, even
  // after a new webinar becomes active). Only fall back to the current
  // active webinar when no match is found.
  let webinar_id = null;
  try {
    if (ts && !isNaN(ts)) {
      const { rows } = await pool.query(
        'SELECT id FROM webinars WHERE source = $1 AND date_time = $2 LIMIT 1',
        [source, ts]
      );
      webinar_id = rows[0]?.id ?? null;
    }
    if (!webinar_id) {
      const { rows } = await pool.query(
        'SELECT id FROM webinars WHERE is_active = TRUE AND source = $1 ORDER BY date_time DESC LIMIT 1',
        [source]
      );
      webinar_id = rows[0]?.id ?? null;
    }
  } catch (_) { /* webinars table may not exist yet — safe to skip */ }

  pool.query(
    'INSERT INTO click_events (event_name, webinar_at, webinar_id, source, is_meta, visitor_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [event_name, ts && !isNaN(ts) ? ts : null, webinar_id, source, isMeta, visitorId]
  ).catch(err => console.error('[events] insert error:', err.message));
});

module.exports = router;
