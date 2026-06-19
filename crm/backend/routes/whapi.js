/*
 * /api/admin/whapi — read-only Whapi.Cloud Partner dashboard proxy for the
 * Meta Temp → Whapi tab. Auth: same adminAuth bearer as the rest of /api/admin.
 *
 * Scope (per product decision): Channels + Projects + Partner + Balance, all
 * READ, plus the one safe/free action (restart a channel). Money-spending and
 * destructive operations (Stripe top-up/refill, create/delete/extend channel)
 * are intentionally NOT exposed here — use the official Whapi panel for those.
 *
 * Sensitive fields (per-channel tokens, the partner JWT) are stripped before
 * anything is returned to the browser.
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { adminAuth } = require('../middleware/adminAuth');
const { whapi, gate, resolveChannel } = require('../utils/whapiPartner');
const { getGroupAdminStatus } = require('../utils/whapiMembers');

router.use(adminAuth);

/* Per-workspace persistence of the chosen Whapi channel. Each workspace
   (source) pins exactly one channel; it stays pinned until explicitly changed,
   surviving navigation, reload, and other devices. Stored on the per-source
   webinar_config row (whapi_channel_id column). */
// 'webreminder' is a dedicated key so the Web Reminder → Alerts page can pin
// its OWN Whapi channel, independent of Meta Temp's.
const ALLOWED_SOURCES = new Set(['meta', 'yt', 'meta2', 'metatemp', 'tagmango', 'webreminder']);
const getSource = (req) => {
  const v = req.query.source ?? req.body?.source;
  return ALLOWED_SOURCES.has(v) ? v : 'meta';
};

/* GET the pinned channel id for a workspace. */
router.get('/selected', async (req, res) => {
  const source = getSource(req);
  try {
    const { rows } = await pool.query(
      'SELECT whapi_channel_id FROM webinar_config WHERE source = $1',
      [source]
    );
    res.json({ source, channel_id: rows[0]?.whapi_channel_id || '' });
  } catch (err) {
    console.error('[whapi] get selected error:', err.message);
    res.status(500).json({ error: 'failed_to_read_selected_channel' });
  }
});

/* GET whether THIS workspace's pinned Whapi number is an admin of the
   community behind a given invite link. Live (queries Whapi on each call) so
   the admin badge is accurate even when the rotation scheduler is off.
   Query: ?link=<invite url>&source=<workspace>. */
router.get('/link-admin', async (req, res) => {
  const source = getSource(req);
  const link   = (req.query.link || '').toString().trim();
  if (!link) return res.status(400).json({ error: 'link_required' });
  try {
    const { rows } = await pool.query(
      'SELECT whapi_channel_id FROM webinar_config WHERE source = $1', [source]
    );
    const channelId = rows[0]?.whapi_channel_id;
    if (!channelId) return res.json({ error: 'no_channel', message: 'No Whapi channel pinned for this workspace.' });
    const status = await getGroupAdminStatus(channelId, link);
    res.json(status);   // { connected, isMember, isAdmin, role, groupName, count }
  } catch (err) {
    fail(res, err);
  }
});

/* PUT (pin) the channel for a workspace. Upsert so it works even if the
   source's webinar_config row doesn't exist yet (id has no sequence, so we
   compute the next one and mirror the seed's required columns). */
router.put('/selected', async (req, res) => {
  const source = getSource(req);
  const channelId = (req.body?.channel_id || '').toString().trim() || null;
  try {
    await pool.query(
      `INSERT INTO webinar_config (id, source, kill_switch, tuesday_whatsapp_link, friday_whatsapp_link, whapi_channel_id)
       SELECT COALESCE(MAX(id), 0) + 1, $1, false, '', '', $2 FROM webinar_config
       ON CONFLICT (source) DO UPDATE SET whapi_channel_id = EXCLUDED.whapi_channel_id`,
      [source, channelId]
    );
    res.json({ ok: true, source, channel_id: channelId || '' });
  } catch (err) {
    console.error('[whapi] put selected error:', err.message);
    res.status(500).json({ error: 'failed_to_save_selected_channel' });
  }
});

/* Only non-secret, display-relevant channel fields reach the frontend. */
const safeChannel = (c = {}) => ({
  id:         c.id,
  name:       c.name,
  status:     c.status,        // active | launching | qr | ...
  mode:       c.mode,          // live | trial
  stopped:    !!c.stopped,
  activeTill: c.activeTill,    // epoch ms
  creationTS: c.creationTS,    // epoch ms
  projectId:  c.projectId,
  server:     c.server,
});

const safeProject = (p = {}) => ({
  id: p.id, name: p.name, isDefault: !!p.isDefault, users: (p.users || []).length,
});

