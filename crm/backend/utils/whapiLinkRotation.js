/*
 * whapiLinkRotation — member-count-driven WhatsApp link rotation for Whapi
 * workspaces (Meta Temp / TagMango). Unlike linkRotation.js (which rotates by
 * LEAD count), this advances the active link when the CURRENT community reaches
 * MEMBER_THRESHOLD real members, counted live via the Whapi admin number.
 *
 * Rotation flow (per product decision):
 *   • Poll the current link's live participant count via Whapi.
 *   • When it reaches the threshold AND a next link exists, promote the next
 *     link to current (webinars.wa_active_index++). The old current link stays
 *     in the list as a read-only "Previous Link". The new current link is
 *     mirrored into webinar_config so the funnel + permanent redirect serve it.
 *   • If Whapi can't read the count (number not in the group / channel down),
 *     DO NOT rotate — return { ok:false } so the caller can alert. No
 *     lead-count fallback.
 */
const pool      = require('../db');
const cache     = require('./webinarConfigCache');
const { broadcast } = require('./sseClients');
const { getMemberCount } = require('./whapiMembers');

const MEMBER_THRESHOLD = 950;

/* Mirror the active link into webinar_config (source-scoped) + refresh cache /
   broadcast, so the funnel and permanentRedirect serve it immediately. */
async function mirrorActiveLink(source, link) {
  await pool.query(
    `UPDATE webinar_config
        SET tuesday_whatsapp_link = $1, friday_whatsapp_link = $1, updated_at = NOW()
      WHERE source = $2`,
    [link, source]
  );
  const { rows } = await pool.query(
    `SELECT next_webinar_at, backup_webinar_at, tuesday_whatsapp_link,
            friday_whatsapp_link, kill_switch,
            pending_whatsapp_link, whatsapp_link_swap_at,
            pending_whatsapp_link_2, whatsapp_link_swap_at_2,
            current_webinar_date, next_webinar_date
       FROM webinar_config WHERE source = $1`,
    [source]
  );
  if (rows.length > 0) { cache.invalidate(source); cache.set(rows[0], source); broadcast(rows[0], source); }
}

/**
 * Poll + (maybe) advance the member-based rotation for one webinar.
 * @param {string} webinarId
 * @param {string} source       workspace (metatemp / tagmango)
 * @param {string} channelId    the workspace's pinned Whapi channel id
 * @returns {{ ok:boolean, rotated?:boolean, activeIndex?:number, count?:number,
 *             threshold?:number, error?:string }}
 */
async function rotateByMembers(webinarId, source, channelId) {
  if (!webinarId || !source || !channelId) return { ok: false, error: 'missing_args' };

  // 1. Links for this webinar, in order.
  const { rows: links } = await pool.query(
    `SELECT id, link_url, order_index FROM whatsapp_links
      WHERE webinar_id = $1 AND link_url <> '' ORDER BY order_index ASC`,
    [webinarId]
  );
  if (links.length === 0) return { ok: false, error: 'no_links' };

  // 2. Current pointer (clamped to the available links).
  const { rows: wRows } = await pool.query(
    'SELECT wa_active_index FROM webinars WHERE id = $1', [webinarId]);
  let activeIndex = Math.min(Math.max(1, wRows[0]?.wa_active_index || 1), links.length);
  const current = links.find(l => l.order_index === activeIndex) || links[activeIndex - 1] || links[0];

  // 3. Live member count for the current community (throws → freeze + alert).
  let info;
  try {
    info = await getMemberCount(channelId, current.link_url);
  } catch (err) {
    return { ok: false, error: err.code || err.message || 'whapi_read_failed', activeIndex };
  }

  // 4. Persist the latest count (display + audit).
  await pool.query(
    `UPDATE whatsapp_links
        SET member_count = $1, member_count_at = NOW(), whapi_group_id = COALESCE($2, whapi_group_id)
      WHERE id = $3`,
    [info.count, info.groupId, current.id]
  );

  // 5. Advance when full and a next link exists.
  let rotated = false;
  if (info.count >= MEMBER_THRESHOLD && activeIndex < links.length) {
    const next = links.find(l => l.order_index === activeIndex + 1) || links[activeIndex];
    if (next && next.link_url) {
      // Never rotate INTO a community we can't count — verify the next link is
      // readable by the Whapi number first; otherwise freeze + alert so the
      // operator adds the admin number to that group before it goes live.
      let nextInfo;
      try {
        nextInfo = await getMemberCount(channelId, next.link_url);
      } catch (err) {
        return { ok: false, error: `next_unreadable:${err.code || err.message}`, activeIndex, count: info.count };
      }
      activeIndex += 1;
      await pool.query('UPDATE webinars SET wa_active_index = $1 WHERE id = $2', [activeIndex, webinarId]);
      await pool.query(
        'UPDATE whatsapp_links SET member_count = $1, member_count_at = NOW(), whapi_group_id = COALESCE($2, whapi_group_id) WHERE id = $3',
        [nextInfo.count, nextInfo.groupId, next.id]
      );
      await mirrorActiveLink(source, next.link_url);
      rotated = true;
      console.log(`[WhapiRotation:${source}] webinar ${webinarId} rotated → link ${activeIndex} ` +
                  `(prev community hit ${info.count}/${MEMBER_THRESHOLD} members; new community ${nextInfo.count} members)`);
    }
  }

  return { ok: true, rotated, activeIndex, count: info.count, threshold: MEMBER_THRESHOLD };
}

module.exports = { rotateByMembers, mirrorActiveLink, MEMBER_THRESHOLD };
