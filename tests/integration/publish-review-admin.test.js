import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import zlib from 'node:zlib';

import { app, buy, cosmetic, createLiveGame, registerPlayer, seedSchemas, unique } from '../helpers.js';
import { GameModel } from '../../src/modules/games/models/index.js';
import { ReviewCaseModel } from '../../src/modules/review/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { withTransaction } from '../../src/lib/transaction.js';
import { rewardsService } from '../../src/modules/rewards/services/rewards.service.js';
import { RewardClaimModel } from '../../src/modules/rewards/models/index.js';
import { webhooksService } from '../../src/modules/webhooks/services/webhooks.service.js';
import { WebhookDeliveryModel } from '../../src/modules/webhooks/models/index.js';
import { verifyWebhookSignature } from '../../src/lib/hmac.js';
import { epochNumberAt } from '../../src/lib/epoch.js';
import { RewardEpochModel } from '../../src/modules/rewards/models/index.js';
import { publicId } from '../../src/lib/ids.js';

async function creatorWithStudio({ bond = 0n } = {}) {
  await seedSchemas();
  const creator = await registerPlayer({ fund: 2_000_000_000n });
  const handle = unique('st');
  await creator.agent.post('/api/v1/studios').send({ handle, displayName: 'Publisher' });
  if (bond) {
    const { StudioModel } = await import('../../src/modules/studios/models/index.js');
    const studio = await StudioModel.findOne({ handle }).lean();
    await withTransaction(async (session) =>
      ledgerService.post({ legs: [
        { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: bond, reason: 'onramp_credit' },
        { accountId: studio.vaultAccountId, direction: 'credit', amountUnits: bond, reason: 'onramp_credit' },
      ] }, session),
    );
  }
  return creator;
}

