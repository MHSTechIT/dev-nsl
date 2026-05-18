/**
 * Remove the seed-test leads we created earlier so the Round-robin
 * queue's "Assigned" column reflects real production data only.
 *
 * Targets ONLY rows that match all three markers:
 *   • full_name LIKE 'Hari Test %'   (the exact pattern we inserted)
 *   • whatsapp_number = '9042313322' (the phone we tagged the seed with)
 *   • email LIKE 'hari.test.%@example.com' (our fake email shape)
 *
 * Any real lead named something like "Hari" or with the same phone will
 * NOT match this triple-criteria — by design, since real users won't
 * have the literal "Hari Test 1..20" name + example.com email.
 *
 * Safe to re-run. Run with:
 *   cd E:\nsl\crm\backend
 *   node scripts/delete-hari-test-leads.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

(async () => {
  const url = process.env.DATABASE_URL || '';
  const usesSsl = !/localhost|13\.234\.115\.104/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: usesSsl ? { rejectUnauthorized: false } : false,
  });

  try {
    // Preview first so we know exactly what's about to be deleted.
    const { rows: preview } = await pool.query(
      `SELECT id, full_name, whatsapp_number, email
         FROM leads
        WHERE full_name LIKE 'Hari Test %'
          AND whatsapp_number = '9042313322'
          AND email LIKE 'hari.test.%@example.com'
        ORDER BY full_name`
    );
    if (preview.length === 0) {
      console.log('✓ Nothing to delete — no Hari Test rows found.');
      return;
    }
    console.log(`Found ${preview.length} seed row(s) to delete:`);
    for (const r of preview) console.log(`  - ${r.full_name}  ${r.email}  id=${r.id}`);

    const { rowCount } = await pool.query(
      `DELETE FROM leads
        WHERE full_name LIKE 'Hari Test %'
          AND whatsapp_number = '9042313322'
          AND email LIKE 'hari.test.%@example.com'`
    );
    console.log(`\n✓ Deleted ${rowCount} lead row(s).`);
  } catch (err) {
    console.error('✗ FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
