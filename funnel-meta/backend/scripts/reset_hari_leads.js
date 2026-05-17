/* One-shot: reset Hari's queue.
   1. Unassign every NON-test lead currently assigned to Hari
      (sets assigned_user_id = NULL, assigned_at = NULL — leads remain
      in the DB, just no longer his).
   2. Ensure 20 test leads (email LIKE 'test-hari-%') exist assigned to
      Hari with whatsapp_number = 8754689554 and assigned_at pinned to
      a far-past timestamp so they sit at the top of his list.

   Run from backend/:  node scripts/reset_hari_leads.js  */

require('dotenv').config();
const pool = require('../db');

const TEST_NUMBER = '8754689554';
const COUNT       = 20;
const TOP_TS      = '2020-01-01T00:00:00Z';
const EMAIL_TAG   = 'test-hari';

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find Hari.
    const { rows: callers } = await client.query(
      `SELECT id, full_name FROM crm_users
        WHERE LOWER(full_name) LIKE 'hari%'
          AND role IN ('junior_caller','senior_caller')
        ORDER BY is_active DESC LIMIT 1`
    );
    if (callers.length === 0) throw new Error('No caller named Hari found.');
    const hari = callers[0];
    console.log(`Found caller: ${hari.full_name} (${hari.id})`);

    // 2. Count and unassign non-test leads.
    const { rows: before } = await client.query(
      `SELECT COUNT(*)::int AS n FROM leads
        WHERE assigned_user_id = $1 AND (email IS NULL OR email NOT LIKE $2)`,
      [hari.id, `${EMAIL_TAG}-%`]
    );
    console.log(`Non-test leads currently assigned to Hari: ${before[0].n}`);

    const { rowCount: unassigned } = await client.query(
      `UPDATE leads
          SET assigned_user_id = NULL,
              assigned_at      = NULL
        WHERE assigned_user_id = $1
          AND (email IS NULL OR email NOT LIKE $2)`,
      [hari.id, `${EMAIL_TAG}-%`]
    );
    console.log(`Unassigned ${unassigned} leads from Hari (still in DB, no owner).`);

    // 3. Active webinar (optional).
    const { rows: webs } = await client.query(
      `SELECT id, name FROM webinars WHERE is_active = TRUE LIMIT 1`
    );
    const webinarId = webs[0]?.id || null;
    console.log(`Active webinar: ${webs[0]?.name || '(none)'}`);

    // 4. Pull existing test leads.
    const { rows: existing } = await client.query(
      `SELECT id, email FROM leads WHERE email LIKE $1 ORDER BY email`,
      [`${EMAIL_TAG}-%`]
    );
    console.log(`Existing test leads: ${existing.length}`);

    // 4a. Update existing test leads — re-assign to Hari, fix number, pin to top.
    if (existing.length > 0) {
      const { rowCount: updated } = await client.query(
        `UPDATE leads
            SET whatsapp_number  = $1,
                assigned_user_id = $2,
                assigned_at      = $3,
                wa_clicked       = FALSE
          WHERE email LIKE $4`,
        [TEST_NUMBER, hari.id, TOP_TS, `${EMAIL_TAG}-%`]
      );
      console.log(`Updated ${updated} existing test leads → number ${TEST_NUMBER}, owner Hari.`);
    }

    // 4b. Insert any missing test leads up to COUNT.
    const haveIdx = new Set(
      existing.map(r => {
        const m = r.email.match(/test-hari-(\d{2})@/);
        return m ? parseInt(m[1], 10) : null;
      }).filter(Boolean)
    );

    const sugars    = ['150-250', '250+'];
    const durations = ['new', 'mid', 'long', 'pre'];
    const langs     = ['tamil', 'english'];

    let inserted = 0;
    for (let i = 1; i <= COUNT; i++) {
      if (haveIdx.has(i)) continue;
      const fullName = `Test Lead ${String(i).padStart(2, '0')}`;
      const email    = `${EMAIL_TAG}-${String(i).padStart(2, '0')}@example.com`;
      const sugar    = sugars[i % sugars.length];
      const duration = durations[i % durations.length];
      const lang     = langs[i % langs.length];
      const score    = (i % 4) + 2;
      await client.query(
        `INSERT INTO leads
           (full_name, whatsapp_number, email,
            sugar_level, diabetes_duration, language_pref,
            lead_score, wa_clicked,
            assigned_user_id, assigned_at,
            webinar_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10)`,
        [fullName, TEST_NUMBER, email, sugar, duration, lang, score, hari.id, TOP_TS, webinarId]
      );
      inserted++;
    }
    console.log(`Inserted ${inserted} new test leads.`);

    // 5. Final summary.
    const { rows: after } = await client.query(
      `SELECT COUNT(*)::int AS n FROM leads
        WHERE assigned_user_id = $1`,
      [hari.id]
    );
    console.log(`\nFinal: Hari now has ${after[0].n} assigned lead(s) (should be ${COUNT}).`);

    await client.query('COMMIT');
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