describe('publish pipeline (UC-19, UC-20)', () => {
  it('runs the seven AI steps in order, gates on approval, and lands in review', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const job = await creator.agent.post('/api/v1/publish/jobs').send({ mode: 'ai', title: `Emberloop ${unique('x')}`, genre: 'arcade' });
    expect(job.status).toBe(201);
    const id = job.body.data.id;
    await GameModel.updateOne({ pid: job.body.data.gameId }, { $set: { buildUrl: 'https://play.example.com/emberloop' } });

    const outOfOrder = await creator.agent.post(`/api/v1/publish/jobs/${id}/steps/map_to_schema`).send({});
    expect(outOfOrder.status).toBe(409);
    expect(outOfOrder.body.error.code).toBe('step_out_of_order');

    const started = Date.now();
    const agentRun = await creator.agent.post(`/api/v1/publish/jobs/${id}/run-agent`).send({});
    expect(agentRun.body.data.steps.filter((step) => step.status === 'done').map((step) => step.step)).toEqual(['scan_project', 'propose_items', 'map_to_schema']);
    const blocked = await creator.agent.post(`/api/v1/publish/jobs/${id}/steps/create_item_pack`).send({});
    expect(blocked.body.error.code).toBe('catalog_not_approved');

    const mapped = agentRun.body.data.draftCatalog;
    expect(mapped.find((item) => item.kind === 'cosmetic').schemaId).toBe('sts/cosmetic/wearable/v1');
    expect(mapped.find((item) => item.kind === 'cosmetic').interopTier).toBe('T1');

    await creator.agent.post(`/api/v1/publish/jobs/${id}/approve-catalog`).send({});
    const done = await creator.agent.post(`/api/v1/publish/jobs/${id}/run-agent`).send({});
    expect(done.body.data.steps.every((step) => step.status === 'done')).toBe(true);
    expect(done.body.data.status).toBe('done');
    expect(Date.now() - started).toBeLessThan(60_000);
    const testPurchase = done.body.data.steps.find((step) => step.step === 'test_purchase').output;
    expect(testPurchase.settled).toBe(true);
    expect(testPurchase.refunded).toBe(true);
    const game = await GameModel.findOne({ pid: done.body.data.gameId }).lean();
    expect(game.status).toBe('live');
    expect(game.clubId).toBeTruthy();
    expect((await ledgerService.trialBalance()).balanced).toBe(true);

    // Retrying step 3 clears steps 4–7 (but not on a finished job).
    expect((await creator.agent.post(`/api/v1/publish/jobs/${id}/steps/map_to_schema`).send({})).body.error.code).toBe('job_finished');
  });

  it('retrying a step clears every later step', async () => {
    const creator = await creatorWithStudio();
    const job = await creator.agent.post('/api/v1/publish/jobs').send({ title: `Retry ${unique('r')}` });
    const id = job.body.data.id;
    await creator.agent.post(`/api/v1/publish/jobs/${id}/run-agent`).send({});
    const retried = await creator.agent.post(`/api/v1/publish/jobs/${id}/steps/propose_items`).send({ draft: [{ name: 'Cape', kind: 'cosmetic', priceUnits: '5000000' }] });
    expect(retried.body.data.steps.map((step) => step.status)).toEqual(['done', 'done', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(retried.body.data.catalogApproved).toBe(false);
  });

  it('a publish-scope API key can drive steps but cannot approve or read game data', async () => {
    const creator = await creatorWithStudio();
    const job = await creator.agent.post('/api/v1/publish/jobs').send({ title: `Agent ${unique('a')}` });
    const key = await creator.agent.post('/api/v1/studios/me/api-keys').send({ scopes: ['publish'] });
    const auth = { Authorization: `Bearer ${key.body.data.secret}` };
    const scan = await request(app).post(`/sdk/v1/publish/jobs/${job.body.data.id}/steps/scan_project`).set(auth).send({ engine: 'godot', engineVersion: '4.3', scenes: 41, surfaces: 3 });
    expect(scan.status).toBe(200);
    expect((await request(app).post(`/sdk/v1/publish/jobs/${job.body.data.id}/approve-catalog`).set(auth).send({})).body.error.code).toBe('human_approval_required');
    expect((await request(app).get('/sdk/v1/passports/usr_x/entitlements').set(auth)).body.error.code).toBe('insufficient_scope');
    const stranger = await creatorWithStudio();
    expect((await stranger.agent.get(`/api/v1/publish/jobs/${job.body.data.id}`)).body.error.code).toBe('not_your_job');
  });

  it('missing bond leaves the game in review with blockedReason bond_required, staking releases it', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({ title: `Bondless ${unique('b')}`, genre: 'puzzle', buildUrl: 'https://play.example.com/b' });
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());
    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.body.data.status).toBe('in_review');
    expect(submit.body.data.blockedReason).toBe('bond_required');
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    expect((await GameModel.findOne({ pid: game.body.data.id }).lean()).status).toBe('live');
  });

  it('submitting requires a verified email', async () => {
    await seedSchemas();
    const creator = await registerPlayer({ verified: false });
    await creator.agent.post('/api/v1/studios').send({ handle: unique('uv'), displayName: 'Unverified' });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({ title: `Unverified ${unique('u')}`, genre: 'puzzle', buildUrl: 'https://play.example.com/u' });
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());
    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.status).toBe(403);
    expect(submit.body.error.code).toBe('email_unverified');
  });

  it('a flagged check escalates instead of publishing', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({ title: `Casino ${unique('c')}`, genre: 'arcade', buildUrl: 'http://insecure.example.com/x.exe', description: 'guaranteed returns' });
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());
    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.body.data.status).toBe('in_review');
    const moderator = await registerPlayer({ roles: ['player', 'moderator'] });
    const cases = await moderator.agent.get('/admin/v1/review-cases?outcome=escalated');
    const mine = cases.body.data.find((row) => row.game?.id === game.body.data.id);
    expect(mine.checks.filter((check) => check.status === 'flagged').map((check) => check.name).sort()).toEqual(['content_policy', 'malware_scan']);
    const reject = await moderator.agent.post(`/admin/v1/games/${game.body.data.id}/reject`).send({});
    expect(reject.status).toBe(400);
    const rejected = await moderator.agent.post(`/admin/v1/games/${game.body.data.id}/reject`).send({ reason: 'Policy violation: gambling claims' });
    expect(rejected.body.data.status).toBe('rejected');
  });
});

function makeZip(files) {
  const localHeaders = [];
  const cdHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const contentBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || '');
    const crc = zlib.crc32(contentBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(contentBuf.length, 18);
    localHeader.writeUInt32LE(contentBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const fileOffset = offset;
    offset += localHeader.length + nameBuf.length + contentBuf.length;
    localHeaders.push(localHeader, nameBuf, contentBuf);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0, 8);
    cdHeader.writeUInt16LE(0, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(contentBuf.length, 20);
    cdHeader.writeUInt32LE(contentBuf.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(fileOffset, 42);

    cdHeaders.push(cdHeader, nameBuf);
  }

  const cdBuffer = Buffer.concat(cdHeaders);
  const cdOffset = offset;
  const cdSize = cdBuffer.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdBuffer, eocd]);
}

