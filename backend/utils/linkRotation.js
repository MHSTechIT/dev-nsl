const pool = require('../db');
const cache = require('./webinarConfigCache');
const { broadcast } = require('./sseClients');

/**
 * Determine the correct WhatsApp link index based on lead count.
 * 0–950 → 1, 951–1900 → 2, 1901–2850 → 3, etc.
 */
function getLinkIndex(leadCount) {
  return Math.max(1, Math.ceil(leadCount / 950));
}

/**
 * Count leads for a webinar and activate the correct WhatsApp link.
 * Updates webinar_config so the funnel serves the right link.
 *
 * @param {number} webinarId — the active webinar's ID
 * @returns {{ rotated: boolean, linkIndex: number, leadCount: number }}
 */
async function rotateLink(webinarId) {
  if (!webinarId) return { rotated: false, linkIndex: 1, leadCount: 0 };

  try {
    // 1. Count leads for this webinar
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM leads WHERE webinar_id = $1',
      [webinarId]
    );
    const leadCount = countRows[0]?.cnt || 0;

    // 2. Determine target link index
    const rawIndex = getLinkIndex(leadCount);

    // 3. Get the max available link for this webinar
    const { rows: maxRows } = await pool.query(
      'SELECT MAX(order_index)::int AS max_idx FROM whatsapp_links WHERE webinar_id = $1 AND link_url != \'\'',
      [webinarId]
    );
    const maxIdx = maxRows[0]?.max_idx;

    // No links configured for this webinar — skip rotation
    if (!maxIdx) return { rotated: false, linkIndex: 1, leadCount };
    const linkIndex = Math.min(rawIndex, maxIdx);

    // 4. Fetch the target link
    const { rows: linkRows } = await pool.query(
      'SELECT link_url FROM whatsapp_links WHERE webinar_id = $1 AND order_index = $2',
      [webinarId, linkIndex]
    );

    if (linkRows.length > 0 && linkRows[0].link_url) {
      const newLink = linkRows[0].link_url;

      // 5. Update webinar_config to serve this link
      await pool.query(
        `UPDATE webinar_config
         SET tuesday_whatsapp_link = $1,
             friday_whatsapp_link  = $1,
             updated_at            = NOW()
         WHERE id = 1`,
        [newLink]
      );

      // 6. Refresh cache & broadcast to all clients
      const { rows: fresh } = await pool.query(
        `SELECT next_webinar_at, backup_webinar_at, tuesday_whatsapp_link,
                friday_whatsapp_link, kill_switch,
                pending_whatsapp_link, whatsapp_link_swap_at,
                pending_whatsapp_link_2, whatsapp_link_swap_at_2,
                current_webinar_date, next_webinar_date
         FROM webinar_config WHERE id = 1`
      );
      if (fresh.length > 0) {
        cache.invalidate();
        cache.set(fresh[0]);
        broadcast(fresh[0]);
      }

      return { rotated: true, linkIndex, leadCount };
    }

    return { rotated: false, linkIndex, leadCount };
  } catch (err) {
    console.error('[LinkRotation] error:', err.message);
    return { rotated: false, linkIndex: 1, leadCount: 0 };
  }
}

module.exports = { rotateLink, getLinkIndex };
