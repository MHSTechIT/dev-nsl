const MAX_SSE_CLIENTS = 500;
const clients = new Set();

function addClient(res) {
  if (clients.size >= MAX_SSE_CLIENTS) {
    res.status(503).end();
    return false;
  }
  clients.add(res);
  return true;
}

function removeClient(res) {
  clients.delete(res);
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

module.exports = { addClient, removeClient, broadcast };
