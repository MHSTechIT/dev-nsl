const MAX_SSE_CLIENTS = 500;
// Map<res, source>. Each SSE client is tagged with the source ('meta' | 'yt')
// it subscribed for; broadcast filters by that tag so Meta-config updates only
// reach Meta clients and vice versa.
const clients = new Map();

function addClient(res, source = 'meta') {
  if (clients.size >= MAX_SSE_CLIENTS) {
    res.status(503).end();
    return false;
  }
  clients.set(res, source);
  return true;
}

function removeClient(res) {
  clients.delete(res);
}

function broadcast(data, source = 'meta') {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const [res, tag] of clients) {
    if (tag !== source) continue;
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

module.exports = { addClient, removeClient, broadcast };
