/**
 * Per-caller SSE registry. Each caller_id maps to a Set of open response objects
 * (one per browser tab). pushTo(callerId, payload) writes to all sockets the caller
 * has open; failures drop the dead socket from the Set.
 */
const MAX_PER_CALLER = 5;
const channels = new Map();   // caller_id -> Set<res>

function add(callerId, res) {
  if (!callerId) return false;
  let set = channels.get(callerId);
  if (!set) { set = new Set(); channels.set(callerId, set); }
  if (set.size >= MAX_PER_CALLER) {
    res.status(503).end();
    return false;
  }
  set.add(res);
  return true;
}

function remove(callerId, res) {
  const set = channels.get(callerId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) channels.delete(callerId);
}

function pushTo(callerId, payload) {
  const set = channels.get(callerId);
  if (!set || set.size === 0) return 0;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  let delivered = 0;
  for (const res of set) {
    try { res.write(data); delivered++; }
    catch { set.delete(res); }
  }
  if (set.size === 0) channels.delete(callerId);
  return delivered;
}

module.exports = { add, remove, pushTo };
