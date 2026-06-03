/**
 * whapi.cloud client — NSM-Caller WhatsApp automation.
 * Reads WHAPI_TOKEN + WHAPI_BASE_URL. isConfigured() guards every call.
 * Mirrors utils/watiClient.js + webinar-dashboard/backend/utils/zoom.js.
 */
const BASE  = (process.env.WHAPI_BASE_URL || 'https://gate.whapi.cloud').replace(/\/$/, '');
const TOKEN = (process.env.WHAPI_TOKEN || '').trim();

function isConfigured() { return Boolean(TOKEN); }

/* Digits only; prepend 91 for a bare 10-digit Indian number (same rule as
   watiClient.js). whapi wants international digits, no '+'. */
function normalizePhone(phone) {
  const num = String(phone || '').replace(/\D/g, '');
  if (!num) return '';
  return num.length === 10 ? `91${num}` : num;
}

async function whapiFetch(path, opts = {}) {
  if (!isConfigured()) { const e = new Error('WHAPI_TOKEN not set'); e.code = 'NOT_CONFIGURED'; throw e; }
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data.error && (data.error.message || data.error.details)) || data.message || data.raw || res.statusText;
    const err = new Error(`whapi ${path} ${res.status}: ${String(msg).slice(0, 200)}`);
    err.status = res.status; err.body = data;
    throw err;
  }
  return data;
}

/* GET /health — channel status (status.text === 'AUTH' when connected). */
async function health() { return whapiFetch('/health', { method: 'GET' }); }

/* The channel's own WhatsApp number (digits), cached. Used to seed group
   creation since whapi requires >=1 participant. */
let _ownNumber = null;
async function getOwnNumber() {
  if (_ownNumber) return _ownNumber;
  try {
    const h = await health();
    _ownNumber = (h.user && h.user.id) ? String(h.user.id).replace(/\D/g, '') : null;
  } catch { _ownNumber = null; }
  return _ownNumber;
}

/* Create a WhatsApp group. Returns { groupId, invite, raw }. Seeds the
   channel's own number so a group can be created before any leads exist. */
async function createGroup({ subject, participants = [] }) {
  const parts = participants.map(normalizePhone).filter(Boolean);
  const own = await getOwnNumber();
  if (own && !parts.includes(own)) parts.unshift(own);
  const data = await whapiFetch('/groups', {
    method: 'POST',
    body: JSON.stringify({ subject, participants: parts }),
  });
  const groupId = data.group_id || data.id || (data.group && data.group.id) || null;
  let invite = data.invite_code ? `https://chat.whatsapp.com/${data.invite_code}` : (data.invite || null);
  if (!invite && groupId) {
    // Fetch the public invite link (best-effort).
    try {
      const inv = await whapiFetch(`/groups/${encodeURIComponent(groupId)}/invite`, { method: 'GET' });
      invite = inv.invite_link || (inv.invite_code ? `https://chat.whatsapp.com/${inv.invite_code}` : null);
    } catch { /* invite link optional */ }
  }
  return { groupId, invite, raw: data };
}

/* A community's announcement group (the chat all members receive). */
async function getCommunityAnnounce(communityId) {
  try {
    const s = await whapiFetch(`/communities/${encodeURIComponent(communityId)}/subgroups`, { method: 'GET' });
    const ann = s.announceGroupInfo || {};
    return { groupId: ann.id || null, invite: ann.inviteCode ? `https://chat.whatsapp.com/${ann.inviteCode}` : null };
  } catch { return { groupId: null, invite: null }; }
}

/* Create a WhatsApp Community. Returns { communityId, groupId, invite } where
   groupId is the community's announcement group — members are added to it and
   reminder messages are sent to it (reusing the group endpoints). */
