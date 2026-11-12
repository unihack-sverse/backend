/**
 * Reputation 0..100 from observable behaviour. Pure and deterministic so it can be explained
 * to a player from the persisted `reputationInputs` snapshot.
 */
export function computeReputation({
  playtimeMinutes = 0,
  spendUnits = 0n,
  clubScore = 0,
  accountAgeDays = 0,
  flags = 0,
} = {}) {
  const playtime = Math.min(35, Math.log10(1 + playtimeMinutes / 60) * 14);
  const spendSrv = Number(BigInt(spendUnits) / 1_000_000n);
  const spend = Math.min(20, Math.log10(1 + spendSrv) * 8);
  const club = Math.min(20, Math.max(0, clubScore) * 0.25);
  const age = Math.min(25, Math.sqrt(Math.max(0, accountAgeDays)) * 1.25);
  const penalty = Math.max(0, flags) * 15;
  return clamp(Math.round(playtime + spend + club + age - penalty), 0, 100);
}

/** Ranking/reward weight. Sublinear below 20 so fresh or farmed passports carry little signal. */
export function reputationWeight(reputation) {
  const rep = clamp(Number(reputation) || 0, 0, 100);
  if (rep < 20) return round((rep / 20) ** 2 * 0.2);
  return round(0.2 + ((rep - 20) / 80) * 0.8);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