describe('game review real URL fetch & scan pipeline (UC-20)', () => {
  let mockServer;
  let serverBaseUrl;
  let liveStudio1GamePid;

  const validZip = makeZip([
    { name: 'index.html', content: '<!doctype html><html><head><title>Great Game</title></head><body><h1>Play</h1></body></html>' },
    { name: 'game.js', content: 'console.log("running");' },
  ]);
  const hiddenExeZip = makeZip([
    { name: 'index.html', content: '<!doctype html><html><body>Play</body></html>' },
    { name: 'malware.exe', content: 'MZexecutablepayload' },
  ]);
  const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const fakeMzExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

  beforeAll(async () => {
    mockServer = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/valid-game.zip' || url.pathname === '/studio2-game.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(validZip);
      } else if (url.pathname === '/cover.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(tinyPng);
      } else if (url.pathname === '/disguised-exe.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(fakeMzExe);
      } else if (url.pathname === '/hidden-exe.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(hiddenExeZip);
      } else if (url.pathname === '/dirty-html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Clean Title</title></head><body>Win real money in our casino jackpot!</body></html>');
      } else if (url.pathname === '/dead-cover.png') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
      }
    });
    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    serverBaseUrl = `http://127.0.0.1:${mockServer.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
  });

  it('auto-approves a valid web ZIP build, captures build & cover fingerprints, and publishes game', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({
      title: `Valid Orbit ${unique('v')}`,
      genre: 'arcade',
      buildUrl: `${serverBaseUrl}/valid-game.zip`,
      coverArt: { url: `${serverBaseUrl}/cover.png` },
      description: 'An awesome space game',
    });
    expect(game.status).toBe(201);
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());

    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('live');

    const gameDoc = await GameModel.findOne({ pid: game.body.data.id }).lean();
    expect(gameDoc.status).toBe('live');
    expect(gameDoc.fingerprints?.build?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(gameDoc.fingerprints?.cover?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const reviewCase = await ReviewCaseModel.findOne({ gameId: gameDoc._id }).lean();
    expect(reviewCase.outcome).toBe('auto_approved');
    expect(reviewCase.checks.every((c) => c.status === 'passed')).toBe(true);

    liveStudio1GamePid = game.body.data.id;
  });

  it('flags a build disguised as a ZIP but containing PE executable magic bytes (MZ)', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({
      title: `Fake Zip ${unique('fz')}`,
      genre: 'puzzle',
      buildUrl: `${serverBaseUrl}/disguised-exe.zip`,
    });
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());

    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.body.data.status).toBe('in_review');

    const gameDoc = await GameModel.findOne({ pid: game.body.data.id }).lean();
    const reviewCase = await ReviewCaseModel.findOne({ gameId: gameDoc._id }).lean();
    expect(reviewCase.outcome).toBe('escalated');
    const malwareCheck = reviewCase.checks.find((c) => c.name === 'malware_scan');
    expect(malwareCheck.status).toBe('flagged');
    expect(malwareCheck.evidence.reason).toMatch(/native executable/i);
  });

  it('flags a web ZIP build containing hidden executable entries (.exe)', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({
      title: `Hidden Exe ${unique('he')}`,
      genre: 'puzzle',
      buildUrl: `${serverBaseUrl}/hidden-exe.zip`,
    });
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());

    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.body.data.status).toBe('in_review');

    const gameDoc = await GameModel.findOne({ pid: game.body.data.id }).lean();
    const reviewCase = await ReviewCaseModel.findOne({ gameId: gameDoc._id }).lean();
    expect(reviewCase.outcome).toBe('escalated');
    const malwareCheck = reviewCase.checks.find((c) => c.name === 'malware_scan');
    expect(malwareCheck.status).toBe('flagged');
    expect(malwareCheck.evidence.reason).toMatch(/contains executable files/i);
    expect(malwareCheck.evidence.entries).toContain('malware.exe');
  });

  it('flags a build URL that returns HTTP 404', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({
      title: `Dead Link ${unique('dl')}`,
      genre: 'action_rpg',
      buildUrl: `${serverBaseUrl}/not-found`,
    });
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());

    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.body.data.status).toBe('in_review');

    const gameDoc = await GameModel.findOne({ pid: game.body.data.id }).lean();
    const reviewCase = await ReviewCaseModel.findOne({ gameId: gameDoc._id }).lean();
    expect(reviewCase.outcome).toBe('escalated');
    const malwareCheck = reviewCase.checks.find((c) => c.name === 'malware_scan');
    expect(malwareCheck.status).toBe('flagged');
    expect(malwareCheck.evidence.httpStatus).toBe(404);
  });

  it('flags cross-studio duplicate build content (matching SHA-256 hash)', async () => {
    expect(liveStudio1GamePid).toBeTruthy();
    const creator2 = await creatorWithStudio({ bond: 300_000_000n });
    await creator2.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const game2 = await creator2.agent.post('/api/v1/studios/me/games').send({
      title: `Plagiarized Game ${unique('pg')}`,
      genre: 'arcade',
      buildUrl: `${serverBaseUrl}/studio2-game.zip`,
      description: 'Totally original game, trust me',
    });
    await creator2.agent.post(`/api/v1/games/${game2.body.data.id}/items`).send(cosmetic());

    const submit = await creator2.agent.post(`/api/v1/games/${game2.body.data.id}/submit`).send({});
    expect(submit.body.data.status).toBe('in_review');

    const gameDoc2 = await GameModel.findOne({ pid: game2.body.data.id }).lean();
    const reviewCase2 = await ReviewCaseModel.findOne({ gameId: gameDoc2._id }).lean();
    expect(reviewCase2.outcome).toBe('escalated');
    const ipCheck = reviewCase2.checks.find((c) => c.name === 'ip_fingerprint');
    expect(ipCheck.status).toBe('flagged');
    expect(ipCheck.evidence.code).toBe('build_hash_match');
    expect(ipCheck.evidence.match).toBe(liveStudio1GamePid);
  });

  it('flags content policy violation extracted from HTML body even with clean metadata', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({
      title: `Clean Looking Game ${unique('cg')}`,
      genre: 'strategy',
      buildUrl: `${serverBaseUrl}/dirty-html`,
      description: 'A completely benign family friendly strategy game',
    });
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());

    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.body.data.status).toBe('in_review');

    const gameDoc = await GameModel.findOne({ pid: game.body.data.id }).lean();
    const reviewCase = await ReviewCaseModel.findOne({ gameId: gameDoc._id }).lean();
    expect(reviewCase.outcome).toBe('escalated');
    const policyCheck = reviewCase.checks.find((c) => c.name === 'content_policy');
    expect(policyCheck.status).toBe('flagged');
    expect(policyCheck.evidence.terms).toContain('casino');
    expect(policyCheck.evidence.sources).toContain('build_page');
  });

  it('flags dead cover art URL that returns HTTP 404', async () => {
    const creator = await creatorWithStudio({ bond: 300_000_000n });
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '250000000' });
    const game = await creator.agent.post('/api/v1/studios/me/games').send({
      title: `Broken Cover ${unique('bc')}`,
      genre: 'puzzle',
      buildUrl: `${serverBaseUrl}/valid-game.zip`,
      coverArt: { url: `${serverBaseUrl}/dead-cover.png` },
    });
    await creator.agent.post(`/api/v1/games/${game.body.data.id}/items`).send(cosmetic());

    const submit = await creator.agent.post(`/api/v1/games/${game.body.data.id}/submit`).send({});
    expect(submit.body.data.status).toBe('in_review');

    const gameDoc = await GameModel.findOne({ pid: game.body.data.id }).lean();
    const reviewCase = await ReviewCaseModel.findOne({ gameId: gameDoc._id }).lean();
    expect(reviewCase.outcome).toBe('escalated');
    const ipCheck = reviewCase.checks.find((c) => c.name === 'ip_fingerprint');
    expect(ipCheck.status).toBe('flagged');
    expect(ipCheck.evidence.reason).toMatch(/cover art URL returned HTTP 404/i);
  });
});

describe('admin (UC-09, UC-22, UC-26)', () => {
  it('non-staff get 404 on every admin route; admins see a balanced trial balance', async () => {
    const player = await registerPlayer();
    for (const path of ['/admin/v1/review-cases', '/admin/v1/ledger/trial-balance', '/admin/v1/users', '/admin/v1/chain/ops']) {
      expect((await player.agent.get(path)).status).toBe(404);
      expect((await request(app).get(path)).status).toBe(404);
    }
    const moderator = await registerPlayer({ roles: ['player', 'moderator'] });
    expect((await moderator.agent.get('/admin/v1/ledger/trial-balance')).status).toBe(404);
    const admin = await registerPlayer({ roles: ['player', 'admin'] });
    const trial = await admin.agent.get('/admin/v1/ledger/trial-balance');
    expect(trial.status).toBe(200);
    expect(trial.body.data.balanced).toBe(true);
  });

  it('slashing the bond below minimum suspends the studio and delists its games', async () => {
    const { studio, game } = await createLiveGame();
    const admin = await registerPlayer({ roles: ['player', 'admin'] });
    const res = await admin.agent.post(`/admin/v1/studios/${studio.pid}/slash-bond`).send({ amountUnits: '100000000', reason: 'Fabricated deeds (case rvw_x)' });
    expect(res.status).toBe(200);
    expect(res.body.data.suspended).toBe(true);
    expect((await GameModel.findById(game._id).lean()).status).toBe('delisted');
    expect((await admin.agent.post(`/admin/v1/studios/${studio.pid}/slash-bond`).send({ amountUnits: '999999999999', reason: 'again please' })).body.error.code).toBe('slash_exceeds_bond');
  });
});

describe('rewards (UC-26, UC-27)', () => {
  it('a zero-revenue epoch publishes empty without error', async () => {
    const number = 5000 + Math.floor(Math.random() * 1000);
    await RewardEpochModel.create({ pid: publicId('epo'), number, startAt: new Date('2000-01-03'), endAt: new Date('2000-01-10'), status: 'open' });
    const epoch = await rewardsService.closeEpoch(number);
    expect(epoch.status).toBe('published');
    expect(epoch.playerPoolUnits).toBe('0');
    expect(epoch.distributedUnits).toBe('0');
  });

  it('pools come from realized fees and claims persist score inputs', async () => {
    const { items } = await createLiveGame({ items: [cosmetic({ priceUnits: '1000000000' })] });
    const buyer = await registerPlayer({ fund: 2_000_000_000n });
    await buy(buyer.agent, items[0].id);
    const number = epochNumberAt(new Date());
    const epoch = await rewardsService.closeEpoch(number, { force: true });
    expect(BigInt(epoch.playerPoolUnits)).toBeLessThanOrEqual((BigInt(epoch.feeRevenueUnits) * 2000n) / 10000n);
    expect(BigInt(epoch.creatorPoolUnits)).toBe((BigInt(epoch.feeRevenueUnits) * 2500n) / 10000n);
    const claims = await RewardClaimModel.find({ epochNumber: number }).lean();
    for (const claim of claims) expect(claim.scoreInputs).toBeTruthy();
    expect(claims.some((claim) => claim.claimantType === 'studio')).toBe(true);
    expect(epoch.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('webhooks', () => {
  it('delivers signed events at-least-once and retries failures', async () => {
    const received = [];
    let fail = true;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = fail ? 500 : 200;
        res.end('ok');
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const url = `http://127.0.0.1:${server.address().port}/hook`;

    const { creator, items } = await createLiveGame({ items: [cosmetic()] });
    const endpoint = await creator.agent.post('/api/v1/studios/me/webhooks').send({ url, events: ['purchase.completed'] });
    expect(endpoint.status).toBe(201);
    const secret = endpoint.body.data.signingSecret;
    const buyer = await registerPlayer({ fund: 500_000_000n });
    await buy(buyer.agent, items[0].id);
    await new Promise((resolve) => setTimeout(resolve, 150));

    await webhooksService.deliverDue();
    const delivery = await WebhookDeliveryModel.findOne({ event: 'purchase.completed' }).sort({ createdAt: -1 }).lean();
    expect(delivery.status).toBe('retrying');
    fail = false;
    await WebhookDeliveryModel.updateOne({ _id: delivery._id }, { $set: { nextRetryAt: new Date(0) } });
    await webhooksService.deliverDue();
    expect((await WebhookDeliveryModel.findById(delivery._id).lean()).status).toBe('delivered');

    const last = received.at(-1);
    expect(verifyWebhookSignature(secret, last.body, last.headers['x-sverse-signature'])).toBe(true);
    const payload = JSON.parse(last.body);
    expect(payload.event).toBe('purchase.completed');
    expect(payload.id).toMatch(/^evt_/);
    expect(payload.data.grossUnits).toBe('85000000');
    expect(received.map((row) => JSON.parse(row.body).id).every((id) => id === payload.id)).toBe(true);
    server.close();
  });
});
