/**
 * Remove test / transactional OMS data from MongoDB.
 * Keeps: staff users, settings, Bosta mappings & cities, catalog (unless test SKUs),
 * HR/accounting masters.
 * Does NOT touch Shopify — re-import orders after a full wipe.
 *
 * Usage:
 *   node scripts/purge-test-data.js              # seed/test fixtures only
 *   node scripts/purge-test-data.js --all-orders # wipe ALL orders + related transactional data
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Product from '../src/models/Product.js';
import Variant from '../src/models/Variant.js';
import Order from '../src/models/Order.js';
import Customer from '../src/models/Customer.js';
import User from '../src/models/User.js';
import OrderStatusHistory from '../src/models/OrderStatusHistory.js';
import InventoryLedger from '../src/models/InventoryLedger.js';
import CogsBatch from '../src/models/CogsBatch.js';
import DiscrepancyAlert from '../src/models/DiscrepancyAlert.js';
import WebhookReceipt from '../src/models/WebhookReceipt.js';
import BostaStatusMapping from '../src/models/BostaStatusMapping.js';
import BostaReturn from '../src/models/BostaReturn.js';
import PaymobReceived from '../src/models/PaymobReceived.js';
import Notification from '../src/models/Notification.js';

const TEST_USER_EMAILS = ['om@test.local', 'sm@test.local'];
const ALL_ORDERS = process.argv.includes('--all-orders');

async function purgeSeedFixtures() {
  const counts = {};

  const testProducts = await Product.find({
    $or: [
      { shopifyProductId: { $regex: /test/i } },
      { title: { $regex: /^Test /i } },
    ],
  });
  const testProductIds = testProducts.map((p) => p._id);

  const testVariants = await Variant.find({
    $or: [
      { shopifyVariantId: { $regex: /test/i } },
      { shopifyInventoryItemId: { $regex: /test/i } },
      { sku: { $regex: /^TEST-SKU/i } },
      ...(testProductIds.length ? [{ productId: { $in: testProductIds } }] : []),
    ],
  });
  const testVariantIds = testVariants.map((v) => v._id);

  const testOrders = await Order.find({
    $or: [
      { shopifyOrderId: { $regex: /^test-order/i } },
      { bostaDeliveryId: { $regex: /^bosta-test/i } },
      { shopifyOrderId: '999888777' },
    ],
  });
  const testOrderIds = testOrders.map((o) => o._id);

  const testCustomers = await Customer.find({
    $or: [
      { phone: { $in: ['+201000000001', 'unknown', '+201111111111'] } },
      { email: { $regex: /test@/i } },
      { fullName: { $regex: /^Test /i } },
      { fullName: 'Webhook Test' },
    ],
  });
  const testCustomerIds = testCustomers.map((c) => c._id);

  if (testOrderIds.length) {
    counts.orderStatusHistory = (
      await OrderStatusHistory.deleteMany({ orderId: { $in: testOrderIds } })
    ).deletedCount;
    counts.orders = (await Order.deleteMany({ _id: { $in: testOrderIds } })).deletedCount;
  }

  if (testVariantIds.length) {
    counts.inventoryLedger = (
      await InventoryLedger.deleteMany({ variantId: { $in: testVariantIds } })
    ).deletedCount;
    counts.cogsBatches = (await CogsBatch.deleteMany({ variantId: { $in: testVariantIds } })).deletedCount;
    counts.discrepancyAlerts = (
      await DiscrepancyAlert.deleteMany({ variantId: { $in: testVariantIds } })
    ).deletedCount;
    counts.variants = (await Variant.deleteMany({ _id: { $in: testVariantIds } })).deletedCount;
  }

  if (testProductIds.length) {
    counts.products = (await Product.deleteMany({ _id: { $in: testProductIds } })).deletedCount;
  }

  if (testCustomerIds.length) {
    const remainingOrders = await Order.countDocuments({ customerId: { $in: testCustomerIds } });
    if (remainingOrders === 0) {
      counts.customers = (await Customer.deleteMany({ _id: { $in: testCustomerIds } })).deletedCount;
    }
  }

  counts.testUsers = (await User.deleteMany({ email: { $in: TEST_USER_EMAILS } })).deletedCount;
  counts.testBostaMappings = (
    await BostaStatusMapping.deleteMany({ bostaState: 'TEST_STATE' })
  ).deletedCount;
  counts.webhookReceipts = (
    await WebhookReceipt.deleteMany({
      $or: [{ externalId: { $regex: /test/i } }, { topic: { $regex: /test/i } }],
    })
  ).deletedCount;

  return counts;
}

async function purgeAllOrders() {
  const counts = {};

  counts.orderStatusHistory = (await OrderStatusHistory.deleteMany({})).deletedCount;
  counts.orders = (await Order.deleteMany({})).deletedCount;
  counts.bostaReturns = (await BostaReturn.deleteMany({})).deletedCount;
  counts.paymobReceived = (await PaymobReceived.deleteMany({})).deletedCount;
  counts.orderNotifications = (
    await Notification.deleteMany({
      $or: [{ orderId: { $exists: true, $ne: null } }, { type: { $in: ['new_order', 'order_verified', 'shipment_created', 'failed_delivery', 'return_to_origin', 'order_callback_due'] } }],
    })
  ).deletedCount;
  counts.webhookReceipts = (await WebhookReceipt.deleteMany({})).deletedCount;

  // Customers with no remaining orders
  const customers = await Customer.find({}).select('_id').lean();
  const customerIds = customers.map((c) => c._id);
  if (customerIds.length) {
    const withOrders = await Order.distinct('customerId');
    const withOrderSet = new Set(withOrders.map(String));
    const orphanIds = customerIds.filter((id) => !withOrderSet.has(String(id)));
    if (orphanIds.length) {
      counts.customers = (await Customer.deleteMany({ _id: { $in: orphanIds } })).deletedCount;
    }
  }

  // Also remove seed fixtures (test products/users)
  const seed = await purgeSeedFixtures();
  return { ...seed, ...counts };
}

async function purge() {
  await connectDatabase();

  console.log(ALL_ORDERS ? 'Purging ALL orders + transactional OMS data…' : 'Purging seed/test fixtures only…');

  const counts = ALL_ORDERS ? await purgeAllOrders() : await purgeSeedFixtures();

  console.log('Purge complete:', counts);
  console.log('Remaining:', {
    products: await Product.countDocuments(),
    variants: await Variant.countDocuments(),
    orders: await Order.countDocuments(),
    customers: await Customer.countDocuments(),
    users: await User.countDocuments(),
  });

  await disconnectDatabase();
}

purge().catch((err) => {
  console.error(err);
  process.exit(1);
});
