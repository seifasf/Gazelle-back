/**
 * Integration tests: stock sync, manual orders, OOS, upload batch, cleanup.
 * Usage: API_BASE=https://gazelle-back-qre2.onrender.com/api/v1 node scripts/test-stock-integration.js
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import Variant from '../src/models/Variant.js';
import Order from '../src/models/Order.js';
import OrderStatusHistory from '../src/models/OrderStatusHistory.js';
import InventoryLedger from '../src/models/InventoryLedger.js';
import { shopifyAvailableFromVariant } from '../src/integrations/shopify/pushWarehouseStock.service.js';

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@gazelle.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'changeme123';
const TEST_SKU = process.env.TEST_SKU || 'GMS-26-3';
const TEST_TAG = 'AUTO-STOCK-TEST';

const results = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, ok: res.ok };
}

async function login() {
  const { data, ok } = await api('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!ok || !data.token) throw new Error('Admin login failed');
  return data.token;
}

async function driftCount() {
  const variants = await Variant.find({
    shopifyInventoryItemId: /^gid:\/\/shopify\/InventoryItem\//,
  })
    .select('realStock onHoldStock onlineStock')
    .lean();
  return variants.filter((v) => shopifyAvailableFromVariant(v) !== (v.onlineStock ?? 0)).length;
}

async function getVariantBySku(sku) {
  return Variant.findOne({ sku });
}

async function deleteTestOrder(orderId) {
  await InventoryLedger.deleteMany({ orderId });
  await OrderStatusHistory.deleteMany({ orderId });
  await Order.deleteOne({ _id: orderId });
}

async function run() {
  console.log('\n=== Stock integration tests ===');
  console.log('API:', BASE);
  console.log('SKU:', TEST_SKU, '\n');

  await mongoose.connect(process.env.MONGODB_URI);
  const token = await login();
  pass('Admin login');

  const health = await api('GET', '/health'.replace('/api/v1', '') === '/health' ? '/health' : '/health');
  // health is at root — use fetch directly
  const healthRes = await fetch(BASE.replace('/api/v1', '') + '/api/v1/health');
  if (healthRes.ok) pass('API health', await healthRes.json().then((d) => d.status));
  else fail('API health', String(healthRes.status));

  const driftBefore = await driftCount();
  if (driftBefore === 0) pass('Drift scan before tests', '0 SKUs');
  else fail('Drift scan before tests', `${driftBefore} SKUs drifted`);

  const variantBefore = await getVariantBySku(TEST_SKU);
  if (!variantBefore) throw new Error(`Test SKU not found: ${TEST_SKU}`);
  const sellableBefore = shopifyAvailableFromVariant(variantBefore);
  pass('Test SKU baseline', `${TEST_SKU} sellable=${sellableBefore} real=${variantBefore.realStock} hold=${variantBefore.onHoldStock}`);

  if (sellableBefore < 1) {
    fail('Manual order create', 'insufficient sellable stock for test');
  } else {
    const createRes = await api('POST', '/orders/manual', {
      token,
      body: {
        manualSource: 'other',
        shippingMethod: 'pickup',
        paymentMethod: 'cod',
        customer: {
          fullName: `${TEST_TAG} Customer`,
          phone: '+201909090909',
        },
        items: [{ variantId: String(variantBefore._id), quantity: 1, unitSellingPrice: 100 }],
        note: TEST_TAG,
      },
    });

    let testOrderId = createRes.data?.data?._id;
    const testOrderRef = createRes.data?.data?.shopifyOrderName;

    if (!createRes.ok || !testOrderId) {
      fail('Manual order create', createRes.data?.error || String(createRes.status));
    } else {
      pass('Manual order create', testOrderRef);

      await new Promise((r) => setTimeout(r, 2500));

      const variantAfterHold = await getVariantBySku(TEST_SKU);
      const sellableAfterHold = shopifyAvailableFromVariant(variantAfterHold);
      const expectedSellable = sellableBefore - 1;

      if (sellableAfterHold === expectedSellable && variantAfterHold.onlineStock === expectedSellable) {
        pass('Shopify sync after manual create', `sellable ${sellableBefore}→${sellableAfterHold}`);
      } else {
        fail(
          'Shopify sync after manual create',
          `expected sellable=${expectedSellable} online=${expectedSellable}, got sellable=${sellableAfterHold} online=${variantAfterHold.onlineStock}`
        );
      }

      const oosRes = await api('POST', `/fulfillment/${testOrderId}/out-of-stock`, {
        token,
        body: { note: `${TEST_TAG} OOS test` },
      });
      if (oosRes.ok) pass('Mark out of stock');
      else fail('Mark out of stock', oosRes.data?.error || String(oosRes.status));

      await new Promise((r) => setTimeout(r, 2000));

      const variantAfterOos = await getVariantBySku(TEST_SKU);
      if (variantAfterOos.onlineStock === expectedSellable) {
        pass('Shopify sync after OOS', `online=${variantAfterOos.onlineStock}`);
      } else {
        fail('Shopify sync after OOS', `online=${variantAfterOos.onlineStock}`);
      }

      const cancelRes = await api('POST', `/orders/${testOrderId}/cancel`, {
        token,
        body: { reason: 'customer_changed_mind', note: `${TEST_TAG} cleanup cancel` },
      });
      if (cancelRes.ok) pass('Cancel test order');
      else fail('Cancel test order', cancelRes.data?.error || String(cancelRes.status));

      await new Promise((r) => setTimeout(r, 2500));

      const variantAfterCancel = await getVariantBySku(TEST_SKU);
      if (shopifyAvailableFromVariant(variantAfterCancel) === sellableBefore) {
        pass('Hold released after cancel', `sellable back to ${sellableBefore}`);
      } else {
        fail(
          'Hold released after cancel',
          `sellable=${shopifyAvailableFromVariant(variantAfterCancel)} expected ${sellableBefore}`
        );
      }

      await deleteTestOrder(testOrderId);
      pass('Delete test order from DB', testOrderRef);
    }
  }

  // Batch stock set: unchanged realStock should still refresh Shopify cache
  const batchVariant = await getVariantBySku(TEST_SKU);
  const real = batchVariant.realStock;
  const batchRes = await api('POST', '/inventory/stock-set/batch', {
    token,
    body: {
      reasonCode: 'stock_count',
      items: [{ variantId: String(batchVariant._id), realStock: real }],
    },
  });
  if (batchRes.ok) {
    await new Promise((r) => setTimeout(r, 2000));
    const afterBatch = await getVariantBySku(TEST_SKU);
    const sellable = shopifyAvailableFromVariant(afterBatch);
    if (afterBatch.onlineStock === sellable) {
      pass('Stock batch unchanged row → Shopify refresh', `online=${afterBatch.onlineStock}`);
    } else {
      fail('Stock batch unchanged row → Shopify refresh', `online=${afterBatch.onlineStock} sellable=${sellable}`);
    }
  } else {
    fail('Stock batch API', batchRes.data?.error || String(batchRes.status));
  }

  const driftAfter = await driftCount();
  if (driftAfter === 0) pass('Drift scan after tests', '0 SKUs');
  else fail('Drift scan after tests', `${driftAfter} SKUs drifted`);

  await mongoose.disconnect();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===\n`);
  if (failed.length) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
