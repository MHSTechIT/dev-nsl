/*
 * Whapi inbound webhook — receives incoming WhatsApp messages for the alert
 * channel and resumes a caller when a recipient taps the "Resume caller" button
 * (or replies with the resume token). Public (Whapi posts here); the resume is
 * gated server-side to registered alert recipients only.
 *
 * Configure the channel to deliver messages here:
 *   URL    https://leadgenx.myhealthschool.in/api/webhooks/whapi
 *   events messages (incoming)
 */
const express = require('express');
const router  = express.Router();
const { handleInboundResume } = require('../utils/whatsappAlerts');

// Whapi can GET the URL to verify it's reachable.
router.get('/', (_req, res) => res.sendStatus(200));

router.post('/', express.json({ limit: '1mb' }), async (req, res) => {
  // Ack immediately so Whapi never retry-storms; process in the background.
  res.sendStatus(200);
  try { await handleInboundResume(req.body); }
  catch (e) { console.error('[whapiInbound] handler error:', e.message); }
});

module.exports = router;
