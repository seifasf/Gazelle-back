/**
 * Backfill Customer.lifetimeCancelled from cancelled orders,
 * and set riskFlag=watch when cancels > 2 (without overriding vip/high_risk).
 *
 * Usage: node scripts/backfill-lifetime-cancelled.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Order from '../src/models/Order.js';
import Customer from '../src/models/Customer.js';
import { FREQUENT_CANCEL_THRESHOLD } from '../src/services/customer.service.js';

async function run() {
  await connectDatabase();

  const counts = await Order.aggregate([
    { $match: { internalStatus: 'cancelled', customerId: { $ne: null } } },
    { $group: { _id: '$customerId', cancelled: { $sum: 1 } } },
  ]);

  let updated = 0;
  let flagged = 0;

  for (const row of counts) {
    const customer = await Customer.findByIdAndUpdate(
      row._id,
      { $set: { lifetimeCancelled: row.cancelled } },
      { new: true }
    );
    if (!customer) continue;
    updated += 1;

    if (
      row.cancelled > FREQUENT_CANCEL_THRESHOLD &&
      (!customer.riskFlag || customer.riskFlag === 'none')
    ) {
      customer.riskFlag = 'watch';
      await customer.save();
      flagged += 1;
    }
  }

  // Zero out customers with no cancelled orders (in case of stale data)
  const withCancels = counts.map((c) => c._id);
  await Customer.updateMany(
    { _id: { $nin: withCancels }, lifetimeCancelled: { $gt: 0 } },
    { $set: { lifetimeCancelled: 0 } }
  );

  console.log(`Updated lifetimeCancelled for ${updated} customers`);
  console.log(`Auto-flagged watch for ${flagged} frequent cancellers (>${FREQUENT_CANCEL_THRESHOLD})`);
  await disconnectDatabase();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
