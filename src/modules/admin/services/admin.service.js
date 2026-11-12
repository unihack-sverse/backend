import { BadRequest, NotFound } from '../../../lib/errors.js';
import { fromUnits, toBigInt } from '../../../lib/money.js';
import { writeAudit } from '../../../lib/audit.js';
import { RefreshTokenModel, UserModel } from '../../auth/models/index.js';
import { ledgerService, mapBalance } from '../../ledger/services/ledger.service.js';
import { AccountModel } from '../../ledger/models/index.js';
import { StudioModel } from '../../studios/models/index.js';
import { GameModel } from '../../games/models/index.js';
import { AuditLogModel } from '../models/index.js';

export const adminService = {
  async users({ q, status, limit = 100 } = {}) {
    const filter = {};
    if (status) filter.status = status;
    if (q) filter.$or = [{ handle: new RegExp(escape(q), 'i') }, { email: new RegExp(escape(q), 'i') }];
    const users = await UserModel.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).lean();
    const wallets = await AccountModel.find({ ownerType: 'user', ownerId: { $in: users.map((user) => user._id) } }).lean();
    const walletByUser = new Map(wallets.map((wallet) => [String(wallet.ownerId), wallet]));
    return users.map((user) => ({
      id: user.pid,
      handle: user.handle,
      email: user.email,
      roles: user.roles,
      status: user.status,
      reputation: user.reputation,
      custodialAddress: user.custodialAddress,
      balanceUnits: walletByUser.has(String(user._id)) ? mapBalance(walletByUser.get(String(user._id))).balanceUnits : '0',
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
    }));
  },

  async setUserStatus(actor, userPid, { status, reason, requestId }) {
    if (!reason?.trim()) throw BadRequest('reason_required');
    const user = await UserModel.findOneAndUpdate({ pid: userPid }, { $set: { status } }, { new: false }).lean();
    if (!user) throw NotFound('user_not_found');
    if (status === 'suspended') await RefreshTokenModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: `user.${status}`, targetType: 'user', targetId: user.pid, reason, before: { status: user.status }, after: { status }, requestId });
    return { id: user.pid, status };
  },

  async setUserRoles(actor, userPid, { roles, reason, requestId }) {
    const user = await UserModel.findOne({ pid: userPid }).lean();
    if (!user) throw NotFound('user_not_found');
    const next = [...new Set(['player', ...roles.filter((role) => role !== 'creator'), ...(user.studioId ? ['creator'] : [])])];
    await UserModel.updateOne({ _id: user._id }, { $set: { roles: next } });
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: 'user.roles', targetType: 'user', targetId: user.pid, reason: reason ?? '', before: { roles: user.roles }, after: { roles: next }, requestId });
    return { id: user.pid, roles: next };
  },

  async studios({ status, limit = 200 } = {}) {
    const filter = status ? { status } : {};
    const studios = await StudioModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    const accounts = await AccountModel.find({ _id: { $in: studios.flatMap((studio) => [studio.vaultAccountId, studio.bondAccountId]) } }).lean();
    const accountById = new Map(accounts.map((account) => [String(account._id), account]));
    const gameCounts = await GameModel.aggregate([{ $match: { studioId: { $in: studios.map((s) => s._id) } } }, { $group: { _id: '$studioId', total: { $sum: 1 }, live: { $sum: { $cond: [{ $eq: ['$status', 'live'] }, 1, 0] } } } }]);
    const countsById = new Map(gameCounts.map((row) => [String(row._id), row]));
    return studios.map((studio) => ({
      id: studio.pid,
      handle: studio.handle,
      displayName: studio.displayName,
      status: studio.status,
      feeTier: studio.feeTier,
      feeBps: studio.feeBps,
      strikes: studio.strikes,
      signerAddress: studio.signerAddress,
      vault: accountById.get(String(studio.vaultAccountId)) ? mapBalance(accountById.get(String(studio.vaultAccountId))) : null,
      bond: accountById.get(String(studio.bondAccountId)) ? mapBalance(accountById.get(String(studio.bondAccountId))) : null,
      debtUnits: toBigInt(studio.debtUnits).toString(),
      kycVerifiedAt: studio.kycVerifiedAt ?? null,
      games: countsById.get(String(studio._id))?.total ?? 0,
      liveGames: countsById.get(String(studio._id))?.live ?? 0,
      grossUnits: toBigInt(studio.counters?.grossUnits).toString(),
      grossSrv: fromUnits(studio.counters?.grossUnits ?? 0n),
      createdAt: studio.createdAt,
    }));
  },

  async setStudioStatus(actor, studioPid, { status, reason, requestId }) {
    if (!reason?.trim()) throw BadRequest('reason_required');
    const studio = await StudioModel.findOneAndUpdate({ pid: studioPid }, { $set: { status } }, { new: false }).lean();
    if (!studio) throw NotFound('studio_not_found');
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: `studio.${status}`, targetType: 'studio', targetId: studio.pid, reason, before: { status: studio.status }, after: { status }, requestId });
    return { id: studio.pid, status };
  },

  async auditLog({ targetType, targetId, limit = 100 } = {}) {
    const filter = {};
    if (targetType) filter.targetType = targetType;
    if (targetId) filter.targetId = targetId;
    const rows = await AuditLogModel.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).lean();
    const actors = await UserModel.find({ _id: { $in: rows.map((row) => row.actorId).filter(Boolean) } }).select('pid handle').lean();
    const actorById = new Map(actors.map((actor) => [String(actor._id), actor]));
    return rows.map((row) => ({
      id: row.pid,
      actor: actorById.get(String(row.actorId))?.handle ?? row.actorType,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      reason: row.reason,
      before: row.before,
      after: row.after,
      createdAt: row.createdAt,
    }));
  },

  trialBalance: () => ledgerService.trialBalance(),
  ledger: (filters) => ledgerService.listEntries(filters),
};

function escape(value) {
  return String(value).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
