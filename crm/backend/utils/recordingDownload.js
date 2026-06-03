/**
 * Background download of a Smartflo recording to backend/uploads/recordings/<callId>.mp3
 * so the URL never expires. Updates calls.recording_url to a /uploads/... path on success.
 *
 * Smartflo recording URLs come in two flavours:
 *   - Self-authenticated (have ?token=… in the query string) → fetch with NO Authorization header
 *   - Bare URLs → fetch with `Authorization: <api_key>` header
 *
 * The downloaded file extension follows the Content-Type, defaulting to .mp3.
 */
const fs   = require('fs');
const path = require('path');
const pool = require('../db');
const tata = require('./tataClient');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'recordings');

function ensureDir() {
  try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) {}
}

function isSelfAuthenticated(url) {
  try {
    const u = new URL(url);
    return u.searchParams.has('token');
  } catch { return false; }
}

function extFromContentType(ct) {
  const t = String(ct || '').toLowerCase();
  if (t.includes('wav'))  return '.wav';
  if (t.includes('mpeg')) return '.mp3';
  if (t.includes('mp3'))  return '.mp3';
  if (t.includes('ogg'))  return '.ogg';
  return '.mp3';
}

/**
 * Download the recording for a given calls row. Resolves the per-user / per-account
 * API key from the caller_id linked on the call.
 *
 * @param {object} args
 * @param {string} args.callId        – calls.id (primary key, used for filename)
 * @param {string} args.recordingUrl  – Smartflo URL from the webhook payload
 * @param {string} [args.callerId]    – crm_users.id; used to resolve auth key
 * @param {string} [args.callsTable]  – calls table to update (Meta 'calls' default, NSM 'nsm_calls')
 * @param {string} [args.usersTable]  – users table for the API-key lookup ('crm_users' default, NSM 'nsm_users')
 */
async function downloadRecording({ callId, recordingUrl, callerId, callsTable = 'calls', usersTable = 'crm_users' }) {
  if (!callId || !recordingUrl) return;
  ensureDir();

  // Resolve auth key from the same tier the call was placed with
  let apiKey = '';
  try {
    if (callerId) {
      const { rows } = await pool.query(
        `SELECT tata_account_type, tata_smartflo_api_key
           FROM ${usersTable} WHERE id = $1`,
        [callerId]
      );
      if (rows[0]) {
        apiKey = tata.resolveApiKey({
          perUserKey:  rows[0].tata_smartflo_api_key,
          accountType: rows[0].tata_account_type,
        });
      }
    }
    if (!apiKey) apiKey = process.env.TATA_TELE_API_KEY || '';
  } catch (_) { /* fall through with whatever we have */ }

  const headers = {};
  // Skip auth header when the URL is already self-authenticated
  if (apiKey && !isSelfAuthenticated(recordingUrl)) {
    headers.Authorization = apiKey;
  }

  let res;
  try {
    res = await fetch(recordingUrl, { redirect: 'follow', headers });
  } catch (err) {
    console.error('[recording] fetch error:', err.message);
    return;
  }
  if (!res.ok) {
    console.error('[recording] fetch HTTP', res.status, 'for call', callId);
    return;
  }

  const ext  = extFromContentType(res.headers.get('content-type'));
  const file = `${callId}${ext}`;
  const dest = path.join(UPLOADS_DIR, file);

  // Stream the body to disk
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
  } catch (err) {
    console.error('[recording] write error:', err.message);
    return;
  }

  const localUrl = `/uploads/recordings/${file}`;
  try {
    await pool.query(
      `UPDATE ${callsTable} SET recording_url = $1, updated_at = NOW() WHERE id = $2`,
      [localUrl, callId]
    );
  } catch (err) {
    console.error('[recording] db update error:', err.message);
  }
}

module.exports = { downloadRecording, UPLOADS_DIR };
