/**
 * Recording playback proxy. Mounted at /api/caller/recordings.
 *
 *   GET /api/caller/recordings/:call_id?token=<jwt>
 *
 * Why a proxy:
 *   - The browser <audio> element can't send Authorization headers, but Smartflo
 *     recording URLs require an API key. So the backend authenticates with JWT
 *     via the ?token= query string, then streams the audio with the Smartflo
 *     auth header attached.
 *   - Self-authenticated Smartflo URLs (those with ?token= already in them)
 *     skip the extra Authorization header.
 *   - Locally-downloaded files (recording_url starts with /uploads/) are served
 *     directly via sendFile, with Range support.
 *   - For remote URLs we forward the browser's Range header so seek works.
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();
const pool    = require('../db');
const tata    = require('../utils/tataClient');
const { verify } = require('../utils/jwt');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

function authViaQuery(req, res, next) {
  const token = req.query?.token;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    const payload = verify(token);
    if (!payload?.user_id) return res.status(401).json({ error: 'unauthorized' });
    req.caller = { id: payload.user_id, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

router.use(authViaQuery);

function isSelfAuthenticatedUrl(url) {
  try { return new URL(url).searchParams.has('token'); } catch { return false; }
}

router.get('/:call_id', async (req, res) => {
  const { call_id } = req.params;
  if (!call_id) return res.status(400).json({ error: 'call_id required' });

  // Look up the call + verify the caller may access it
  let row;
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.recording_url, c.caller_id,
              u.tata_account_type, u.tata_smartflo_api_key
         FROM calls c
         LEFT JOIN crm_users u ON u.id = c.caller_id
        WHERE c.id = $1`,
      [call_id]
    );
    row = rows[0];
  } catch (err) {
    console.error('[recordings] lookup error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!row || !row.recording_url) return res.status(404).json({ error: 'not_found' });

  // Authorization: caller can stream their own calls. (Super-admin token has
  // a different shape and isn't checked here — extend if you need that.)
  if (row.caller_id && row.caller_id !== req.caller.id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Local file path?
  if (row.recording_url.startsWith('/uploads/')) {
    const safe = path.normalize(row.recording_url).replace(/^[\\/]+/, '');
    const abs  = path.join(__dirname, '..', safe);
    if (!abs.startsWith(UPLOADS_ROOT) || !fs.existsSync(abs)) {
      return res.status(404).json({ error: 'file_missing' });
    }
    const ext = path.extname(abs).toLowerCase();
    const ct  = ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
    res.setHeader('Content-Type', ct);
    return res.sendFile(abs);
  }

  // Remote — stream with auth header (skipping it for self-auth Smartflo URLs)
  const apiKey = tata.resolveApiKey({
    perUserKey:  row.tata_smartflo_api_key,
    accountType: row.tata_account_type,
  });
  const headers = {};
  if (apiKey && !isSelfAuthenticatedUrl(row.recording_url)) {
    headers.Authorization = apiKey;
  }
  // Forward the browser's Range header so seek works
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(row.recording_url, { redirect: 'follow', headers });
  } catch (err) {
    console.error('[recordings] upstream fetch error:', err.message);
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status).json({ error: `upstream_${upstream.status}` });
  }

  // Mirror critical response headers
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  // Default to audio/mpeg if upstream didn't send a content-type
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'audio/mpeg');

  // Stream the body
  try {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise(r => res.once('drain', r));
      }
    }
  } catch (err) {
    console.error('[recordings] stream error:', err.message);
  }
  res.end();
});

module.exports = router;
