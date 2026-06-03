/**
 * Synthetic "Test Form" for the NSM-Caller workflow — TEMPORARY / removable.
 *
 * Adds a fake form to the batch "Meta forms" dropdown that injects 2 known
 * leads into nsm_leads, one at a time, 5 minutes apart, so the full workflow
 * (Leads page → caller assignment → WhatsApp group) can be tested without real
 * Meta leads.
 *
 * To REMOVE after testing: delete this file, its require in routes/admin.js +
 * utils/nsmLeadsSync.js, and the two hook lines (the dropdown prepend in
 * GET /nsm/lead-forms and the branch in syncBatch).
 */
const TEST_FORM_ID = '__nsm_test_form__';
const INTERVAL_MS  = 5 * 60 * 1000; // 5 minutes between leads

const TEST_LEADS = [
  { suffix: 'hari',     name: 'hari',     phone: '8754689554' },
  { suffix: 'santhosh', name: 'santhosh', phone: '9176753253' },
];

/* The dropdown entry. */
function testFormDescriptor() {
  return { id: TEST_FORM_ID, name: '🧪 Test Form (Hari, Santhosh)' };
}

/* Returns the synthetic leads that are DUE now for this batch, in the same
   shape fetchFormLeads yields: [{ id, created_time, field_data:[{name,values}] }].
   Lead i is released i*5min after the batch was created. */
function testFormLeads(batch) {
  const base = batch && batch.created_at ? new Date(batch.created_at).getTime() : Date.now();
  const now = Date.now();
  const out = [];
  TEST_LEADS.forEach((t, i) => {
    const releaseAt = base + i * INTERVAL_MS;
    // First lead is always due (immune to DB↔node clock skew on a fresh batch);
    // later leads release on their 5-min cadence.
    if (i === 0 || now >= releaseAt) {
      out.push({
        id: `${TEST_FORM_ID}_${batch.id}_${t.suffix}`,
        created_time: new Date(Math.min(releaseAt, now)).toISOString(),
        field_data: [
          { name: 'Name', values: [t.name] },
          { name: 'phone_number', values: [t.phone] },
        ],
      });
    }
  });
  return out;
}

module.exports = { TEST_FORM_ID, testFormDescriptor, testFormLeads };
