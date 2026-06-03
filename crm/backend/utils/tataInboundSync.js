/**
 * Tata inbound-call sync.
 *
 * Smartflo dashboards don't always expose webhook config, so we proactively
 * poll Tata's CDR API every couple of minutes. For each inbound call we don't
 * already have, upsert a row in the `calls` table (direction='inbound') so the
 * Missed Calls page picks it up.
 *
 * Matching:
 *   – Existing row by provider_call_id (uuid) → update status/duration
 *   – Otherwise INSERT new row, attempt to attach a lead by last-10 of phone
 */

const pool = require('../db');
const callerSse = require('./callerSse');
const { fetchInboundMissedCalls, normalizeCdrRow } = require('./tataClient');

let _running = false;
let _timer = null;
let _lastResult = { ranAt: null, fetched: 0, upserted: 0, error: null };

/**
 * Auto-assign a missed-call lead — the automated equivalent of the "Missed"
 * refill button (POST /api/caller/leads/reopen, source:'missed'). Clears any
 * prior outcome so a Completed / Not-Interested customer who calls back is
 * reopened, unparks Next-Batch leads, and pins the lead to the top of the
 * owner's Assigned page. Pushes SSE so the page refreshes live.
 */
async function autoAssignMissedCallLead(leadId, leadsTable = 'leads') {
  if (!leadId) return;
  try {
    const { rows } = await pool.query(
      `UPDATE ${leadsTable}
          SET last_note_outcome    = NULL,
              last_note_interested = NULL,
              last_note_at         = NULL,
              follow_up_at         = NULL,
              completed_at         = NULL,
              next_batch_parked    = FALSE,
              next_batch_parked_at = NULL,
              assigned_at          = NOW(),
              pinned_at            = NOW()
        WHERE id = $1
        RETURNING id, assigned_user_id`,
      [leadId]
    );
    const lead = rows[0];
    if (lead && lead.assigned_user_id) {
      callerSse.pushTo(lead.assigned_user_id, {
        type: 'lead.assigned',
        lead: { id: lead.id, promoted_from: 'missed_call' },
      });
    }
  } catch (e) {
    console.error('[tataInboundSync] auto-assign missed-call lead error:', e.message);
  }
}

