/**
 * One-shot backfill: copy raw_payload.ref_id into provider_call_id for any
 * call rows still missing it. Safe to re-run — only touches NULL rows.
 *
 *   node scripts/backfill-provider-call-id.js
 */
require('dotenv').config();
const pool = require('../db');

(async () => {
  try {
    const r = await pool.query(
      `UPDATE calls
          SET provider_call_id = raw_payload->>'ref_id'
        WHERE provider_call_id IS NULL
          AND raw_payload IS NOT NULL
          AND raw_payload ? 'ref_id'
        RETURNING id, provider_call_id`
    );
    console.log('backfilled', r.rowCount, 'calls');
    process.exit(0);
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  }
})();
