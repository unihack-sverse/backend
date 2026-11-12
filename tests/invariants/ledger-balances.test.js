import { describe, expect, it } from 'vitest';

import { buy, cosmetic, createLiveGame, registerPlayer } from '../helpers.js';
import { LedgerEntryModel } from '../../src/modules/ledger/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { withTransaction } from '../../src/lib/transaction.js';
import { toBigInt } from '../../src/lib/money.js';

describe('invariant 1 — the ledger always balances', () => {
  it('every transaction has Σdebits === Σcredits and the trial balance is zero', async () => {
    const { items } = await createLiveGame({ items: [cosmetic(), cosmetic({ priceUnits: '123456789' })] });
    const buyer = await registerPlayer({ fund: 1_000_000_000n });
    expect((await buy(buyer.agent, items[0].id)).status).toBe(200);
    expect((await buy(buyer.agent, items[1].id)).status).toBe(200);

    const txs = await LedgerEntryModel.aggregate([
      {
        $group: {
          _id: '$txId',
          debits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amountUnits', 0n] } },
          credits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amountUnits', 0n] } },
        },
      },
    ]);
    expect(txs.length).toBeGreaterThan(3);
    for (const tx of txs) expect(toBigInt(tx.debits)).toBe(toBigInt(tx.credits));

    const trial = await ledgerService.trialBalance();
    expect(trial.balanced).toBe(true);
    expect(trial.balanceSumUnits).toBe('0');
    expect(trial.driftAccounts).toEqual([]);
  });

  it('refuses to write an unbalanced transaction', async () => {
    const { user } = await registerPlayer();
    await expect(
      withTransaction(async (session) => {
        const wallet = await ledgerService.walletFor(user._id, session);
        await ledgerService.post(
          {
            legs: [
              { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: 10n, reason: 'faucet' },
              { accountId: wallet._id, direction: 'credit', amountUnits: 11n, reason: 'faucet' },
            ],
          },
          session,
        );
      }),
    ).rejects.toMatchObject({ code: 'ledger_unbalanced' });
  });

  it('ledger entries are append-only at the model layer', async () => {
    const entry = await LedgerEntryModel.findOne().lean();
    await expect(LedgerEntryModel.updateOne({ _id: entry._id }, { $set: { memo: 'x' } })).rejects.toMatchObject({ code: 'ledger_is_append_only' });
    await expect(LedgerEntryModel.deleteOne({ _id: entry._id })).rejects.toMatchObject({ code: 'ledger_is_append_only' });
  });

  it('a reversal returns the trial balance to its prior state', async () => {
    const { user } = await registerPlayer();
    const before = await ledgerService.trialBalance();
    const { txId } = await withTransaction(async (session) =>
      ledgerService.post(
        {
          legs: [
            { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: 5_000_000n, reason: 'faucet' },
            { accountId: (await ledgerService.walletFor(user._id, session))._id, direction: 'credit', amountUnits: 5_000_000n, reason: 'faucet' },
          ],
        },
        session,
      ),
    );
    await withTransaction((session) => ledgerService.reverse(txId, {}, session));
    const after = await ledgerService.trialBalance();
    expect(after.balanced).toBe(true);
    expect(after.accounts.find((row) => row.purpose === 'wallet')?.balanceUnits).toBe(before.accounts.find((row) => row.purpose === 'wallet')?.balanceUnits);
    await expect(withTransaction((session) => ledgerService.reverse(txId, {}, session))).rejects.toMatchObject({ code: 'already_reversed' });
  });
});
