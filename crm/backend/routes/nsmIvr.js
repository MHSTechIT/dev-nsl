/**
 * NSM-IVR Marketing API — independent clone of the NSM-Caller marketing
 * endpoints on the nsm_ivr_* tables. Mounted at /api/admin/nsm-ivr. No callers
 * / assignment. Reuses the table-agnostic helpers (whapiClient, settings
 * defaults, test form, Meta form fetch). Bearer-admin auth.
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();
const pool = require('../db');
const { adminAuth } = require('../middleware/adminAuth');
const whapi = require('../utils/whapiClient');
const { mergeNsmSettings } = require('../utils/nsmSettingsDefaults');
const nsmTestForm = require('../utils/nsmTestForm');
const { fetchAllLeadgenForms } = require('../utils/metaInsights');
const nsmIvrSync = require('../utils/nsmIvrLeadsSync');
const nsmIvrWa = require('../utils/nsmIvrWhatsappScheduler');
const { mergeIvrConfig, loadIvrConfig } = require('../utils/nsmIvrCallConfig');
const { loadTeleConfig, saveTeleConfig, sendTeleMessage } = require('../utils/teleConfig');

router.use(adminAuth);

async function loadSettings() {
  try {
    const { rows } = await pool.query('SELECT settings FROM nsm_ivr_settings WHERE id = 1');
    return mergeNsmSettings(rows[0] && rows[0].settings);
  } catch (e) { return mergeNsmSettings(null); }
}

/* Best-effort WhatsApp community creation for a batch (never throws). */
async function createBatchGroup(batch) {
  if (!whapi.isConfigured()) return;
  const settings = await loadSettings();
  if (!settings.whatsapp.enabled) return;
  try {
    const { communityId, groupId, invite } = await whapi.createCommunity({ subject: batch.batch_name });
    if (!groupId) throw new Error('community created but no announce group returned');
    await pool.query(
      `UPDATE nsm_ivr_batches SET whatsapp_community_id=$1, whatsapp_group_id=$2, whatsapp_group_invite=$3, whatsapp_group_error=NULL WHERE id=$4`,
      [communityId, groupId, invite, batch.id]
    );
    Object.assign(batch, { whatsapp_community_id: communityId, whatsapp_group_id: groupId, whatsapp_group_invite: invite, whatsapp_group_error: null });
  } catch (err) {
    console.error('[nsm-ivr] createBatchGroup failed:', err.message);
    await pool.query('UPDATE nsm_ivr_batches SET whatsapp_group_error=$1 WHERE id=$2', [err.message.slice(0, 300), batch.id]).catch(() => {});
    batch.whatsapp_group_error = err.message;
  }
}

router.get('/lead-forms', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const forms = await fetchAllLeadgenForms(force);
    res.json({ forms: [nsmTestForm.testFormDescriptor(), ...forms] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Meta forms', forms: [] });
  }
});

