/* ──────────────────────────────────────────────────────────────────────────
   Zoom Server-to-Server OAuth client.

   ONE S2S OAuth app on the MAIN Zoom account creates meetings under any of the
   configured host users (ZOOM_HOSTS) — the "5 accounts under one main account"
   model. Set ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET to switch
   real Zoom on; until then every call is gated by isConfigured() so the
   dashboard still creates + stores webinar cards (fallback mode).

   Attendee data (after a meeting ends):
     • name / email / duration  → getParticipants()  (report:read:admin, paid plan)
     • phone                    → getRegistrants()    (only if the registration
                                   form has a phone field; merged onto participants)
     • chat messages            → require cloud-recording "save chat" (TODO) or
                                   live webhooks; not covered by these report APIs.
   ────────────────────────────────────────────────────────────────────────── */

const OAUTH_URL = 'https://zoom.us/oauth/token';
const API = 'https://api.zoom.us/v2';

const ACCOUNT_ID    = () => process.env.ZOOM_ACCOUNT_ID || '';
const CLIENT_ID     = () => process.env.ZOOM_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.ZOOM_CLIENT_SECRET || '';

function isConfigured() {
  return Boolean(ACCOUNT_ID() && CLIENT_ID() && CLIENT_SECRET());
}

/* Parse ZOOM_HOSTS — comma list of "Label=user@email" (or just "user@email").
   These are the host users a meeting can be created under. */
function listHosts() {
  const raw = (process.env.ZOOM_HOSTS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((entry) => {
    const s = entry.trim();
    if (!s) return null;
    const eq = s.indexOf('=');
    if (eq === -1) return { key: s, label: s, hostId: s };
    const label  = s.slice(0, eq).trim();
    const hostId = s.slice(eq + 1).trim();
    return { key: hostId || label, label: label || hostId, hostId };
  }).filter(Boolean);
}

let _token = null;
let _tokenExp = 0;

async function getAccessToken() {
  if (!isConfigured()) throw new Error('Zoom not configured');
  const now = Date.now();
  if (_token && now < _tokenExp - 60_000) return _token;
  const basic = Buffer.from(`${CLIENT_ID()}:${CLIENT_SECRET()}`).toString('base64');
  const res = await fetch(`${OAUTH_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(ACCOUNT_ID())}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zoom OAuth failed: ${data.reason || data.error || res.status}`);
  _token = data.access_token;
  _tokenExp = now + (data.expires_in || 3600) * 1000;
  return _token;
}

async function zoomFetch(path, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Zoom API ${res.status}: ${data.message || data.raw || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* Create a scheduled WEBINAR under `hostId`. Registration ON so attendee
   name + phone can be captured via the registrants list. Requires the host to
   have a Zoom Webinar license + the webinar:write:webinar:admin scope. */
async function createWebinar(opts = {}) {
  const {
    hostId, topic, startAt, durationMin = 60, timezone = 'Asia/Kolkata',
    agenda = '', registration = true, password = '', autoRecording = 'none',
    hostVideo = false, panelistsVideo = false, audio = 'both',
    practiceSession = false, qAndA = true, hdVideo = false,
    emailInAttendeeReport = false, alternativeHosts = '',
  } = opts;

  const body = {
    topic,
    type: 5, // scheduled webinar
    start_time: new Date(startAt).toISOString(),
    duration: durationMin,
    timezone,
    ...(agenda ? { agenda } : {}),
    ...(password ? { password } : {}),
    settings: {
      host_video: !!hostVideo,
      panelists_video: !!panelistsVideo,
      approval_type: registration ? 0 : 2,   // 0 = auto-approve registrants, 2 = no registration
      registration_type: 1,
      audio,                                  // 'both' | 'telephony' | 'voip'
      auto_recording: autoRecording,          // 'none' | 'local' | 'cloud'  (cloud → enables chat capture)
      practice_session: !!practiceSession,
      hd_video: !!hdVideo,
      question_answer: !!qAndA,
      email_in_attendee_report: !!emailInAttendeeReport,
      alternative_hosts: alternativeHosts || '',
    },
  };
  const data = await zoomFetch(`/users/${encodeURIComponent(hostId)}/webinars`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    meetingId:       String(data.id),
    joinUrl:         data.join_url || null,
    startUrl:        data.start_url || null,
    registrationUrl: data.registration_url || null,
    password:        data.password || password || null,
    uuid:            data.uuid || null,
  };
}

/* Post-webinar participant report: name, email, duration (sec), join/leave. */
async function getParticipants(webinarId) {
  const out = [];
  let token = '';
  do {
    const qs = `page_size=300${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`;
    const data = await zoomFetch(`/report/webinars/${encodeURIComponent(webinarId)}/participants?${qs}`);
    for (const p of data.participants || []) {
      out.push({
        name:        p.name || null,
        email:       p.user_email || null,
        joinAt:      p.join_time || null,
        leaveAt:     p.leave_time || null,
        durationSec: p.duration != null ? Number(p.duration) : null,
      });
    }
    token = data.next_page_token || '';
  } while (token);
  return out;
}

/* Registrants: name + phone + email (phone present only when the registration
   form includes a phone field). Used to enrich participants with a phone #. */
async function getRegistrants(webinarId) {
  const out = [];
  let token = '';
  do {
    const qs = `page_size=300&status=approved${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`;
    const data = await zoomFetch(`/webinars/${encodeURIComponent(webinarId)}/registrants?${qs}`);
    for (const r of data.registrants || []) {
      out.push({
        name:  [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null,
        email: r.email || null,
        phone: r.phone || null,
      });
    }
    token = data.next_page_token || '';
  } while (token);
  return out;
}

module.exports = { isConfigured, listHosts, createWebinar, getParticipants, getRegistrants };
