/**
 * Remove duplicate auto_delivery journals (keep the oldest per order), then build the
 * unique { orderId, source } index that stops new duplicates.
 *
 * Usage:
 *   node scripts/dedupe-delivery-journals.js          # dry run
 *   node scripts/dedupe-delivery-journals.js --apply  # delete duplicates + build index
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import JournalEntry from '../src/models/JournalEntry.js';

const APPLY = process.argv.includes('--apply');

async function run() {
  await connectDatabase();

  const groups = await JournalEntry.aggregate([
    { $match: { source: 'auto_delivery', orderId: { $ne: null } } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: '$orderId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  const extraIds = groups.flatMap((g) => g.ids.slice(1));
  console.log(`${groups.length} order(s) with duplicate delivery journals, ${extraIds.length} extra journal(s)`);

  if (!APPLY) {
    console.log('Dry run. Re-run with --apply to delete the extras and build the index.');
    return;
  }

  if (extraIds.length) {
    const res = await JournalEntry.deleteMany({ _id: { $in: extraIds } });
    console.log(`Deleted ${res.deletedCount} duplicate journal(s)`);
  }
  await JournalEntry.createIndexes();
  console.log('Unique delivery-journal index built');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
