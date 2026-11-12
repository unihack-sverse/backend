import { z } from 'zod';

import { ITEM_KINDS, MANUAL_PUBLISH_STEPS, PUBLISH_STEPS } from '../../../config/constants.js';
import { Conflict, Forbidden, NotFound, Unprocessable, AppError } from '../../../lib/errors.js';
import { publicId } from '../../../lib/ids.js';
import { fromUnits, toBigInt } from '../../../lib/money.js';
import { nextSequence } from '../../../db/system-models.js';
import { chainAdapter } from '../../../adapters/chain/index.js';
import { withTransaction } from '../../../lib/transaction.js';
import { UserModel } from '../../auth/models/index.js';
import { checkoutService } from '../../checkout/services/checkout.service.js';
import { GameModel } from '../../games/models/index.js';
import { gamesService } from '../../games/services/games.service.js';
import { ItemDefinitionModel, TraitSchemaModel } from '../../items/models/index.js';
import { itemsService } from '../../items/services/items.service.js';
import { ledgerService } from '../../ledger/services/ledger.service.js';
import { reviewService } from '../../review/services/review.service.js';
import { PublishJobModel } from '../models/index.js';

const draftItem = z.object({
  sku: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  kind: z.enum(ITEM_KINDS),
  priceUnits: z.union([z.string(), z.number()]).transform((value) => String(value)).refine((value) => /^\d+$/.test(value) && BigInt(value) > 0n, 'priceUnits must be a positive integer'),
  slot: z.string().max(30).optional(),
  schemaId: z.string().optional(),
  interopTier: z.enum(['T0', 'T1', 'T2', 'T3']).optional(),
  traits: z.record(z.any()).optional(),
  supplyMax: z.number().int().positive().nullable().optional(),
  emoji: z.string().max(8).optional(),
  art: z.object({ url: z.string().max(500).optional(), emoji: z.string().max(8).optional() }).optional(),
});

const STEP_INPUT = {
  scan_project: z.object({
    engine: z.enum(['unity', 'godot', 'js', 'unreal', 'other']),
    engineVersion: z.string().max(20).optional(),
    scenes: z.number().int().min(0).max(100000).optional(),
    surfaces: z.number().int().min(0).max(1000).optional(),
    monetizableObjects: z.array(z.string().max(80)).max(200).optional(),
  }),
  propose_items: z.object({ draft: z.array(draftItem).min(1).max(100) }),
  map_to_schema: z.object({ overrides: z.record(z.string()).optional() }).default({}),
  create_item_pack: z.object({}).default({}),
  install_sdk: z.object({
    sdk: z.enum(['sverse-js', 'sverse-unity', 'sverse-godot', 'sverse-payments']),
    version: z.string().max(20),
    filesChanged: z.array(z.string().max(200)).max(200).default([]),
  }),
  test_purchase: z.object({}).default({}),
  publish: z.object({}).default({}),
};

const DEFAULT_SCHEMA = {
  cosmetic: 'sts/cosmetic/wearable/v1',
  living: 'sts/weapon/melee/v1',
  content: 'sts/content/chapter/v1',
  bundle: 'sts/bundle/v1',
};