router.get('/batches', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.batch_name, b.start_at, b.end_at, b.webinar_at, b.webinar_link, b.webinar_meeting_id,
              b.whatsapp_community_id, b.whatsapp_group_id, b.whatsapp_group_invite, b.whatsapp_group_count, b.whatsapp_group_error,
              b.meta_forms, b.created_at,
              COALESCE((SELECT COUNT(*) FROM nsm_ivr_leads l WHERE l.batch_id = b.id AND l.deleted_at IS NULL), 0)::int AS leads_number
         FROM nsm_ivr_batches b ORDER BY b.created_at DESC`
    );
    res.json({ batches: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load batches' });
  }
});

router.post('/sync', async (_req, res) => {
  try {
    const results = await nsmIvrSync.syncAllBatches();
    const upserted = results.reduce((s, r) => s + (r.upserted || 0), 0);
    res.json({ ok: true, upserted, results });
  } catch (err) {
    res.status(500).json({ error: 'Sync failed' });
  }
});

router.get('/leads', async (req, res) => {
  const batchId = req.query.batch_id || null;
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.meta_lead_id, l.batch_id, b.batch_name, l.form_name,
              l.created_time, l.full_name, l.phone, l.email, l.city, l.field_data
         FROM nsm_ivr_leads l
         LEFT JOIN nsm_ivr_batches b ON b.id = l.batch_id
        WHERE l.deleted_at IS NULL AND ($1::uuid IS NULL OR l.batch_id = $1::uuid)
        ORDER BY l.created_time DESC NULLS LAST
        LIMIT 5000`,
      [batchId]
    );
    const order = [], seen = new Set();
    for (const r of rows) for (const k of Object.keys(r.field_data || {})) if (!seen.has(k)) { seen.add(k); order.push(k); }
    const rank = (k) => {
      const l = k.toLowerCase();
      if (l.includes('name')) return 0;
      if (l.includes('phone') || l.includes('mobile') || l.includes('whatsapp') || l.includes('number')) return 1;
      if (l.includes('email')) return 2;
      if (l.includes('city') || l.includes('town') || l.includes('location')) return 3;
      return 4;
    };
    const columns = order.sort((a, b) => rank(a) - rank(b))
      .map(key => ({ key, label: key.replace(/_/g, ' ').replace(/\?\s*$/, '').replace(/\s+/g, ' ').trim() }));

    // Per-campaign IVR call status → one column per configured campaign.
    // Each lead gets ivr_calls = { campaign_id: 'called'|'failed'|'pending' };
    // a missing entry means "not triggered yet".
    const cfg = await loadIvrConfig();
    const campaigns = cfg.campaigns.map(c => ({ id: c.id, name: c.name }));
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const { rows: callRows } = await pool.query(
        `SELECT lead_id, campaign_id, status FROM nsm_ivr_lead_calls WHERE lead_id = ANY($1::uuid[])`,
        [ids]
      );
      const byLead = new Map();
      for (const cr of callRows) {
        if (!byLead.has(cr.lead_id)) byLead.set(cr.lead_id, {});
        byLead.get(cr.lead_id)[cr.campaign_id] = cr.status;
      }
      for (const r of rows) r.ivr_calls = byLead.get(r.id) || {};
    }

    res.json({ leads: rows, columns, campaigns, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

router.post('/leads/delete', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean).map(String) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'No lead ids provided' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE nsm_ivr_leads SET deleted_at = NOW() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete leads' });
  }
});

