/**
 * One-shot test seed: create 20 leads, all with phone 9042313322,
 * all assigned directly to the caller named "hari".
 *
 * Run with:
 *   cd E:\nsl\crm\backend
 *   node ../../scripts/seed-hari-leads.js
 *
 * The script reads DATABASE_URL from crm/backend/.env via dotenv so it
 * uses the exact same DB the live services are talking to.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const PHONE = '9042313322';
const COUNT = 20;

(async () => {
  // The EC2 Postgres at 13.234.115.104 doesn't have SSL enabled, but the
  // hosted prod box does. Detect by URL substring — anything other than the
  // EC2 IP gets `ssl: { rejectUnauthorized: false }` for managed Postgres.
  const url = process.env.DATABASE_URL || '';
  const usesSsl = !/localhost|13\.234\.115\.104/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: usesSsl ? { rejectUnauthorized: false } : false,
  });

  try {
    // 1. Find Hari
    const { rows: callers } = await pool.query(
      `SELECT id, full_name, email, role, is_active
         FROM crm_users
        WHERE LOWER(full_name) LIKE '%hari%' AND is_active = TRUE
        ORDER BY created_at
        LIMIT 1`
    );
    if (callers.length === 0) {
      throw new Error('No active caller with "hari" in full_name found in crm_users');
    }
    const hari = callers[0];
    console.log(`✓ Caller: ${hari.full_name}  (${hari.email})  id=${hari.id}`);

    // 2. Find active webinar — the date column was renamed across
    //    migrations (webinar_at → date_time), so we just SELECT * and
    //    grab whatever id is active. Sorting by id works since BIGSERIAL.
    const { rows: webinars } = await pool.query(
      `SELECT * FROM webinars WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`
    );
    if (webinars.length === 0) {
      throw new Error('No active webinar found in webinars table');
    }
    const webinarId = webinars[0].id;
    console.log(`✓ Webinar: id=${webinarId}`);

    // 3. Insert 20 leads, each with a unique full_name + email so we don't
    //    collide on any UNIQUE constraint; same phone for all.
    const stamp = Date.now();
    let inserted = 0;
    for (let i = 1; i <= COUNT; i++) {
      const fullName = `Hari Test ${i}`;
      const email    = `hari.test.${stamp}.${i}@example.com`;
      // Cycle through a few qualification profiles so lead_score varies
      const sugarLevels = ['150-250', '250+'];
      const durations   = ['new', 'mid', 'long', 'pre'];
      const sugar       = sugarLevels[i % sugarLevels.length];
      const duration    = durations[i % durations.length];
      const leadScore   = duration === 'pre'
        ? 2
        : Math.min(5, (sugar === '250+' ? 3 : 2) + ({ long: 2, mid: 1, new: 0 }[duration] ?? 0));

      const { rows } = await pool.query(
        `INSERT INTO leads
           (full_name, whatsapp_number, email, sugar_level, diabetes_duration,
            language_pref, lead_score, webinar_id, source, assigned_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          fullName, PHONE, email, sugar, duration,
          'tamil', leadScore, webinarId, 'meta', hari.id,
        ]
      );
      inserted++;
      console.log(`  [${i}/${COUNT}] lead_id=${rows[0].id}  score=${leadScore}  sugar=${sugar}  dur=${duration}`);
    }

    console.log(`\n✓ Inserted ${inserted} leads, all assigned_user_id=${hari.id} (${hari.full_name})`);
  } catch (err) {
    console.error('✗ FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
