import { describe, expect, it } from 'vitest';

import { mapTraits } from '../../src/modules/interop/services/interop.service.js';

describe('invariant 6 — interop never exceeds the host envelope', () => {
  const accept = {
    schemaId: 'sts/weapon/melee/v1',
    tierMax: 'T2',
    powerTierRange: [1, 5],
    mapping: { damage: { from: 'damage', curve: 'linear', outRange: [10, 80] } },
    clampPolicy: 'reject',
  };

  it('for 1,000 random sources, mapped values never exit the band; out-of-band fails rather than clamps', () => {
    let rejected = 0;
    for (let i = 0; i < 1000; i += 1) {
      const damage = Math.floor(Math.random() * 200) - 50;
      const { mapped, violations } = mapTraits({ damage, power_tier: 1 + (i % 5) }, accept);
      if (mapped.damage !== undefined) {
        expect(mapped.damage).toBeGreaterThanOrEqual(10);
        expect(mapped.damage).toBeLessThanOrEqual(80);
      }
      if (damage < 10 || damage > 80) {
        expect(mapped.damage).toBeUndefined();
        expect(violations.length).toBeGreaterThan(0);
        rejected += 1;
      }
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it('linear normalization maps the source band into the host band', () => {
    const rule = { ...accept, mapping: { damage: { from: 'power_tier', curve: 'linear', inRange: [1, 5], outRange: [10, 80] } } };
    for (let tier = 1; tier <= 5; tier += 1) {
      const { mapped, violations } = mapTraits({ power_tier: tier }, rule);
      expect(violations).toEqual([]);
      expect(mapped.damage).toBeGreaterThanOrEqual(10);
      expect(mapped.damage).toBeLessThanOrEqual(80);
    }
    expect(mapTraits({ power_tier: 6 }, rule).violations.length).toBeGreaterThan(0);
  });
});
