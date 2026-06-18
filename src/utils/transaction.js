import mongoose from 'mongoose';
import logger from './logger.js';

/**
 * Run a callback inside a MongoDB multi-document transaction.
 * Required for inventory_ledger + variant stock atomicity.
 */
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    logger.error({ err: error }, 'Transaction aborted');
    throw error;
  } finally {
    session.endSession();
  }
}
