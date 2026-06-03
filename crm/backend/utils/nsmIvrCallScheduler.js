/**
 * Dynamic Cloudshope IVR reminder scheduler — runs for BOTH NSM workspaces:
 *   • NSM-IVR     (IVR_CTX)    — nsm_ivr_call_config / nsm_ivr_leads / nsm_ivr_batches / nsm_ivr_lead_calls
 *   • NSM-Caller  (CALLER_CTX) — nsm_call_config     / nsm_leads     / nsm_batches     / nsm_lead_ivr_calls
 *
 * Campaigns are admin-defined per workspace on that workspace's IVR page. This
 * scheduler fires every enabled NON-immediate campaign; 'immediate' campaigns
 * fire on lead arrival via fireImmediate() (called from each workspace's lead
 * sync). Trigger types: days_before_at {days_before,time}, on_day_at {time},
 * offset_minutes {offset_minutes}. Once-per-(lead,campaign) is enforced by the
 * claims table (UNIQUE + INSERT ON CONFLICT DO NOTHING); ivr_attempts is a
 * global per-lead safety cap. Cloudshope auto-retries unconnected calls via
 * retry_did. Firing is gated behind DISABLE_SCHEDULERS so only prod dials.
 *
 * ctx tables are fixed constants (never user input) → safe to interpolate.
 */
const pool = require('../db');
const cloudshope = require('./cloudshopeClient');
const { loadIvrConfig } = require('./nsmIvrCallConfig');

const PER_TICK     = 50;
const IST_OFFSET   = 5.5 * 3600 * 1000;
const WINDOW_HOURS = 6; // offset_minutes: don't fire if the due-time passed > 6h ago

const IVR_CTX = {
  label: 'nsmIvrCall',
  configTable: 'nsm_ivr_call_config',
  leads: 'nsm_ivr_leads', batches: 'nsm_ivr_batches', claims: 'nsm_ivr_lead_calls',
  allowLocalDial: true, // NSM-IVR may be dialed from a local box for testing (see dialingAllowed)
};
const CALLER_CTX = {
  label: 'nsmCallerIvr',
  configTable: 'nsm_call_config',
  leads: 'nsm_leads', batches: 'nsm_batches', claims: 'nsm_lead_ivr_calls',
};

/* Real paid calls fire when the global scheduler gate is open (prod), OR — for
   NSM-IVR ONLY — when NSM_IVR_LOCAL_DIAL=true lets a local dev box dial for
   end-to-end testing. NSM-Caller (CALLER_CTX) is never un-gated this way, so the
   local override can't accidentally call the caller workspace's leads. */
function dialingAllowed(ctx) {
  if (process.env.DISABLE_SCHEDULERS !== 'true') return true;
  return Boolean(ctx && ctx.allowLocalDial) && process.env.NSM_IVR_LOCAL_DIAL === 'true';
}

