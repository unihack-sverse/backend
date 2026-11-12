import { SYSTEM_ACCOUNT_PURPOSES } from '../../../config/constants.js';
import { AppError, Conflict, PaymentRequired } from '../../../lib/errors.js';
import { epochNumberAt } from '../../../lib/epoch.js';
import { publicId } from '../../../lib/ids.js';
import { fromUnits, toBigInt } from '../../../lib/money.js';
import { AccountModel, LedgerEntryModel } from '../models/index.js';

const SYSTEM_OWNER_TYPE = {
  treasury: 'treasury',
  burn: 'pool',
  creator_rewards: 'pool',
  player_rewards: 'pool',
  curator: 'pool',
  payable: 'payable',
  onramp: 'external',
};

const systemCache = new Map();

/**
 * The only writer of `accounts` and `ledgerEntries` (01 §2.1). Balances are liabilities to the
 * owner: credit increases, debit decreases. With every transaction balanced, the sum of all
 * balances is always zero — that is the trial balance.
 */
export const ledgerService = {
  async ensureSystemAccounts(session) {
    for (const purpose of SYSTEM_ACCOUNT_PURPOSES) {
      await AccountModel.updateOne(
        { ownerType: SYSTEM_OWNER_TYPE[purpose], ownerId: null, purpose },
        {
          $setOnInsert: {
            pid: publicId('acc'),
            balanceUnits: 0n,
            lockedUnits: 0n,
            // Treasury and pools may run negative (bootstrap emission, refund deficits).
            allowNegative: ['treasury', 'onramp', 'player_rewards', 'creator_rewards'].includes(purpose),
          },
        },
        { upsert: true, session },
      );
    }
    systemCache.clear();
  },

  async systemAccountId(purpose, session) {
    if (!systemCache.has(purpose)) {
      const account = await AccountModel.findOne({ ownerId: null, purpose }).session(session ?? null).select('_id').lean();
      if (!account) throw new AppError('system_account_missing', 500, { message: `Missing ${purpose} account` });
      systemCache.set(purpose, account._id);
    }
    return systemCache.get(purpose);
  },

  async createAccount({ ownerType, ownerId, purpose }, session) {
    const [account] = await AccountModel.create(
      [{ pid: publicId('acc'), ownerType, ownerId, purpose, balanceUnits: 0n, lockedUnits: 0n, allowNegative: false }],
      { session },
    );
    return account;
  },

  async walletFor(userId, session) {
    return requireAccount({ ownerType: 'user', ownerId: userId, purpose: 'wallet' }, session);
  },

  async vaultFor(studioId, session) {
    return requireAccount({ ownerType: 'studio', ownerId: studioId, purpose: 'vault' }, session);
  },

  async bondFor(studioId, session) {
    return requireAccount({ ownerType: 'studio_bond', ownerId: studioId, purpose: 'bond' }, session);
  },

  /**
   * Posts one balanced transaction. `legs`: [{ accountId, direction, amountUnits, reason }].
   * Must run inside the caller's Mongo session so the legs commit with the business change.
   */
  async post({ legs, refType = null, refId = null, memo = '', reversalOf = null, txId = publicId('ltx') }, session) {
    if (!session) throw new AppError('ledger_requires_transaction', 500);
    if (!Array.isArray(legs) || legs.length < 2) throw new AppError('ledger_needs_two_legs', 500);

    let debits = 0n;
    let credits = 0n;
    const normalized = legs.map((leg) => {
      const amountUnits = toBigInt(leg.amountUnits);
      if (amountUnits < 0n) throw new AppError('ledger_negative_leg', 500);
      if (leg.direction === 'debit') debits += amountUnits;
      else if (leg.direction === 'credit') credits += amountUnits;
      else throw new AppError('ledger_bad_direction', 500);
      return { ...leg, amountUnits };
    });
    // Invariant 1: never write an unbalanced transaction.
    if (debits !== credits) {
      throw new AppError('ledger_unbalanced', 500, { message: `debits ${debits} != credits ${credits}` });
    }

    const epoch = epochNumberAt(new Date());
    const entries = [];
    for (const leg of normalized.filter((candidate) => candidate.amountUnits > 0n)) {
      const balanceAfter = await applyLeg(leg, session);
      entries.push({
        pid: publicId('led'),
        txId,
        accountId: leg.accountId,
        direction: leg.direction,
        amountUnits: leg.amountUnits,
        balanceAfter,
        reason: leg.reason,
        refType,
        refId,
        reversalOf,
        memo,
        epoch,
      });
    }
    if (entries.length) await LedgerEntryModel.insertMany(entries, { session });
    return { txId, entries };
  },

  /** Corrections are mirrored reversals, never edits (UC-09). */
  async reverse(txId, { memo = 'reversal', reason = 'reversal', allowNegativeFor = [] } = {}, session) {
    const already = await LedgerEntryModel.exists({ reversalOf: txId }).session(session);
    if (already) throw Conflict('already_reversed');
    const original = await LedgerEntryModel.find({ txId }).session(session).lean();
    if (!original.length) throw new AppError('ledger_tx_not_found', 404);
    return this.post(
      {
        legs: original.map((entry) => ({
          accountId: entry.accountId,
          direction: entry.direction === 'debit' ? 'credit' : 'debit',
          amountUnits: entry.amountUnits,
          reason,
          allowNegative: allowNegativeFor.some((id) => String(id) === String(entry.accountId)),
        })),
        refType: original[0].refType,
        refId: original[0].refId,
        memo,
        reversalOf: txId,
      },
      session,
    );
  },

  async lock(accountId, amountUnits, session) {
    await AccountModel.updateOne({ _id: accountId }, { $inc: { lockedUnits: toBigInt(amountUnits) } }, { session });
  },

  async unlock(accountId, amountUnits, session) {
    const amount = toBigInt(amountUnits);
    const result = await AccountModel.updateOne(
      { _id: accountId, lockedUnits: { $gte: amount } },
      { $inc: { lockedUnits: -amount } },
      { session },
    );
    if (result.modifiedCount !== 1) {
      await AccountModel.updateOne({ _id: accountId }, { $set: { lockedUnits: 0n } }, { session });
    }
  },

  async balance(accountId, session) {
    const account = await AccountModel.findById(accountId).session(session ?? null).lean();
    if (!account) throw new AppError('account_not_found', 404);
    return mapBalance(account);
  },

  async trialBalance() {
    const [byDirection, accounts, perAccount] = await Promise.all([
      LedgerEntryModel.aggregate([{ $group: { _id: '$direction', total: { $sum: '$amountUnits' } } }]),
      AccountModel.aggregate([{ $group: { _id: '$purpose', total: { $sum: '$balanceUnits' }, count: { $sum: 1 } } }]),
      LedgerEntryModel.aggregate([
        {
          $group: {
            _id: '$accountId',
            credits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amountUnits', 0n] } },
            debits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amountUnits', 0n] } },
          },
        },
      ]),
    ]);
    const totals = Object.fromEntries(byDirection.map((row) => [row._id, toBigInt(row.total)]));
    const debits = totals.debit ?? 0n;
    const credits = totals.credit ?? 0n;
    const balanceSum = accounts.reduce((sum, row) => sum + toBigInt(row.total), 0n);

    // Every cached balance must equal its entry history.
    const accountIds = perAccount.map((row) => row._id);
    const cached = await AccountModel.find({ _id: { $in: accountIds } }).select('pid balanceUnits').lean();
    const pidById = new Map(cached.map((account) => [String(account._id), account.pid]));
    const cachedById = new Map(cached.map((account) => [String(account._id), toBigInt(account.balanceUnits)]));
    const drift = perAccount
      .filter((row) => cachedById.get(String(row._id)) !== toBigInt(row.credits) - toBigInt(row.debits))
      .map((row) => pidById.get(String(row._id)) ?? String(row._id));

    return {
      balanced: debits === credits && balanceSum === 0n && drift.length === 0,
      debitsUnits: debits.toString(),
      creditsUnits: credits.toString(),
      balanceSumUnits: balanceSum.toString(),
      driftAccounts: drift,
      accounts: accounts.map((row) => ({ purpose: row._id, count: row.count, balanceUnits: toBigInt(row.total).toString() })),
      checkedAt: new Date().toISOString(),
    };
  },

  async listEntries({ accountId, reason, limit = 100, before } = {}) {
    const filter = {};
    if (accountId) filter.accountId = accountId;
    if (reason) filter.reason = reason;
    // `before` is an entry id (stable keyset paging) or, for compatibility, an ISO timestamp.
    if (before) {
      const anchor = String(before).startsWith('led_') ? await LedgerEntryModel.findOne({ pid: before }).select('createdAt _id').lean() : null;
      filter.$or = anchor
        ? [{ createdAt: { $lt: anchor.createdAt } }, { createdAt: anchor.createdAt, _id: { $lt: anchor._id } }]
        : [{ createdAt: { $lt: new Date(before) } }];
    }
    const entries = await LedgerEntryModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(Math.min(limit, 500)).lean();
    const accounts = await AccountModel.find({ _id: { $in: entries.map((entry) => entry.accountId) } })
      .select('pid purpose ownerType')
      .lean();
    const byId = new Map(accounts.map((account) => [String(account._id), account]));
    return entries.map((entry) => {
      const account = byId.get(String(entry.accountId));
      return {
        id: entry.pid,
        txId: entry.txId,
        account: account ? { id: account.pid, purpose: account.purpose, ownerType: account.ownerType } : null,
        direction: entry.direction,
        amountUnits: toBigInt(entry.amountUnits).toString(),
        amountSrv: fromUnits(entry.amountUnits),
        balanceAfterUnits: toBigInt(entry.balanceAfter).toString(),
        reason: entry.reason,
        refType: entry.refType,
        memo: entry.memo,
        reversalOf: entry.reversalOf,
        epoch: entry.epoch,
        createdAt: entry.createdAt,
      };
    });
  },

  async sumRevenue({ epoch, reasons = ['fee'] }) {
    const rows = await LedgerEntryModel.aggregate([
      { $match: { epoch, reason: { $in: reasons }, direction: 'credit' } },
      { $group: { _id: null, total: { $sum: '$amountUnits' } } },
    ]);
    return rows.length ? toBigInt(rows[0].total) : 0n;
  },
};