function fail(res, err) {
  if (err.code === 'NO_KEY') {
    return res.status(503).json({ error: 'whapi_not_configured',
      message: 'Set WHAPI_PARTNER_KEY in the backend .env to enable the Whapi dashboard.' });
  }
  console.error('[whapi]', err.status || '-', err.message, err.data ? JSON.stringify(err.data).slice(0, 200) : '');
  const status = (err.status >= 400 && err.status < 600) ? err.status : 502;
  return res.status(status).json({ error: 'whapi_request_failed', detail: err.data || err.message });
}

/* One call powering the whole tab: partner balance + channels + projects. */
router.get('/overview', async (_req, res) => {
  try {
    const [partner, ch, pr] = await Promise.all([
      whapi('GET', '/partners'),
      whapi('GET', '/channels/list'),
      whapi('GET', '/projects'),
    ]);
    const channels = (ch.channels || []).map(safeChannel);
    res.json({
      partner: {
        name:          partner.name || partner.codename || '—',
        codename:      partner.codename || null,
        daysOnBalance: partner.pwr ?? null,   // "Days on Balance" in the Whapi UI
      },
      channels,
      projects: (pr.projects || []).map(safeProject),
      counts: {
        channels: channels.length,
        active:   channels.filter(c => c.status === 'active' && !c.stopped).length,
        projects: (pr.projects || []).length,
      },
    });
  } catch (e) { fail(res, e); }
});

router.get('/channels', async (_req, res) => {
  try { const d = await whapi('GET', '/channels/list'); res.json({ channels: (d.channels || []).map(safeChannel) }); }
  catch (e) { fail(res, e); }
});

router.get('/channels/:id', async (req, res) => {
  try { const d = await whapi('GET', '/channels/' + encodeURIComponent(req.params.id)); res.json(safeChannel(d.channel || d)); }
  catch (e) { fail(res, e); }
});

router.get('/projects', async (_req, res) => {
  try { const d = await whapi('GET', '/projects'); res.json({ projects: (d.projects || []).map(safeProject) }); }
  catch (e) { fail(res, e); }
});

router.get('/partner', async (_req, res) => {
  try { const p = await whapi('GET', '/partners'); res.json({ name: p.name || p.codename, codename: p.codename, daysOnBalance: p.pwr ?? null }); }
  catch (e) { fail(res, e); }
});

/* Safe, free action: restart a channel's WhatsApp session. */
router.post('/channels/:id/restart', async (req, res) => {
  try { const d = await whapi('POST', '/channels/' + encodeURIComponent(req.params.id) + '/restart'); res.json({ ok: true, result: d }); }
  catch (e) { fail(res, e); }
});

/* Edit a channel — Whapi PATCH /channels/{id} (ChannelCustom).
   name + projectId are required by the API; phone is optional. This only
   renames / reassigns the project — it does not create, delete, extend, or
   change billing mode. */
router.patch('/channels/:id', async (req, res) => {
  const name      = (req.body?.name || '').trim();
  const projectId = (req.body?.projectId || '').trim();
  const phone     = (req.body?.phone || '').trim();
  if (!name || !projectId) {
    return res.status(400).json({ error: 'invalid_input', message: 'name and projectId are required.' });
  }
  const body = { name, projectId };
  if (phone) body.phone = phone;
  try {
    const d = await whapi('PATCH', '/channels/' + encodeURIComponent(req.params.id), body);
    res.json({ ok: true, channel: safeChannel(d.channel || d) });
  } catch (e) { fail(res, e); }
});

/* ── Connection (Gate API per channel) ──────────────────────────────────── */

/* Live connection status. connected === the WhatsApp session is authorised. */
router.get('/channels/:id/status', async (req, res) => {
  try {
    const ch = await resolveChannel(req.params.id);
    const h  = await gate('GET', ch, '/health?wakeup=true');
    const text = (h.status && h.status.text) || 'UNKNOWN';
    res.json({
      connected:  text === 'AUTH' || !!h.user,
      statusText: text,
      user:       h.user || null,   // { id, name, ... } when connected
    });
  } catch (e) { fail(res, e); }
});

/* Login QR (base64 PNG) for an unconnected channel + seconds until it reloads. */
router.get('/channels/:id/qr', async (req, res) => {
  try {
    const ch = await resolveChannel(req.params.id);
    const d  = await gate('GET', ch, '/users/login');
    res.json({ base64: d.base64 || null, expire: d.expire || 20, status: d.status || null });
  } catch (e) { fail(res, e); }
});

/* Logout / unlink the current WhatsApp account so a DIFFERENT number can be
   linked (e.g. when the previous number hits WhatsApp's linking restriction). */
router.post('/channels/:id/logout', async (req, res) => {
  try {
    const ch = await resolveChannel(req.params.id);
    const d  = await gate('POST', ch, '/users/logout');
    res.json({ ok: true, result: d });
  } catch (e) { fail(res, e); }
});

module.exports = router;
