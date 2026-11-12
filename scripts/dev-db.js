import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Local single-node replica set (transactions need one) with data kept in .data/mongo.
// Usage: npm run dev:db   →   MONGODB_URI=mongodb://127.0.0.1:27018/sverse?replicaSet=sverse-dev
const port = Number(process.env.DEV_DB_PORT ?? 27018);
const dbPath = path.resolve(process.env.DEV_DB_PATH ?? '.data/mongo');
mkdirSync(dbPath, { recursive: true });

const replSet = await MongoMemoryReplSet.create({
  replSet: { name: 'sverse-dev', count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ port, dbPath, launchTimeout: 90_000 }],
});
console.log(`dev mongo ready: mongodb://127.0.0.1:${port}/sverse?replicaSet=sverse-dev (data in ${dbPath})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await replSet.stop({ doCleanup: false });
    process.exit(0);
  });
}
await new Promise(() => {});
