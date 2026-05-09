const pool = require('../db');
const cache = require('./webinarConfigCache');
const { broadcast } = require('./sseClients');
const { rotateLink } = require('./linkRotation');

async function runSwaps() {
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
      WHERE id = 1
        AND whatsapp_link_swap_at IS NOT NULL
        AND whatsapp_link_swap_at <= NOW()
        AND pending_whatsapp_link IS NOT NULL
        AND pending_whatsapp_link != ''
    `);

    // Slot 2
    await pool.query(`
      UPDATE webinar_config
      SET tuesday_whatsapp_link  = pending_whatsapp_link_2,
          friday_whatsapp_link   = pending_whatsapp_link_2,
          pending_whatsapp_link_2 = '',
          whatsapp_link_swap_at_2 = NULL,
          updated_at             = NOW()
      WHERE id = 1
        AND whatsapp_link_swap_at_2 IS NOT NULL
        AND whatsapp_link_swap_at_2 <= NOW()
        AND pending_whatsapp_link_2 IS NOT NULL
        AND pending_whatsapp_link_2 != ''
    `);

    // ── Webinar auto-transition ──
    // When current webinar has passed and a backup exists:
    // 1. Promote backup → current in webinar_config
    // 2. Mark old active webinar as inactive
    // 3. Mark new webinar as active
    // 4. Activate the first WhatsApp link of the new webinar
    const { rows: configRows } = await pool.query(
      `SELECT next_webinar_at, backup_webinar_at, current_webinar_date, next_webinar_date FROM webinar_config WHERE id = 1`
    );

    if (configRows.length > 0) {
      const cfg = configRows[0];
      const now = new Date();
      const currentEnd = cfg.next_webinar_at ? new Date(cfg.next_webinar_at) : null;
      const hasBackup = !!cfg.backup_webinar_at;

      if (currentEnd && currentEnd < now && hasBackup) {
        // Step 1: Update webinar_config — promote backup pair (timer + actual webinar date)
        await pool.query(`
          UPDATE webinar_config
          SET next_webinar_at      = backup_webinar_at,
              current_webinar_date = next_webinar_date,
              backup_webinar_at    = NULL,
              next_webinar_date    = NULL,
              updated_at           = NOW()
          WHERE id = 1
        `);

        // Step 2: Mark old active webinar(s) as inactive
        await pool.query(`UPDATE webinars SET is_active = FALSE WHERE is_active = TRUE`);

        // Step 3: Find or create the new active webinar
        const { rows: upcomingRows } = await pool.query(
          `SELECT id FROM webinars WHERE date_time = $1 LIMIT 1`,
          [cfg.backup_webinar_at]
        );

        let newWebinarId;
        if (upcomingRows.length > 0) {
          newWebinarId = upcomingRows[0].id;
          await pool.query(`UPDATE webinars SET is_active = TRUE WHERE id = $1`, [newWebinarId]);
        } else {
          // Create the webinar row if it doesn't exist
          const { nextWebinarName } = require('./webinarName');
          const name = await nextWebinarName();
          const { rows: insertedRows } = await pool.query(
            `INSERT INTO webinars (date_time, is_active, name) VALUES ($1, TRUE, $2) RETURNING id`,
            [cfg.backup_webinar_at, name]
          );
          newWebinarId = insertedRows[0]?.id;
        }

        // Step 4: Activate the first WhatsApp link of the new active webinar
        if (newWebinarId) {
          await rotateLink(newWebinarId);
        }

        console.log('[Scheduler] Webinar transitioned:', cfg.next_webinar_at, '→', cfg.backup_webinar_at);
      }
    }

    // ── Fetch fresh config after all updates ──
    const { rows, rowCount } = await pool.query(`
      SELECT next_webinar_at, backup_webinar_at, tuesday_whatsapp_link,
             friday_whatsapp_link, kill_switch,
             pending_whatsapp_link, whatsapp_link_swap_at,
             pending_whatsapp_link_2, whatsapp_link_swap_at_2,
             current_webinar_date, next_webinar_date
      FROM webinar_config WHERE id = 1
    `);
    if (rowCount > 0) {
      cache.invalidate();
      cache.set(rows[0]);
      broadcast(rows[0]);
    }
  } catch (err) {
    console.error('Link swap scheduler error:', err.message);
  }
}

function startLinkSwapScheduler() {
  setInterval(runSwaps, 30_000);
}

module.exports = { startLinkSwapScheduler };
