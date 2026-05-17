# MHS — Split Repo Structure

Three self-contained service folders, each holding its own frontend + backend. All three share the **same Postgres database** and talk to each other via `pg_notify` channels — that's how they stay "connected" without depending on each other's processes.

```
nsl/
├── crm/
│   ├── frontend/                 ← CRM SPA (caller dashboard + admin panel)
│   └── backend/                  ← CRM Node service (port 3003)
│       └── routes: admin, auth, caller, calls, recordings, webhooks, webinarConfig
│
├── funnel-meta/
│   ├── frontend/
│   │   ├── funnel/               ← Meta landing-page funnel + embedded admin
│   │   ├── whatsapp/             ← Post-submit WA redirect (Meta)
│   │   └── disqualified/         ← Disqualification screens (Meta)
│   └── backend/                  ← Meta funnel Node service (port 3001)
│       └── routes: webinarConfig, leads, events, auth, admin
│
├── funnel-yt/
│   ├── frontend/
│   │   ├── funnel-yt/            ← YouTube landing-page funnel
│   │   ├── whatsapp-yt/          ← Post-submit WA redirect (YT)
│   │   └── disqualified-yt/      ← Disqualification screens (YT)
│   └── backend/                  ← YT funnel Node service (port 3002)
│       └── routes: webinarConfig, leads, events, auth, admin
│
├── apps/                         ← (LEGACY, kept as backup — original frontends)
├── backend/                      ← (LEGACY, kept as backup — original monolith)
├── database/                     ← Shared SQL schema reference
├── docs/                         ← Shared documentation
└── scripts/                      ← Shared dev tooling
```

## How they talk to each other

All three services connect to the **same Postgres database** via `DATABASE_URL` in their respective `.env` files. They communicate via Postgres `LISTEN/NOTIFY`:

- `lead.created` — funnel services fire this when a new lead is inserted. CRM listens and assigns the lead to a caller.
- `webinar.config.updated` — admin (on any service) fires this when webinar config changes. The funnel services listen and rebroadcast to their landing-page SPAs via SSE.

No service depends on another being up. If funnel-meta crashes, CRM and funnel-yt keep running. New leads queue in the DB and CRM picks them up on next restart via its boot-time sweep.

## Running each service

### CRM (port 3003)
```bash
cd crm/backend
npm install
npm start                # runs servers/crm.js

# In another terminal:
cd crm/frontend
npm install
npm run dev              # runs Vite on port 5177
```

### Funnel-Meta (port 3001)
```bash
cd funnel-meta/backend
npm install
npm start                # runs servers/funnel-meta.js

# Each frontend app starts independently:
cd funnel-meta/frontend/funnel       && npm install && npm run dev   # port 5173
cd funnel-meta/frontend/whatsapp     && npm install && npm run dev   # port 5175
cd funnel-meta/frontend/disqualified && npm install && npm run dev   # port 5176
```

### Funnel-YT (port 3002)
```bash
cd funnel-yt/backend
npm install
npm start                # runs servers/funnel-yt.js

# Each frontend app starts independently:
cd funnel-yt/frontend/funnel-yt       && npm install && npm run dev
cd funnel-yt/frontend/whatsapp-yt     && npm install && npm run dev
cd funnel-yt/frontend/disqualified-yt && npm install && npm run dev
```

## Environment files

Each `backend/` needs its own `.env` with at minimum:
```
DATABASE_URL=postgresql://...
ADMIN_PASSWORD=...
PORT=3001          # 3001 funnel-meta, 3002 funnel-yt, 3003 crm
CLIENT_ORIGIN=...
```

CRM additionally needs:
```
TATA_TELE_API_KEY=...        # Smartflo JWT
TATA_TELE_WEBHOOK_SECRET=... # optional, for webhook signing
GMAIL_FROM=...
GMAIL_APP_PASSWORD=...
```

Copy `backend/.env.example` (in each folder) as a starting point.

## What "connected" means

| Mechanism | Purpose |
|---|---|
| Shared `DATABASE_URL` | All services read/write the same tables (leads, calls, webinar_config, etc.) |
| `pg_notify('lead.created')` | Funnel services notify CRM whenever a new lead lands |
| `pg_notify('webinar.config.updated')` | Admin updates broadcast across all services |
| Webhook URL (Tata Smartflo) | Configured to point at the **CRM** service's `/api/webhooks/tata*` paths |
| Same JWT secret | If users log into admin on funnel-meta, CRM accepts the same token |

## Legacy folders

- `apps/` — the original combined apps directory (kept for safety; delete once the new structure is verified working)
- `backend/` — the original monolithic backend (kept for safety; delete once the new structure is verified working)

The old `backend/` still has all the same code as the new ones — running `node index.js` from `backend/` still works as a single-process fallback. The three new backends are just `backend/`'s `servers/{crm,funnel-meta,funnel-yt}.js` entries broken out into independent folders.
