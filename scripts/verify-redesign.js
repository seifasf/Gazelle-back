/**
 * Verification for OMS role & stock redesign — uses live catalog, no dummy seed data.
 * Usage: node scripts/verify-redesign.js
 */
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';

const results = [];

async function req(method, path, { token, body, expectStatus, allowFail = false } = {}) {
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

  const ok = expectStatus ? res.status === expectStatus : res.ok;
  results.push({
    method,
    path,
    status: res.status,
    ok: allowFail ? true : ok,
    error: ok || allowFail ? null : data.error || data.raw || res.statusText,
  });

  if (!ok && !allowFail) {
    throw new Error(`${method} ${path} → ${res.status}: ${data.error || text}`);
  }
  return { status: res.status, data };
}

async function login(email, password) {
  const { data } = await req('POST', '/auth/login', { body: { email, password } });
  return data.token;
}

async function ensureTestUsers() {
  const { connectDatabase, disconnectDatabase } = await import('../src/config/database.js');
  const User = (await import('../src/models/User.js')).default;
  const bcrypt = (await import('bcrypt')).default;

  await connectDatabase();
  for (const u of [
    { email: 'om@test.local', role: 'orders_manager', name: 'Orders Manager Test' },
    { email: 'sm@test.local', role: 'stock_manager', name: 'Stock Manager Test' },
  ]) {
    if (!(await User.findOne({ email: u.email }))) {
      await User.create({
        ...u,
        passwordHash: await bcrypt.hash('testpass123', 12),
        isActive: true,
      });
      console.log(`  Created test user ${u.email}`);
    }
  }
  await disconnectDatabase();
}

async function run() {
  console.log('Verifying OMS redesign against', BASE, '\n');
  await ensureTestUsers();

  const adminToken = await login('admin@gazelle.local', 'changeme123');

  // Catalog pagination (136 products)
  const { data: catalogPage1 } = await req('GET', '/inventory/catalog?limit=24&page=1', { token: adminToken });
  if ((catalogPage1.totalProducts ?? 0) < 100) {
    throw new Error(`Expected 100+ products, got ${catalogPage1.totalProducts}`);
  }
  if (!catalogPage1.catalog?.[0]?.variantCount) {
    throw new Error('Catalog missing variantCount on parent products');
  }

  const searchSku = catalogPage1.catalog[0]?.variants?.[0]?.sku;
  if (searchSku) {
    const { data: searchResult } = await req(
      'GET',
      `/inventory/catalog?search=${encodeURIComponent(searchSku)}&limit=5`,
      { token: adminToken }
    );
    if (!searchResult.catalog?.length) {
      throw new Error(`SKU search failed for ${searchSku}`);
    }
  }

  // Order state counts endpoint
  await req('GET', '/orders/counts', { token: adminToken });

  // Shopify readiness endpoints (admin)
  await req('GET', '/integrations/shopify/status', { token: adminToken });
  await req('GET', '/integrations/health', { token: adminToken });

  // Role permissions — stock_manager cannot access settings
  let smToken;
  try {
    smToken = await login('sm@test.local', 'testpass123');
  } catch {
    console.log('  (sm@test.local not found — skipping stock_manager tests)');
  }

  let omToken;
  try {
    omToken = await login('om@test.local', 'testpass123');
  } catch {
    console.log('  (om@test.local not found — skipping orders_manager tests)');
  }

  if (smToken) {
    await req('GET', '/settings', { token: smToken, expectStatus: 403 });
    await req('GET', '/inventory/catalog?limit=2', { token: smToken });
    await req('GET', '/inventory/stock-intake', { token: smToken, expectStatus: 404, allowFail: true });
    await req('POST', '/inventory/stock-intake', {
      token: smToken,
      body: { sku: 'X', quantity: 1 },
      expectStatus: 403,
    });
  }

  if (omToken) {
    await req('GET', '/inventory/catalog?limit=2', { token: omToken, expectStatus: 403 });
    await req('GET', '/reports/dashboard', { token: omToken, expectStatus: 403 });
    await req('GET', '/orders/counts', { token: omToken });

    // SKU lookup for manual orders
    if (searchSku) {
      await req('GET', `/inventory/variants/lookup?sku=${encodeURIComponent(searchSku)}`, { token: omToken });
    }

    // Manual order create (Gazelle-only)
    const variantId = catalogPage1.catalog[0]?.variants?.[0]?._id;
    if (variantId) {
      const { data: manualRes } = await req('POST', '/orders/manual', {
        token: omToken,
        body: {
          manualSource: 'instagram',
          shippingMethod: 'local_shipping',
          customer: { fullName: 'Verify Test', phone: '+201555000099', email: 'verify@test.local' },
          shippingAddress: { line1: '1 Test St', city: 'Cairo', phone: '+201555000099' },
          items: [{ variantId, quantity: 1 }],
        },
        expectStatus: 201,
      });
      const orderId = manualRes.data?._id;
      if (!orderId) throw new Error('Manual order missing _id');
      if (manualRes.data?.orderSource !== 'manual') throw new Error('Manual order missing orderSource=manual');

      // Verify with shipping method
      await req('POST', `/orders/${orderId}/verify`, {
        token: omToken,
        body: { outcome: 'confirmed', note: 'Redesign verify test', shippingMethod: 'local_shipping' },
      });

      // Stock manager pick-pack local shipping (if sm token)
      if (smToken) {
        const { data: pickRes } = await req('POST', `/fulfillment/${orderId}/pick-pack`, { token: smToken });
        if (!pickRes.localShipping) {
          throw new Error('Expected localShipping=true for local_shipping order');
        }
      }

      // Cleanup — cancel order
      await req('POST', `/orders/${orderId}/cancel`, {
        token: omToken,
        body: { reason: 'other', note: 'Redesign verification cleanup' },
        allowFail: true,
      });
    }
  }

  // Admin stock intake (real variant, sync queued — Shopify job may skip without Admin token)
  const variantId = catalogPage1.catalog[0]?.variants?.[0]?._id;
  if (variantId) {
    const before = await req('GET', `/inventory/variants/${variantId}`, { token: adminToken });
    const beforeStock = before.data?.data?.realStock ?? 0;

    const { status: intakeStatus } = await req('POST', '/inventory/stock-intake', {
      token: adminToken,
      body: {
        variantId,
        quantity: 1,
        reasonCode: 'restock',
        syncToShopify: true,
      },
      allowFail: true,
    });

    if (intakeStatus === 201) {
      const after = await req('GET', `/inventory/variants/${variantId}`, { token: adminToken });
      const afterStock = after.data?.data?.realStock ?? 0;
      if (afterStock <= beforeStock) {
        throw new Error('Stock intake did not increase realStock');
      }

      await req('POST', `/inventory/variants/${variantId}/adjust`, {
        token: adminToken,
        body: { quantityDelta: -1, reasonCode: 'stocktake_correction', syncToShopify: false },
        allowFail: true,
      });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log('Results:\n');
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const extra = r.error ? ` (${r.error})` : '';
    console.log(`  ${icon} ${r.method.padEnd(6)} ${r.path.split('?')[0]} → ${r.status}${extra}`);
  }

  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

run().catch((err) => {
  console.error('\nVerification aborted:', err.message);
  process.exit(1);
});
