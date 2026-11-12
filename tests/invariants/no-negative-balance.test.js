import { describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/modules/ledger/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { withTransaction } from '../../src/lib/transaction.js';
import { toBigInt } from '../../src/lib/money.js';
import { buy, cosmetic, createLiveGame, registerPlayer } from '../helpers.js';

describe('invariant 2 — no negative balances outside treasury/pools', () => {
  it('20 genuinely parallel debits cannot overdraw one wallet', async () => {
    const { user } = await registerPlayer({ fund: 100_000_000n });
    const debit = () =>
      withTransaction(async (session) =>
        ledgerService.post(
          {
            legs: [
              { accountId: (await ledgerService.walletFor(user._id, session))._id, direction: 'debit', amountUnits: 10_000_000n, reason: 'purchase' },
              { accountId: await ledgerService.systemAccountId('treasury', session), direction: 'credit', amountUnits: 10_000_000n, reason: 'fee' },
            ],
          },
          session,
        ),
      );
    const results = await Promise.allSettled([...Array(20)].map(debit));
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    expect(ok).toBe(10);
    for (const result of results.filter((r) => r.status === 'rejected')) expect(result.reason.code).toBe('insufficient_funds');
    const wallet = await ledgerService.walletFor(user._id);
    expect(toBigInt(wallet.balanceUnits)).toBe(0n);
  });

  it('concurrent purchases cannot overdraw a wallet', async () => {
    const { items } = await createLiveGame({ items: [cosmetic({ priceUnits: '40000000' }), cosmetic({ priceUnits: '40000000' }), cosmetic({ priceUnits: '40000000' })] });
    const buyer = await registerPlayer({ fund: 80_000_000n });
    const results = await Promise.all(items.map((item) => buy(buyer.agent, item.id)));
    expect(results.filter((res) => res.status === 200)).toHaveLength(2);
    expect(results.filter((res) => res.status === 402)).toHaveLength(1);
    const wallet = await ledgerService.walletFor(buyer.user._id);
    expect(toBigInt(wallet.balanceUnits)).toBe(0n);
  });

  it('allowNegative is set only on treasury and reward pools', async () => {
    const negative = await AccountModel.find({ allowNegative: true }).lean();
    expect(negative.map((account) => account.purpose).sort()).toEqual(['creator_rewards', 'onramp', 'player_rewards', 'treasury']);
  });
});
