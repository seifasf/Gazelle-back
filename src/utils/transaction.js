import mongoose from 'mongoose';
import logger from './logger.js';

const MAX_ATTEMPTS = 3;
const MAX_COMMIT_ATTEMPTS = 3;

function hasLabel(error, label) {
  return Boolean(
    error
    && (typeof error.hasErrorLabel === 'function'
      ? error.hasErrorLabel(label)
      : Array.isArray(error.errorLabels) && error.errorLabels.includes(label))
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function commitWithRetry(session) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      if (attempt < MAX_COMMIT_ATTEMPTS && hasLabel(error, 'UnknownTransactionCommitResult')) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Run a callback inside a MongoDB multi-document transaction.
 * Required for inventory_ledger + variant stock atomicity.
 * Write conflicts (two staff touching the same variant/order) are retried, so the
 * callback may run more than once: keep side effects outside it.
 */
export async function withTransaction(fn) {
  for (let attempt = 1; ; attempt += 1) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(session);
      await commitWithRetry(session);
      return result;
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction().catch(() => {});
      }
      if (attempt < MAX_ATTEMPTS && hasLabel(error, 'TransientTransactionError')) {
        logger.warn({ attempt, code: error.code }, 'Transaction write conflict; retrying');
        await sleep(25 * attempt + Math.floor(Math.random() * 50));
        continue;
      }
      if (!error.statusCode || error.statusCode >= 500) {
        logger.error({ err: error }, 'Transaction aborted');
      }
      throw error;
    } finally {
      session.endSession();
    }
  }
}
