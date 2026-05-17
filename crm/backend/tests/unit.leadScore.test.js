/**
 * MODULE 1 — Unit Tests: Lead Score calculation
 * Extracted from leads.js — tests business logic in isolation.
 */

// Replicate the exact function from routes/leads.js
function computeLeadScore(sugarLevel, duration) {
  if (duration === 'pre') return 2;
  const sugarScore = sugarLevel === '250+' ? 3 : 2;
  const durationBonus = { long: 2, mid: 1, new: 0 }[duration] ?? 0;
  return Math.min(5, sugarScore + durationBonus);
}

describe('computeLeadScore', () => {
  // Pre-diabetic always returns 2
  test('pre-diabetic returns 2 regardless of sugar level', () => {
    expect(computeLeadScore('150-250', 'pre')).toBe(2);
    expect(computeLeadScore('250+', 'pre')).toBe(2);
  });

  // High sugar (250+) cases
  test('250+ sugar + long duration = 5 (max)', () => {
    expect(computeLeadScore('250+', 'long')).toBe(5);
  });
  test('250+ sugar + mid duration = 4', () => {
    expect(computeLeadScore('250+', 'mid')).toBe(4);
  });
  test('250+ sugar + new duration = 3', () => {
    expect(computeLeadScore('250+', 'new')).toBe(3);
  });

  // Normal sugar (150-250) cases
  test('150-250 sugar + long duration = 4', () => {
    expect(computeLeadScore('150-250', 'long')).toBe(4);
  });
  test('150-250 sugar + mid duration = 3', () => {
    expect(computeLeadScore('150-250', 'mid')).toBe(3);
  });
  test('150-250 sugar + new duration = 2', () => {
    expect(computeLeadScore('150-250', 'new')).toBe(2);
  });

  // Edge cases
  test('score never exceeds 5', () => {
    expect(computeLeadScore('250+', 'long')).toBeLessThanOrEqual(5);
  });
  test('unknown duration returns base sugar score (no bonus)', () => {
    // undefined duration → bonus = 0 via nullish coalescing
    expect(computeLeadScore('250+', undefined)).toBe(3);
    expect(computeLeadScore('150-250', undefined)).toBe(2);
  });
});
