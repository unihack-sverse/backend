import { describe, expect, it } from 'vitest';

import { registerPlayer, unique } from '../helpers.js';

describe('resilience: publish runStep CAS', () => {
  it('allows only one concurrent execution of a pending step', async () => {
    const creator = await registerPlayer();
    const handle = unique('pubcas');
    await creator.agent.post('/api/v1/studios').send({ handle, displayName: 'Publish CAS Studio' });

    const jobRes = await creator.agent
      .post('/api/v1/publish/jobs')
      .send({ mode: 'ai', title: `CAS Game ${unique('g')}`, genre: 'arcade' });
    expect(jobRes.status).toBe(201);
    const jobId = jobRes.body.data.id;

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        creator.agent
          .post(`/api/v1/publish/jobs/${jobId}/steps/scan_project`)
          .send({ engine: 'godot', engineVersion: '4.3', scenes: 10, surfaces: 2 }),
      ),
    );

    const successes = responses.filter((r) => r.status === 200);
    const conflicts = responses.filter((r) => r.status === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(3);
    for (const c of conflicts) {
      expect(c.body.error.code).toBe('step_already_running');
    }

    // Sequential retry after completion still works.
    const retryRes = await creator.agent
      .post(`/api/v1/publish/jobs/${jobId}/steps/scan_project`)
      .send({ engine: 'unity', engineVersion: '2022.3', scenes: 12, surfaces: 3 });
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.data.steps[0].status).toBe('done');
  });
});