export const publishService = {
  async createJob(actor, { mode = 'ai', gameId, title, genre }) {
    const studio = actor.studio;
    let game;
    if (gameId) {
      game = await GameModel.findOne({ pid: gameId, studioId: studio._id }).lean();
      if (!game) throw NotFound('game_not_found');
    } else {
      if (!title) throw Unprocessable('game_required');
      const created = await gamesService.create(studio, { title, genre: genre ?? 'arcade', tokenizationLevel: 'L2' });
      game = await GameModel.findOne({ pid: created.id }).lean();
    }
    /**
     * Reuse only a running job of the SAME mode. Reusing across modes handed a creator asking for a manual
     * run the stuck AI job for that game, so the manual escape hatch silently did nothing.
     */
    const running = await PublishJobModel.findOne({ gameId: game._id, status: 'running', mode }).lean();
    if (running) return mapJob(running, game);
    const names = mode === 'manual' ? MANUAL_PUBLISH_STEPS : PUBLISH_STEPS;
    const job = await PublishJobModel.create({
      pid: publicId('job'),
      studioId: studio._id,
      gameId: game._id,
      createdByUserId: actor.user?._id ?? null,
      mode,
      steps: names.map((step) => ({ step, status: 'pending', requiresApproval: step === 'create_item_pack' })),
    });
    return mapJob(job.toObject(), game);
  },

  async getJob(actor, jobPid) {
    const job = await findJob(actor, jobPid);
    return mapJob(job, await GameModel.findById(job.gameId).lean());
  },

  async listJobs(actor) {
    const jobs = await PublishJobModel.find({ studioId: actor.studio._id }).sort({ createdAt: -1 }).limit(20).lean();
    const games = await GameModel.find({ _id: { $in: jobs.map((job) => job.gameId) } }).lean();
    const gameById = new Map(games.map((game) => [String(game._id), game]));
    return jobs.map((job) => mapJob(job, gameById.get(String(job.gameId))));
  },

  /** Approval of the proposed catalog is a human act — API keys cannot approve (UC-19 §5). */
  async approveCatalog(actor, jobPid, { draft } = {}) {
    if (!actor.user) throw Forbidden('human_approval_required');
    const job = await findJob(actor, jobPid);
    const proposeDone = job.steps.find((step) => step.step === 'propose_items')?.status === 'done' || job.mode === 'manual';
    if (!proposeDone && !draft) throw Conflict('step_out_of_order');
    const set = { catalogApproved: true, approvedByUserId: actor.user._id };
    if (draft) set.draftCatalog = z.array(draftItem).min(1).max(100).parse(draft).map(normalizeDraft);
    const updated = await PublishJobModel.findOneAndUpdate({ _id: job._id }, { $set: set }, { new: true }).lean();
    return mapJob(updated, await GameModel.findById(job.gameId).lean());
  },

  /** UC-19 state machine: strict order, retries clear later steps, approval gates item writes. */
  async runStep(actor, jobPid, stepName, body = {}) {
    const job = await findJob(actor, jobPid);
    if (job.status === 'done') throw Conflict('job_finished');
    const index = job.steps.findIndex((step) => step.step === stepName);
    if (index === -1) throw NotFound('step_not_found');
    const blocking = job.steps.slice(0, index).find((step) => !['done', 'skipped'].includes(step.status));
    if (blocking) throw Conflict('step_out_of_order', { message: `${blocking.step} must finish first.` });
    if (stepName === 'create_item_pack' && !job.catalogApproved) throw Conflict('catalog_not_approved');

    const schema = STEP_INPUT[stepName];
    const input = schema.safeParse(body ?? {});
    if (!input.success) {
      throw Unprocessable('invalid_step_input', { details: input.error.issues.map((issue) => ({ field: issue.path.join('.'), issue: issue.message })) });
    }

    // A retry replaces this step's output and clears every later step.
    const startedAt = new Date();
    const steps = job.steps.map((step, i) => {
      if (i === index) return { ...step, status: 'running', startedAt, finishedAt: null, output: null, error: null };
      if (i > index) return { ...step, status: 'pending', startedAt: null, finishedAt: null, output: null, error: null };
      return step;
    });
    const reset = { steps, status: 'running', finishedAt: null };
    if (stepName === 'propose_items') reset.catalogApproved = false;
    await PublishJobModel.updateOne({ _id: job._id }, { $set: reset });

    const game = await GameModel.findById(job.gameId).lean();
    try {
      const { output, jobPatch = {} } = await STEP_HANDLERS[stepName]({ job: { ...job, ...reset }, game, actor, input: input.data });
      steps[index] = { ...steps[index], status: 'done', output, finishedAt: new Date() };
      const allDone = steps.every((step) => ['done', 'skipped'].includes(step.status));
      const finishedAt = allDone ? new Date() : null;
      await PublishJobModel.updateOne(
        { _id: job._id },
        { $set: { ...jobPatch, steps, status: allDone ? 'done' : 'running', finishedAt, elapsedMs: finishedAt ? finishedAt - job.startedAt : null } },
      );
    } catch (error) {
      steps[index] = { ...steps[index], status: 'failed', finishedAt: new Date(), error: { code: error.code ?? 'step_failed', message: error.message } };
      await PublishJobModel.updateOne({ _id: job._id }, { $set: { steps } });
      if (error instanceof AppError) throw error;
      throw new AppError('step_failed', 500, { message: error.message });
    }
    return this.getJob(actor, jobPid);
  },

  /**
   * Reference agent: performs the agent-side steps from the studio's own game metadata so the
   * console can demonstrate the full MCP flow without an external LLM. It stops at the human
   * approval gate and resumes once the catalog is approved.
   */
  async runReferenceAgent(actor, jobPid) {
    let job = await findJob(actor, jobPid);
    const game = await GameModel.findById(job.gameId).lean();
    for (const step of job.steps) {
      if (['done', 'skipped'].includes(step.status)) continue;
      if (step.step === 'create_item_pack' && !job.catalogApproved) break;
      await this.runStep(actor, jobPid, step.step, referenceInput(step.step, game));
      job = await findJob(actor, jobPid);
    }
    // Steps change the game (create items, submit, publish); return its current state.
    return mapJob(job, await GameModel.findById(job.gameId).lean());
  },
};

