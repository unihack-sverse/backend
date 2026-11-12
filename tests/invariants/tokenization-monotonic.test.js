import { describe, expect, it } from 'vitest';

import { GameModel } from '../../src/modules/games/models/index.js';
import { createLiveGame, living } from '../helpers.js';

describe('invariant 5 — tokenization level is monotonic', () => {
  it('service layer rejects L3 → L2 with level_downgrade_forbidden', async () => {
    const { creator, game, items } = await createLiveGame({ items: [living()], tokenizationLevel: 'L3' });
    const res = await creator.agent.patch(`/api/v1/games/${game.pid}`).send({ tokenizationLevel: 'L2' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('level_downgrade_forbidden');
    const up = await creator.agent.patch(`/api/v1/games/${game.pid}`).send({ tokenizationLevel: 'L4' });
    expect(up.status).toBe(200);
    const itemDown = await creator.agent.patch(`/api/v1/items/${items[0].id}`).send({ tokenizationLevel: 'L2' });
    expect(itemDown.body.error.code).toBe('level_downgrade_forbidden');
  });

  it('model layer rejects a downgrade even when the service is bypassed', async () => {
    const { game } = await createLiveGame({ tokenizationLevel: 'L3' });
    const doc = await GameModel.findById(game._id);
    doc.tokenizationLevel = 'L2';
    await expect(doc.save()).rejects.toMatchObject({ code: 'level_downgrade_forbidden' });
    await expect(GameModel.updateOne({ _id: game._id }, { $set: { tokenizationLevel: 'L1' } })).rejects.toMatchObject({ code: 'level_write_requires_document_save' });
  });

  it('slug is immutable once published', async () => {
    const { creator, game } = await createLiveGame();
    const res = await creator.agent.patch(`/api/v1/games/${game.pid}`).send({ slug: 'another-slug' });
    expect(res.body.error.code).toBe('slug_immutable');
  });
});
