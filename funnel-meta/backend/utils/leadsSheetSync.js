const pool = require('../db');
const { writeLeadsToSheet } = require('./googleSheets');

/**
 * Fetches all leads from the DB and writes them to Google Sheets.
 * Safe to call at any time — skips silently if env vars aren't configured.
 */
async function syncLeadsToSheet() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_SHEET_ID) {
    console.log('[Sheets Sync] Skipped — GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SHEET_ID not set');
    return { skipped: true };
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM leads ORDER BY created_at ASC'
    );
    const count = await writeLeadsToSheet(rows);
    const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    console.log(`[Sheets Sync] ✓ ${count} leads synced at ${ts} IST`);
    return { success: true, count };
  } catch (err) {
    console.error('[Sheets Sync] ✗ Error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { syncLeadsToSheet };