const STEP_HANDLERS = {
  async scan_project({ input }) {
    return { output: { ...input, scannedAt: new Date().toISOString() } };
  },

  async propose_items({ input }) {
    const draft = input.draft.map(normalizeDraft);
    return {
      output: {
        candidates: draft.length,
        packs: draft.filter((item) => item.kind === 'bundle').length,
        draft: draft.map((item) => ({ name: item.name, kind: item.kind, priceUnits: item.priceUnits, priceSrv: fromUnits(item.priceUnits) })),
      },
      jobPatch: { draftCatalog: draft, catalogApproved: false },
    };
  },

  /** Runs by default, which is what makes interop free and universal (UC-19 Post). */
  async map_to_schema({ job, input }) {
    const schemas = await TraitSchemaModel.find({ status: 'active' }).lean();
    const bySchemaId = new Map(schemas.map((schema) => [schema.schemaId, schema]));
    const mapped = job.draftCatalog.map((item) => {
      const schemaId = input.overrides?.[item.sku] ?? item.schemaId ?? DEFAULT_SCHEMA[item.kind] ?? null;
      const schema = schemaId ? bySchemaId.get(schemaId) : null;
      const requested = item.interopTier ?? (item.kind === 'cosmetic' ? 'T1' : item.kind === 'living' ? 'T2' : 'T0');
      return { ...item, schemaId: schema?.schemaId ?? null, interopTier: itemsService.resolveInteropTier(schema, requested) };
    });
    return {
      output: { mapped: mapped.map((item) => ({ sku: item.sku, schemaId: item.schemaId, interopTier: item.interopTier })) },
      jobPatch: { draftCatalog: mapped },
    };
  },

  async create_item_pack({ job, game, actor }) {
    if (!job.draftCatalog.length) throw Unprocessable('empty_catalog');
    const created = [];
    for (const draft of job.draftCatalog) {
      const existing = await ItemDefinitionModel.findOne({ gameId: game._id, sku: draft.sku }).lean();
      if (existing) {
        created.push({ id: existing.pid, sku: existing.sku, existed: true });
        continue;
      }
      /**
       * Keep the creator's art URL from the approved draft. Overwriting `art` with just an emoji silently
       * dropped every image the creator pasted, leaving the store with placeholders.
       */
      const art = {
        ...(draft.art?.url ? { url: draft.art.url } : {}),
        emoji: draft.art?.emoji ?? draft.emoji ?? '📦',
      };
      const item = await itemsService.createDefinition({
        studio: actor.studio,
        game,
        input: { ...draft, art },
      });
      created.push({ id: item.pid, sku: item.sku, interopTier: item.interopTier, schemaId: item.schemaId });
    }
    return { output: { created: created.length, items: created } };
  },

  async install_sdk({ input }) {
    return { output: input };
  },

  /** End-to-end sandbox order against a studio test passport, reversed afterwards. */
  async test_purchase({ game, actor }) {
    const item = await ItemDefinitionModel.findOne({ gameId: game._id, status: 'active' }).sort({ priceUnits: 1 }).lean();
    if (!item) throw Unprocessable('empty_catalog');
    const tester = await sandboxPassport(actor.studio);
    await withTransaction(async (session) => {
      await ledgerService.post(
        {
          legs: [
            { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: item.priceUnits, reason: 'faucet' },
            { accountId: (await ledgerService.walletFor(tester._id, session))._id, direction: 'credit', amountUnits: item.priceUnits, reason: 'faucet' },
          ],
          refType: 'user',
          refId: tester._id,
          memo: 'sandbox test purchase funding',
        },
        session,
      );
    });
    const testerSession = { ...tester, id: tester.pid };
    const intent = await checkoutService.createIntent(testerSession, { itemDefinitionId: item.pid }, { channel: 'sandbox' });
    const settled = await checkoutService.confirm(testerSession, intent.id);
    const refunded = await checkoutService.refund(null, intent.id, { reason: 'sandbox test purchase' });
    return {
      output: {
        orderId: intent.id,
        sku: item.sku,
        priceUnits: toBigInt(item.priceUnits).toString(),
        settled: settled.status === 'completed',
        chain: settled.chain,
        refunded: refunded.status === 'refunded',
        testPassport: tester.pid,
      },
    };
  },

  async publish({ game, actor }) {
    const { game: submitted, reviewCase } = await reviewService.submit(actor.studio, game.pid, {
      actor: actor.user ? { type: 'user', id: actor.user._id } : { type: 'api_key', id: actor.apiKey?._id },
    });
    const checkedCase = await reviewService.runChecks(reviewCase._id);
    const after = await GameModel.findById(submitted._id).lean();
    return {
      output: {
        status: after.status,
        blockedReason: after.blockedReason,
        reviewCaseId: reviewCase.pid,
        outcome: checkedCase?.outcome ?? 'pending',
        checks: checkedCase?.checks ?? [],
        slug: after.slug,
      },
    };
  },
};

