/*
 * whapiMembers — read the LIVE participant count of the WhatsApp community/group
 * behind a chat.whatsapp.com invite link, via the Whapi Gate API.
 *
 * The Whapi number must be a member/admin of the community for this to work
 * (confirmed: GET /groups/link/<inviteCode> returns the group's metadata
 * including participantsCount). If it isn't, Whapi 4xx's and getMemberCount
 * throws — the caller (rotation scheduler) then FREEZES rotation and alerts,
 * per the product decision (no lead-count fallback for Whapi workspaces).
 */
const { gate, resolveChannel } = require('./whapiPartner');

/* Pull the invite code out of a WhatsApp invite URL.
   Handles chat.whatsapp.com/<code>, with/without scheme, trailing slash, query. */
function inviteCodeOf(url) {
  if (!url) return '';
  const m = String(url).trim().match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

/* Resolve the live member count for a single invite link on a given channel —
   MEMBERSHIP-GATED. The count must come from data only a real member can see,
   so the access check is genuinely scoped to THIS number:

     1. /groups/link/<code> resolves the invite to a group id. This is a public
        invite PREVIEW — it works for anyone holding the link, member or not, so
        its count must NOT be trusted as proof of access.
     2. /groups/<id> is the authoritative fetch and only succeeds when this
        number is actually IN the group; it 404s otherwise. We take the count
        from here. A 404 → NOT_MEMBER, which makes the caller freeze + alert
        ("add this number to the community first").

   Returns { count, groupId, groupName }. Throws on bad link, non-membership,
   or any Whapi/network failure. */
async function getMemberCount(channelId, inviteUrl) {
  const code = inviteCodeOf(inviteUrl);
  if (!code) { const e = new Error('not_a_whatsapp_invite'); e.code = 'BAD_LINK'; throw e; }

  const ch = await resolveChannel(channelId);          // throws if channel gone

  // 1. Invite preview → group id (does NOT require membership).
  const preview = await gate('GET', ch, `/groups/link/${encodeURIComponent(code)}`);
  const groupId = preview.id;
  if (!groupId) { const e = new Error('group_not_resolved'); e.code = 'NO_GROUP'; throw e; }

  // 2. Authoritative, membership-gated fetch. 404 = this number isn't a member.
  let g;
  try {
    g = await gate('GET', ch, `/groups/${encodeURIComponent(groupId)}`);
  } catch (err) {
    if (err.status === 404) { const e = new Error('number_not_in_group'); e.code = 'NOT_MEMBER'; throw e; }
    throw err;
  }

  // /groups/<id> uses participants_count (snake); fall back to array length.
  const count = g.participants_count
    ?? g.participantsCount
    ?? (Array.isArray(g.participants) ? g.participants.length : null);

  if (count == null) { const e = new Error('no_count_in_response'); e.code = 'NO_COUNT'; throw e; }

  return { count: Number(count), groupId, groupName: g.name || preview.name || null };
}

/* Reduce any WhatsApp id ("919240XXXXXX", "919240XXXXXX:12@s.whatsapp.net",
   "919240XXXXXX@c.us") to its bare digits so self ↔ participant ids compare. */
function digitsId(x) {
  return String(x || '').split(/[:@]/)[0].replace(/\D/g, '');
}

/* Is the Whapi number an ADMIN of the community behind this invite link?
   Reuses the same invite→group resolution as getMemberCount, then:
     1. reads the channel's OWN number from Gate /health (user.id) — null when
        the channel isn't logged in (can't determine → connected:false),
     2. fetches /groups/<id> participants and matches self by bare digits,
     3. reports the matched participant's rank (creator/admin → isAdmin).

   Returns { connected, isMember, isAdmin, role, groupName, count }.
   Never throws for the "expected" states (not connected / not a member) — it
   encodes them in the result so the UI can render a clear badge. Only genuine
   bad-link / channel-gone errors throw. */
async function getGroupAdminStatus(channelId, inviteUrl) {
  const code = inviteCodeOf(inviteUrl);
  if (!code) { const e = new Error('not_a_whatsapp_invite'); e.code = 'BAD_LINK'; throw e; }

  const ch = await resolveChannel(channelId);          // throws if channel gone

  // Self number — only present once the channel is logged into WhatsApp.
  let selfDigits = '';
  try {
    const health = await gate('GET', ch, '/health?wakeup=true');
    selfDigits = digitsId(health?.user?.id);
  } catch { /* health unreachable → treat as not connected below */ }
  if (!selfDigits) {
    return { connected: false, isMember: false, isAdmin: false, role: null, groupName: null, count: null };
  }

  // Resolve invite → group id (public preview, membership not required).
  const preview = await gate('GET', ch, `/groups/link/${encodeURIComponent(code)}`);
  const groupId = preview.id;
  if (!groupId) { const e = new Error('group_not_resolved'); e.code = 'NO_GROUP'; throw e; }

  // Authoritative fetch — 404 means this number isn't in the group.
  let g;
  try {
    g = await gate('GET', ch, `/groups/${encodeURIComponent(groupId)}`);
  } catch (err) {
    if (err.status === 404) {
      return { connected: true, isMember: false, isAdmin: false, role: null,
               groupName: preview.name || null, count: null };
    }
    throw err;
  }

  const parts = Array.isArray(g.participants) ? g.participants : [];
  const me = parts.find(p => digitsId(p.id) === selfDigits);
  const role = me ? (me.rank || me.role || 'member') : null;     // creator | admin | member | null
  const isAdmin = ['creator', 'admin', 'superadmin'].includes(String(role).toLowerCase());
  const count = g.participants_count ?? g.participantsCount ?? parts.length ?? null;

  return {
    connected: true,
    isMember: !!me,
    isAdmin,
    role,
    groupName: g.name || preview.name || null,
    count: count == null ? null : Number(count),
  };
}

module.exports = { inviteCodeOf, getMemberCount, getGroupAdminStatus };
