import '../src/db/register-models.js';
import { createChainAdapter, setChainAdapter } from '../src/adapters/chain/index.js';
import { env } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';
import { chainService } from '../src/modules/chain/services/chain.service.js';

// Usage: npm run seed:reset [-- --images]. Demo data only; refuses to reset production by default.
async function main() {
  // A reset wipes every collection. Remote databases need an explicit, typed opt-in.
  const host = new URL(env.MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.argv.includes('--yes-reset-remote')) {
    throw new Error(`Refusing to reset remote database at ${host}. Pass --yes-reset-remote if you really mean it.`);
  }
  await connectDatabase();
  setChainAdapter(createChainAdapter({ nonceFloor: (address) => chainService.nonceFloor(address) }));
  const result = await seedDatabase({ reset: true, generateImages: process.argv.includes('--images'), forceImages: false });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
  });
