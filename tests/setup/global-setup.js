import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet;

// Transactions need a replica set, so tests run against a single-node in-memory replset.
export async function setup({ provide }) {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: 90_000 }],
  });
  provide('mongoUri', replSet.getUri());
}

export async function teardown() {
  await replSet?.stop();
}
