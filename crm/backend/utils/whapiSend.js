/*
 * whapiSend — send WhatsApp messages to a GROUP via the Whapi Gate API.
 *
 * The rest of the Whapi integration is read-only (status, groups, member count).
 * This adds the WRITE path used by the template auto-send scheduler: post a text
 * or media message to the community group behind the current active link.
 *
 * Media size reality (WhatsApp / Whapi caps):
 *   image ≤ 5 MB · video ≤ 16 MB · audio ≤ 16 MB · document ≤ 100 MB
 * The promo videos are 150–245 MB, so they CAN'T go as native media. When the
 * file is over its type's cap we fall back to sending the body text plus the
 * public media link, so the message still goes out (caller decides; we expose
 * the limits + a helper for the scheduler to choose).
 */
const path = require('path');
const fs   = require('fs');
const { resolveChannel } = require('./whapiPartner');

// Public base for media URLs Whapi must be able to fetch. This box serves
// leadgenx, which is public, so /uploads/templates/<f> is reachable there.
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://leadgenx.myhealthschool.in').replace(/\/$/, '');
const UPLOAD_DIR  = path.join(__dirname, '..', 'uploads', 'templates');

// WhatsApp per-type byte caps (a touch under the documented limit for safety).
const SIZE_CAP = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 100 * 1024 * 1024 };

/* Absolute, publicly-fetchable URL for a stored media_url (/uploads/templates/x). */
function publicMediaUrl(mediaUrl) {
  if (!mediaUrl) return '';
  if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;     // already absolute
  return `${PUBLIC_BASE}${mediaUrl.startsWith('/') ? '' : '/'}${mediaUrl}`;
}

/* On-disk byte size for a local media_url, or null if not a local file. */
function localMediaSize(mediaUrl) {
  if (!mediaUrl || /^https?:\/\//i.test(mediaUrl)) return null;
  try { return fs.statSync(path.join(UPLOAD_DIR, path.basename(mediaUrl))).size; }
  catch { return null; }
}

/* Whether a media_url can be sent natively as `type` (fits the size cap). */
function fitsNative(type, mediaUrl) {
  const cap = SIZE_CAP[type];
  if (!cap) return false;
  const size = localMediaSize(mediaUrl);
  if (size == null) return true;            // remote URL — let Whapi judge
  return size <= cap;
}

/* POST a JSON body to the channel's Gate API. */
async function gatePost(channel, apiPath, body) {
  const base = (channel.apiUrl || 'https://gate.whapi.cloud/').replace(/\/$/, '');
  const res = await fetch(base + apiPath, {
    method: 'POST',
    headers: { Authorization: `Bearer ${channel.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) { const e = new Error(`gate_${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

/* Send a template message to a group chat.
   @param channelId  the workspace's pinned Whapi channel id
   @param to         group id (e.g. "<id>@g.us" or the bare group id)
   @param msg        { msg_type, body, media_url }
   Returns { ok, mode:'text'|'media'|'text_with_link', endpoint, raw } or throws. */
async function sendTemplateToGroup(channelId, to, msg) {
  const ch = await resolveChannel(channelId);          // throws if channel gone
  const type    = (msg.msg_type || 'text').toLowerCase();
  const body    = msg.body || '';
  const mediaUrl = msg.media_url || '';

  // Text-only template.
  if (type === 'text' || !mediaUrl) {
    const raw = await gatePost(ch, '/messages/text', { to, body });
    return { ok: true, mode: 'text', endpoint: '/messages/text', raw };
  }

  // Media template that fits its size cap → native media with body as caption.
  if (['image', 'video', 'audio', 'document'].includes(type) && fitsNative(type, mediaUrl)) {
    const payload = { to, media: publicMediaUrl(mediaUrl) };
    if (type !== 'audio') payload.caption = body;        // audio has no caption
    const raw = await gatePost(ch, `/messages/${type}`, payload);
    return { ok: true, mode: 'media', endpoint: `/messages/${type}`, raw };
  }

  // Oversized media (e.g. the 150–245 MB videos) → send the text + a public link
  // so the message still lands. Caller can later swap in a <16 MB / Drive copy.
  const link = publicMediaUrl(mediaUrl);
  const withLink = body ? `${body}\n\n${link}` : link;
  const raw = await gatePost(ch, '/messages/text', { to, body: withLink });
  return { ok: true, mode: 'text_with_link', endpoint: '/messages/text', raw, note: 'media over WhatsApp size cap — sent as link' };
}

module.exports = { sendTemplateToGroup, publicMediaUrl, localMediaSize, fitsNative, SIZE_CAP };
