import './db/register-models.js';
import { createChainAdapter, setChainAdapter } from './adapters/chain/index.js';
import { env } from './config/env.js';
import { connectDatabase } from './db/connection.js';
import { seedDatabase } from './db/seed.js';
import { logger } from './lib/logger.js';
import { chainService } from './modules/chain/services/chain.service.js';
import { ledgerService } from './modules/ledger/services/ledger.service.js';

/** Shared startup for the API and the worker: DB, system accounts, chain adapter, optional seed. */
export async function bootstrap() {
  await connectDatabase();
  setChainAdapter(createChainAdapter({ nonceFloor: (address) => chainService.nonceFloor(address) }));
  await withSession((session) => ledgerService.ensureSystemAccounts(session));
  if (env.SEED_ON_BOOT) await seedDatabase();
  logger.info({ chain: env.CHAIN_ADAPTER, chainId: env.AVALANCHE_CHAIN_ID }, 'bootstrap_complete');
}

async function withSession(fn) {
  const { withTransaction } = await import('./lib/transaction.js');
  return withTransaction(fn);
}