router.post('/batches',
  body('batch_name').trim().isLength({ min: 1 }).withMessage('Batch name is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { batch_name, start_at, end_at, webinar_at, webinar_link, webinar_meeting_id } = req.body;
    const rawForms = Array.isArray(req.body.meta_forms) ? req.body.meta_forms : [];
    const metaForms = rawForms.filter(f => f && f.id != null).map(f => ({ id: String(f.id), name: String(f.name ?? f.id) }));
    // Lead-collection window: from the batch start time (admin-set; defaults to
    // creation time) up to the webinar (end = webinar_at).
    const startAt = start_at || new Date().toISOString();
    const endAt = webinar_at || null;
    try {
      // Only one webinar may run at a time: reject an overlapping [start, webinar] window.
      if (webinar_at) {
        const { rows: clash } = await pool.query(
          `SELECT batch_name, webinar_at FROM nsm_ivr_batches
            WHERE start_at IS NOT NULL AND webinar_at IS NOT NULL
              AND start_at < $1::timestamptz AND $2::timestamptz < webinar_at
            ORDER BY webinar_at LIMIT 1`,
          [webinar_at, startAt]
        );
        if (clash.length) {
          const w = new Date(clash[0].webinar_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
          return res.status(409).json({ error: `Only one webinar can run at a time. "${clash[0].batch_name}" runs until its webinar (${w}). Set this batch's start time after that.` });
        }
      }
      const { rows } = await pool.query(
        `INSERT INTO nsm_ivr_batches (batch_name, start_at, end_at, webinar_at, webinar_link, webinar_meeting_id, meta_forms)
              VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
           RETURNING id, batch_name, start_at, end_at, webinar_at, webinar_link, webinar_meeting_id, meta_forms, created_at`,
        [batch_name.trim(), startAt, endAt, webinar_at || null,
         (typeof webinar_link === 'string' && webinar_link.trim()) ? webinar_link.trim() : null,
         (typeof webinar_meeting_id === 'string' && webinar_meeting_id.trim()) ? webinar_meeting_id.trim() : null,
         JSON.stringify(metaForms)]
      );
      const batch = { ...rows[0], leads_number: 0 };
      await createBatchGroup(batch);
      res.status(201).json({ batch });
    } catch (err) {
      console.error('[nsm-ivr] POST /batches error:', err.message);
      res.status(500).json({ error: 'Failed to create batch' });
    }
  }
);

/* Edit a batch's details (does NOT recreate the WhatsApp group). */
router.patch('/batches/:id',
  body('batch_name').trim().isLength({ min: 1 }).withMessage('Batch name is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { batch_name, start_at, end_at, webinar_at, webinar_link, webinar_meeting_id } = req.body;
    const rawForms = Array.isArray(req.body.meta_forms) ? req.body.meta_forms : [];
    const metaForms = rawForms.filter(f => f && f.id != null).map(f => ({ id: String(f.id), name: String(f.name ?? f.id) }));
    try {
      // One-webinar-at-a-time: reject if the (effective) window overlaps another batch.
      if (webinar_at) {
        let effStart = start_at;
        if (!effStart) { const cur = await pool.query('SELECT start_at FROM nsm_ivr_batches WHERE id = $1', [req.params.id]); effStart = cur.rows[0]?.start_at; }
        if (effStart) {
          const { rows: clash } = await pool.query(
            `SELECT batch_name, webinar_at FROM nsm_ivr_batches
              WHERE id <> $3 AND start_at IS NOT NULL AND webinar_at IS NOT NULL
                AND start_at < $1::timestamptz AND $2::timestamptz < webinar_at
              ORDER BY webinar_at LIMIT 1`,
            [webinar_at, effStart, req.params.id]
          );
          if (clash.length) {
            const w = new Date(clash[0].webinar_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
            return res.status(409).json({ error: `Only one webinar can run at a time. "${clash[0].batch_name}" runs until its webinar (${w}). Set this batch's start time after that.` });
          }
        }
      }
      // start_at = admin-set batch start (COALESCE keeps existing if omitted);
      // end follows the webinar.
      const { rows } = await pool.query(
        `UPDATE nsm_ivr_batches
            SET batch_name = $2, start_at = COALESCE($3::timestamptz, start_at),
                end_at = $4, webinar_at = $5,
                webinar_link = $6, webinar_meeting_id = $7, meta_forms = $8::jsonb
          WHERE id = $1
          RETURNING id, batch_name, start_at, end_at, webinar_at, webinar_link, webinar_meeting_id, meta_forms, created_at`,
        [req.params.id, batch_name.trim(), start_at || null, webinar_at || null, webinar_at || null,
         (typeof webinar_link === 'string' && webinar_link.trim()) ? webinar_link.trim() : null,
         (typeof webinar_meeting_id === 'string' && webinar_meeting_id.trim()) ? webinar_meeting_id.trim() : null,
         JSON.stringify(metaForms)]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
      res.json({ batch: rows[0] });
    } catch (err) {
      console.error('[nsm-ivr] PATCH /batches error:', err.message);
      res.status(500).json({ error: 'Failed to update batch' });
    }
  }
);

router.delete('/batches/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT whatsapp_community_id, whatsapp_group_id FROM nsm_ivr_batches WHERE id = $1', [req.params.id]);
    const cid = rows[0] && rows[0].whatsapp_community_id;
    const gid = rows[0] && rows[0].whatsapp_group_id;
    await pool.query('DELETE FROM nsm_ivr_batches WHERE id = $1', [req.params.id]);
    if (whapi.isConfigured()) {
      if (cid) whapi.deleteCommunity(cid).catch(() => {});
      else if (gid) whapi.leaveGroup(gid).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete batch' });
  }
});

router.post('/batches/:id/whatsapp/retry', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, batch_name FROM nsm_ivr_batches WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Batch not found' });
    const batch = rows[0];
    await createBatchGroup(batch);
    res.json({ ok: !!batch.whatsapp_group_id, whatsapp_group_id: batch.whatsapp_group_id || null, error: batch.whatsapp_group_error || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/batches/:id/whatsapp/test', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, batch_name, webinar_at, webinar_link, webinar_meeting_id, whatsapp_group_id FROM nsm_ivr_batches WHERE id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Batch not found' });
    if (!rows[0].whatsapp_group_id) return res.status(400).json({ error: 'No WhatsApp community for this batch' });
    const settings = await loadSettings();
    const tpl = (settings.whatsapp.templates || []).find(t => t.key === (req.body && req.body.template_key));
    if (!tpl) return res.status(400).json({ error: 'template_key not found' });
    const resp = await nsmIvrWa.sendTemplate(rows[0], tpl);
    res.json({ ok: true, resp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings', async (_req, res) => {
  try { res.json({ settings: await loadSettings() }); }
  catch (err) { res.status(500).json({ error: 'Failed to load settings' }); }
});

router.put('/settings', async (req, res) => {
  const incoming = req.body && req.body.settings;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'settings object required' });
  const merged = mergeNsmSettings(incoming);
  try {
    await pool.query(
      `INSERT INTO nsm_ivr_settings (id, settings, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
    res.json({ settings: merged });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

router.get('/whatsapp/status', async (_req, res) => {
  if (!whapi.isConfigured()) return res.json({ configured: false });
  try {
    const h = await whapi.health();
    res.json({ configured: true, connected: (h.status && h.status.text) === 'AUTH', account: h.user ? { name: h.user.name, id: h.user.id } : null });
  } catch (err) {
    res.json({ configured: true, connected: false, error: err.message });
  }
});

/* ── IVR (CloudShope voice-call) config ──
   Three triggers, each with a voice id + enabled flag (+ offset for the
   timed ones). Stored in nsm_ivr_call_config (defaults + merge live in
   utils/nsmIvrCallConfig.js, shared with the trigger logic). The actual
   call-firing runs in nsmIvrLeadsSync (immediate) + nsmIvrCallScheduler
   (before/after) via utils/cloudshopeClient.js. */
router.get('/ivr-config', async (_req, res) => {
  try {
    res.json({ config: await loadIvrConfig() });
  } catch (err) { res.status(500).json({ error: 'Failed to load IVR config' }); }
});

router.put('/ivr-config', async (req, res) => {
  const incoming = req.body && req.body.config;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'config object required' });
  const merged = mergeIvrConfig(incoming);
  try {
    await pool.query(
      `INSERT INTO nsm_ivr_call_config (id, config, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
    res.json({ config: merged });
  } catch (err) { res.status(500).json({ error: 'Failed to save IVR config' }); }
});

/* ── Telegram alert config (NSM-IVR). { enabled, bot_token, chat_id } ── */
router.get('/tele-config', async (_req, res) => {
  try { res.json({ config: await loadTeleConfig('nsm_ivr_tele_config') }); }
  catch (e) { res.status(500).json({ error: 'Failed to load Telegram config' }); }
});
router.put('/tele-config', async (req, res) => {
  const inc = req.body && req.body.config;
  if (!inc || typeof inc !== 'object') return res.status(400).json({ error: 'config object required' });
  try { res.json({ config: await saveTeleConfig('nsm_ivr_tele_config', inc) }); }
  catch (e) { res.status(500).json({ error: 'Failed to save Telegram config' }); }
});
router.post('/tele-config/test', async (_req, res) => {
  try {
    const cfg = await loadTeleConfig('nsm_ivr_tele_config');
    await sendTeleMessage({ bot_token: cfg.bot_token, chat_id: cfg.chat_id });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
