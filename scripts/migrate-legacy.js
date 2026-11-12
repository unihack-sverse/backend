import mongoose from 'mongoose';

import '../src/db/register-models.js';
import { createChainAdapter, setChainAdapter } from '../src/adapters/chain/index.js';
import { env } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase, ensureIndexes } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';
import { studioBlueprints } from '../src/db/seed-blueprints.js';
import { nextSequence } from '../src/db/system-models.js';
import { randomToken } from '../src/lib/hmac.js';
import { publicId } from '../src/lib/ids.js';
import { toBigInt } from '../src/lib/money.js';
import { withTransaction } from '../src/lib/transaction.js';
import { chainService } from '../src/modules/chain/services/chain.service.js';
import { AccountModel } from '../src/modules/ledger/models/index.js';
import { ledgerService } from '../src/modules/ledger/services/ledger.service.js';

/**
 * Upgrades a database written by the pre-v1 demo backend (string balances, `studioPid`, no
 * ledger). Real sign-ups keep their login (legacy scrypt hashes verify and are rehashed on next
 * login), get a custodial address and a wallet, and their old balance is posted through the
 * ledger. Legacy demo content is dropped and replaced by the current seed.
 *
 *   node scripts/migrate-legacy.js            # dry run: prints the plan, writes nothing
 *   node scripts/migrate-legacy.js --apply    # performs it (take a backup first)
 */
const LEGACY_COLLECTIONS = [
  'studios',
  'games',
  'itemdefinitions',
  'itemDefinitions',
  'inventoryitems',
  'inventoryItems',
  'deeds',
  'listings',
  'clubposts',
  'clubPosts',
  'rewardepochs',
  'rewardEpochs',
  'reviewcases',
  'reviewCases',
  'ledgerentries',
  'ledgerEntries',
  'orders',
  'publishjobs',
  'publishJobs',
];

const apply = process.argv.includes('--apply');

async function main() {
  await connectDatabase({ syncIndexes: false });
  setChainAdapter(createChainAdapter({ nonceFloor: (address) => chainService.nonceFloor(address) }));
  const db = mongoose.connection.db;
  const users = db.collection('users');
  const demoEmails = new Set(studioBlueprints.map((entry) => entry.owner.email));

  const legacy = await users.find({ custodyIndex: { $exists: false } }).toArray();
  const demo = legacy.filter((user) => demoEmails.has(user.email) || String(user.email).endsWith('@example.com'));
  const real = legacy.filter((user) => !demo.includes(user));
  const existing = (await db.listCollections().toArray()).map((row) => row.name);
  const drop = LEGACY_COLLECTIONS.filter((name) => existing.includes(name));
  const legacyLedger = existing.includes('ledgerEntries') && (await db.collection('ledgerEntries').findOne({ side: { $exists: true } }));

  console.log(JSON.stringify({
    database: mongoose.connection.name,
    mode: apply ? 'APPLY' : 'dry-run',
    legacyUsers: legacy.length,
    keepAndUpgrade: real.map((user) => ({ handle: user.handle, balanceUnits: user.balanceUnits ?? '0' })),
    deleteDemoUsers: demo.map((user) => user.handle),
    dropCollections: drop,
    legacyLedgerShape: Boolean(legacyLedger),
    thenSeed: true,
  }, null, 2));
  if (!apply) return;

  for (const name of drop) await db.collection(name).drop().catch(() => {});
  if (demo.length) await users.deleteMany({ _id: { $in: demo.map((user) => user._id) } });
  await ensureIndexes();
  await withTransaction((session) => ledgerService.ensureSystemAccounts(session));

  for (const user of real) {
    await withTransaction(async (session) => {
      const custodyIndex = await nextSequence('custody:user', session);
      const { address } = await createChainAdapter().createAccount({ kind: 'user', index: custodyIndex });
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            custodyIndex,
            custodialAddress: address,
            studioId: null,
            roles: (user.roles ?? ['player']).filter((role) => role !== 'creator'),
            reputationSource: 'computed',
            'referral.code': `${String(user.handle).slice(0, 8)}${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`,
          },
          $unset: { balanceUnits: '', studioPid: '' },
        },
        { session },
      );
      let wallet = await AccountModel.findOne({ ownerType: 'user', ownerId: user._id, purpose: 'wallet' }).session(session);
      if (!wallet) wallet = await ledgerService.createAccount({ ownerType: 'user', ownerId: user._id, purpose: 'wallet' }, session);
      const balance = toBigInt(user.balanceUnits ?? 0);
      if (balance > 0n) {
        await ledgerService.post(
          {
            legs: [
              { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: balance, reason: 'onramp_credit' },
              { accountId: wallet._id, direction: 'credit', amountUnits: balance, reason: 'onramp_credit' },
            ],
            refType: 'user',
            refId: user._id,
            memo: `legacy balance migration ${publicId('mig')}`,
          },
          session,
        );
      }
    });
  }

  const seeded = await seedDatabase({ reset: false });
  console.log(JSON.stringify({ migratedUsers: real.length, seeded, chain: env.CHAIN_ADAPTER }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
  });