async function syncOnce({ lookbackMinutes = 30, calls = 'calls', leads = 'leads', phoneCol = 'whatsapp_number' } = {}) {
  if (_running) return { skipped: 'already_running' };
  _running = true;
  const startedAt = new Date();
  try {
    const fetchRes = await fetchInboundMissedCalls({ lookbackMinutes });
    if (!fetchRes.ok) {
      _lastResult = { ranAt: startedAt, fetched: 0, upserted: 0, error: fetchRes.error, attempts: fetchRes.attempts };
      return _lastResult;
    }

    let upserted = 0;
    for (const row of fetchRes.calls) {
      const n = normalizeCdrRow(row);
      if (!n.provider_call_id) continue; // skip rows without an id

      // Try to attach a lead by phone last-10
      let leadId = null, callerUserId = null;
      if (n.phone10 && n.phone10.length === 10) {
        try {
          const { rows: leadRows } = await pool.query(
            `SELECT id, assigned_user_id FROM ${leads}
              WHERE RIGHT(REGEXP_REPLACE(${phoneCol}, '\\D', '', 'g'), 10) = $1
              ORDER BY assigned_at DESC NULLS LAST
              LIMIT 1`,
            [n.phone10]
          );
          if (leadRows[0]) {
            leadId = leadRows[0].id;
            callerUserId = leadRows[0].assigned_user_id;
          }
        } catch (_) { /* lookup failure is non-fatal */ }
      }

      // Upsert by provider_call_id. If the row exists, refresh status fields.
      try {
        const existing = await pool.query(
          `SELECT id, status FROM ${calls} WHERE provider_call_id = $1 LIMIT 1`,
          [n.provider_call_id]
        );
        const callerPhone10 = n.phone10 && n.phone10.length === 10 ? n.phone10 : null;
        const didNumber10   = n.to_did   && n.to_did.length   === 10 ? n.to_did   : null;
        if (existing.rows.length > 0) {
          // Was this row already 'missed' before we touched it? If not, this
          // poll is the moment it transitions into 'missed' (e.g. the
          // /tata-tele/dialplan webhook inserted a 'ringing' row first), so
          // auto-assign exactly once. Re-polls of an already-missed call skip.
          const wasMissed = existing.rows[0].status === 'missed';
          await pool.query(
            `UPDATE ${calls}
                SET status        = COALESCE($2, status),
                    duration_sec  = COALESCE($3, duration_sec),
                    recording_url = COALESCE($4, recording_url),
                    started_at    = COALESCE(started_at, $5),
                    lead_id       = COALESCE(lead_id, $6),
                    caller_id     = COALESCE(caller_id, $7),
                    raw_payload   = $8,
                    caller_phone  = COALESCE(caller_phone, $9),
                    did_number    = COALESCE(did_number, $10),
                    direction     = 'inbound',
                    updated_at    = NOW()
              WHERE id = $1`,
            [
              existing.rows[0].id,
              'missed',
              n.duration_sec,
              n.recording_url,
              n.started_at ? new Date(n.started_at).toISOString() : null,
              leadId,
              callerUserId,
              n.raw_payload,
              callerPhone10,
              didNumber10,
            ]
          );
          // Just transitioned into 'missed' — pin the lead to the caller's
          // Assigned page as their next call.
          if (!wasMissed && leadId) await autoAssignMissedCallLead(leadId, leads);
        } else {
          await pool.query(
            `INSERT INTO ${calls}
               (lead_id, caller_id, provider_call_id, direction, status,
                duration_sec, recording_url, started_at, raw_payload, caller_phone, did_number)
             VALUES ($1, $2, $3, 'inbound', 'missed', $4, $5,
                     COALESCE($6::timestamptz, NOW()), $7, $8, $9)`,
            [
              leadId,
              callerUserId,
              n.provider_call_id,
              n.duration_sec,
              n.recording_url,
              n.started_at ? new Date(n.started_at).toISOString() : null,
              n.raw_payload,
              callerPhone10,
              didNumber10,
            ]
          );
          upserted++;

          // New inbound missed call — pin the lead to the caller's Assigned
          // page as their next call.
          if (leadId) await autoAssignMissedCallLead(leadId, leads);

          // Push SSE so the Missed Calls page refreshes instantly if it's open
          if (callerUserId) {
            callerSse.pushTo(callerUserId, {
              type:    'call.incoming',
              lead_id: leadId,
              phone:   n.phone10,
              uuid:    n.provider_call_id,
            });
          }
        }
      } catch (e) {
        console.error('[tataInboundSync] upsert error for', n.provider_call_id, e.message);
      }
    }

    _lastResult = { ranAt: startedAt, fetched: fetchRes.calls.length, upserted, error: null, endpoint: fetchRes.endpoint };
    return _lastResult;
  } catch (e) {
    _lastResult = { ranAt: startedAt, fetched: 0, upserted: 0, error: e.message };
    return _lastResult;
  } finally {
    _running = false;
  }
}

function startScheduler({ intervalMs = 2 * 60 * 1000 } = {}) {
  // Skip if Tata API isn't configured — no point polling.
  if (!process.env.TATA_TELE_API_KEY) {
    console.log('[tataInboundSync] TATA_TELE_API_KEY not set; scheduler disabled');
    return;
  }
  // Clear any existing timer first so a live restart never leaves two running.
  if (_timer) { clearInterval(_timer); _timer = null; }
  _timer = setInterval(() => {
    syncOnce({ lookbackMinutes: 10 }).then(r => {
      if (r.upserted > 0 || r.error) {
        console.log('[tataInboundSync]', JSON.stringify({
          ranAt: r.ranAt, fetched: r.fetched, upserted: r.upserted, error: r.error, endpoint: r.endpoint
        }));
      }
    }).catch(e => console.error('[tataInboundSync] tick error:', e.message));
  }, intervalMs);
  console.log(`[tataInboundSync] scheduler started — every ${intervalMs / 1000}s`);
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function getLastResult() { return _lastResult; }

module.exports = { syncOnce, startScheduler, stopScheduler, getLastResult };
