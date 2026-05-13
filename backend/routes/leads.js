const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();
const pool = require('../db');
const { rotateLink } = require('../utils/linkRotation');
const { assignNewLead } = require('../utils/leadAssigner');

function computeLeadScore(sugarLevel, duration) {
  if (duration === 'pre') return 2;
  const sugarScore = sugarLevel === '250+' ? 3 : 2;
  const durationBonus = { long: 2, mid: 1, new: 0 }[duration] ?? 0;
  return Math.min(5, sugarScore + durationBonus);
}

function getISTDayOfWeek() {
  const now = new Date();
  return now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
}

const validators = [
  body('full_name').trim().isLength({ min: 2 }).matches(/^[a-zA-Z\s]+$/),
  body('whatsapp_number').trim().matches(/^\d{10}$/),
  body('email').trim().isEmail().normalizeEmail(),
  body('sugar_level').isIn(['150-250', '250+']),
  body('diabetes_duration').isIn(['new', 'mid', 'long', 'pre']),
  body('language_pref').isIn(['tamil', 'english']),
];

const ALLOWED_SOURCES = new Set(['meta', 'yt']);
function normalizeSource(value) {
  return ALLOWED_SOURCES.has(value) ? value : 'meta';
}

router.post('/leads', validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      error: 'validation_failed',
      fields: errors.array().map(e => e.path),
    });
  }

  const source = normalizeSource(req.body.source);

  // Fetch config for this source
  let config = { kill_switch: false, tuesday_whatsapp_link: '', friday_whatsapp_link: '' };
  try {
    const { rows } = await pool.query(
      'SELECT kill_switch, tuesday_whatsapp_link, friday_whatsapp_link FROM webinar_config WHERE source = $1',
      [source]
    );
    if (rows.length > 0) config = rows[0];
  } catch (err) {
    console.warn('Config fetch warning:', err.message);
  }

  if (config.kill_switch) {
    return res.status(409).json({ success: false, error: 'registrations_paused' });
  }

  const { full_name, whatsapp_number, email, sugar_level, diabetes_duration,
          language_pref, utm_source, utm_campaign, utm_content, fbclid } = req.body;

  // Visitor ID from the client's localStorage. Lets us tie this lead to
  // its pre-registration page_visited events for Option-C unique-visitor
  // dedupe via the lead's phone number.
  const visitor_id = typeof req.body.visitor_id === 'string'
    ? req.body.visitor_id.slice(0, 64)
    : null;

  const lead_score = computeLeadScore(sugar_level, diabetes_duration);
  const day = getISTDayOfWeek();
  const whatsapp_link = (day === 'Mon' || day === 'Tue')
    ? config.tuesday_whatsapp_link
    : config.friday_whatsapp_link;

  // Look up the currently active webinar session for this source
  let webinar_id = null;
  try {
    const { rows: wRows } = await pool.query(
      'SELECT id FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1',
      [source]
    );
    webinar_id = wRows[0]?.id ?? null;
  } catch (_) { /* webinars table may not exist yet — safe to skip */ }

  try {
    const { rows } = await pool.query(
      `INSERT INTO leads
        (full_name, whatsapp_number, email, sugar_level, diabetes_duration,
         language_pref, lead_score, utm_source, utm_campaign, utm_content, fbclid, webinar_id, source, visitor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        full_name, whatsapp_number, email, sugar_level, diabetes_duration,
        language_pref, lead_score,
        utm_source || null, utm_campaign || null, utm_content || null, fbclid || null,
        webinar_id, source, visitor_id,
      ]
    );

    res.status(201).json({
      success: true,
      lead_id: rows[0].id,
      lead_score,
      whatsapp_link,
    });

    // Fire-and-forget: rotate WhatsApp link if lead count crossed a threshold
    if (webinar_id) {
      rotateLink(webinar_id).catch(e => console.error('[LinkRotation] post-lead error:', e.message));
    }

    // Fire-and-forget: round-robin assign this lead to an eligible caller
    if (webinar_id) {
      assignNewLead(rows[0].id, sugar_level, webinar_id)
        .catch(e => console.error('[Assigner] post-lead error:', e.message));
    }
  } catch (err) {
    console.error('Lead insert error:', err.message);
    res.status(500).json({ success: false, error: 'server_error' });
  }
});

/* PATCH /api/leads/:id/wa-click */
router.patch('/leads/:id/wa-click', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false });

  try {
    await pool.query('UPDATE leads SET wa_clicked = true WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('wa-click update error:', err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
module.exports._computeLeadScore = computeLeadScore;
module.exports._getISTDayOfWeek  = getISTDayOfWeek;
