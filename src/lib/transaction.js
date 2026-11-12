import mongoose from 'mongoose';

const RETRYABLE = ['TransientTransactionError', 'UnknownTransactionCommitResult'];

/**
 * Runs `work(session)` inside a Mongo transaction, retrying transient failures. Every
 * multi-document money write goes through here (07 §21).
 */
export async function withTransaction(work, { retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(
        async () => {
          result = await work(session);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      return result;
    } catch (error) {
      attempt += 1;
      const retryable = RETRYABLE.some((label) => error?.hasErrorLabel?.(label)) || error?.code === 112;
      if (!retryable || attempt > retries) throw error;
    } finally {
      await session.endSession();
    }
  }
}
