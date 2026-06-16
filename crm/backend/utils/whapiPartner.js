/*
 * whapiPartner — thin server-side client for the Whapi.Cloud **Partner API**
 * (https://manager.whapi.cloud). The partner key is powerful (it can create/
 * delete channels and spend balance via Stripe), so it lives ONLY here, read
 * from the backend .env — it must never be sent to the browser. The CRM
 * frontend talks to our own /api/admin/whapi/* proxy, which calls this.
 */
const BASE = (process.env.WHAPI_PARTNER_BASE || 'https://manager.whapi.cloud').replace(/\/$/, '');
const KEY  = process.env.WHAPI_PARTNER_KEY || '';

async function whapi(method, path, body) {
  if (!KEY) {
    const e = new Error('WHAPI_PARTNER_KEY not configured');
    e.code = 'NO_KEY';
    throw e;
  }
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = new Error(`whapi_${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

/* ── Gate API (per-channel) ──────────────────────────────────────────────
 * Channel-scoped operations (connection status, login QR, logout) use the
 * Gate API at the channel's own apiUrl, authenticated with that channel's
 * token. We resolve the token server-side from the partner channel list so it
 * never reaches the browser. */
async function resolveChannel(id) {
  const d = await whapi('GET', '/channels/list');
  const ch = (d.channels || []).find(c => c.id === id);
  if (!ch) { const e = new Error('channel_not_found'); e.status = 404; throw e; }
  return ch; // { id, token, apiUrl, status, ... }
}

async function gate(method, channel, path) {
  const base = (channel.apiUrl || 'https://gate.whapi.cloud/').replace(/\/$/, '');
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${channel.token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) { const e = new Error(`gate_${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

module.exports = { whapi, gate, resolveChannel, whapiConfigured: () => !!KEY };
