/*
 * metaLeadSync — periodic RECONCILIATION pull of Meta Lead-Ads leads.
 *
 * The webhook (routes/metaLeadgenWebhook.js) is the real-time path; Meta pushes
 * each lead the instant it's submitted. But pushes can be missed (backend asleep
 * on Render cold start, a deploy mid-delivery, a dropped retry). This module is
 * the safety net: every few minutes it asks the Graph API "any leads in the last
 * N minutes?" for each workspace's selected forms and ingests anything the
 * webhook didn't already record.
 *
 * It deliberately mirrors the webhook's behaviour so the two never fight:
 *   • Same form→source routing (webinar_config.current_form_id / next_form_id).
 *   • Same dedup key (leads.meta_lead_id) — a lead the webhook already inserted
 *     is skipped here, and vice-versa.
 *   • Same pg_notify('lead.created') so the round-robin assigner routes it.
 *
 * Crash-safety (the whole point of the exercise):
 *   • fetchFormLeads already returns errors as values (never throws) and caps
 *     paging, so a Meta outage/timeout can't take the process down.
 *   • Only pool.query() is used — no manual connect()/release(), so no pool leak.
 *   • The caller (scheduler) wraps each run in try/catch with a re-entrancy guard.
 */
const pool = require('../db');
const { fetchFormLeads, metaConfigured } = require('./metaInsights');
const { assignNewLead } = require('./leadAssigner');

/* field_data mapping — mirrors routes/admin.js + metaLeadgenWebhook.js. */
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
/* Space/underscore-insensitive key lookup. Meta form fields arrive named
   either "phone_number" or "phone number" (and other spacing), so normalise
   both sides — otherwise a "phone number" field silently yields an empty phone
   and every such lead collides on the empty-string dedup. */
const normKey = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '');
function pickKey(map, keys) {
  const nmap = {};
  for (const k in map) nmap[normKey(k)] = map[k];
  for (const k of keys) { const v = nmap[normKey(k)]; if (v) return v; }
  return '';
}

/* Parse a webinar_config form-id column into a string[] (parsed JSONB array,
   JSON-array string, or a bare id). Mirrors the webhook's parseFormIds. */
function parseFormIds(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : [String(p)]; }
  catch { return [String(v)]; }
}

/**
 * Reconcile recent Meta leads for ONE workspace.
 * @param {string} source              e.g. 'metatemp'
 * @param {object} [opts]
 * @param {number} [opts.windowMinutes=15]  how far back to ask Meta (overlap is
 *        intentional — dedup makes re-seen leads free, and a wider window
 *        recovers leads missed during a longer outage).
 * @returns {{ source, inserted, skipped, forms, error? }}
 */
async function syncMetaLeadsForSource(source, { windowMinutes = 15 } = {}) {
  if (!metaConfigured()) return { source, inserted: 0, skipped: 0, forms: 0, error: 'meta_not_configured' };

  // 1. Forms this workspace currently routes (live from webinar_config).
  const { rows: cfg } = await pool.query(
    'SELECT current_form_id, next_form_id FROM webinar_config WHERE source = $1', [source]);
  if (cfg.length === 0) return { source, inserted: 0, skipped: 0, forms: 0, error: 'no_config' };
  const formIds = [...new Set([
    ...parseFormIds(cfg[0].current_form_id),
    ...parseFormIds(cfg[0].next_form_id),
  ])].filter(Boolean);
  if (formIds.length === 0) return { source, inserted: 0, skipped: 0, forms: 0 }; // nothing selected

  // 2. Active webinar so the assigner can scope round-robin.
  let webinarId = null;
  try {
    const { rows } = await pool.query(
      'SELECT id FROM webinars WHERE is_active = TRUE AND source = $1 LIMIT 1', [source]);
    webinarId = rows[0]?.id ?? null;
  } catch { /* webinars optional */ }

  const sinceUnix = Math.floor(Date.now() / 1000) - windowMinutes * 60;

  let inserted = 0, skipped = 0;
  for (const formId of formIds) {
    const { leads, error } = await fetchFormLeads(formId, sinceUnix, null);
    if (error) { console.warn(`[metaLeadSync:${source}] form ${formId}: ${String(error).slice(0, 120)}`); continue; }
    if (!leads.length) continue;

    // Dedup against only the candidate ids — efficient even as the table grows.
    const ids = leads.map(l => String(l.id)).filter(Boolean);
    const { rows: existRows } = await pool.query(
      'SELECT meta_lead_id FROM leads WHERE source = $1 AND meta_lead_id = ANY($2::text[])',
      [source, ids]);
    const seen = new Set(existRows.map(r => String(r.meta_lead_id)));

    for (const ml of leads) {
      const metaLeadId = String(ml.id || '');
      if (!metaLeadId || seen.has(metaLeadId)) { skipped++; continue; }
      seen.add(metaLeadId);

      const map = flattenFieldData(ml.field_data);
      let fullName = pickKey(map, NAME_KEYS);
      if (!fullName && (map['first_name'] || map['last_name'])) {
        fullName = [map['first_name'], map['last_name']].filter(Boolean).join(' ').trim();
      }
      const phone = pickKey(map, PHONE_KEYS).replace(/\D/g, '').slice(-10);
      const email = pickKey(map, EMAIL_KEYS) || null;
      const createdAt = ml.created_time ? new Date(ml.created_time) : new Date();

      let leadId = null;
      try {
        const { rows } = await pool.query(
          `INSERT INTO leads
             (full_name, whatsapp_number, email, lead_score, webinar_id, source,
              field_data, meta_lead_id, meta_form_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [fullName || '', phone, email, 2, webinarId, source,
           JSON.stringify(map), metaLeadId, formId, createdAt]);
        leadId = rows[0]?.id || null;
      } catch (e) {
        console.error(`[metaLeadSync:${source}] insert ${metaLeadId} failed: ${e.message}`);
        continue;
      }
      if (!leadId) { skipped++; continue; }  // raced with the webhook — fine
      inserted++;

      // Assign immediately via the round-robin assigner. We call it DIRECTLY
      // rather than pg_notify('lead.created') because a notify only routes the
      // lead if a LISTEN client is connected at that instant — exactly the kind
      // of miss this reconciliation sweep exists to prevent. assignNewLead is
      // idempotent-safe (per-webinar FOR UPDATE lock + duplicate guard).
      if (webinarId) {
        try { await assignNewLead(leadId, null, webinarId); }
        catch (e) { console.error(`[metaLeadSync:${source}] assign ${leadId}:`, e.message); }
      }
    }
  }

  if (inserted) console.log(`[metaLeadSync:${source}] reconciled ${inserted} new lead(s) (${skipped} already present, ${formIds.length} form(s))`);
  return { source, inserted, skipped, forms: formIds.length };
}

module.exports = { syncMetaLeadsForSource };
