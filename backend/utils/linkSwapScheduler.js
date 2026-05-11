const pool = require('../db');
const cache = require('./webinarConfigCache');
const { broadcast } = require('./sseClients');
const { rotateLink } = require('./linkRotation');

const SOURCES = ['meta', 'yt'];

async function runSwapsForSource(source) {
  try {
    // ── Legacy slot swaps (kept for backward compat) ──
    // Slot 1
    await pool.query(`
      UPDATE webinar_config
      SET tuesday_whatsapp_link = pending_whatsapp_link,
          friday_whatsapp_link  = pending_whatsapp_link,
          pending_whatsapp_link = '',
          whatsapp_link_swap_at = NULL,
          updated_at            = NOW()
      WHERE source = $1
        AND whatsapp_link_swap_at IS NOT NULL
        AND whatsapp_link_swap_at <= NOW()
        AND pending_whatsapp_link IS NOT NULL
        AND pending_whatsapp_link != ''
    `, [source]);

    // Slot 2
    await pool.query(`
      UPDATE webinar_config
      SET tuesday_whatsapp_link  = pending_whatsapp_link_2,
          friday_whatsapp_link   = pending_whatsapp_link_2,
          pending_whatsapp_link_2 = '',
          whatsapp_link_swap_at_2 = NULL,
          updated_at             = NOW()
      WHERE source = $1
        AND whatsapp_link_swap_at_2 IS NOT NULL
        AND whatsapp_link_swap_at_2 <= NOW()
        AND pending_whatsapp_link_2 IS NOT NULL
        AND pending_whatsapp_link_2 != ''
    `, [source]);

    // ── Webinar auto-transition (per source) ──
    const { rows: configRows } = await pool.query(
      `SELECT next_webinar_at, backup_webinar_at, current_webinar_date, next_webinar_date FROM webinar_config WHERE source = $1`,
      [source]
    );

    if (configRows.length > 0) {
      const cfg = configRows[0];
      const now = new Date();
      const currentEnd = cfg.next_webinar_at ? new Date(cfg.next_webinar_at) : null;
      const hasBackup = !!cfg.backup_webinar_at;

      if (currentEnd && currentEnd < now && hasBackup) {
        // Step 1: promote backup pair
        await pool.query(`
          UPDATE webinar_config
          SET next_webinar_at      = backup_webinar_at,
              current_webinar_date = next_webinar_date,
              backup_webinar_at    = NULL,
              next_webinar_date    = NULL,
              updated_at           = NOW()
          WHERE source = $1
        `, [source]);

        // Step 2: mark old active webinar(s) for this source as inactive
        await pool.query(`UPDATE webinars SET is_active = FALSE WHERE is_active = TRUE AND source = $1`, [source]);

        // Step 3: find or create the new active webinar (this source)
        const { rows: upcomingRows } = await pool.query(
          `SELECT id FROM webinars WHERE date_time = $1 AND source = $2 LIMIT 1`,
          [cfg.backup_webinar_at, source]
        );

        let newWebinarId;
        if (upcomingRows.length > 0) {
          newWebinarId = upcomingRows[0].id;
          await pool.query(`UPDATE webinars SET is_active = TRUE WHERE id = $1`, [newWebinarId]);
        } else {
          const { nextWebinarName } = require('./webinarName');
          const name = await nextWebinarName(source);
          const { rows: insertedRows } = await pool.query(
            `INSERT INTO webinars (date_time, is_active, name, source) VALUES ($1, TRUE, $2, $3) RETURNING id`,
            [cfg.backup_webinar_at, name, source]
          );
          newWebinarId = insertedRows[0]?.id;
        }

        // Step 4: pre-flight — make sure the new webinar actually has links
        // configured. If empty, log a loud warning so it shows up in Render
        // logs / monitoring instead of failing silently. The old link stays
        // in webinar_config as a (stale) fallback until admin fixes it.
        let linkCount = 0;
        if (newWebinarId) {
          try {
            const { rows: poolRows } = await pool.query(
              `SELECT COUNT(*)::int AS cnt
                 FROM whatsapp_links
                WHERE webinar_id = $1 AND link_url <> ''`,
              [newWebinarId]
            );
            linkCount = poolRows[0]?.cnt || 0;
          } catch (_) { /* non-fatal */ }
        }
        if (linkCount === 0) {
          console.error(
            `[Scheduler:${source}] ⚠ TRANSITION HAPPENED but new webinar ${newWebinarId} ` +
            `has NO WhatsApp links configured. webinar_config keeps the previous link as a ` +
            `fallback. Admin needs to add links via CRM → Marketing → WhatsApp Links → ` +
            `Current Webinar tab ASAP.`
          );
        } else if (newWebinarId) {
          await rotateLink(newWebinarId);
        }

        console.log(`[Scheduler:${source}] Webinar transitioned:`, cfg.next_webinar_at, '→', cfg.backup_webinar_at, `(new pool: ${linkCount} link${linkCount === 1 ? '' : 's'})`);
      }
    }

    // ── Fresh config broadcast (per source) ──
    const { rows, rowCount } = await pool.query(`
      SELECT next_webinar_at, backup_webinar_at, tuesday_whatsapp_link,
             friday_whatsapp_link, kill_switch,
             pending_whatsapp_link, whatsapp_link_swap_at,
             pending_whatsapp_link_2, whatsapp_link_swap_at_2,
             current_webinar_date, next_webinar_date
      FROM webinar_config WHERE source = $1
    `, [source]);
    if (rowCount > 0) {
      cache.invalidate(source);
      cache.set(rows[0], source);
      broadcast(rows[0], source);
    }
  } catch (err) {
    console.error(`Link swap scheduler error [${source}]:`, err.message);
  }
}

async function runSwaps() {
  for (const src of SOURCES) {
    await runSwapsForSource(src);
  }
}

function startLinkSwapScheduler() {
  setInterval(runSwaps, 30_000);
}

module.exports = { startLinkSwapScheduler };
