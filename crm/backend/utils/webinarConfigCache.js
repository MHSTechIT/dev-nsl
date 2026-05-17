const TTL_MS = 5 * 60 * 1000; // 5 minutes

const store = new Map(); // source -> { data, at }

function get(source = 'meta') {
  const hit = store.get(source);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  return null;
}

function set(data, source = 'meta') {
  store.set(source, { data, at: Date.now() });
}

function invalidate(source) {
  if (source) store.delete(source);
  else store.clear();
}

module.exports = { get, set, invalidate };
