import { afterAll, beforeAll, inject } from 'vitest';
import mongoose from 'mongoose';

import '../../src/db/register-models.js';
import { MockChainAdapter } from '../../src/adapters/chain/mock-chain-adapter.js';
import { setChainAdapter } from '../../src/adapters/chain/index.js';
import { connectDatabase, ensureIndexes } from '../../src/db/connection.js';
import { chainService } from '../../src/modules/chain/services/chain.service.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { withTransaction } from '../../src/lib/transaction.js';

beforeAll(async () => {
  const base = inject('mongoUri');
  const dbName = `sverse_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const uri = base.replace(/\/(\?|$)/, `/${dbName}$1`);
  await connectDatabase({ uri, syncIndexes: false });
  await ensureIndexes();
  setChainAdapter(new MockChainAdapter({ latencyMs: 0 }));
  chainService.setLeader(true);
  await withTransaction((session) => ledgerService.ensureSystemAccounts(session));
});

afterAll(async () => {
  const helpers = await import('../helpers.js').catch(() => null);
  helpers?.server?.close();
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});
