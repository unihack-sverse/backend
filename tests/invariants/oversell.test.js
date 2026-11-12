import { describe, expect, it } from 'vitest';

import { ItemDefinitionModel } from '../../src/modules/items/models/index.js';
import { buy, cosmetic, createLiveGame, registerPlayer } from '../helpers.js';

describe('oversell — parallel buys of the last unit', () => {
  it('exactly one buyer wins, the rest get sold_out', async () => {
    const { items } = await createLiveGame({ items: [cosmetic({ supplyMax: 1, priceUnits: '10000000' })] });
    const buyers = await Promise.all([...Array(20)].map(() => registerPlayer({ fund: 50_000_000n })));
    const intents = await Promise.all(
      buyers.map((buyer, index) =>
        buyer.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', `oversell-${index}-${Date.now()}`).send({ itemDefinitionId: items[0].id }),
      ),
    );
    expect(intents.every((res) => res.status === 201)).toBe(true);
    const results = await Promise.all(buyers.map((buyer, index) => buyer.agent.post(`/api/v1/checkout/intents/${intents[index].body.data.id}/confirm`).send({})));
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409 && res.body.error.code === 'sold_out')).toHaveLength(19);
    expect((await ItemDefinitionModel.findOne({ pid: items[0].id }).lean()).supply.minted).toBe(1);
    // A sold-out item rejects new intents immediately too.
    const late = await registerPlayer({ fund: 50_000_000n });
    expect((await buy(late.agent, items[0].id)).body.error.code).toBe('sold_out');
  });
});
