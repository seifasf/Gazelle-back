/**
 * Move local-shipping courier orders out of Bosta's picked_up_by_bosta status
 * into the dedicated local_shipping status.
 *
 * Also fixes any local_shipping method orders still stuck on picked_up_by_bosta
 * after warehouse handoff (legacy flow reused the Bosta status).
 *
 * Usage: node scripts/migrate-local-shipping-status.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Order from '../src/models/Order.js';
import OrderStatusHistory from '../src/models/OrderStatusHistory.js';

async function run() {
  await connectDatabase();

  const filter = {
    shippingMethod: 'local_shipping',
    internalStatus: 'picked_up_by_bosta',
  };

  const orders = await Order.find(filter)
    .select('_id shopifyOrderId shopifyOrderName name internalStatus shippingMethod')
    .lean();

  console.log(`Found ${orders.length} local shipping order(s) in picked_up_by_bosta`);

  let updated = 0;
  for (const order of orders) {
    const result = await Order.updateOne(
      { _id: order._id, shippingMethod: 'local_shipping', internalStatus: 'picked_up_by_bosta' },
      { $set: { internalStatus: 'local_shipping' } }
    );
    if (result.modifiedCount !== 1) continue;

    await OrderStatusHistory.create({
      orderId: order._id,
      fromStatus: 'picked_up_by_bosta',
      toStatus: 'local_shipping',
      source: 'system',
      note: 'Migrated: local shipping must not use Bosta picked_up status',
    });

    updated += 1;
    const label = order.shopifyOrderName || order.name || order.shopifyOrderId || order._id;
    console.log(`  → ${label}`);
  }

  console.log(`Updated ${updated} order(s)`);
  await disconnectDatabase();
}

run().catch(async (err) => {
  console.error(err);
  try {
    await disconnectDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
