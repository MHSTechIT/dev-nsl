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

module.exports = { inviteCodeOf, getMemberCount };
