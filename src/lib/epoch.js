import { env } from '../config/env.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Epochs are weekly, Monday 00:00 UTC. Epoch 1 starts at REWARDS_GENESIS_DATE. */
export function epochNumberAt(date = new Date()) {
  const genesis = genesisStart();
  const elapsed = date.getTime() - genesis.getTime();
  return Math.max(1, Math.floor(elapsed / WEEK_MS) + 1);
}

export function currentEpoch(now = new Date()) {
  return epochNumberAt(now);
}

export function epochBounds(number) {
  const startAt = new Date(genesisStart().getTime() + (number - 1) * WEEK_MS);
  return { startAt, endAt: new Date(startAt.getTime() + WEEK_MS) };
}

function genesisStart() {
  const genesis = new Date(env.REWARDS_GENESIS_DATE);
  const day = genesis.getUTCDay();
  const offset = (day + 6) % 7;
  return new Date(Date.UTC(genesis.getUTCFullYear(), genesis.getUTCMonth(), genesis.getUTCDate() - offset));
}
