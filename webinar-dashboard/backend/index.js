require('dotenv').config();
const { app, migrate } = require('./app');
const zoom = require('./utils/zoom');

const PORT = process.env.PORT || 3005;

migrate()
  .then(() => console.log('[webinar-dashboard] migrations ok (wd_webinars, wd_participants, wd_chat_messages)'))
  .catch((e) => console.error('[webinar-dashboard] migration error:', e.message));

app.listen(PORT, () => {
  console.log(`[webinar-dashboard] backend on port ${PORT}`);
  console.log(
    `[webinar-dashboard] Zoom ${zoom.isConfigured() ? 'CONFIGURED' : 'NOT configured — fallback mode (cards save; no live meeting)'}` +
    ` | hosts: ${zoom.listHosts().length}`
  );
});
