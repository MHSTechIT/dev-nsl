/* One-shot: print every CRM caller's Tata-related config so we can see
   which caller's extension / account_type / api_key is mis-configured
   and causing the "Invalid Agent Extension Entered" error in Tata.

   Run from crm/backend:
     node scripts/inspect-callers-tata-config.js
*/

require('dotenv').config();
const pool = require('../db');

(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, role, is_active,
              tata_extension, tata_agent_number, tata_caller_id,
              tata_account_type,
              CASE WHEN tata_smartflo_api_key IS NULL THEN NULL
                   ELSE substr(tata_smartflo_api_key, 1, 8) || '...' || substr(tata_smartflo_api_key, length(tata_smartflo_api_key) - 4)
              END AS tata_api_key_masked,
              tata_outbound_route
         FROM crm_users
        WHERE role IN ('junior_caller','senior_caller')
        ORDER BY is_active DESC, full_name ASC`
    );
    console.log(`\nFound ${rows.length} caller(s).\n`);
    console.log('Env fallbacks:');
    console.log('  TATA_TELE_AGENT_EXTENSION =', process.env.TATA_TELE_AGENT_EXTENSION || '(not set)');
    console.log('  TATA_TELE_DID             =', process.env.TATA_TELE_DID || '(not set)');
    console.log('  TATA_TELE_API_KEY         =', process.env.TATA_TELE_API_KEY ? '(set)' : '(not set)');
    console.log('  TATA_TELE_API_KEY_NSL_C2C =', process.env.TATA_TELE_API_KEY_NSL_C2C ? '(set)' : '(not set)');
    console.log('');
    for (const r of rows) {
      console.log(`── ${r.full_name} <${r.email}>  [${r.role}${r.is_active ? '' : ', INACTIVE'}]`);
      console.log(`     id              : ${r.id}`);
      console.log(`     extension       : ${r.tata_extension || '(empty → falls back to TATA_TELE_AGENT_EXTENSION)'}`);
      console.log(`     agent_number    : ${r.tata_agent_number || '(empty)'}`);
      console.log(`     caller_id (DID) : ${r.tata_caller_id || '(empty → falls back to TATA_TELE_DID)'}`);
      console.log(`     account_type    : ${r.tata_account_type || '(empty → uses global TATA_TELE_API_KEY)'}`);
      console.log(`     api_key         : ${r.tata_api_key_masked || '(empty → uses env)'}`);
      console.log(`     outbound_route  : ${r.tata_outbound_route || 'extension'}`);
      console.log('');
    }
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