export function mapBalance(account) {
  const balance = toBigInt(account.balanceUnits);
  const locked = toBigInt(account.lockedUnits);
  const available = balance - locked > 0n ? balance - locked : 0n;
  return {
    accountId: account.pid,
    balanceUnits: balance.toString(),
    balanceSrv: fromUnits(balance),
    lockedUnits: locked.toString(),
    availableUnits: available.toString(),
    availableSrv: fromUnits(available),
  };
}

async function requireAccount(filter, session) {
  const account = await AccountModel.findOne(filter).session(session ?? null);
  if (!account) throw new AppError('account_not_found', 404);
  return account;
}

/** Applies one leg with a guarded $inc so a non-negative account can never go below zero. */
async function applyLeg(leg, session) {
  const delta = leg.direction === 'credit' ? leg.amountUnits : -leg.amountUnits;
  const filter = { _id: leg.accountId };
  if (leg.direction === 'debit' && !leg.allowNegative) {
    filter.$or = [
      { allowNegative: true },
      leg.requireAvailable
        ? { $expr: { $gte: [{ $subtract: ['$balanceUnits', '$lockedUnits'] }, leg.amountUnits] } }
        : { balanceUnits: { $gte: leg.amountUnits } },
    ];
  }
  const account = await AccountModel.findOneAndUpdate(filter, { $inc: { balanceUnits: delta } }, { new: true, session }).lean();
  if (!account) {
    const exists = await AccountModel.exists({ _id: leg.accountId }).session(session);
    if (!exists) throw new AppError('account_not_found', 500);
    // Invariant 2: the guarded update refused to overdraw.
    throw PaymentRequired(leg.insufficientCode ?? 'insufficient_funds');
  }
  return toBigInt(account.balanceUnits);
}
