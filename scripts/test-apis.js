/**
 * End-to-end API smoke tests for Gazelle ERP/OMS.
 * Usage: node scripts/test-apis.js
 */
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';
const WEBHOOK_BASE = process.env.API_BASE?.replace('/api/v1', '') || 'http://localhost:4000';

const results = [];

async function req(method, path, { token, body, base = BASE, expectStatus, allowFail = false } = {}) {
  const url = `${base}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  const ok = expectStatus ? res.status === expectStatus : res.ok;
  results.push({
    method,
    path,
    status: res.status,
    ok: allowFail ? true : ok,
    note: allowFail && !ok ? `(allowed fail: ${data.error || res.statusText})` : null,
    error: ok || allowFail ? null : data.error || data.raw || res.statusText,
  });

  if (!ok && !allowFail && expectStatus !== res.status) {
    throw new Error(`${method} ${path} → ${res.status}: ${data.error || text}`);
  }
  return { status: res.status, data };
}

async function login(email, password) {
  const { data } = await req('POST', '/auth/login', { body: { email, password } });
  return data.token;
}

async function seedTestData() {
  const { connectDatabase, disconnectDatabase } = await import('../src/config/database.js');
  const Product = (await import('../src/models/Product.js')).default;
  const Variant = (await import('../src/models/Variant.js')).default;
  const Customer = (await import('../src/models/Customer.js')).default;
  const Order = (await import('../src/models/Order.js')).default;
  const User = (await import('../src/models/User.js')).default;
  const bcrypt = (await import('bcrypt')).default;

  await connectDatabase();

  for (const u of [
    { email: 'om@test.local', role: 'orders_manager', name: 'Orders Manager' },
    { email: 'sm@test.local', role: 'stock_manager', name: 'Stock Manager' },
  ]) {
    if (!(await User.findOne({ email: u.email }))) {
      await User.create({
        ...u,
        passwordHash: await bcrypt.hash('testpass123', 12),
        isActive: true,
      });
    }
  }

  let product = await Product.findOne({ shopifyProductId: 'gid://shopify/Product/test-1' });
  if (!product) {
    product = await Product.create({
      shopifyProductId: 'gid://shopify/Product/test-1',
      title: 'Test T-Shirt',
      status: 'active',
    });
  }

  let variant = await Variant.findOne({ shopifyVariantId: 'gid://shopify/ProductVariant/test-1' });
  if (!variant) {
    variant = await Variant.create({
      productId: product._id,
      shopifyVariantId: 'gid://shopify/ProductVariant/test-1',
      shopifyInventoryItemId: 'gid://shopify/InventoryItem/test-1',
      sku: 'TEST-SKU-001',
      title: 'Red / Large',
      sellingPrice: 299,
      cogs: 120,
      onlineStock: 10,
      realStock: 20,
      onHoldStock: 0,
    });
  }

  let variant2 = await Variant.findOne({ shopifyVariantId: 'gid://shopify/ProductVariant/test-2' });
  if (!variant2) {
    variant2 = await Variant.create({
      productId: product._id,
      shopifyVariantId: 'gid://shopify/ProductVariant/test-2',
      shopifyInventoryItemId: 'gid://shopify/InventoryItem/test-2',
      sku: 'TEST-SKU-002',
      title: 'Blue / Medium',
      sellingPrice: 349,
      cogs: 140,
      onlineStock: 5,
      realStock: 15,
      onHoldStock: 0,
    });
  }

  let customer = await Customer.findOne({ phone: '+201000000001' });
  if (!customer) {
    customer = await Customer.create({
      fullName: 'Test Customer',
      phone: '+201000000001',
      email: 'test@customer.local',
      addresses: [{ label: 'Home', line1: '123 Test St', city: 'Cairo', isDefault: true }],
    });
  }

  const ensureOrder = async (shopifyOrderId, defaults) => {
    let order = await Order.findOne({ shopifyOrderId });
    if (!order) {
      order = await Order.create({ shopifyOrderId, customerId: customer._id, ...defaults });
    }
    return order;
  };

  const orderA = await ensureOrder('test-order-001', {
    shippingAddress: { fullName: 'Test Customer', line1: '123 Test St', city: 'Cairo', phone: '+201000000001' },
    internalStatus: 'pending_verification',
    totalSellingPrice: 598,
    items: [{ variantId: variant._id, sku: variant.sku, quantity: 2, unitSellingPrice: 299, unitCogs: 120 }],
    placedAt: new Date(),
  });

  const orderB = await ensureOrder('test-order-002', {
    shippingAddress: { fullName: 'Test Customer', line1: '456 Ship St', city: 'Cairo', phone: '+201000000001' },
    internalStatus: 'verified_ready_for_shipping',
    totalSellingPrice: 299,
    totalCogsSnapshot: 120,
    verifiedAt: new Date(),
    items: [{ variantId: variant._id, sku: variant.sku, quantity: 1, unitSellingPrice: 299, unitCogs: 120 }],
    placedAt: new Date(Date.now() - 3600000),
  });

  const orderC = await ensureOrder('test-order-003', {
    shippingAddress: { fullName: 'Test Customer', line1: '789 RTO St', city: 'Cairo' },
    internalStatus: 'returning_to_origin',
    bostaDeliveryId: 'bosta-test-delivery-003',
    totalSellingPrice: 299,
    items: [{ variantId: variant._id, sku: variant.sku, quantity: 1, unitSellingPrice: 299, unitCogs: 120 }],
    placedAt: new Date(Date.now() - 86400000),
  });

  // Fresh order for cancel flow
  const orderD = await ensureOrder('test-order-004', {
    shippingAddress: { fullName: 'Test Customer', line1: 'Cancel St', city: 'Cairo' },
    internalStatus: 'pending_verification',
    totalSellingPrice: 299,
    items: [{ variantId: variant._id, sku: variant.sku, quantity: 1, unitSellingPrice: 299, unitCogs: 120 }],
    placedAt: new Date(),
  });

  // Sync onHoldStock from active orders so exchange/cancel tests have correct holds
  const activeOrders = await Order.find({
    internalStatus: { $nin: ['delivered', 'cancelled', 'returned_to_stock'] },
  });
  const holdByVariant = {};
  for (const o of activeOrders) {
    for (const item of o.items) {
      const vid = item.variantId.toString();
      holdByVariant[vid] = (holdByVariant[vid] || 0) + item.quantity;
    }
  }
  for (const [vid, qty] of Object.entries(holdByVariant)) {
    await Variant.updateOne({ _id: vid }, { onHoldStock: qty });
  }

  await disconnectDatabase();
  return { product, variant, variant2, customer, orderA, orderB, orderC, orderD };
}

async function run() {
  let ids = {};
  const shouldSeed = process.env.SEED_FOR_TESTS === '1';
  if (shouldSeed) {
    console.log('Seeding test data...');
    ids = await seedTestData();
  } else {
    console.log('Skipping test data seed (set SEED_FOR_TESTS=1 to enable)\n');
    const { connectDatabase, disconnectDatabase } = await import('../src/config/database.js');
    const Product = (await import('../src/models/Product.js')).default;
    const Variant = (await import('../src/models/Variant.js')).default;
    const Customer = (await import('../src/models/Customer.js')).default;
    const Order = (await import('../src/models/Order.js')).default;
    await connectDatabase();
    const variant = await Variant.findOne({ sku: 'TEST-SKU-001' });
    const variant2 = await Variant.findOne({ sku: 'TEST-SKU-002' });
    const customer = await Customer.findOne({ phone: '+201000000001' });
    const orderA = await Order.findOne({ shopifyOrderId: 'test-order-001' });
    const orderB = await Order.findOne({ shopifyOrderId: 'test-order-002' });
    const orderC = await Order.findOne({ shopifyOrderId: 'test-order-003' });
    const orderD = await Order.findOne({ shopifyOrderId: 'test-order-004' });
    if (!variant || !customer) {
      console.error('Test fixtures missing. Run: SEED_FOR_TESTS=1 node scripts/test-apis.js');
      process.exit(1);
    }
    ids = { variant, variant2, customer, orderA, orderB, orderC, orderD };
    await disconnectDatabase();
  }
  console.log('Running API tests against', BASE, '\n');

  await req('GET', '/health');
  await req('POST', '/auth/login', { body: { email: 'wrong@test.local', password: 'bad' }, expectStatus: 401 });

  const adminToken = await login('admin@gazelle.local', 'changeme123');
  await req('GET', '/auth/me', { token: adminToken });

  await req('GET', '/users', { token: adminToken });
  await req('POST', '/users', {
    token: adminToken,
    body: { name: 'Extra OM', email: `om-extra-${Date.now()}@test.local`, password: 'testpass123', role: 'orders_manager' },
    expectStatus: 201,
  });

  await req('GET', '/settings', { token: adminToken });
  await req('PATCH', '/settings', {
    token: adminToken,
    body: { shopifyLocationId: 'gid://shopify/Location/test', bostaPollingThresholdHours: 48 },
  });
  await req('POST', '/settings/bosta-mappings', {
    token: adminToken,
    body: { bostaState: 'TEST_STATE', internalStatus: 'in_transit', description: 'API test mapping' },
  });
  await req('POST', '/settings/shopify/sync', { token: adminToken });

  await req('GET', '/reports/dashboard', { token: adminToken });
  await req('GET', '/reports/profitability', { token: adminToken });
  await req('GET', '/reports/audit', { token: adminToken });

  await req('GET', '/products', { token: adminToken });
  await req('PATCH', `/products/variants/${ids.variant._id}/cogs`, { token: adminToken, body: { cogs: 125 } });
  await req('POST', `/products/variants/${ids.variant._id}/cogs-batches`, {
    token: adminToken,
    body: { batchLabel: 'Batch-2026-01', cogs: 125, quantity: 50 },
  });

  await req('GET', '/inventory/variants', { token: adminToken });
  await req('GET', `/inventory/variants/${ids.variant._id}`, { token: adminToken });
  await req('POST', `/inventory/variants/${ids.variant._id}/adjust`, {
    token: adminToken,
    body: { quantityDelta: 5, reasonCode: 'restock' },
  });
  await req('GET', `/inventory/variants/${ids.variant._id}/ledger`, { token: adminToken });
  await req('GET', '/inventory/discrepancies', { token: adminToken });

  await req('GET', '/customers', { token: adminToken });
  await req('GET', `/customers/${ids.customer._id}`, { token: adminToken });
  await req('PATCH', `/customers/${ids.customer._id}/risk-flag`, { token: adminToken, body: { riskFlag: 'watch' } });

  await req('GET', '/orders', { token: adminToken });
  await req('GET', `/orders/${ids.orderA._id}`, { token: adminToken });
  await req('GET', `/orders/${ids.orderA._id}/history`, { token: adminToken });
  await req('POST', `/orders/${ids.orderA._id}/claim`, { token: adminToken, allowFail: true });
  await req('PATCH', `/orders/${ids.orderA._id}/shipping`, {
    token: adminToken,
    body: { line1: '999 Updated St', city: 'Giza' },
  });

  const omToken = await login('om@test.local', 'testpass123');

  // Verify only if still pending
  const { data: orderAData } = await req('GET', `/orders/${ids.orderA._id}`, { token: omToken });
  if (orderAData.data?.internalStatus === 'pending_verification') {
    await req('POST', `/orders/${ids.orderA._id}/verify`, {
      token: omToken,
      body: { outcome: 'confirmed', note: 'Customer confirmed', totalCogsSnapshot: 240 },
    });
  }

  const { data: orderBData } = await req('GET', `/orders/${ids.orderB._id}`, { token: omToken });
  if (orderBData.data?.internalStatus === 'verified_ready_for_shipping') {
    await req('POST', `/orders/${ids.orderB._id}/exchange`, {
      token: omToken,
      body: {
        fromItemId: orderBData.data.items[0]._id,
        toVariantId: ids.variant2._id.toString(),
        note: 'Size change',
      },
    });
  }

  const { data: orderDData } = await req('GET', `/orders/${ids.orderD._id}`, { token: omToken });
  if (orderDData.data?.internalStatus === 'pending_verification') {
    await req('POST', `/orders/${ids.orderD._id}/cancel`, {
      token: omToken,
      body: { reason: 'customer_changed_mind', note: 'API test cancel' },
    });
  }

  const smToken = await login('sm@test.local', 'testpass123');
  await req('GET', '/fulfillment/pick-list', { token: smToken });

  const { data: orderBAfter } = await req('GET', `/orders/${ids.orderB._id}`, { token: smToken });
  if (orderBAfter.data?.internalStatus === 'verified_ready_for_shipping') {
    await req('POST', `/fulfillment/${ids.orderB._id}/pick-pack`, { token: smToken });
  }

  await req('GET', `/fulfillment/${ids.orderB._id}/awb`, { token: smToken, allowFail: true });

  const { data: orderCData } = await req('GET', `/orders/${ids.orderC._id}`, { token: smToken });
  if (orderCData.data?.internalStatus === 'returning_to_origin') {
    await req('POST', `/orders/${ids.orderC._id}/confirm-return`, {
      token: smToken,
      body: { note: 'Item received in warehouse' },
    });
  }

  await req('GET', '/reports/dashboard', { token: smToken, expectStatus: 403 });
  await req('GET', '/inventory/variants', { token: omToken, expectStatus: 403 });

  await req('POST', '/webhooks/shopify/orders-create', {
    base: WEBHOOK_BASE,
    body: {
      id: 999888777,
      created_at: new Date().toISOString(),
      total_price: '199.00',
      customer: { first_name: 'Webhook', last_name: 'Test', phone: '+201111111111' },
      shipping_address: {
        first_name: 'Webhook',
        last_name: 'Test',
        address1: '1 Webhook Lane',
        city: 'Cairo',
        phone: '+201111111111',
      },
      line_items: [{ variant_id: 'test-1', sku: 'TEST-SKU-001', quantity: 1, price: '199.00' }],
    },
  });

  await req('POST', '/webhooks/bosta', {
    base: WEBHOOK_BASE,
    body: { _id: 'bosta-test-delivery-003', state: 'DELIVERED' },
  });

  await req('GET', '/nonexistent', { token: adminToken, expectStatus: 404 });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log('Results:\n');
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const extra = r.note || (r.error ? ` (${r.error})` : '');
    console.log(`  ${icon} ${r.method.padEnd(6)} ${r.path} → ${r.status}${extra}`);
  }

  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('\nTest run aborted:', err.message);
  process.exit(1);
});