async function findJob(actor, jobPid) {
  const job = await PublishJobModel.findOne({ pid: jobPid }).lean();
  if (!job) throw NotFound('job_not_found');
  if (String(job.studioId) !== String(actor.studio._id)) throw Forbidden('not_your_job');
  if (actor.apiKey?.gameId && String(actor.apiKey.gameId) !== String(job.gameId)) throw Forbidden('not_your_job');
  return job;
}

function normalizeDraft(item, index) {
  const sku = item.sku ?? `${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '').slice(0, 32) || 'item'}_${index + 1}`;
  return { ...item, sku, priceUnits: String(item.priceUnits) };
}

async function sandboxPassport(studio) {
  const handle = `sandbox_${studio.pid.slice(-8).toLowerCase()}`;
  const existing = await UserModel.findOne({ handle }).lean();
  if (existing) return existing;
  return withTransaction(async (session) => {
    const custodyIndex = await nextSequence('custody:user', session);
    const { address } = await chainAdapter().createAccount({ kind: 'user', index: custodyIndex });
    const [user] = await UserModel.create(
      [
        {
          pid: publicId('usr'),
          handle,
          handleRaw: handle,
          email: `${handle}@sandbox.sverse.invalid`,
          passwordHash: `sandbox:${publicId('pwd')}`,
          custodialAddress: address,
          custodyIndex,
          roles: ['player'],
          reputation: 0,
        },
      ],
      { session },
    );
    await ledgerService.createAccount({ ownerType: 'user', ownerId: user._id, purpose: 'wallet' }, session);
    return user.toObject();
  });
}

function referenceInput(step, game) {
  const engineByBuild = { web: 'js', miniapp: 'js', native: 'unity' };
  switch (step) {
    case 'scan_project':
      return { engine: engineByBuild[game.buildType] ?? 'js', engineVersion: '1.0', scenes: 12, surfaces: 3, monetizableObjects: ['cosmetics', 'starter pack'] };
    case 'propose_items':
      return {
        draft: [
          { name: `${game.title} Starter Pack`, kind: 'bundle', priceUnits: '120000000', description: 'Starter resources and a cosmetic.', emoji: '📦' },
          { name: `${game.title} Founder Jacket`, kind: 'cosmetic', priceUnits: '85000000', slot: 'torso', traits: { slot: 'torso', rarity: 'rare' }, emoji: '🧥' },
          { name: `${game.title} Season Pass`, kind: 'pass', priceUnits: '240000000', emoji: '🎟️' },
        ],
      };
    case 'install_sdk':
      return { sdk: game.buildType === 'native' ? 'sverse-unity' : 'sverse-js', version: '0.9.0', filesChanged: ['src/sverse.ts', 'src/store.ts'] };
    default:
      return {};
  }
}

export function mapJob(job, game) {
  return {
    id: job.pid,
    mode: job.mode,
    status: job.status,
    gameId: game?.pid ?? null,
    game: game ? { id: game.pid, slug: game.slug, title: game.title, status: game.status, blockedReason: game.blockedReason, tokenizationLevel: game.tokenizationLevel, buildUrl: game.buildUrl ?? null } : null,
    catalogApproved: job.catalogApproved,
    draftCatalog: (job.draftCatalog ?? []).map((item) => ({ ...item, priceSrv: fromUnits(item.priceUnits ?? 0) })),
    steps: job.steps.map((step, index) => ({
      index: index + 1,
      step: step.step,
      name: step.step,
      status: step.status,
      requiresApproval: step.requiresApproval,
      output: step.output,
      error: step.error,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    })),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: job.elapsedMs ?? (job.finishedAt ? job.finishedAt - job.startedAt : Date.now() - new Date(job.startedAt).getTime()),
    createdAt: job.createdAt,
  };
}
