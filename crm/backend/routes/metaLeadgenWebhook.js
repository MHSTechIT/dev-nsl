/**
 * Public Meta Lead Ads webhook  — Meta workspace only (temporary).
 *
 * Replaces POLLING the Graph API for new leads. Meta PUSHES a "leadgen"
 * notification the instant a lead submits the form; we fetch that ONE lead,
 * insert it into the Meta `leads` table (dedup on meta_lead_id), then fire the
 * same pg_notify('lead.created') the funnel fires so the existing round-robin
 * assigner (leadAssigner) picks it up and routes it to a caller.
 *
 *   GET  /api/meta-leadgen   — Meta's subscription verification handshake.
 *   POST /api/meta-leadgen   — leadgen change notifications.
 *
 * No auth header (Meta can't send one). Integrity is via:
 *   1. GET verify-token handshake (META_LEADGEN_VERIFY_TOKEN).
 *   2. Optional X-Hub-Signature-256 HMAC (enabled once META_APP_SECRET is set).
 *
 * Env:
 *   META_LEADGEN_VERIFY_TOKEN  — the "Verify Token" you paste into Meta.
 *   META_APP_SECRET            — (optional) enables payload signature checks.
 *   META_ACCESS_TOKEN / META_PAGE_TOKEN_<pageId> — already used by metaInsights
 *                                                  to read the Page's leads.
 */
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../db');
const { fetchLeadById } = require('../utils/metaInsights');

const router = express.Router();

const VERIFY_TOKEN = (process.env.META_LEADGEN_VERIFY_TOKEN || '').trim();
const APP_SECRET   = (process.env.META_APP_SECRET || '').trim();
const SOURCE       = 'meta';   // temp: this webhook serves the Meta workspace only.

/* ── field_data mapping — mirrors routes/admin.js POST /leads/fetch-meta ── */
const NAME_KEYS  = ['full_name', 'name', 'your_name', 'full name'];
const PHONE_KEYS = ['phone_number', 'phone', 'mobile_number', 'mobile', 'whatsapp_number', 'contact_number'];
const EMAIL_KEYS = ['email', 'email_address', 'e-mail'];
function flattenFieldData(fd) {
  const out = {};
  for (const f of (Array.isArray(fd) ? fd : [])) {
    if (!f || !f.name) continue;
    out[String(f.name).toLowerCase()] = (Array.isArray(f.values) ? f.values : [f.values]).filter(v => v != null).join(', ');
  }
  return out;
}
const pickKey = (m, keys) => { for (const k of keys) if (m[k]) return m[k]; return ''; };

/* ── GET: subscription verification handshake ── */
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ── Optional HMAC signature check (off until META_APP_SECRET is set) ── */
function signatureOk(req) {
  if (!APP_SECRET) return true;
  const sig = req.get('x-hub-signature-256') || '';
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── POST: leadgen notifications ── */
router.post('/', async (req, res) => {
  // ACK first — Meta retries aggressively and times out fast, so never make it
  // wait on the Graph fetch + DB insert. Process the payload after responding.
  res.sendStatus(200);
  try {
    if (!signatureOk(req)) { console.warn('[meta-leadgen] bad signature — ignoring payload'); return; }
    const body = req.body || {};
    if (body.object !== 'page') return;

    const changes = [];
    for (const entry of (body.entry || [])) {
      for (const ch of (entry.changes || [])) {
        if (ch.field === 'leadgen' && ch.value && ch.value.leadgen_id) {
          changes.push({
            leadgenId: String(ch.value.leadgen_id),
            formId:    ch.value.form_id ? String(ch.value.form_id) : null,
            pageId:    ch.value.page_id ? String(ch.value.page_id) : (entry.id ? String(entry.id) : null),
          });
        }
      }
    }
    for (const c of changes) await ingestLead(c);
  } catch (e) {
    console.error('[meta-leadgen] POST error:', e.message);
  }
});

async function ingestLead({ leadgenId, formId, pageId }) {
  // Dedup — already imported by webhook or the legacy fetch-meta poller?
  const { rows: dupe } = await pool.query(
    'SELECT id FROM leads WHERE meta_lead_id = $1 AND source = $2 LIMIT 1', [leadgenId, SOURCE]);
  if (dupe.length) return;

  const { lead, error } = await fetchLeadById(leadgenId, pageId);
  if (!lead) { console.warn(`[meta-leadgen] could not fetch lead ${leadgenId}: ${error || ''}`); return; }

  const map = flattenFieldData(lead.field_data);
  let full_name = pickKey(map, NAME_KEYS);
  if (!full_name && (map['first_name'] || map['last_name'])) {
    full_name = [map['first_name'], map['last_name']].filter(Boolean).join(' ').trim();
  }
  const phone      = pickKey(map, PHONE_KEYS).replace(/\D/g, '').slice(-10);
  const email      = pickKey(map, EMAIL_KEYS) || null;
  const created_at = lead.created_time ? new Date(lead.created_time) : new Date();
  const formIdFinal = formId || (lead.form_id ? String(lead.form_id) : null);

  // Active webinar for this source so the assigner can scope round-robin.
  let webinar_id = null;
  try {
    const { rows } = await pool.query(
      'SELECT id FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1', [SOURCE]);
    webinar_id = rows[0]?.id ?? null;
  } catch { /* webinars table optional */ }

  let leadId = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO leads
         (full_name, whatsapp_number, email, lead_score, webinar_id, source,
          field_data, meta_lead_id, meta_form_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [full_name || '', phone, email, 2, webinar_id, SOURCE,
       JSON.stringify(map), leadgenId, formIdFinal, created_at]
    );
    leadId = rows[0]?.id || null;
  } catch (e) {
    console.error(`[meta-leadgen] insert failed ${leadgenId}:`, e.message);
    return;
  }
  if (!leadId) return; // raced with a duplicate insert — nothing more to do.

  // Same notification the funnel fires on a real registration → round-robin
  // assigner (leadCreatedListener → assignNewLead) routes it to a caller.
  pool.query(`SELECT pg_notify('lead.created', $1)`,
    [JSON.stringify({ leadId, source: SOURCE, sugarLevel: null, webinarId: webinar_id })]
  ).catch(e => console.error('[meta-leadgen notify]', e.message));

  console.log(`[meta-leadgen] ingested ${leadgenId} → ${leadId} (${full_name || 'no name'} / ${phone || 'no phone'})`);
}

module.exports = router;
