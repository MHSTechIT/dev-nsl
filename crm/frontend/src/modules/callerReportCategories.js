/* callerReportCategories.js — the single place that turns the RAW disposition
   atoms returned by GET /api/admin/caller-report into the human-facing report
   columns (the 14 "Lead Outcome" categories + the funnel/conversion numbers).

   Why this exists: a few categories in the spreadsheet ("Diabetes interested in
   webinar", "Diabetes not interested in webinar", "Disqualified") are composites
   whose exact business rule wasn't pinned down. The backend therefore returns
   plain atoms (per-outcome and per-subtag counts) and ALL composition happens
   here — so when the rules are confirmed it's a one-file change, no SQL.

   Rows marked `tentative: true` use a best-effort rule flagged `TODO confirm`. */

const num = (v) => Number(v) || 0;

/* ── The 14 disposition categories, in spreadsheet order ─────────────────────
   `compute(r)` reads the raw atoms on a caller row. */
export const DISPOSITION_CATEGORIES = [
  { key: 'new',                  label: 'New',                               compute: (r) => num(r.new_leads) },
  // TODO confirm: "Diabetes interested in webinar" — best-effort = leads the
  // caller flagged interested. Likely should be confirmed-diabetes AND
  // available_for_webinar = yes once the rule is set.
  { key: 'diab_int_webinar',     label: 'Diabetes interested in webinar',    compute: (r) => num(r.interested), tentative: true },
  { key: 'no_sugar_interested',  label: 'No Sugar Interested',               compute: (r) => num(r.st_no_sugar_interested) },
  { key: 'follow_up',            label: 'Follow Up',                         compute: (r) => num(r.o_follow_up) },
  { key: 'dnp',                  label: 'DNP',                               compute: (r) => num(r.o_not_picked) },
  { key: 'no_sugar_not_int',     label: 'No Sugar Not Interested',           compute: (r) => num(r.st_no_sugar_not_interested) },
  // TODO confirm: "Diabetes not interested in webinar" — best-effort =
  // not_interested leads who declined the webinar slot.
  { key: 'diab_not_int_webinar', label: 'Diabetes not interested in webinar', compute: (r) => num(r.st_not_available_for_webinar), tentative: true },
  { key: 'not_interested',       label: 'Not interested',                    compute: (r) => num(r.o_not_interested) },
  { key: 'not_registered',       label: 'Not Registered',                    compute: (r) => num(r.st_not_register) },
  // TODO confirm: "Disqualified" — best-effort = junk-ish subtags
  // (no diabetes / wrong number / already attended).
  { key: 'disqualified',         label: 'Disqualified',                      compute: (r) => num(r.st_no_diabetes) + num(r.st_wrong_number) + num(r.st_already_attended), tentative: true },
  { key: 'next_batch',           label: 'Next Batch',                        compute: (r) => num(r.next_batch) },
  { key: 'just_for_knowledge',   label: 'Just for Knowledge',                compute: (r) => num(r.st_just_for_knowledge) },
  { key: 'other_language',       label: 'Other Language',                    compute: (r) => num(r.st_other_languages) },
  { key: 'already_paid',         label: 'Already Paid',                      compute: (r) => num(r.st_already_paid) },
];

/* Returns { [key]: count } for every disposition category for one caller row. */
export function composeCategories(row) {
  const out = {};
  for (const c of DISPOSITION_CATEGORIES) out[c.key] = c.compute(row);
  return out;
}

/* ── Funnel + conversion headline numbers (inline columns) ───────────────────
   assigned    = cumulative assignment events (fresh + reassigned) in the window.
   connected   = "answered" = notes with outcome completed/follow_up.
   notPicking  = outbound calls the customer didn't pick up.
   interested  = Hot + Warm + Cold (from note history).
   actualLeads = FRESH assignments only (kind='fresh') — excludes moved-back leads.
   connPct: TODO confirm the exact denominator — seeded as connected / assigned. */
export function funnelMetrics(row) {
  const assigned    = num(row.assigned);
  const connected   = num(row.answered);
  const notPicking  = num(row.missed);
  const interested  = num(row.interested);
  const actualLeads = num(row.actual_leads);
  // L→C % = connected (answered) ÷ leads actually assigned to the caller (their
  // current book). Falls back to windowed assignment events only if the snapshot
  // count isn't present (older API response).
  const assignedLeads = num(row.current_assigned) || assigned;
  const connPct     = assignedLeads > 0 ? Math.round((connected / assignedLeads) * 1000) / 10 : null;
  return { assigned, assignedLeads, connected, notPicking, interested, actualLeads, connPct };
}

export { num };
