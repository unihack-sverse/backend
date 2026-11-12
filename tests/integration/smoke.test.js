import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { app, buy, cosmetic, createLiveGame, registerPlayer } from '../helpers.js';

describe('smoke', () => {
  it('serves health and a full purchase', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);

    const { items } = await createLiveGame({ items: [cosmetic()] });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    const res = await buy(buyer.agent, items[0].id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.balanceUnits).toBe('415000000');
  });
});
