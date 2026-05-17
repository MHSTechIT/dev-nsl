/* One-shot: insert 20 test leads assigned to Hari, all with the same WhatsApp
   number (8754689554), positioned at the TOP of his Assigned Leads list.

   The caller view sorts by assigned_at ASC NULLS LAST, so we set assigned_at
   to a fixed timestamp far in the past — these leads will sort above any
   existing real leads.

   Run from backend/:
       node scripts/seed_test_leads_hari.js

   Re-running is safe — it skips if 20 leads with the sentinel email pattern
   already exist for Hari. */

require('dotenv').config();
const pool = require('../db');

const TEST_NUMBER = '8754689554';
const COUNT       = 20;
const TOP_TS      = '2020-01-01T00:00:00Z';   // far in the past → top of ASC list
const EMAIL_TAG   = 'test-hari';              // sentinel for re-run safety

(async () => {
  try {
    // 1. Find Hari (case-insensitive).
    const { rows: callers } = await pool.query(
      `SELECT id, full_name FROM crm_users
        WHERE LOWER(full_name) LIKE 'hari%'
          AND role IN ('junior_caller','senior_caller')
        ORDER BY is_active DESC LIMIT 1`
    );
    if (callers.length === 0) {
      console.error('No caller named Hari found.');
      process.exit(1);
    }
    const hari = callers[0];
    console.log(`Found caller: ${hari.full_name} (${hari.id})`);

    // 2. Find the active webinar (optional but keeps things tidy).
    const { rows: webs } = await pool.query(
      `SELECT id, name FROM webinars WHERE is_active = TRUE LIMIT 1`
    );
    const webinarId = webs[0]?.id || null;
    console.log(`Active webinar: ${webs[0]?.name || '(none)'}`);

    // 3. Skip if already seeded.
    const { rows: existing } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM leads
        WHERE assigned_user_id = $1 AND email LIKE $2`,
      [hari.id, `${EMAIL_TAG}-%`]
    );
    if (existing[0].n >= COUNT) {
      console.log(`Already seeded (${existing[0].n} test leads exist for ${hari.full_name}). Nothing to do.`);
      await pool.end();
      return;
    }

    // 4. Insert COUNT leads.
    const sugars = ['150-250', '250+'];
    const durations = ['new', 'mid', 'long', 'pre'];
    const langs = ['tamil', 'english'];

    const inserted = [];
    for (let i = 1; i <= COUNT; i++) {
      const fullName = `Test Lead ${String(i).padStart(2, '0')}`;
      const email    = `${EMAIL_TAG}-${String(i).padStart(2, '0')}@example.com`;
      const sugar    = sugars[i % sugars.length];
      const duration = durations[i % durations.length];
      const lang     = langs[i % langs.length];
      const score    = (i % 4) + 2;   // 2..5

      const { rows } = await pool.query(
        `INSERT INTO leads
           (full_name, whatsapp_number, email,
            sugar_level, diabetes_duration, language_pref,
            lead_score, wa_clicked,
            assigned_user_id, assigned_at,
            webinar_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10)
         RETURNING id`,
        [fullName, TEST_NUMBER, email, sugar, duration, lang, score, hari.id, TOP_TS, webinarId]
      );
      inserted.push(rows[0].id);
    }

    console.log(`Inserted ${inserted.length} test leads assigned to ${hari.full_name}.`);
    console.log(`  whatsapp: ${TEST_NUMBER}`);
    console.log(`  assigned_at: ${TOP_TS} (will appear at top of Assigned Leads)`);
    console.log(`To clean up later:`);
    console.log(`  DELETE FROM leads WHERE assigned_user_id = '${hari.id}' AND email LIKE '${EMAIL_TAG}-%';`);

    await pool.end();
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  }
})();
