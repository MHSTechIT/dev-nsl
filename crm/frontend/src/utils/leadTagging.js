/* Lead tag classifier — HOT / WARM / COLD / JUNK.
 *
 * Mirrors the scoring rubric:
 *
 *   ── JUNK (forces, beats everything else) ──────────────────────────
 *   • Confirm Range = "No Diabetes"
 *   • Other Languages = YES
 *   • Already Paid   = YES
 *
 *   ── Instant HOT (rule 5) ──────────────────────────────────────────
 *   • Next Batch Joining = YES   →  HOT regardless of other fields
 *
 *   ── HOT (hard criteria) ───────────────────────────────────────────
 *   • Confirm Range = 250+
 *   • Other Languages = NO
 *   • HbA1c > 7.5
 *   • Medicine = YES
 *   • Already Paid = NO
 *   • Webinar Attended = YES  OR  Available for Webinar = YES
 *
 *   ── WARM (hard criteria) ──────────────────────────────────────────
 *   • Confirm Range = 200–250
 *   • Other Languages = NO
 *   • HbA1c = 6.5 – 7.5
 *   • Already Paid = NO
 *   • Webinar Attended = YES  OR  Available for Webinar = YES
 *     OR (Patient Age 25–54  AND  Working Professional in
 *          {Business, IT, Government, Private})
 *
 *   ── COLD ──────────────────────────────────────────────────────────
 *   Anything that survived the JUNK filter and didn't qualify for
 *   HOT / WARM lands here. No need for explicit matching.
 *
 * The input is the same field shape the LeadCallNoteModal collects via
 * its useState hooks (string values, lowercase-underscored). Empty
 * strings = unanswered. `null` is returned only when there's literally
 * nothing useful filled in yet — caller can render a neutral
 * "Not classified" badge in that case.
 */

const WARM_AGE_BUCKETS = new Set(['25-34', '35-44', '45-54']);
const WARM_PROFS       = new Set(['business', 'it', 'government', 'private']);

function isYes(v) { return String(v || '').trim().toLowerCase() === 'yes'; }
function isNo(v)  { return String(v || '').trim().toLowerCase() === 'no';  }

// Treat the otherLanguages free-text field as YES when it contains anything
// meaningful (i.e., the caller wrote a language name). Empty or 'none' / 'no'
// counts as NO.
function otherLanguagesIsYes(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return false;
  if (s === 'no' || s === 'none' || s === '-' || s === 'nil') return false;
  return true;
}

/** Returns 'HOT' | 'WARM' | 'COLD' | 'JUNK' | null. */
export function classifyLeadTag(fields = {}) {
  const {
    confirmedRange,
    otherLanguages,
    hba1c,
    takesMedicine,
    alreadyPaid,
    webinarAttended,
    availableForWebinar,
    nextBatchJoining,
    patientAge,
    workingProfessional,
  } = fields;

  // ── Bail out when nothing is filled — caller renders "—". ───────────
  const allEmpty = !confirmedRange && !otherLanguages && !hba1c
    && !takesMedicine && !alreadyPaid && !webinarAttended
    && !availableForWebinar && !nextBatchJoining && !patientAge
    && !workingProfessional;
  if (allEmpty) return null;

  // ── JUNK (any one of these forces JUNK) ─────────────────────────────
  if (confirmedRange === 'no_diabetes')     return 'JUNK';
  if (otherLanguagesIsYes(otherLanguages))  return 'JUNK';
  if (isYes(alreadyPaid))                   return 'JUNK';

  // ── Instant HOT (rule 5) ────────────────────────────────────────────
  if (isYes(nextBatchJoining)) return 'HOT';

  // ── HOT hard criteria ───────────────────────────────────────────────
  const hot = confirmedRange === '250+'
    && hba1c === 'gt_7_5'
    && isYes(takesMedicine)
    && isNo(alreadyPaid)
    && (isYes(webinarAttended) || isYes(availableForWebinar));
  if (hot) return 'HOT';

  // ── WARM hard criteria ──────────────────────────────────────────────
  const warmBase = confirmedRange === '200-250'
    && hba1c === '6_5_to_7_5'
    && isNo(alreadyPaid);
  const warmSoft = isYes(webinarAttended)
    || isYes(availableForWebinar)
    || (WARM_AGE_BUCKETS.has(patientAge) && WARM_PROFS.has(workingProfessional));
  if (warmBase && warmSoft) return 'WARM';

  // ── COLD (fallback for anything not forced to JUNK / qualifying HOT or WARM) ─
  return 'COLD';
}

/** Visual presentation tokens for each tag. Used by LeadTagBadge. */
export const TAG_STYLES = {
  HOT:  { bg: 'rgba(220,38,38,0.12)',  fg: '#B91C1C', dot: '#DC2626', icon: '🔥', label: 'HOT'  },
  WARM: { bg: 'rgba(245,158,11,0.16)', fg: '#B45309', dot: '#F59E0B', icon: '🟡', label: 'WARM' },
  COLD: { bg: 'rgba(59,130,246,0.14)', fg: '#1D4ED8', dot: '#3B82F6', icon: '🔵', label: 'COLD' },
  JUNK: { bg: 'rgba(107,114,128,0.18)', fg: '#374151', dot: '#6B7280', icon: '⛔', label: 'JUNK' },
};
