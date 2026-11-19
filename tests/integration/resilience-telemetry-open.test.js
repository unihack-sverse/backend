import { describe, expect, it } from 'vitest';

import { createLiveGame, registerPlayer } from '../helpers.js';
import { publicId } from '../../src/lib/ids.js';
import { ApiKeyModel } from '../../src/modules/studios/models/index.js';
import { PlaySessionModel } from '../../src/modules/telemetry/models/index.js';
import { telemetryService } from '../../src/modules/telemetry/services/telemetry.service.js';

describe('resilience: telemetry.open concurrency', () => {
  it('enforces a single open session via partial unique index and preserves newest-wins on race', async () => {
    const { creator, game } = await createLiveGame();
    const player = await registerPlayer();
    const keyRes = await creator.agent
      .post('/api/v1/studios/me/api-keys')
      .send({ label: 'telemetry-race-test', scopes: ['game', 'read'], gameId: game.pid });
    expect(keyRes.status).toBe(201);
    const apiKey = await ApiKeyModel.findOne({ pid: keyRes.body.data.id }).lean();

    await PlaySessionModel.syncIndexes();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        telemetryService.open({ apiKey, game }, { passportId: player.id }),
      ),
    );

    expect(results).toHaveLength(5);
    const allSessions = await PlaySessionModel.find({ userId: player.user._id, gameId: game._id }).lean();
    expect(allSessions).toHaveLength(5);

    const openSessions = allSessions.filter((s) => s.closedAt === null);
    const closedSessions = allSessions.filter((s) => s.closedAt !== null);
    expect(openSessions).toHaveLength(1);
    expect(closedSessions).toHaveLength(4);
    for (const s of closedSessions) {
      expect(s.closeReason).toBe('superseded');
    }

    // Partial unique index directly rejects a second open session on raw insert.
    await expect(
      PlaySessionModel.create({
        pid: publicId('ses'),
        userId: player.user._id,
        gameId: game._id,
        apiKeyId: apiKey._id,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
