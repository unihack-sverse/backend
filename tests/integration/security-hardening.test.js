import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

import { env, envSchema } from '../../src/config/env.js';
import { signWebhook, verifyWebhookSignature } from '../../src/lib/hmac.js';
import { publicId } from '../../src/lib/ids.js';
import { seal } from '../../src/lib/secret-box.js';
import { isPrivateAddress, resolveTarget, safeFetch } from '../../src/modules/review/scanners/safe-fetch.js';
import { WebhookEndpointModel } from '../../src/modules/studios/models/index.js';
import { studioService } from '../../src/modules/studios/services/studio.service.js';
import { WebhookDeliveryModel } from '../../src/modules/webhooks/models/index.js';
import { assertSafeUrl, resolveSafeWebhookTarget, webhooksService } from '../../src/modules/webhooks/services/webhooks.service.js';
import { createLiveGame } from '../helpers.js';

describe('security: envelope mapping schema (1.2)', () => {
  it('accepts valid linear, passthrough, and empty mappings', async () => {
    const { creator, game } = await createLiveGame();
    const res = await creator.agent.put(`/api/v1/games/${game.pid}/envelope`).send({
      acceptsTierMax: 'T2',
      accepts: [
        {
          schemaId: 'sts/weapon/melee/v1',
          tierMax: 'T2',
          powerTierRange: [1, 5],
          mapping: {
            damage: { from: 'power_tier', curve: 'linear', inRange: [1, 5], outRange: [10, 80] },
            rarity: { from: 'rarity', passthrough: true, values: ['common', 'rare', 'epic'] },
          },
          clampPolicy: 'reject',
        },
        {
          schemaId: 'sts/cosmetic/wearable/v1',
          tierMax: 'T1',
          mapping: {},
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.accepts).toHaveLength(2);
  });

  it('rejects XSS keys, unknown fields, invalid ranges, and oversized mappings', async () => {
    const { creator, game } = await createLiveGame();
    const put = (mapping) =>
      creator.agent.put(`/api/v1/games/${game.pid}/envelope`).send({
        acceptsTierMax: 'T2',
        accepts: [{ schemaId: 'sts/weapon/melee/v1', tierMax: 'T2', mapping }],
      });

    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`trait_${i}`, { passthrough: true }]));
    const badPayloads = [
      { '<img src=x onerror=alert(1)>': { passthrough: true } },
      { damage: { from: '<script>alert(1)</script>', passthrough: true } },
      { damage: { passthrough: true, extra: 'injected' } },
      { damage: { from: 'power_tier', curve: 'linear' } },
      { damage: { from: 'power_tier', curve: 'linear', outRange: [80, 10] } },
      { damage: { from: 'power_tier', curve: 'linear', inRange: [5, 1], outRange: [10, 80] } },
      tooMany,
    ];

    for (const mapping of badPayloads) {
      const res = await put(mapping);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });
});

describe('security: webhook SSRF protection (1.3)', () => {
  it('synchronously blocks IP literals (IPv4, decimal/hex, IPv6, v4-mapped), localhost, credentials and http in prod', async () => {
    const blocked = [
      'https://127.0.0.1/hook',
      'https://2130706433/hook',
      'https://0x7f000001/hook',
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://localhost/hook',
      'https://localhost./hook',
      'https://sub.localhost./hook',
      'https://metadata.internal/hook',
      'https://metadata.internal./hook',
    ];
    for (const url of blocked) {
      expect(() => assertSafeUrl(url, { allowPrivate: false })).toThrow(/private or reserved/);
    }
    expect(() => assertSafeUrl('http://webhook.example.com/hook', { allowPrivate: false })).toThrow(/HTTPS/);
    expect(() => assertSafeUrl('https://user:pass@webhook.example.com/hook', { allowPrivate: false })).toThrow(/credentials/);
    expect(() => assertSafeUrl('ftp://webhook.example.com/hook', { allowPrivate: true })).toThrow(/unsupported protocol/);

    const { creator } = await createLiveGame();
    const badReg = await creator.agent.post('/api/v1/studios/me/webhooks').send({
      url: 'https://user:pass@webhook.example.com/hook',
      events: ['purchase.completed'],
    });
    expect(badReg.status).toBe(422);
    expect(badReg.body.error.code).toBe('invalid_webhook_url');
  });

  it('defaults WEBHOOK_ALLOW_PRIVATE_NET to false even when NODE_ENV=development', () => {
    const devParsed = envSchema.parse({ NODE_ENV: 'development' });
    expect(devParsed.WEBHOOK_ALLOW_PRIVATE_NET).toBe(false);

    const stagingParsed = envSchema.parse({});
    expect(stagingParsed.WEBHOOK_ALLOW_PRIVATE_NET).toBe(false);

    const enabledParsed = envSchema.parse({ NODE_ENV: 'development', WEBHOOK_ALLOW_PRIVATE_NET: 'true' });
    expect(enabledParsed.WEBHOOK_ALLOW_PRIVATE_NET).toBe(true);
  });

  it('blocks SSRF URLs on PATCH /api/v1/studios/me/webhooks/:id and studioService.updateWebhook', async () => {
    const { creator } = await createLiveGame();
    const created = await creator.agent.post('/api/v1/studios/me/webhooks').send({
      url: 'https://webhook.example.com/hook',
      events: ['purchase.completed'],
    });
    expect(created.status).toBe(201);
    const endpointId = created.body.data.id;

    // Credentials and non-http(s) protocols are always rejected regardless of WEBHOOK_ALLOW_PRIVATE_NET.
    const credPatch = await creator.agent.patch(`/api/v1/studios/me/webhooks/${endpointId}`).send({
      url: 'https://user:pass@webhook.example.com/hook',
    });
    expect(credPatch.status).toBe(422);
    expect(credPatch.body.error.code).toBe('invalid_webhook_url');

    const ftpPatch = await creator.agent.patch(`/api/v1/studios/me/webhooks/${endpointId}`).send({
      url: 'ftp://webhook.example.com/hook',
    });
    expect(ftpPatch.status).toBe(400);
    expect(ftpPatch.body.error.code).toBe('validation_failed');

    await expect(
      studioService.updateWebhook(creator.user, endpointId, { url: 'ftp://webhook.example.com/hook' }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_webhook_url' });

    const prevAllowPrivate = env.WEBHOOK_ALLOW_PRIVATE_NET;
    env.WEBHOOK_ALLOW_PRIVATE_NET = false;
    try {
      const blockedUrls = [
        'https://127.0.0.1/hook',
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.5/hook',
        'https://metadata.internal/hook',
        'http://webhook.example.com/hook',
      ];
      for (const url of blockedUrls) {
        const res = await creator.agent.patch(`/api/v1/studios/me/webhooks/${endpointId}`).send({ url });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('invalid_webhook_url');
      }

      await expect(
        studioService.updateWebhook(creator.user, endpointId, { url: 'https://169.254.169.254/latest/meta-data' }),
      ).rejects.toMatchObject({ status: 422, code: 'invalid_webhook_url' });

      // Non-URL patches continue to succeed when private webhook URLs are disabled.
      const eventsPatch = await creator.agent.patch(`/api/v1/studios/me/webhooks/${endpointId}`).send({
        events: ['purchase.completed', 'game.published'],
      });
      expect(eventsPatch.status).toBe(200);
      expect(eventsPatch.body.data.url).toBe('https://webhook.example.com/hook');
    } finally {
      env.WEBHOOK_ALLOW_PRIVATE_NET = prevAllowPrivate;
    }

    const stored = await WebhookEndpointModel.findOne({ pid: endpointId }).lean();
    expect(stored.url).toBe('https://webhook.example.com/hook');
  });

  it('blocks hostnames resolving to private IPv4/IPv6 addresses when allowPrivate is false', async () => {
    const privateIps = [
      { address: '127.0.0.1', family: 4 },
      { address: '10.0.0.5', family: 4 },
      { address: '169.254.169.254', family: 4 },
      { address: '172.16.0.1', family: 4 },
      { address: '192.168.1.10', family: 4 },
      { address: '::1', family: 6 },
      { address: '::ffff:127.0.0.1', family: 6 },
      { address: 'fc00::1', family: 6 },
      { address: 'fe80::1', family: 6 },
    ];

    for (const entry of privateIps) {
      await expect(
        resolveSafeWebhookTarget('https://webhook.evil.example/hook', {
          allowPrivate: false,
          lookup: async () => [entry],
        }),
      ).rejects.toMatchObject({ code: 'ssrf_blocked' });
    }

    await expect(resolveSafeWebhookTarget('http://webhook.example.com/hook', { allowPrivate: false })).rejects.toMatchObject({ code: 'https_required' });
    await expect(resolveSafeWebhookTarget('http://127.0.0.1/hook', { allowPrivate: false })).rejects.toMatchObject({ code: 'https_required' });
    await expect(resolveSafeWebhookTarget('https://user:pass@webhook.example.com/hook', { allowPrivate: false })).rejects.toMatchObject({ code: 'credentials_in_url' });
  });

  it('allows non-production http:// non-localhost webhook delivery and rejects it when allowPrivate is false', async () => {
    const { studio } = await createLiveGame();
    const secret = 'whsec_test_secret_value_1234567890';
    const endpoint = await WebhookEndpointModel.create({
      pid: publicId('whe'),
      studioId: studio._id,
      url: 'http://webhook.example.com/hook',
      events: ['purchase.completed'],
      signingSecretPrefix: secret.slice(0, 12),
      signingSecretEnc: seal(secret),
      status: 'active',
    });

    const prodDelivery = await WebhookDeliveryModel.create({
      pid: publicId('whd'),
      endpointId: endpoint._id,
      studioId: studio._id,
      event: 'purchase.completed',
      eventId: publicId('evt'),
      payload: { id: 'evt_http_prod', event: 'purchase.completed' },
    });
    let prodFetchCalled = false;
    await webhooksService.deliverDue({
      allowPrivate: false,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => {
        prodFetchCalled = true;
        return { status: 200 };
      },
    });
    expect(prodFetchCalled).toBe(false);
    const prodRow = await WebhookDeliveryModel.findById(prodDelivery._id).lean();
    expect(prodRow.status).toBe('retrying');
    expect(prodRow.lastError).toContain('HTTPS');
    await WebhookDeliveryModel.updateOne({ _id: prodDelivery._id }, { $set: { nextRetryAt: new Date(Date.now() + 60_000) } });

    const devDelivery = await WebhookDeliveryModel.create({
      pid: publicId('whd'),
      endpointId: endpoint._id,
      studioId: studio._id,
      event: 'purchase.completed',
      eventId: publicId('evt'),
      payload: { id: 'evt_http_dev', event: 'purchase.completed' },
    });
    let devFetchCalled = false;
    await webhooksService.deliverDue({
      allowPrivate: true,
      lookup: async () => [{ address: '192.168.1.5', family: 4 }],
      fetchImpl: async () => {
        devFetchCalled = true;
        return { status: 200 };
      },
    });
    expect(devFetchCalled).toBe(true);
    expect((await WebhookDeliveryModel.findById(devDelivery._id).lean()).status).toBe('delivered');
  });

  it('pins the validated IP on real delivery, blocks private DNS in deliverDue, and keeps fetchImpl injection working', async () => {
    const { studio } = await createLiveGame();
    const secret = 'whsec_test_secret_value_1234567890';
    const endpoint = await WebhookEndpointModel.create({
      pid: publicId('whe'),
      studioId: studio._id,
      url: 'https://rebind.example.com/hook',
      events: ['purchase.completed'],
      signingSecretPrefix: secret.slice(0, 12),
      signingSecretEnc: seal(secret),
      status: 'active',
    });

    const blockedDelivery = await WebhookDeliveryModel.create({
      pid: publicId('whd'),
      endpointId: endpoint._id,
      studioId: studio._id,
      event: 'purchase.completed',
      eventId: publicId('evt'),
      payload: { id: 'evt_1', event: 'purchase.completed' },
    });

    let fetchCalled = false;
    await webhooksService.deliverDue({
      allowPrivate: false,
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      fetchImpl: async () => {
        fetchCalled = true;
        return { status: 200 };
      },
    });
    expect(fetchCalled).toBe(false);
    const failedRow = await WebhookDeliveryModel.findById(blockedDelivery._id).lean();
    expect(failedRow.status).toBe('retrying');
    expect(failedRow.lastError).toContain('private or reserved address');

    const okDelivery = await WebhookDeliveryModel.create({
      pid: publicId('whd'),
      endpointId: endpoint._id,
      studioId: studio._id,
      event: 'purchase.completed',
      eventId: publicId('evt'),
      payload: { id: 'evt_2', event: 'purchase.completed' },
    });
    await WebhookDeliveryModel.updateOne({ _id: blockedDelivery._id }, { $set: { nextRetryAt: new Date(Date.now() + 60_000) } });

    let capturedHeaders = null;
    let capturedBody = null;
    await webhooksService.deliverDue({
      allowPrivate: false,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (_url, opts) => {
        capturedHeaders = opts.headers;
        capturedBody = opts.body;
        return { status: 204 };
      },
    });
    const deliveredRow = await WebhookDeliveryModel.findById(okDelivery._id).lean();
    expect(deliveredRow.status).toBe('delivered');
    expect(verifyWebhookSignature(secret, capturedBody, capturedHeaders['X-Sverse-Signature'])).toBe(true);
    const sigTimestamp = Number(capturedHeaders['X-Sverse-Signature'].match(/t=(\d+)/)[1]);
    expect(signWebhook(secret, capturedBody, sigTimestamp)).toBe(capturedHeaders['X-Sverse-Signature']);

    // Verify real (non-fetchImpl) HTTP delivery uses IP pinning and non-prod localhost http works.
    let receivedBody = null;
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        receivedBody = body;
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
      const localEp = await WebhookEndpointModel.create({
        pid: publicId('whe'),
        studioId: studio._id,
        url: `http://localhost:${srv.address().port}/hook`,
        events: ['purchase.completed'],
        signingSecretPrefix: secret.slice(0, 12),
        signingSecretEnc: seal(secret),
        status: 'active',
      });
      const localDelivery = await WebhookDeliveryModel.create({
        pid: publicId('whd'),
        endpointId: localEp._id,
        studioId: studio._id,
        event: 'purchase.completed',
        eventId: publicId('evt'),
        payload: { id: 'evt_local', event: 'purchase.completed' },
      });
      let lookupCalls = 0;
      await webhooksService.deliverDue({
        lookup: async () => {
          lookupCalls += 1;
          return [{ address: '127.0.0.1', family: 4 }];
        },
      });
      expect(lookupCalls).toBe(1);
      expect(JSON.parse(receivedBody).id).toBe('evt_local');
      expect((await WebhookDeliveryModel.findById(localDelivery._id).lean()).status).toBe('delivered');
    } finally {
      srv.close();
    }
  });
});

describe('security: safe-fetch edge cases', () => {
  it('classifies IPv4 and IPv6 addresses accurately', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('198.18.0.1')).toBe(true);
    expect(isPrivateAddress('224.0.0.1')).toBe(true);
    expect(isPrivateAddress('::')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('ff02::1')).toBe(true);
    expect(isPrivateAddress('not-an-ip')).toBe(true);

    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('rejects unsupported protocols, empty DNS, and handles redirects and byte caps', async () => {
    await expect(resolveTarget(new URL('ftp://example.com/file'), false)).rejects.toMatchObject({ code: 'unsupported_protocol' });
    await expect(resolveTarget(new URL('https://empty.example.com/'), false, async () => [])).rejects.toMatchObject({ code: 'dns_failed' });

    const invalid = await safeFetch('not a url');
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toBe('invalid_url');

    let mode = 'redirect_loop';
    const srv = createServer((req, res) => {
      if (mode === 'redirect_loop') {
        res.statusCode = 302;
        res.setHeader('Location', '/next');
        res.end();
        return;
      }
      if (mode === 'not_found') {
        res.statusCode = 404;
        res.end('missing');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('0123456789abcdef');
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${srv.address().port}`;

    try {
      const loopRes = await safeFetch(`${base}/start`, { allowPrivate: true });
      expect(loopRes.ok).toBe(false);
      expect(loopRes.error).toBe('too_many_redirects');

      mode = 'not_found';
      const notFoundRes = await safeFetch(`${base}/missing`, { allowPrivate: true });
      expect(notFoundRes.ok).toBe(false);
      expect(notFoundRes.error).toBe('http_status_404');

      mode = 'ok';
      const cappedRes = await safeFetch(`${base}/big`, { allowPrivate: true, maxBytes: 8 });
      expect(cappedRes.ok).toBe(true);
      expect(cappedRes.truncated).toBe(true);
      expect(cappedRes.bytesRead).toBe(8);
      expect(cappedRes.headBuffer.toString('utf8')).toBe('01234567');
    } finally {
      srv.close();
    }
  });
});
