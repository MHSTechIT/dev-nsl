/* ────────────────────────────────────────────────────────────────────────
   Meta CAPI mirror route.
   ----------------------------------------------------------------------
   POST /api/meta/event — the browser mirror endpoint.

   The frontend's metaPixel.js fires every Meta event TWICE:
     1. via window.fbq (browser pixel)
     2. via this endpoint → Conversions API

   Both events carry the same `event_id`; Meta dedupes them.

   Body shape (set by frontend/src/utils/metaPixel.js → mirrorToServer):
     {
       event_name:        string          // e.g. "Lead", "FieldSelect_sugar_level"
       event_id:          string          // UUID — dedup key shared with pixel
       event_time:        number          // seconds since epoch
       event_source_url:  string
       fbp:               string | null
       fbc:               string | null
       visitor_id:        string | null
       user_agent:        string
       utm:               object
       custom_data:       object          // anything from the pixel call
       user_data:         object          // { email, phone, ... } RAW
                                          // — hashed before forwarding
       action_source:     'website'
     }
   ──────────────────────────────────────────────────────────────────── */

const express = require('express');
const router = express.Router();
const { sendCapiEvent } = require('../utils/metaCapi');

router.post('/event', express.json({ limit: '64kb' }), async (req, res) => {
  // Acknowledge fast — the browser used sendBeacon / keepalive, we don't
  // need to keep its connection open for the Graph API round-trip.
  res.status(202).json({ accepted: true });

  try {
    const body = req.body || {};
    const ipRaw = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
    const clientIp = String(ipRaw).split(',')[0].trim() || undefined;

    const userData = {
      // Raw — buildUserData() in metaCapi.js hashes everything per Meta spec.
      email:       body.user_data && body.user_data.email,
      phone:       body.user_data && body.user_data.phone,
      full_name:   body.user_data && body.user_data.full_name,
      city:        body.user_data && body.user_data.city,
      state:       body.user_data && body.user_data.state,
      zip:         body.user_data && body.user_data.zip,
      country:     (body.user_data && body.user_data.country) || 'in',
      visitor_id:  body.visitor_id,
      external_id: body.visitor_id,
      fbp:         body.fbp || undefined,
      fbc:         body.fbc || undefined,
      client_ip_address: clientIp,
      client_user_agent: body.user_agent || req.headers['user-agent'] || undefined,
    };

    // Custom data — flatten UTM into the top of custom_data so Meta's
    // UI shows them as filterable params alongside the screen / field
    // signals the pixel already attached.
    const customData = {
      ...(body.utm || {}),
      ...(body.custom_data || {}),
    };

    await sendCapiEvent({
      event_name:       body.event_name,
      event_id:         body.event_id,
      event_time:       body.event_time,
      event_source_url: body.event_source_url,
      action_source:    body.action_source || 'website',
      user_data:        userData,
      custom_data:      customData,
    });
  } catch (err) {
    // Never bubble — this is a fire-and-forget pipeline.
    console.warn('[meta/event] handler error:', err.message);
  }
});

module.exports = router;
