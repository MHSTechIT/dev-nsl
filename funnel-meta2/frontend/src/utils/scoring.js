export function computeLeadScore(sugarLevel, duration) {
  if (duration === 'pre') return 2;
  const sugarScore = sugarLevel === '250+' ? 3 : 2;
  const durationBonus = { long: 2, mid: 1, new: 0 }[duration] ?? 0;
  return Math.min(5, sugarScore + durationBonus);
}
