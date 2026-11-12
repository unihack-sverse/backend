import { afterAll, beforeAll, inject } from 'vitest';
import mongoose from 'mongoose';

import '../../src/db/register-models.js';
import { createChainAdapter, setChainAdapter } from '../../src/adapters/chain/index.js';
import { connectDatabase, ensureIndexes } from '../../src/db/connection.js';
import { chainService } from '../../src/modules/chain/services/chain.service.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { withTransaction } from '../../src/lib/transaction.js';

beforeAll(async () => {
  const base = inject('mongoUri');
  const uri = base.replace(/\/(\?|$)/, `/sverse_chain_${Date.now()}$1`);
  await connectDatabase({ uri, syncIndexes: false });
  await ensureIndexes();
  setChainAdapter(createChainAdapter({ kind: 'avalanche', nonceFloor: (address) => chainService.nonceFloor(address) }));
  chainService.setLeader(true);
  await withTransaction((session) => ledgerService.ensureSystemAccounts(session));
});

afterAll(async () => {
  const helpers = await import('../helpers.js').catch(() => null);
  helpers?.server?.close();
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});
