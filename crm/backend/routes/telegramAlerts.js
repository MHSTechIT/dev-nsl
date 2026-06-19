/*
 * /api/admin/telegram-alerts — manage Telegram alert recipients.
 *
 *   GET    /                  → list all recipients (joined with TL name)
 *   POST   /                  → create a recipient
 *   PATCH  /:id               → update a recipient
 *   DELETE /:id               → remove a recipient
 *   POST   /:id/test          → send a test ping to that chat
 *
 * Auth: protected by the same adminAuth bearer the rest of /api/admin uses.
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const pool    = require('../db');
const { adminAuth }      = require('../middleware/adminAuth');
const { sendTelegram }   = require('../utils/telegramNotifier');
const { sendTextToNumber } = require('../utils/whapiSend');
const { alertChannelId }  = require('../utils/whatsappAlerts');
const { sendHourlyReports } = require('../utils/hourlyCallerReportScheduler');

router.use(adminAuth);

/* ── GET /api/admin/telegram-alerts ─────────────────────────────────── */
router.get('/', async (req, res) => {
  // TL scope: only recipients targeting THIS team_leader (so a TL sees
  // exactly who gets notified when their team auto-pauses). Manager +
  // super-admin see everything as before.
  const tl = req.adminUser && req.adminUser.kind === 'tl';
  const params = [];
  let whereSQL = '';
  if (tl) {
    params.push(req.adminUser.id);
    whereSQL = `WHERE r.target_type = 'team_leader' AND r.team_leader_id = $1`;
  }
  try {
    const { rows } = await pool.query(`
      SELECT r.id,
             r.telegram_chat_id,
             r.target_type,
             r.team_leader_id,
             r.department,
             r.label,
             r.created_at,
             tl.full_name AS team_leader_name
        FROM telegram_alert_recipients r
        LEFT JOIN crm_users tl ON tl.id = r.team_leader_id
       ${whereSQL}
       ORDER BY r.created_at DESC
    `, params);
    res.json({ recipients: rows });
  } catch (err) {
    console.error('GET /telegram-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to load Telegram recipients.' });
  }
});

/* ── POST /api/admin/telegram-alerts ────────────────────────────────── */
router.post(
  '/',
  body('telegram_chat_id').isString().trim().notEmpty().withMessage('WhatsApp number is required.'),
  body('target_type').isIn(['team_leader', 'manager', 'assistant_manager']).withMessage('target_type must be team_leader, manager or assistant_manager.'),
  body('team_leader_id').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Invalid team_leader_id.'),
  body('department').optional({ nullable: true, checkFalsy: true }).isIn(['sales', 'marketing']).withMessage('Department must be sales or marketing.'),
  body('label').optional({ nullable: true }).isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { telegram_chat_id, target_type, team_leader_id, department, label } = req.body;

    // Schema-level CHECK enforces this too — surface a friendly error first.
    if (target_type === 'team_leader' && !team_leader_id) {
      return res.status(400).json({ error: 'team_leader_id is required when target_type=team_leader.' });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO telegram_alert_recipients
           (telegram_chat_id, target_type, team_leader_id, department, label)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          String(telegram_chat_id).trim(),
          target_type,
          target_type === 'team_leader' ? team_leader_id : null,
          target_type === 'manager'     ? (department || null) : null,
          label || null,
        ]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      console.error('POST /telegram-alerts error:', err.message);
      res.status(500).json({ error: 'Failed to create recipient.' });
    }
  }
);

/* ── PATCH /api/admin/telegram-alerts/:id ───────────────────────────── */
router.patch('/:id', async (req, res) => {
  const allowed = ['telegram_chat_id', 'target_type', 'team_leader_id', 'department', 'label'];
  const set = [];
  const vals = [];
  for (const k of allowed) {
    if (k in req.body) {
      set.push(`${k} = $${set.length + 1}`);
      vals.push(req.body[k] === '' ? null : req.body[k]);
    }
  }
  if (set.length === 0) return res.status(400).json({ error: 'No fields to update.' });
  vals.push(req.params.id);
  try {
    const { rowCount } = await pool.query(
      `UPDATE telegram_alert_recipients SET ${set.join(', ')} WHERE id = $${vals.length}`,
      vals
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Recipient not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /telegram-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to update recipient.' });
  }
});

/* ── DELETE /api/admin/telegram-alerts/:id ──────────────────────────── */
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM telegram_alert_recipients WHERE id = $1`,
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Recipient not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /telegram-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to delete recipient.' });
  }
});

/* ── POST /api/admin/telegram-alerts/:id/test ───────────────────────── */
router.post('/:id/test', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT telegram_chat_id, label FROM telegram_alert_recipients WHERE id = $1`,
      [req.params.id]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Recipient not found.' });

    // Alerts now go over WhatsApp (Whapi) — send the test to the recipient's
    // WhatsApp number (telegram_chat_id reused) via the Web-Reminder channel.
    const channelId = await alertChannelId();
    if (!channelId) return res.status(400).json({ error: 'No Whapi channel set. Pick one on Web Reminder → Alerts and Save.' });
    const number = String(r.telegram_chat_id || '').replace(/\D/g, '');
    if (number.length < 10) return res.status(400).json({ error: 'Enter a valid WhatsApp number first.' });

    try {
      await sendTextToNumber(channelId, number,
        `✅ MHS CRM test message\n\nIf you can read this, WhatsApp alerts are wired up correctly for ${r.label || 'this recipient'}.`);
      res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: `WhatsApp send failed: ${e.message}` });
    }
  } catch (err) {
    console.error('POST /telegram-alerts/:id/test error:', err.message);
    res.status(500).json({ error: 'Test send failed.' });
  }
});

/* ── POST /api/admin/telegram-alerts/report-now ─────────────────────────
   Manually fire the hourly caller report to every configured recipient now
   (the "Send report now" button on the Alerts page). Bypasses the office-hours
   window so it can be tested on demand. */
router.post('/report-now', async (req, res) => {
  try {
    const result = await sendHourlyReports({ force: true });
    if (!result.ok) {
      const msg = result.reason === 'no_channel'
        ? 'No Whapi channel set. Pick one on Web Reminder → Alerts and Save.'
        : `Report not sent (${result.reason}).`;
      return res.status(400).json({ error: msg });
    }
    if (result.sent === 0) {
      return res.status(400).json({ error: 'No TL / manager recipients with a valid WhatsApp number. Add one above first.' });
    }
    res.json({ ok: true, sent: result.sent, recipients: result.recipients });
  } catch (err) {
    console.error('POST /telegram-alerts/report-now error:', err.message);
    res.status(500).json({ error: 'Failed to send report.' });
  }
});

module.exports = router;
