/* One-shot: update the WhatsApp number on the 20 test leads I previously
   seeded for Hari (identified by email pattern 'test-hari-%').
   Run from backend/:  node scripts/update_test_leads_number.js  */

require('dotenv').config();
const pool = require('../db');

const NEW_NUMBER = '9345600690';
const EMAIL_TAG  = 'test-hari';

(async () => {
  try {
    const { rows: before } = await pool.query(
      `SELECT id, full_name, whatsapp_number FROM leads
        WHERE email LIKE $1
        ORDER BY full_name`,
      [`${EMAIL_TAG}-%`]
    );
    if (before.length === 0) {
      console.log('No test leads found (email LIKE test-hari-%). Nothing to update.');
      await pool.end();
      return;
    }
    console.log(`Found ${before.length} test leads. Old number(s):`);
    const distinctOld = [...new Set(before.map(r => r.whatsapp_number))];
    distinctOld.forEach(n => console.log(`   ${n}`));

    const { rowCount } = await pool.query(
      `UPDATE leads SET whatsapp_number = $1
        WHERE email LIKE $2`,
      [NEW_NUMBER, `${EMAIL_TAG}-%`]
    );
    console.log(`\nUpdated ${rowCount} lead${rowCount === 1 ? '' : 's'} → ${NEW_NUMBER}`);

    await pool.end();
  } catch (err) {
    console.error('Update failed:', err.message);
    process.exit(1);
  }
})();
