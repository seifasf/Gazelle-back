/**
 * Move Bosta return pickups stuck in Ready to ship (Fulfillment) to Returning to
 * Warehouse and create their Bosta CRP, same as a return created as Bosta.
 *
 * Usage:
 *   node scripts/route-bosta-return-pickups.js          # dry run
 *   node scripts/route-bosta-return-pickups.js --apply  # move + create CRP
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Order from '../src/models/Order.js';
import { routeBostaReturnPickup } from '../src/services/order.service.js';

const APPLY = process.argv.includes('--apply');

async function run() {
  await connectDatabase();

  const orders = await Order.find({
    isReturnOrder: true,
    shippingMethod: 'bosta',
    internalStatus: 'verified_ready_for_shipping',
  }).select('shopifyOrderName assignedOrdersManagerId');

  for (const o of orders) {
    if (!APPLY) {
      console.log(`${o.shopifyOrderName}: would move to Returning to Warehouse + create Bosta CRP`);
      continue;
    }
    const result = await routeBostaReturnPickup(o._id, o.assignedOrdersManagerId);
    console.log(
      `${o.shopifyOrderName}: ${result.order?.internalStatus}`
      + (result.crpError ? ` (CRP failed: ${result.crpError})` : ` - CRP ${result.order?.bostaTrackingNumber || result.order?.bostaDeliveryId || 'created'}`)
    );
  }

  console.log(`\n${APPLY ? 'Applied' : 'Dry run'}: ${orders.length} order(s).`);
  await disconnectDatabase();
}

run().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