async function createCommunity({ subject, description = '' }) {
  const data = await whapiFetch('/communities', {
    method: 'POST',
    body: JSON.stringify({ subject, description: description || subject }),
  });
  const communityId = data.id || data.community_id || (data.community && data.community.id) || null;
  let groupId = null, invite = null;
  if (communityId) ({ groupId, invite } = await getCommunityAnnounce(communityId));
  return { communityId, groupId, invite, raw: data };
}

/* Create a member sub-group inside a community (members belong in sub-groups,
   not the announce group). Needs >=1 non-self participant. Returns { groupId }. */
async function createCommunityGroup({ communityId, subject, participants = [] }) {
  const parts = participants.map(normalizePhone).filter(Boolean);
  const data = await whapiFetch(`/communities/${encodeURIComponent(communityId)}`, {
    method: 'POST',
    body: JSON.stringify({ subject, participants: parts }),
  });
  return { groupId: data.id || data.group_id || null, raw: data };
}

/* Delete a community (best-effort cleanup). */
async function deleteCommunity(communityId) {
  if (!communityId) return null;
  return whapiFetch(`/communities/${encodeURIComponent(communityId)}`, { method: 'DELETE' });
}

/* Add participants (phones) to a group.
   whapi replies HTTP 200 with { success, processed:[ids], failed:[ids] } — a
   number WhatsApp won't let us force-add (privacy "who can add me to groups",
   or no prior opt-in) comes back in `failed`, NOT `processed`. Callers MUST
   branch on these arrays; HTTP 200 alone does NOT mean the person joined.
   Returns { processed:[digits], failed:[digits], raw }. */
async function addParticipants({ groupId, phones = [] }) {
  const parts = phones.map(normalizePhone).filter(Boolean);
  if (!groupId || parts.length === 0) return { processed: [], failed: [], raw: null };
  const data = await whapiFetch(`/groups/${encodeURIComponent(groupId)}/participants`, {
    method: 'POST',
    body: JSON.stringify({ participants: parts }),
  });
  const norm = a => (Array.isArray(a) ? a.map(x => String(x && x.id != null ? x.id : x).replace(/\D/g, '')).filter(Boolean) : []);
  return { processed: norm(data.processed), failed: norm(data.failed), raw: data };
}

/* Public invite link for a group (so blocked numbers can self-join).
   Returns a https://chat.whatsapp.com/... URL or null. */
async function getGroupInvite(groupId) {
  if (!groupId) return null;
  try {
    const d = await whapiFetch(`/groups/${encodeURIComponent(groupId)}/invite`, { method: 'GET' });
    if (d.invite_link) return d.invite_link;
    if (d.invite_code) return `https://chat.whatsapp.com/${d.invite_code}`;
    return null;
  } catch { return null; }
}

/* Send a plain text message to `to` (a group id "...@g.us" or a phone). */
async function sendText({ to, body }) {
  return whapiFetch('/messages/text', { method: 'POST', body: JSON.stringify({ to, body }) });
}

/* Send media (image|video) by URL with an optional caption. */
async function sendMedia({ to, type, mediaUrl, caption }) {
  const ep = type === 'video' ? '/messages/video' : '/messages/image';
  return whapiFetch(ep, { method: 'POST', body: JSON.stringify({ to, media: mediaUrl, caption: caption || '' }) });
}

/* Leave / delete a group (the channel exits it). Best-effort cleanup. */
async function leaveGroup(groupId) {
  if (!groupId) return null;
  return whapiFetch(`/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
}

/* Send a poll. options: [string]. */
async function sendPoll({ to, title, options = [] }) {
  return whapiFetch('/messages/poll', {
    method: 'POST',
    body: JSON.stringify({ to, title, options: options.filter(Boolean), count: 1 }),
  });
}

module.exports = {
  isConfigured, normalizePhone, health,
  createGroup, createCommunity, createCommunityGroup, deleteCommunity, getCommunityAnnounce,
  addParticipants, getGroupInvite, leaveGroup, sendText, sendMedia, sendPoll,
};
