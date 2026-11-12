import { env } from '../../../config/env.js';
import { Conflict, Forbidden, NotFound, Unauthorized } from '../../../lib/errors.js';
import { fromUnits } from '../../../lib/money.js';
import { withTransaction } from '../../../lib/transaction.js';
import { UserModel } from '../../auth/models/index.js';
import { inventoryService } from '../../inventory/services/inventory.service.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { ledgerService, mapBalance } from '../../ledger/services/ledger.service.js';
import { curationService } from '../../rewards/services/curation.service.js';
import { StudioModel } from '../../studios/models/index.js';

export const passportService = {
  /** UC-03 passport summary; also the `/auth/me` payload. Never includes `passwordHash`. */
  async me(userId) {
    const user = await UserModel.findById(userId).lean();
    if (!user || user.status === 'deleted') throw Unauthorized('missing_session');
    const [wallet, counts, equipped, studio, curation] = await Promise.all([
      ledgerService.walletFor(user._id),
      inventoryService.countsFor(user._id),
      InventoryItemModel.find({ userId: user._id, equipped: true, status: { $in: ['owned', 'listed'] } }).select('interopTier schemaId gameId').lean(),
      user.studioId ? StudioModel.findById(user.studioId).select('pid handle displayName status').lean() : null,
      curationService.summaryFor(user._id),
    ]);
    const { interopService } = await import('../../interop/services/interop.service.js');
    const targets = await interopService.renderTargetsFor(equipped);
    const renderTargets = new Set([...targets.values()].flat().map((target) => target.gameId)).size;
    const balance = mapBalance(wallet);
    return {
      id: user.pid,
      handle: user.handle,
      displayHandle: user.handleRaw,
      email: user.email,
      emailVerified: user.emailVerified,
      roles: user.roles,
      status: user.status,
      custodialAddress: user.custodialAddress,
      reputation: user.reputation,
      skill: user.skill,
      inventory: counts,
      wardrobe: {
        highestTier: equipped.reduce((best, item) => (item.interopTier > best ? item.interopTier : best), equipped.length ? 'T1' : 'T0'),
        renderTargets,
        equipped: equipped.length,
      },
      creator: studio ? { studioId: studio.pid, handle: studio.handle, displayName: studio.displayName, status: studio.status } : null,
      studio: studio ? { id: studio.pid, handle: studio.handle, displayName: studio.displayName } : null,
      referral: { code: user.referral?.code ?? null, ...curation },
      balanceUnits: balance.balanceUnits,
      balanceSrv: balance.balanceSrv,
      faucet: { enabled: env.FAUCET_ENABLED, availableAt: faucetAvailableAt(user) },
      createdAt: user.createdAt,
    };
  },

  async balance(user) {
    return mapBalance(await ledgerService.walletFor(user._id));
  },

  /** Testnet SRV faucet, mirroring the MockSRV on-chain faucet (1,000 tSRV per 24h). */
  async faucet(user) {
    if (!env.FAUCET_ENABLED) throw Forbidden('faucet_disabled');
    const now = new Date();
    const claimed = await UserModel.findOneAndUpdate(
      { _id: user._id, $or: [{ faucetClaimedAt: null }, { faucetClaimedAt: { $lt: new Date(now.getTime() - 86_400_000) } }] },
      { $set: { faucetClaimedAt: now } },
      { new: true },
    ).lean();
    if (!claimed) throw Conflict('faucet_cooldown', { message: `Next claim at ${faucetAvailableAt(user)?.toISOString()}` });
    try {
      await withTransaction(async (session) => {
        await ledgerService.post(
          {
            legs: [
              { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: env.FAUCET_AMOUNT_UNITS, reason: 'faucet' },
              { accountId: (await ledgerService.walletFor(user._id, session))._id, direction: 'credit', amountUnits: env.FAUCET_AMOUNT_UNITS, reason: 'faucet' },
            ],
            refType: 'user',
            refId: user._id,
            memo: 'testnet faucet',
          },
          session,
        );
      });
    } catch (error) {
      await UserModel.updateOne({ _id: user._id }, { $set: { faucetClaimedAt: user.faucetClaimedAt ?? null } });
      throw error;
    }
    return { creditedUnits: env.FAUCET_AMOUNT_UNITS.toString(), creditedSrv: fromUnits(env.FAUCET_AMOUNT_UNITS), ...(await this.balance(user)) };
  },

  async findByPid(passportPid) {
    const user = await UserModel.findOne({ pid: passportPid, status: { $ne: 'deleted' } }).lean();
    if (!user) throw NotFound('passport_not_found');
    return user;
  },
};

function faucetAvailableAt(user) {
  if (!user.faucetClaimedAt) return null;
  const next = new Date(new Date(user.faucetClaimedAt).getTime() + 86_400_000);
  return next > new Date() ? next : null;
}

