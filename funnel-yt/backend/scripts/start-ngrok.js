#!/usr/bin/env node
/* Start ngrok against the backend (port 3001) and print one public URL ready
   to paste into every Tata Smartflo webhook field. Backend webhook routes
   share a single generic handler, so one URL covers every event type. */

const { spawn } = require('child_process');
const http      = require('http');

const PORT       = 3001;
const NGROK_API  = 'http://127.0.0.1:4040/api/tunnels';

console.log(`\nStarting ngrok → http://localhost:${PORT} …`);

const child = spawn('ngrok', ['http', String(PORT), '--log=stdout'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});

let printed = false;
child.stdout.on('data', d => process.stdout.write(`[ngrok] ${d}`));
child.stderr.on('data', d => process.stderr.write(`[ngrok ERR] ${d}`));
child.on('exit', code => {
  console.log(`\nngrok exited with code ${code}.`);
  process.exit(code || 0);
});

function fetchTunnels() {
  return new Promise((resolve, reject) => {
    http.get(NGROK_API, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function pollUntilUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const data = await fetchTunnels();
      const t = (data.tunnels || []).find(x => x.proto === 'https') || data.tunnels?.[0];
      if (t?.public_url) return t.public_url;
    } catch (_) { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('ngrok did not expose a public URL within 30 s');
}

(async () => {
  try {
    const publicUrl = await pollUntilUrl();
    if (printed) return;
    printed = true;
    const bar = '═'.repeat(72);
    const rows = [
      ['Catch-all (any event)',     `${publicUrl}/api/webhooks/tata`],
      ['Recording ready',           `${publicUrl}/api/webhooks/tata-tele/recording`],
      ['Answered by agent',         `${publicUrl}/api/webhooks/tata-tele/answered-by-agent`],
      ['Answered by customer',      `${publicUrl}/api/webhooks/tata-tele/answered-by-customer`],
      ['Hangup',                    `${publicUrl}/api/webhooks/tata-tele/hangup`],
      ['Missed',                    `${publicUrl}/api/webhooks/tata-tele/missed`],
      ['Inbound dialplan / pop',    `${publicUrl}/api/webhooks/tata/dialplan`],
    ];
    const labelWidth = Math.max(...rows.map(r => r[0].length));
    console.log(`
${bar}
🔗  PUBLIC NGROK BASE URL — ${publicUrl}
${bar}

All Tata Smartflo webhook endpoints (paste into matching fields in Tata):

${rows.map(([label, url]) => `   ${label.padEnd(labelWidth)}  →  ${url}`).join('\n')}

ngrok inspector: http://127.0.0.1:4040
${bar}

Tip: every call-event endpoint above is wired to the SAME handler, so
you can also just paste the catch-all URL into all six call-event fields
and skip the per-event ones. The dialplan URL is a separate endpoint
because Tata expects routing JSON back from it.

Press Ctrl+C to stop ngrok.
`);
  } catch (err) {
    console.error('Failed to read ngrok URL:', err.message);
    child.kill('SIGINT');
    process.exit(1);
  }
})();

process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
