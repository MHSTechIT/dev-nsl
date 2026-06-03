/**
 * NSM-IVR lead sync — independent clone of nsmLeadsSync for the nsm_ivr_* tables.
 * No caller assignment (NSM-IVR has no users). Pulls Meta lead-gen leads per
 * batch into nsm_ivr_leads.
 *
 * Note: leads are NOT added to (nor invited to) the WhatsApp community. whapi's
 * only roles are (1) creating the community on batch create and (2) sending the
 * scheduled reminder messages to it (see nsmIvrWhatsappScheduler). Lead capture
 * here is purely DB-side.
 */
const pool = require('../db');
const { fetchFormLeads } = require('./metaInsights');
const nsmTestForm = require('./nsmTestForm'); // shared, removable test form
const cloudshope = require('./cloudshopeClient');
const { loadIvrConfig } = require('./nsmIvrCallConfig');

const PER_TICK = 30;

/* Fire every enabled 'immediate' campaign for freshly-arrived leads (the
   on-arrival Cloudshope reminders). Campaigns are admin-defined in the IVR
   page. Each lead is dialled at most once per campaign (nsm_ivr_lead_calls
   claim) and ivr_attempts is a global safety cap. A failed call (e.g. no voice
   credit yet) stays claimed so we don't re-dial every 30s tick. Cloudshope
   auto-retries unconnected calls via retry_did — no app retry loop. */
async function fireImmediateCalls(batch) {
  // Real paid calls: only the prod instance dials (local dev runs with
  // DISABLE_SCHEDULERS=true). Per-campaign claim still guarantees exactly-once.
  // Local exception: NSM_IVR_LOCAL_DIAL=true lets a dev box place NSM-IVR
  // immediate calls for end-to-end testing (NSM-IVR only).
  if (process.env.DISABLE_SCHEDULERS === 'true' && process.env.NSM_IVR_LOCAL_DIAL !== 'true') return 0;
  if (!cloudshope.isConfigured()) return 0;

  const cfg = await loadIvrConfig();
  const immediates = cfg.campaigns.filter(c => c.trigger_type === 'immediate' && c.enabled && c.voice_id);
  if (immediates.length === 0) return 0;

  let fired = 0;
  for (const campaign of immediates) {
    const { rows } = await pool.query(
      `SELECT id, phone, full_name FROM nsm_ivr_leads l
        WHERE batch_id = $1 AND deleted_at IS NULL
          AND opted_out = FALSE AND ivr_attempts < $2
          AND phone IS NOT NULL AND phone <> ''
          AND NOT EXISTS (SELECT 1 FROM nsm_ivr_lead_calls lc
                           WHERE lc.lead_id = l.id AND lc.campaign_id = $3)
        ORDER BY created_time ASC NULLS LAST
        LIMIT $4`,
      [batch.id, cfg.max_attempts, campaign.id, PER_TICK]
    );
    for (const lead of rows) {
      const claim = await pool.query(
        `INSERT INTO nsm_ivr_lead_calls (lead_id, campaign_id, status)
         VALUES ($1, $2, 'pending') ON CONFLICT (lead_id, campaign_id) DO NOTHING RETURNING id`,
        [lead.id, campaign.id]
      );
      if (claim.rowCount === 0) continue;
      const claimId = claim.rows[0].id;
      let status = 'failed', resp = null;
      try {
        resp = await cloudshope.triggerCall({ phone: lead.phone, voiceFileId: campaign.voice_id, campaignName: lead.full_name || batch.batch_name });
        status = 'called';
        fired++;
      } catch (e) {
        resp = { error: e.message };
        console.error('[nsmIvrCall] immediate failed', lead.id, e.message);
      }
      await pool.query(`UPDATE nsm_ivr_lead_calls SET status = $2, response = $3::jsonb WHERE id = $1`,
        [claimId, status, JSON.stringify(resp)]);
      await pool.query(
        `UPDATE nsm_ivr_leads SET ivr_attempts = ivr_attempts + 1, ivr_status = $2, last_ivr_at = NOW() WHERE id = $1`,
        [lead.id, status]);
    }
  }
  if (fired > 0) console.log(`[nsmIvrCall] immediate fired ${fired} call(s) for ${batch.batch_name}`);
  return fired;
}

