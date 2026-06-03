/**
 * NSM-Caller lead sync.
 *
 * Pulls leads from the Meta Lead Gen forms attached to each nsm_batches row
 * (filtered to the batch's start_at → end_at window) and upserts them into
 * nsm_leads, keyed by the Meta leadgen id so re-runs are idempotent.
 *
 * Runs two ways:
 *   • periodic interval (startScheduler) — gated behind DISABLE_SCHEDULERS in
 *     servers/crm.js so only prod-CRM owns it (dev shares the prod DB).
 *   • on demand via POST /api/admin/nsm/sync (the Leads page "Sync" button).
 */
const pool = require('../db');
const { fetchFormLeads } = require('./metaInsights');
const nsmTestForm = require('./nsmTestForm'); // TEMP: removable test form
const ivrScheduler = require('./nsmIvrCallScheduler'); // NSM-Caller IVR immediate calls

// Leads are NOT added to (nor invited to) the WhatsApp community. whapi only
// (1) creates the community on batch create and (2) sends the scheduled reminder
// messages to it (nsmWhatsappScheduler). Lead capture here is purely DB-side.

/* Pick the first field whose (lower-cased) name contains any of the needles. */
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

  let fetched = 0;
  let upserted = 0;

  for (const f of forms) {
    // Incremental: only pull leads newer than the latest already stored for
    // this batch+form (minus a 2-min re-check buffer so boundary leads aren't
    // missed; the upsert dedupes). First run for a form falls back to the
    // window start. This keeps the 30s cadence cheap — steady state fetches
    // only brand-new leads instead of re-pulling the whole window.
    let since = winStart;
    try {
      const { rows } = await pool.query(
        `SELECT EXTRACT(EPOCH FROM MAX(created_time))::bigint AS maxts
           FROM nsm_leads WHERE batch_id = $1 AND form_id = $2`,
        [batch.id, f.id]
      );
      const lastMax = rows[0] && rows[0].maxts != null ? Number(rows[0].maxts) : null;
      if (lastMax) since = Math.max(winStart || 0, lastMax - 120);
    } catch (e) { /* fall back to window start */ }

    let leads;
    if (f.id === nsmTestForm.TEST_FORM_ID) {            // TEMP: synthetic test leads
      leads = nsmTestForm.testFormLeads(batch);
    } else {
      ({ leads } = await fetchFormLeads(f.id, since, winEnd));
    }
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
          `INSERT INTO nsm_leads
             (meta_lead_id, batch_id, form_id, form_name, created_time, full_name, phone, email, city, field_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           ON CONFLICT (meta_lead_id) DO UPDATE SET
             batch_id     = EXCLUDED.batch_id,
             form_id      = EXCLUDED.form_id,
             form_name    = EXCLUDED.form_name,
             created_time = EXCLUDED.created_time,
             full_name    = EXCLUDED.full_name,
             phone        = EXCLUDED.phone,
             email        = EXCLUDED.email,
             city         = EXCLUDED.city,
             field_data   = EXCLUDED.field_data,
             synced_at    = NOW()
           WHERE nsm_leads.deleted_at IS NULL`,
          [raw.id, batch.id, f.id, f.name, raw.created_time || null, fullName, phone, email, city, JSON.stringify(fields)]
        );
        upserted++;
      } catch (e) {
        console.error('[nsmLeadsSync] upsert lead', raw.id, e.message);
      }
    }
  }

  let assigned = 0;
  try { assigned = await assignUnassigned(batch.id); }
  catch (e) { console.error('[nsmLeadsSync] assign', batch.id, e.message); }

  // Immediate (on-arrival) IVR reminder calls for this workspace's leads.
  // Internally gated by DISABLE_SCHEDULERS — local dev never dials.
  try { await ivrScheduler.fireImmediate(batch, ivrScheduler.CALLER_CTX); }
  catch (e) { console.error('[nsmCallerIvr] immediate', batch.id, e.message); }

  return { batch_id: batch.id, batch_name: batch.batch_name, fetched, upserted, assigned };
}

/* Round-robin any still-unassigned leads in a batch across the NSM callers
   enabled for that batch (nsm_lead_share_config). No config → leads stay
   unassigned. Persists the rotation pointer in nsm_round_robin_state so the
   distribution stays even across sync ticks and restarts. */
async function assignUnassigned(batchId) {
  const { rows: callers } = await pool.query(
    `SELECT caller_id FROM nsm_lead_share_config
      WHERE batch_id = $1 AND enabled = TRUE
      ORDER BY position ASC, created_at ASC`,
    [batchId]
  );
  if (callers.length === 0) return 0;
  const ids = callers.map(c => c.caller_id);

  const { rows: leads } = await pool.query(
    `SELECT id FROM nsm_leads
      WHERE batch_id = $1 AND assigned_user_id IS NULL AND deleted_at IS NULL
      ORDER BY created_time ASC NULLS LAST, id ASC`,
    [batchId]
  );
  if (leads.length === 0) return 0;

  const { rows: st } = await pool.query(
    `SELECT last_position FROM nsm_round_robin_state WHERE batch_id = $1`, [batchId]
  );
  let last = st[0] ? st[0].last_position : -1;
  let assigned = 0;
  for (const l of leads) {
    last = (last + 1) % ids.length;
    await pool.query(
      `UPDATE nsm_leads SET assigned_user_id = $1, assigned_at = NOW()
        WHERE id = $2 AND assigned_user_id IS NULL`,
      [ids[last], l.id]
    );
    assigned++;
  }
  await pool.query(
    `INSERT INTO nsm_round_robin_state (batch_id, last_position, updated_at)
          VALUES ($1, $2, NOW())
     ON CONFLICT (batch_id) DO UPDATE SET last_position = EXCLUDED.last_position, updated_at = NOW()`,
    [batchId, last]
  );
  return assigned;
}

async function syncAllBatches() {
  const { rows } = await pool.query(
    `SELECT id, batch_name, created_at, start_at, end_at, meta_forms,
            whatsapp_community_id, whatsapp_group_id, whatsapp_member_group_id, whatsapp_group_count
       FROM nsm_batches`
  );
  const results = [];
  for (const b of rows) {
    try { results.push(await syncBatch(b)); }
    catch (e) { console.error('[nsmLeadsSync] batch', b.id, e.message); }
  }
  return results;
}

let _timer = null;
let _running = false;
function startScheduler(intervalMs = 30 * 1000) {
  if (_timer) return;
  const tick = async () => {
    if (_running) return;            // skip if the previous run is still going
    _running = true;
    try {
      const results = await syncAllBatches();
      const up = results.reduce((s, r) => s + (r.upserted || 0), 0);
      if (up > 0) console.log(`[nsmLeadsSync] +${up} lead(s)`);
    } catch (e) {
      console.error('[nsmLeadsSync] tick error:', e.message);
    } finally {
      _running = false;
    }
  };
  tick();
  _timer = setInterval(tick, intervalMs);
  console.log(`[nsmLeadsSync] auto-sync every ${Math.round(intervalMs / 1000)}s`);
}

module.exports = { syncBatch, syncAllBatches, assignUnassigned, startScheduler };
