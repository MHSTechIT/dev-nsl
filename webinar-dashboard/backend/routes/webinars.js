const express = require('express');
const router = express.Router();
const pool = require('../db');
const zoom = require('../utils/zoom');

/* GET /api/webinars/hosts — the configured Zoom host users (for the modal). */
router.get('/hosts', (_req, res) => {
  res.json({ configured: zoom.isConfigured(), hosts: zoom.listHosts() });
});

/* GET /api/webinars — all webinars, soonest-start first, with attendee counts. */
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT w.*, COALESCE(p.cnt, 0)::int AS participant_count
        FROM wd_webinars w
        LEFT JOIN (
          SELECT webinar_id, COUNT(*) AS cnt FROM wd_participants GROUP BY webinar_id
        ) p ON p.webinar_id = w.id
       ORDER BY w.start_at ASC, w.id DESC
    `);
    res.json({ webinars: rows });
  } catch (e) {
    console.error('[wd] list error:', e.message);
    res.status(500).json({ error: 'Failed to load webinars.' });
  }
});

/* POST /api/webinars — create a webinar row (+ a Zoom meeting when configured).
   Body: { name, start_at, batch_name?, category?, host_id?, duration_min? } */
router.post('/', async (req, res) => {
  const { name, start_at, batch_name, category, host_id, duration_min,
          timezone, agenda, registration, passcode, auto_recording,
          host_video, panelists_video, audio, practice_session, q_and_a,
          hd_video, email_in_attendee_report, alternative_hosts } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Webinar name is required.' });
  if (!start_at || isNaN(new Date(start_at).getTime())) return res.status(400).json({ error: 'A valid date & time is required.' });

  let z = { meetingId: null, joinUrl: null, startUrl: null, registrationUrl: null };
  let zoomStatus = 'pending';   // pending = no Zoom creds yet; created | failed otherwise
  let zoomError = null;

  if (zoom.isConfigured()) {
    try {
      const hosts = zoom.listHosts();
      const host = host_id || hosts[0]?.hostId;
      if (!host) throw new Error('No Zoom host configured (set ZOOM_HOSTS).');
      z = await zoom.createWebinar({
        hostId: host,
        topic: String(name).trim(),
        startAt: start_at,
        durationMin: Number(duration_min) || 60,
        timezone: timezone || 'Asia/Kolkata',
        agenda: agenda || '',
        registration: registration !== false,
        password: passcode || '',
        autoRecording: auto_recording || 'none',
        hostVideo: !!host_video,
        panelistsVideo: !!panelists_video,
        audio: audio || 'both',
        practiceSession: !!practice_session,
        qAndA: q_and_a !== false,
        hdVideo: !!hd_video,
        emailInAttendeeReport: !!email_in_attendee_report,
        alternativeHosts: alternative_hosts || '',
      });
      zoomStatus = 'created';
    } catch (e) {
      console.error('[wd] zoom create failed:', e.message);
      zoomStatus = 'failed';
      zoomError = e.message;
    }
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO wd_webinars
        (name, batch_name, category, start_at, host_id, duration_min, agenda, passcode,
         zoom_meeting_id, zoom_join_url, zoom_start_url, zoom_registration_url,
         zoom_status, zoom_error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [
      String(name).trim(), batch_name || null, category || null,
      new Date(start_at).toISOString(), host_id || null,
      Number(duration_min) || 60, agenda || null, z.password || passcode || null,
      z.meetingId, z.joinUrl, z.startUrl, z.registrationUrl,
      zoomStatus, zoomError,
    ]);
    res.status(201).json({ webinar: { ...rows[0], participant_count: 0 } });
  } catch (e) {
    console.error('[wd] create error:', e.message);
    res.status(500).json({ error: 'Failed to save webinar.' });
  }
});

/* GET /api/webinars/:id — one webinar + its participants + chat. */
router.get('/:id', async (req, res) => {
  try {
    const { rows: wr } = await pool.query('SELECT * FROM wd_webinars WHERE id = $1', [req.params.id]);
    if (!wr.length) return res.status(404).json({ error: 'Not found.' });
    const { rows: parts } = await pool.query(
      'SELECT * FROM wd_participants WHERE webinar_id = $1 ORDER BY duration_sec DESC NULLS LAST, name', [req.params.id]);
    const { rows: chat } = await pool.query(
      'SELECT * FROM wd_chat_messages WHERE webinar_id = $1 ORDER BY sent_at NULLS LAST, id', [req.params.id]);
    res.json({ webinar: wr[0], participants: parts, chat });
  } catch (e) {
    console.error('[wd] get error:', e.message);
    res.status(500).json({ error: 'Failed to load webinar.' });
  }
});

/* POST /api/webinars/:id/sync — pull attendee data from Zoom (post-meeting):
   participant report (name/email/duration) enriched with registrants (phone). */
router.post('/:id/sync', async (req, res) => {
  if (!zoom.isConfigured()) return res.status(400).json({ error: 'Zoom is not configured yet — add credentials to the backend .env.' });
  try {
    const { rows: wr } = await pool.query('SELECT * FROM wd_webinars WHERE id = $1', [req.params.id]);
    if (!wr.length) return res.status(404).json({ error: 'Not found.' });
    const w = wr[0];
    if (!w.zoom_meeting_id) return res.status(400).json({ error: 'This webinar has no Zoom meeting attached.' });

    const [participants, registrants] = await Promise.all([
      zoom.getParticipants(w.zoom_meeting_id),
      zoom.getRegistrants(w.zoom_meeting_id).catch(() => []), // registrants optional
    ]);

    const phoneByEmail = new Map();
    const phoneByName = new Map();
    for (const r of registrants) {
      if (r.email) phoneByEmail.set(r.email.toLowerCase(), r.phone || null);
      if (r.name) phoneByName.set(r.name.toLowerCase(), r.phone || null);
    }

    // Idempotent re-sync: replace this webinar's participants.
    await pool.query('DELETE FROM wd_participants WHERE webinar_id = $1', [w.id]);
    for (const p of participants) {
      const phone = (p.email && phoneByEmail.get(p.email.toLowerCase()))
        || (p.name && phoneByName.get(p.name.toLowerCase()))
        || null;
      await pool.query(
        `INSERT INTO wd_participants (webinar_id, name, email, phone, join_at, leave_at, duration_sec)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [w.id, p.name, p.email, phone, p.joinAt, p.leaveAt, p.durationSec]);
    }
    const { rows } = await pool.query(
      'SELECT * FROM wd_participants WHERE webinar_id = $1 ORDER BY duration_sec DESC NULLS LAST', [w.id]);
    res.json({ synced: rows.length, participants: rows });
  } catch (e) {
    console.error('[wd] sync error:', e.message);
    res.status(500).json({ error: `Sync failed: ${e.message}` });
  }
});

/* DELETE /api/webinars/:id — remove a webinar card (and its attendees). */
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM wd_webinars WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[wd] delete error:', e.message);
    res.status(500).json({ error: 'Failed to delete.' });
  }
});

module.exports = router;
