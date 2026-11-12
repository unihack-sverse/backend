import { env } from '../config/env.js';
import { FEE_SPLIT_BPS } from '../config/constants.js';

export const SRV_DECIMALS = 6;
export const ONE_SRV = 1_000_000n;
export const BPS = 10_000n;

export function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Money must be an integer number of units.');
    return BigInt(value);
  }
  if (typeof value === 'object' && typeof value.toString === 'function') return BigInt(value.toString());
  return BigInt(value);
}

/** "120.5" → 120500000n. Rejects more than 6 decimals rather than rounding. */
export function toUnits(srv) {
  const text = String(srv).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new TypeError(`Invalid SRV amount: ${text}`);
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * ONE_SRV + BigInt(frac.padEnd(SRV_DECIMALS, '0'));
}

/** 120500000n → "120.50" (two decimals for display; never parsed back into money). */
export function fromUnits(units, decimals = 2) {
  const value = toBigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / ONE_SRV;
  const frac = (abs % ONE_SRV).toString().padStart(SRV_DECIMALS, '0').slice(0, decimals);
  return `${negative ? '-' : ''}${whole}${decimals ? `.${frac}` : ''}`;
}

export function usdSnapshot(units, rate = env.SRV_USD_RATE) {
  // Display-only conversion: scale the rate to micro-dollars to stay in integer space.
  const rateMicros = BigInt(Math.round(rate * 1_000_000));
  const cents = (toBigInt(units) * rateMicros) / (ONE_SRV * 10_000n);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function moneyFields(name, units) {
  const value = toBigInt(units);
  return {
    [`${name}Units`]: value.toString(),
    [`${name}Srv`]: fromUnits(value),
    [`${name}UsdSnapshot`]: usdSnapshot(value),
  };
}

export function applyBps(amountUnits, bps) {
  return (toBigInt(amountUnits) * BigInt(bps)) / BPS;
}

/**
 * Splits a protocol fee into its destination accounts. Parts are exact integers whose sum
 * equals `feeUnits`; the integer-division remainder always lands in treasury.
 */
export function splitFee(feeUnits, splitBps = FEE_SPLIT_BPS) {
  const fee = toBigInt(feeUnits);
  if (fee < 0n) throw new RangeError('Fee cannot be negative.');
  const parts = {};
  let allocated = 0n;
  for (const [purpose, bps] of Object.entries(splitBps)) {
    parts[purpose] = (fee * BigInt(bps)) / BPS;
    allocated += parts[purpose];
  }
  parts.treasury = (parts.treasury ?? 0n) + (fee - allocated);
  return parts;
}

/** Full primary-sale breakdown for a price at a studio fee rate. */
export function primarySaleBreakdown(priceUnits, feeBps) {
  const price = toBigInt(priceUnits);
  const protocolUnits = applyBps(price, feeBps);
  const studioUnits = price - protocolUnits;
  const parts = splitFee(protocolUnits);
  return {
    feeBps,
    studioUnits,
    protocolUnits,
    burnUnits: parts.burn,
    creatorRewardsUnits: parts.creator_rewards,
    playerRewardsUnits: parts.player_rewards,
    treasuryUnits: parts.treasury,
    curatorUnits: parts.curator,
  };
}

export function serializeBreakdown(breakdown) {
  return Object.fromEntries(
    Object.entries(breakdown).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]),
  );
}
