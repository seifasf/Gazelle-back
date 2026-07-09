/**
 * Remove all API-test / dummy data from MongoDB.
 * Keeps: admin users, real staff users, settings, Bosta mappings & cities.
 * Does NOT touch Shopify — run catalog sync after connecting credentials.
 *
 * Usage: node scripts/purge-test-data.js
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
import Settings from '../src/models/Settings.js';

const TEST_PRODUCT_IDS = [/test-1/i, /Product\/test/i];
const TEST_VARIANT_IDS = [/test-1/i, /test-2/i, /Variant\/test/i];
const TEST_SKUS = [/^TEST-SKU/i];
const TEST_ORDER_IDS = [/^test-order/i, /^webhook-test/i];
const TEST_CUSTOMER_PHONES = ['+201000000001', 'unknown'];
const TEST_CUSTOMER_EMAILS = [/test@/i, /@test\.local$/i];
const TEST_USER_EMAILS = ['om@test.local', 'sm@test.local'];

function matchesAny(value, patterns) {
  if (!value) return false;
  const str = String(value);
  return patterns.some((p) => (p instanceof RegExp ? p.test(str) : str === p));
}

async function purge() {
  await connectDatabase();

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
      { phone: { $in: TEST_CUSTOMER_PHONES } },
      { phone: '+201111111111' },
      { email: { $regex: /test@/i } },
      { fullName: { $regex: /^Test /i } },
      { fullName: 'Webhook Test' },
    ],
  });
  const testCustomerIds = testCustomers.map((c) => c._id);

  const counts = {};

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

  counts.testUsers = (
    await User.deleteMany({ email: { $in: TEST_USER_EMAILS } })
  ).deletedCount;

  counts.testBostaMappings = (
    await BostaStatusMapping.deleteMany({ bostaState: 'TEST_STATE' })
  ).deletedCount;

  counts.webhookReceipts = (
    await WebhookReceipt.deleteMany({
      $or: [
        { externalId: { $regex: /test/i } },
        { topic: { $regex: /test/i } },
      ],
    })
  ).deletedCount;

  console.log('Purge complete:', counts);
  console.log('Remaining:', {
    products: await Product.countDocuments(),
    variants: await Variant.countDocuments(),
    orders: await Order.countDocuments(),
    customers: await Customer.countDocuments(),
  });

  await disconnectDatabase();
}

purge().catch((err) => {
  console.error(err);
  process.exit(1);
});
