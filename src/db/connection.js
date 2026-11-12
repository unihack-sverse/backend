import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export async function connectDatabase({ uri = env.MONGODB_URI, syncIndexes = env.NODE_ENV !== 'production' } = {}) {
  mongoose.set('strictQuery', true);

  let attempt = 0;
  for (;;) {
    try {
      await mongoose.connect(uri, {
        autoIndex: false,
        serverSelectionTimeoutMS: 5000,
        // int64 money must round-trip as BigInt, never as a lossy JS number.
        useBigInt64: true,
      });
      break;
    } catch (error) {
      attempt += 1;
      if (attempt >= 5) throw error;
      logger.warn({ err: error, attempt }, 'mongo_connect_retry');
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  if (syncIndexes) await ensureIndexes();
}

export async function ensureIndexes() {
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection().catch(() => {});
    await model.syncIndexes();
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export function databaseStatus() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    state: states[mongoose.connection.readyState] ?? 'unknown',
    ready: mongoose.connection.readyState === 1,
    name: mongoose.connection.name,
  };
}
