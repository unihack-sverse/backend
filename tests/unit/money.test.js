import { describe, expect, it } from 'vitest';

import { applyBps, fromUnits, primarySaleBreakdown, splitFee, toUnits, usdSnapshot } from '../../src/lib/money.js';
import { computeReputation, reputationWeight } from '../../src/lib/reputation.js';
import { buildMerkleTree, rewardLeaf, verifyMerkleProof } from '../../src/lib/merkle.js';
import { canonicalJson } from '../../src/lib/canonical-json.js';
import { signWebhook, verifyWebhookSignature } from '../../src/lib/hmac.js';

describe('money', () => {
  it('splitFee sums exactly for 10,000 random amounts; remainder goes to treasury', () => {
    for (let i = 0; i < 10_000; i += 1) {
      const fee = BigInt(Math.floor(Math.random() * 1e12));
      const parts = splitFee(fee);
      expect(Object.values(parts).reduce((a, b) => a + b, 0n)).toBe(fee);
      expect(parts.treasury).toBeGreaterThanOrEqual((fee * 2000n) / 10000n);
    }
  });

  it('primary sale breakdown matches the documented 90/10 example', () => {
    const b = primarySaleBreakdown(120_000_000n, 1000);
    expect(b.studioUnits).toBe(108_000_000n);
    expect(b.protocolUnits).toBe(12_000_000n);
    expect(b.burnUnits).toBe(3_000_000n);
    expect(b.creatorRewardsUnits).toBe(3_000_000n);
    expect(b.playerRewardsUnits).toBe(2_400_000n);
    expect(b.treasuryUnits).toBe(2_400_000n);
    expect(b.curatorUnits).toBe(1_200_000n);
  });

  it('converts units without floats', () => {
    expect(toUnits('120.5')).toBe(120_500_000n);
    expect(fromUnits(120_500_000n)).toBe('120.50');
    expect(() => toUnits('1.1234567')).toThrow();
    expect(usdSnapshot(120_000_000n, 0.042)).toBe('5.04');
    expect(applyBps(1000n, 250)).toBe(25n);
  });
});

describe('reputation', () => {
  it('is pure, bounded and monotone in playtime', () => {
    const a = computeReputation({ playtimeMinutes: 60, accountAgeDays: 10 });
    const b = computeReputation({ playtimeMinutes: 60_000, accountAgeDays: 10 });
    expect(b).toBeGreaterThan(a);
    expect(computeReputation({ playtimeMinutes: 1e9, spendUnits: 10n ** 15n, clubScore: 1e6, accountAgeDays: 1e5 })).toBeLessThanOrEqual(100);
    expect(computeReputation({ flags: 10 })).toBe(0);
    expect(reputationWeight(5)).toBeLessThan(0.05);
    expect(reputationWeight(100)).toBe(1);
  });
});

describe('merkle', () => {
  it('builds OpenZeppelin-compatible proofs that verify', () => {
    const leaves = [...Array(7)].map((_, index) =>
      rewardLeaf({ epochNumber: 3, index, account: `0x${String(index + 1).padStart(40, '0')}`, amountUnits: BigInt(index + 1) * 1000n }),
    );
    const { root, proofs } = buildMerkleTree(leaves);
    leaves.forEach((leaf, index) => expect(verifyMerkleProof(leaf, proofs[index], root)).toBe(true));
    expect(verifyMerkleProof(leaves[0], proofs[1], root)).toBe(false);
  });
});

describe('signatures', () => {
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });

  it('webhook signatures verify against the raw body with ±5 min skew', () => {
    const now = Date.now();
    const header = signWebhook('whsec_x', '{"a":1}', Math.floor(now / 1000) - 200);
    expect(verifyWebhookSignature('whsec_x', '{"a":1}', header, { now })).toBe(true);
    expect(verifyWebhookSignature('whsec_x', '{"a":2}', header, { now })).toBe(false);
    expect(verifyWebhookSignature('whsec_x', '{"a":1}', header, { now: now + 10 * 60_000 })).toBe(false);
  });
});