function pickField(fields, ...needles) {
  const keys = Object.keys(fields);
  for (const n of needles) {
    const k = keys.find(key => key.toLowerCase().includes(n));
    if (k && fields[k]) return fields[k];
  }
  return null;
}

async function syncBatch(batch) {
  const forms = Array.isArray(batch.meta_forms) ? batch.meta_forms : [];
  if (forms.length === 0) return { batch_id: batch.id, fetched: 0, upserted: 0 };

  const winStart = batch.start_at ? Math.floor(new Date(batch.start_at).getTime() / 1000) : null;
  const winEnd   = batch.end_at   ? Math.floor(new Date(batch.end_at).getTime() / 1000)   : null;

  let fetched = 0, upserted = 0;
  for (const f of forms) {
    let since = winStart;
    try {
      const { rows } = await pool.query(
        `SELECT EXTRACT(EPOCH FROM MAX(created_time))::bigint AS maxts FROM nsm_ivr_leads WHERE batch_id = $1 AND form_id = $2`,
        [batch.id, f.id]
      );
      const lastMax = rows[0] && rows[0].maxts != null ? Number(rows[0].maxts) : null;
      if (lastMax) since = Math.max(winStart || 0, lastMax - 120);
    } catch (e) { /* fall back */ }

    let leads;
    if (f.id === nsmTestForm.TEST_FORM_ID) leads = nsmTestForm.testFormLeads(batch);
    else ({ leads } = await fetchFormLeads(f.id, since, winEnd));
    fetched += leads.length;

    for (const raw of leads) {
      const fields = {};
      for (const fd of (raw.field_data || [])) fields[fd.name] = (fd.values || []).join(', ');
      const fullName = pickField(fields, 'full name', 'full_name', 'name');
      const phone    = pickField(fields, 'phone', 'mobile', 'whatsapp', 'number');
      const email    = pickField(fields, 'email');
      const city     = pickField(fields, 'city', 'town', 'location');
      try {
        await pool.query(
          `INSERT INTO nsm_ivr_leads
             (meta_lead_id, batch_id, form_id, form_name, created_time, full_name, phone, email, city, field_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           ON CONFLICT (meta_lead_id) DO UPDATE SET
             batch_id=EXCLUDED.batch_id, form_id=EXCLUDED.form_id, form_name=EXCLUDED.form_name,
             created_time=EXCLUDED.created_time, full_name=EXCLUDED.full_name, phone=EXCLUDED.phone,
             email=EXCLUDED.email, city=EXCLUDED.city, field_data=EXCLUDED.field_data, synced_at=NOW()
           WHERE nsm_ivr_leads.deleted_at IS NULL`,
          [raw.id, batch.id, f.id, f.name, raw.created_time || null, fullName, phone, email, city, JSON.stringify(fields)]
        );
        upserted++;
      } catch (e) { console.error('[nsmIvrSync] upsert lead', raw.id, e.message); }
    }
  }

  let ivrFired = 0;
  try { ivrFired = await fireImmediateCalls(batch); }
  catch (e) { console.error('[nsmIvrCall] immediate', batch.id, e.message); }

  return { batch_id: batch.id, batch_name: batch.batch_name, fetched, upserted, ivrFired };
}

async function syncAllBatches() {
  const { rows } = await pool.query(
    `SELECT id, batch_name, created_at, start_at, end_at, meta_forms,
            whatsapp_community_id, whatsapp_group_id, whatsapp_member_group_id, whatsapp_group_count
       FROM nsm_ivr_batches`
  );
  const results = [];
  for (const b of rows) {
    try { results.push(await syncBatch(b)); }
    catch (e) { console.error('[nsmIvrSync] batch', b.id, e.message); }
  }
  return results;
}

let _timer = null, _running = false;
function startScheduler(intervalMs = 30 * 1000) {
  if (_timer) return;
  const tick = async () => {
    if (_running) return;
    _running = true;
    try {
      const results = await syncAllBatches();
      const up = results.reduce((s, r) => s + (r.upserted || 0), 0);
      if (up > 0) console.log(`[nsmIvrSync] +${up} lead(s)`);
    } catch (e) { console.error('[nsmIvrSync] tick error:', e.message); }
    finally { _running = false; }
  };
  tick();
  _timer = setInterval(tick, intervalMs);
  console.log(`[nsmIvrSync] auto-sync every ${Math.round(intervalMs / 1000)}s`);
}

module.exports = { syncBatch, syncAllBatches, startScheduler };