function istDateStr(d) {
  return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join('-');
}
function timeToMins(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/* Build the eligible-leads query for one campaign. Returns {sql, params} or
   null if the campaign isn't due right now.
   NOTE: there is NO global attempts cap here — each trigger is independent and
   fires for EVERY lead in the matching (running) batch. "Fire once per trigger"
   is enforced per-campaign by the nsm_ivr_lead_calls claim (UNIQUE lead+campaign),
   so one trigger never blocks another. */
function buildQuery(campaign, nowIST, ctx) {
  const minsNow = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
  const base = (timingSql, timingParams) => {
    const params = [campaign.id, ...timingParams, PER_TICK];
    const limitIdx = params.length;
    return {
      sql: `SELECT l.id, l.phone, l.full_name, b.batch_name
              FROM ${ctx.leads} l
              JOIN ${ctx.batches} b ON b.id = l.batch_id
             WHERE l.deleted_at IS NULL
               AND l.opted_out = FALSE
               AND l.phone IS NOT NULL AND l.phone <> ''
               AND b.webinar_at IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM ${ctx.claims} lc
                                WHERE lc.lead_id = l.id AND lc.campaign_id = $1)
               AND ${timingSql}
             ORDER BY l.created_time ASC NULLS LAST
             LIMIT $${limitIdx}`,
      params,
    };
  };

  if (campaign.trigger_type === 'days_before_at') {
    if (minsNow < timeToMins(campaign.time)) return null;
    const target = istDateStr(new Date(nowIST.getTime() + (campaign.days_before || 0) * 86400000));
    return base(`(b.webinar_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`, [target]);
  }
  if (campaign.trigger_type === 'on_day_at') {
    if (minsNow < timeToMins(campaign.time)) return null;
    return base(`(b.webinar_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`, [istDateStr(nowIST)]);
  }
  if (campaign.trigger_type === 'offset_minutes') {
    const off = Number(campaign.offset_minutes) || 0;
    return base(
      `NOW() >= b.webinar_at + ($2 * INTERVAL '1 minute')
       AND NOW() <= b.webinar_at + ($2 * INTERVAL '1 minute') + ($3 * INTERVAL '1 hour')`,
      [off, WINDOW_HOURS]
    );
  }
  return null; // 'immediate' handled by fireImmediate()
}

/* Dial one lead for a campaign: atomic claim → triggerCall → record status. */
async function dialLead(lead, campaign, ctx) {
  const claim = await pool.query(
    `INSERT INTO ${ctx.claims} (lead_id, campaign_id, status)
     VALUES ($1, $2, 'pending') ON CONFLICT (lead_id, campaign_id) DO NOTHING RETURNING id`,
    [lead.id, campaign.id]
  );
  if (claim.rowCount === 0) return false; // another tick/instance got it
  const claimId = claim.rows[0].id;
  let status = 'failed', resp = null;
  try {
    resp = await cloudshope.triggerCall({ phone: lead.phone, voiceFileId: campaign.voice_id, campaignName: lead.full_name || campaign.name });
    status = 'called';
  } catch (e) {
    resp = { error: e.message };
    console.error(`[${ctx.label}] ${campaign.id} failed`, lead.id, e.message);
  }
  await pool.query(`UPDATE ${ctx.claims} SET status = $2, response = $3::jsonb WHERE id = $1`, [claimId, status, JSON.stringify(resp)]);
  await pool.query(`UPDATE ${ctx.leads} SET ivr_attempts = ivr_attempts + 1, ivr_status = $2, last_ivr_at = NOW() WHERE id = $1`, [lead.id, status]);
  return status === 'called';
}

async function fireCampaign(campaign, nowIST, ctx) {
  if (!campaign.enabled || !campaign.voice_id) return 0;
  const q = buildQuery(campaign, nowIST, ctx);
  if (!q) return 0;
  const { rows } = await pool.query(q.sql, q.params);
  let fired = 0;
  for (const lead of rows) if (await dialLead(lead, campaign, ctx)) fired++;
  if (fired > 0) console.log(`[${ctx.label}] ${campaign.name} (${campaign.id}) fired ${fired} call(s)`);
  return fired;
}

/* Fire every enabled 'immediate' campaign for a batch's freshly-arrived leads.
   Called from each workspace's lead sync on every tick. Gated + idempotent. */
async function fireImmediate(batch, ctx) {
  if (!dialingAllowed(ctx)) return 0;
  if (!cloudshope.isConfigured()) return 0;
  const cfg = await loadIvrConfig(ctx.configTable);
  const immediates = cfg.campaigns.filter(c => c.trigger_type === 'immediate' && c.enabled && c.voice_id);
  if (immediates.length === 0) return 0;
  let fired = 0;
  for (const campaign of immediates) {
    const { rows } = await pool.query(
      `SELECT id, phone, full_name FROM ${ctx.leads} l
        WHERE batch_id = $1 AND deleted_at IS NULL AND opted_out = FALSE
          AND phone IS NOT NULL AND phone <> ''
          AND NOT EXISTS (SELECT 1 FROM ${ctx.claims} lc WHERE lc.lead_id = l.id AND lc.campaign_id = $2)
        ORDER BY created_time ASC NULLS LAST LIMIT $3`,
      [batch.id, campaign.id, 30]
    );
    for (const lead of rows) if (await dialLead({ ...lead, name: campaign.name }, campaign, ctx)) fired++;
  }
  if (fired > 0) console.log(`[${ctx.label}] immediate fired ${fired} call(s) for ${batch.batch_name}`);
  return fired;
}

/* One scheduler instance per workspace (independent timer). */
function makeScheduler(ctx) {
  let _timer = null, _running = false;
  async function tick() {
    if (!dialingAllowed(ctx)) return;
    if (!cloudshope.isConfigured()) return;
    const cfg = await loadIvrConfig(ctx.configTable);
    const nowIST = new Date(Date.now() + IST_OFFSET);
    for (const campaign of cfg.campaigns) {
      if (campaign.trigger_type === 'immediate') continue; // fired on arrival
      try { await fireCampaign(campaign, nowIST, ctx); }
      catch (e) { console.error(`[${ctx.label}] ${campaign.id} tick`, e.message); }
    }
  }
  function startScheduler(intervalMs = 30 * 1000) {
    if (_timer) return;
    const run = async () => {
      if (_running) return;
      _running = true;
      try { await tick(); } catch (e) { console.error(`[${ctx.label}] tick error:`, e.message); }
      finally { _running = false; }
    };
    run();
    _timer = setInterval(run, intervalMs);
    console.log(`[${ctx.label}] dynamic reminder scheduler every ${Math.round(intervalMs / 1000)}s`);
  }
  return { tick, startScheduler };
}

const _ivr    = makeScheduler(IVR_CTX);
const _caller = makeScheduler(CALLER_CTX);

module.exports = {
  IVR_CTX, CALLER_CTX, makeScheduler, fireImmediate, fireCampaign,
  // NSM-IVR default instance (backward-compatible with existing call site).
  tick: _ivr.tick,
  startScheduler: (ms) => _ivr.startScheduler(ms),
  // NSM-Caller instance.
  startCallerScheduler: (ms) => _caller.startScheduler(ms),
};
