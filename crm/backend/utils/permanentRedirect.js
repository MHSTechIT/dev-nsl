/* ── Permanent WhatsApp subdomain redirect ───────────────────────────────────
 * A branded subdomain (e.g. https://join.myhealthschool.in) is pointed (DNS /
 * Render custom domain) straight at this backend. The admin saves that exact
 * URL in webinar_config.permanent_whatsapp_link for a workspace. When a visitor
 * hits the subdomain, we look up which workspace owns that hostname and 302 to
 * its CURRENT ACTIVE WhatsApp link (respecting the every-950-leads rotation),
 * so the printed/shared link never changes while the underlying group can.
 *
 * Matched purely by Host header — no path or ?source needed. Unmatched hosts
 * (the API domain, health checks, etc.) fall straight through to next().
 * ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../db');
const { getLinkIndex } = require('./linkRotation');

/* Host → source map, cached briefly (permanent links change rarely). */
let hostMap = null;
let hostMapAt = 0;
const TTL_MS = 30 * 1000;

/* Reduce any stored value ("https://join.x.in/", "join.x.in", with port) to a
   bare lowercase hostname for comparison against req.hostname. */
function hostnameOf(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try { return new URL(s).hostname.toLowerCase(); } catch { return ''; }
}

async function getHostMap() {
  const now = Date.now();
  if (hostMap && now - hostMapAt < TTL_MS) return hostMap;
  const m = new Map();
  try {
    const { rows } = await pool.query(
      "SELECT source, permanent_whatsapp_link FROM webinar_config WHERE permanent_whatsapp_link IS NOT NULL AND permanent_whatsapp_link <> ''"
    );
    for (const r of rows) {
      const h = hostnameOf(r.permanent_whatsapp_link);
      if (h) m.set(h, r.source);
    }
  } catch (e) {
    // On a transient DB error keep serving the previous map rather than 404ing.
    if (hostMap) return hostMap;
  }
  hostMap = m; hostMapAt = now;
  return m;
}

/* Resolve the workspace's current active WhatsApp link:
   active webinar → its links → rotation index by lead count, with a fallback to
   the webinar_config mirror (kept in sync by linkRotation.rotateLink). */
async function resolveActiveLink(source) {
  let webinarId = null;
  try {
    const { rows } = await pool.query(
      'SELECT id FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1', [source]);
    webinarId = rows[0]?.id ?? null;
  } catch { /* fall through to mirror */ }

  if (webinarId) {
    try {
      const { rows: cnt } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM leads WHERE webinar_id = $1', [webinarId]);
      const leadCount = cnt[0]?.c || 0;
      const { rows: links } = await pool.query(
        "SELECT link_url, order_index FROM whatsapp_links WHERE webinar_id = $1 AND link_url <> '' ORDER BY order_index",
        [webinarId]);
      if (links.length) {
        const maxIdx = links[links.length - 1].order_index;
        const idx = Math.min(getLinkIndex(leadCount), maxIdx);
        const hit = links.find(l => l.order_index === idx) || links[0];
        if (hit?.link_url) return hit.link_url;
      }
    } catch { /* fall through to mirror */ }
  }

  try {
    const { rows } = await pool.query(
      'SELECT tuesday_whatsapp_link, friday_whatsapp_link FROM webinar_config WHERE source = $1', [source]);
    return rows[0]?.tuesday_whatsapp_link || rows[0]?.friday_whatsapp_link || null;
  } catch { return null; }
}

/* Paths the matched subdomain should still let through to normal routing, in
   case the same host is ever (mis)used for the API. */
const SKIP = ['/api', '/uploads', '/go', '/join', '/wa', '/favicon.ico'];

async function permanentRedirect(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path || '/';
  if (SKIP.some(s => p === s || p.startsWith(s + '/'))) return next();

  const host = (req.hostname || '').toLowerCase();
  if (!host) return next();

  let source;
  try { source = (await getHostMap()).get(host); } catch { return next(); }
  if (!source) return next();  // not a permalink subdomain → normal handling

  const link = await resolveActiveLink(source);
  if (link && /^https?:\/\//i.test(link)) {
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, link);
  }
  return res.status(404).type('html').send(
    '<h2 style="font-family:sans-serif">WhatsApp link not available yet.</h2>');
}

module.exports = { permanentRedirect, resolveActiveLink };
