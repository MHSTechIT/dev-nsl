/**
 * NSM-IVR call config — DYNAMIC campaigns. Admins add/remove their own
 * Cloudshope reminder campaigns on the IVR page; this module is the shared
 * schema + loader (used by routes GET/PUT and by the sync + scheduler).
 * Single JSONB row in nsm_ivr_call_config.
 *
 * Shape:
 *   {
 *     max_attempts: 10,
 *     campaigns: [
 *       { id, name, trigger_type, voice_id, enabled, time?, days_before?, offset_minutes? }
 *     ]
 *   }
 *
 * trigger_type:
 *   'immediate'       — fire on lead arrival (no time). Fired by nsmIvrLeadsSync.
 *   'days_before_at'  — { days_before, time }  fire `days_before` days before the
 *                       webinar day, at HH:MM IST.  (day-before 7PM = days_before:1, time:'19:00')
 *   'on_day_at'       — { time }               fire on the webinar day at HH:MM IST.
 *   'offset_minutes'  — { offset_minutes }     fire webinar_at + N minutes (negative = before).
 */
const pool = require('../db');

const TRIGGER_TYPES = new Set(['immediate', 'days_before_at', 'on_day_at', 'offset_minutes']);

/* Defaults = the three campaigns the workspace shipped with, so an
   un-configured (or first-load) install behaves exactly as before. */
const DEFAULT_CAMPAIGNS = [
  { id: 'immediate',  name: 'On lead arrival', trigger_type: 'immediate',      voice_id: '103184', enabled: true },
  { id: 'before_day', name: 'Day before',      trigger_type: 'days_before_at', days_before: 1, time: '19:00', voice_id: '103182', enabled: true },
  { id: 'live_day',   name: 'Webinar day',     trigger_type: 'on_day_at',      time: '13:30',  voice_id: '103183', enabled: true },
];
const IVR_DEFAULTS = { max_attempts: 10, campaigns: DEFAULT_CAMPAIGNS };

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* "HH:MM" 24h, else fallback. */
function normTime(v, dflt = '19:00') {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return dflt;
  const h = clampInt(m[1], 0, 23, 0);
  const mm = clampInt(m[2], 0, 59, 0);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function newId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normCampaign(c) {
  c = c && typeof c === 'object' ? c : {};
  const trigger_type = TRIGGER_TYPES.has(c.trigger_type) ? c.trigger_type : 'on_day_at';
  const out = {
    id:           c.id ? String(c.id) : newId(),
    name:         (c.name != null ? String(c.name) : '').trim().slice(0, 60) || 'Reminder',
    trigger_type,
    voice_id:     c.voice_id != null ? String(c.voice_id).trim() : '',
    enabled:      c.enabled != null ? !!c.enabled : false,
  };
  if (trigger_type === 'days_before_at') {
    out.days_before = clampInt(c.days_before, 0, 30, 1);
    out.time = normTime(c.time, '19:00');
  } else if (trigger_type === 'on_day_at') {
    out.time = normTime(c.time, '13:30');
  } else if (trigger_type === 'offset_minutes') {
    out.offset_minutes = clampInt(c.offset_minutes, -1440, 1440, -30);
  }
  // 'immediate' carries no timing fields.
  return out;
}

function mergeIvrConfig(stored) {
  stored = stored && typeof stored === 'object' ? stored : {};
  // Back-compat: an old { immediate, before, after } object → map to campaigns.
  let rawCampaigns = stored.campaigns;
  if (!Array.isArray(rawCampaigns)) {
    if (stored.immediate || stored.before || stored.after) {
      rawCampaigns = [
        { id: 'immediate',  name: 'On lead arrival', trigger_type: 'immediate',     voice_id: stored.immediate?.voice_id, enabled: stored.immediate?.enabled },
        { id: 'before_day', name: 'Before webinar',  trigger_type: 'offset_minutes', offset_minutes: -(Number(stored.before?.offset_minutes) || 60), voice_id: stored.before?.voice_id, enabled: stored.before?.enabled },
        { id: 'live_day',   name: 'After webinar',   trigger_type: 'offset_minutes', offset_minutes: (Number(stored.after?.offset_minutes) || 10),  voice_id: stored.after?.voice_id, enabled: stored.after?.enabled },
      ];
    } else {
      rawCampaigns = DEFAULT_CAMPAIGNS;
    }
  }
  const campaigns = rawCampaigns.map(normCampaign);
  // Guarantee unique ids (a duplicate would break the per-campaign claim).
  const seen = new Set();
  for (const c of campaigns) {
    while (seen.has(c.id)) c.id = newId();
    seen.add(c.id);
  }
  return {
    max_attempts: clampInt(stored.max_attempts, 1, 50, 10),
    campaigns,
  };
}

/* Config lives in one of two single-row tables: nsm_ivr_call_config (NSM-IVR
   workspace, default) or nsm_call_config (NSM-Caller workspace). Allowlisted
   since the name is interpolated into SQL. */
const CONFIG_TABLES = new Set(['nsm_ivr_call_config', 'nsm_call_config']);
async function loadIvrConfig(table = 'nsm_ivr_call_config') {
  const T = CONFIG_TABLES.has(table) ? table : 'nsm_ivr_call_config';
  try {
    const { rows } = await pool.query(`SELECT config FROM ${T} WHERE id = 1`);
    return mergeIvrConfig(rows[0] && rows[0].config);
  } catch (e) { return mergeIvrConfig(null); }
}

module.exports = { IVR_DEFAULTS, TRIGGER_TYPES, mergeIvrConfig, loadIvrConfig };
