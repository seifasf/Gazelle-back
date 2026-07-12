/**
 * End-to-end feature + permission tests for all three roles.
 * Exercises real (read-only) Shopify-backed catalog + the full order lifecycle,
 * notifications, customer order history, and RBAC boundaries.
 *
 * Usage: node scripts/test-all-roles.js
 */
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';

const results = [];
let section = 'general';

function record(name, ok, detail = '') {
  results.push({ section, name, ok, detail });
  const icon = ok ? '✓' : '✗';
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(method, path, { token, body } = {}) {
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
  return { status: res.status, data };
}

/** Assert a call returns one of the expected statuses. */
async function expect(name, method, path, { token, body, status = 200 } = {}) {
  const allowed = Array.isArray(status) ? status : [status];
  const res = await call(method, path, { token, body });
  const ok = allowed.includes(res.status);
  record(name, ok, ok ? `${res.status}` : `got ${res.status}, want ${allowed.join('/')} ${JSON.stringify(res.data).slice(0, 120)}`);
  return res;
}

async function login(email, password) {
  const { data } = await call('POST', '/auth/login', { body: { email, password } });
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
    const existing = await User.findOne({ email: u.email });
    if (!existing) {
      await User.create({ ...u, passwordHash: await bcrypt.hash('testpass123', 12), isActive: true });
      console.log(`  created ${u.email}`);
    } else if (!existing.isActive) {
      existing.isActive = true;
      await existing.save();
    }
  }
  await disconnectDatabase();
}

async function run() {
  console.log('\n=== Gazelle OMS — full role feature & permission test ===');
  console.log('Target:', BASE, '\n');

  await ensureTestUsers();

  const admin = await login('admin@gazelle.local', 'changeme123');
  const om = await login('om@test.local', 'testpass123');
  const sm = await login('sm@test.local', 'testpass123');
  if (!admin || !om || !sm) throw new Error('Failed to obtain tokens for all roles');
  console.log('Logged in as all three roles.\n');

  // Grab a real variant + customer to drive lifecycle tests.
  const { data: catalog } = await call('GET', '/inventory/catalog?limit=24&page=1', { token: admin });
  const variant = catalog.catalog?.[0]?.variants?.[0];
  const variantId = variant?._id;
  const sku = variant?.sku;

  /* ---------------- ADMIN ---------------- */
  section = 'ADMIN';
  console.log('[ADMIN]');
  await expect('dashboard report', 'GET', '/reports/dashboard', { token: admin });
  await expect('profitability report', 'GET', '/reports/profitability', { token: admin });
  await expect('audit log', 'GET', '/reports/audit', { token: admin });
  await expect('settings read', 'GET', '/settings', { token: admin });
  await expect('users list', 'GET', '/users', { token: admin });
  await expect('shopify status', 'GET', '/integrations/shopify/status', { token: admin });
  await expect('shopify sync-status', 'GET', '/integrations/shopify/sync-status', { token: admin });
  await expect('integration health', 'GET', '/integrations/health', { token: admin });
  await expect('catalog', 'GET', '/inventory/catalog?limit=5', { token: admin });
  await expect('products (with cogs)', 'GET', '/products', { token: admin });
  await expect('order state counts', 'GET', '/orders/counts', { token: admin });
  await expect('notifications', 'GET', '/notifications', { token: admin });
  await expect('accounting accounts', 'GET', '/accounting/accounts', { token: admin });
  await expect('hr employees', 'GET', '/hr/employees', { token: admin });
  await expect('manufacturing factories', 'GET', '/manufacturing/factories', { token: admin });
  await expect('pl report', 'GET', '/accounting/reports/pl', { token: admin });
  await expect('cities list', 'GET', '/reference/bosta-cities', { token: admin });
  await expect('warehouse review', 'GET', '/fulfillment/warehouse-review', { token: admin });

  /* ---------------- EXCEL EXPORTS (admin) ---------------- */
  section = 'EXCEL_EXPORTS';
  console.log('\n[EXCEL EXPORTS — ADMIN]');
  async function expectExcel(name, path, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`${BASE}${path}`, { headers });
    const ct = res.headers.get('content-type') || '';
    const ok = res.status === 200 && ct.includes('spreadsheetml');
    record(name, ok, `${res.status} ${ct.slice(0, 40)}`);
  }
  await expectExcel('profitability export', '/reports/profitability/export', admin);
  await expectExcel('pl export', '/accounting/reports/pl/export', admin);
  await expectExcel('cogs export', '/products/cogs-health/export?limit=10', admin);
  await expectExcel('warehouse backlog export', '/fulfillment/warehouse-review/export', admin);
  {
    const res = await fetch(`${BASE}/reports/profitability/export`, { headers: { Authorization: `Bearer ${sm}` } });
    record('BLOCK SM profitability export', res.status === 403, String(res.status));
  }

  /* ---------------- STOCK MANAGER ---------------- */
  section = 'STOCK_MANAGER';
  console.log('\n[STOCK MANAGER]');
  await expect('catalog', 'GET', '/inventory/catalog?limit=5', { token: sm });
  await expect('variants list', 'GET', '/inventory/variants?limit=5', { token: sm });
  if (variantId) {
    await expect('variant detail', 'GET', `/inventory/variants/${variantId}`, { token: sm });
    await expect('variant ledger', 'GET', `/inventory/variants/${variantId}/ledger`, { token: sm });
  }
  await expect('discrepancies', 'GET', '/inventory/discrepancies', { token: sm });
  await expect('pick list', 'GET', '/fulfillment/pick-list', { token: sm });
  await expect('warehouse review', 'GET', '/fulfillment/warehouse-review', { token: sm });
  await expect('order counts (shared)', 'GET', '/orders/counts', { token: sm });
  await expect('notifications', 'GET', '/notifications', { token: sm });
  await expect('products (no cogs)', 'GET', '/products', { token: sm });
  if (variantId) {
    await expect('SM stock intake', 'POST', '/inventory/stock-intake', {
      token: sm,
      status: [200, 201],
      body: { variantId, quantity: 1, reasonCode: 'restock', syncToShopify: false },
    });
    const barcodeRes = await fetch(`${BASE}/inventory/variants/${variantId}/barcode.png`, {
      headers: { Authorization: `Bearer ${sm}` },
    });
    const barcodeCt = barcodeRes.headers.get('content-type') || '';
    record('barcode PNG', barcodeRes.status === 200 && barcodeCt.includes('image/png'), `${barcodeRes.status}`);
  }
  // Forbidden for stock manager:
  await expect('BLOCK settings', 'GET', '/settings', { token: sm, status: 403 });
  await expect('BLOCK reports', 'GET', '/reports/dashboard', { token: sm, status: 403 });
  await expect('BLOCK users', 'GET', '/users', { token: sm, status: 403 });
  await expect('BLOCK customers', 'GET', '/customers', { token: sm, status: 403 });
  await expect('BLOCK accounting', 'GET', '/accounting/accounts', { token: sm, status: 403 });
  await expect('BLOCK cities sync', 'POST', '/reference/bosta-cities/sync', { token: sm, status: 403 });
  // Stock manager must not list verification queue even if they request it.
  const smPending = await call('GET', '/orders?status=pending_verification&limit=5', { token: sm });
  const smPendingStatuses = (smPending.data?.orders || smPending.data?.data || [])
    .map((o) => o.internalStatus)
    .filter(Boolean);
  record(
    'SM cannot list pending_verification',
    smPending.status === 200 && smPendingStatuses.every((s) => s !== 'pending_verification'),
    smPendingStatuses.slice(0, 5).join(',') || `status ${smPending.status}`
  );

  /* ---------------- ORDERS MANAGER ---------------- */
  section = 'ORDERS_MANAGER';
  console.log('\n[ORDERS MANAGER]');
  await expect('orders list', 'GET', '/orders?limit=5', { token: om });
  await expect('order counts', 'GET', '/orders/counts', { token: om });
  await expect('customers list', 'GET', '/customers?limit=5', { token: om });
  await expect('notifications', 'GET', '/notifications', { token: om });
  if (sku) await expect('SKU lookup', 'GET', `/inventory/variants/lookup?sku=${encodeURIComponent(sku)}`, { token: om });
  // Forbidden for orders manager:
  await expect('BLOCK catalog', 'GET', '/inventory/catalog?limit=2', { token: om, status: 403 });
  await expect('BLOCK reports', 'GET', '/reports/dashboard', { token: om, status: 403 });
  await expect('BLOCK settings', 'GET', '/settings', { token: om, status: 403 });
  await expect('BLOCK pick-list', 'GET', '/fulfillment/pick-list', { token: om, status: 403 });
  await expect('BLOCK accounting', 'GET', '/accounting/accounts', { token: om, status: 403 });
  await expect('BLOCK hr', 'GET', '/hr/employees', { token: om, status: 403 });
  await expect('BLOCK manufacturing', 'GET', '/manufacturing/factories', { token: om, status: 403 });
  await expect('variants for exchange', 'GET', '/inventory/variants?limit=5', { token: om });
  await expect('BLOCK warehouse review export', 'GET', '/fulfillment/warehouse-review/export', { token: om, status: 403 });

  /* ---------------- OM CANCEL NOTE ---------------- */
  section = 'OM_CANCEL';
  console.log('\n[OM CANCEL — NOTE REQUIRED]');
  if (variantId) {
    const draft = await call('POST', '/orders/manual', {
      token: om,
      body: {
        manualSource: 'phone',
        shippingMethod: 'local_shipping',
        customer: { fullName: 'Cancel Test', phone: '+201555000999' },
        shippingAddress: { line1: '2 Test St', city: 'Cairo', phone: '+201555000999' },
        items: [{ variantId, quantity: 1 }],
      },
    });
    const cancelOrderId = draft.data?.data?._id;
    if (cancelOrderId) {
      await expect('cancel without note rejected', 'POST', `/orders/${cancelOrderId}/cancel`, {
        token: om,
        status: 400,
        body: { reason: 'customer_changed_mind' },
      });
      await expect('cancel with note ok', 'POST', `/orders/${cancelOrderId}/cancel`, {
        token: om,
        status: [200, 201],
        body: { reason: 'customer_changed_mind', note: 'Role test — customer changed mind' },
      });
    }
  }

  /* ---------------- FULL ORDER LIFECYCLE + NOTIFICATIONS ---------------- */
  section = 'LIFECYCLE';
  console.log('\n[ORDER LIFECYCLE + NOTIFICATIONS]');
  let orderId, customerId;
  if (variantId) {
    // Pre-stock the variant so the order can be delivered (and reverted) cleanly.
    await call('POST', '/inventory/stock-intake', {
      token: admin,
      body: { variantId, quantity: 1, reasonCode: 'restock', syncToShopify: false },
    });

    // Baseline notification counts before creating the order.
    const omBefore = (await call('GET', '/notifications/unread-count', { token: om })).data?.data?.unread ?? 0;
    const smBefore = (await call('GET', '/notifications/unread-count', { token: sm })).data?.data?.unread ?? 0;

    const created = await expect('OM creates manual order', 'POST', '/orders/manual', {
      token: om,
      status: [200, 201],
      body: {
        manualSource: 'instagram',
        shippingMethod: 'local_shipping',
        customer: { fullName: 'Role Test Buyer', phone: '+201555000123', email: 'roletest@test.local' },
        shippingAddress: { line1: '1 Test St', city: 'Cairo', phone: '+201555000123' },
        items: [{ variantId, quantity: 1 }],
      },
    });
    orderId = created.data?.data?._id;
    customerId = created.data?.data?.customerId?._id || created.data?.data?.customerId;

    // new_order notification should reach OM but NOT stock manager.
    await new Promise((r) => setTimeout(r, 400));
    const omAfter = (await call('GET', '/notifications/unread-count', { token: om })).data?.data?.unread ?? 0;
    const smAfter = (await call('GET', '/notifications/unread-count', { token: sm })).data?.data?.unread ?? 0;
    record('new_order notifies Orders Manager', omAfter > omBefore, `${omBefore} → ${omAfter}`);
    record('new_order does NOT notify Stock Manager', smAfter === smBefore, `${smBefore} → ${smAfter}`);

    if (orderId) {
      // SM cannot verify (orders-manager action).
      await expect('BLOCK SM verify', 'POST', `/orders/${orderId}/verify`, { token: sm, body: { outcome: 'confirmed' }, status: 403 });
      // OM verifies → should emit order_verified to stock manager.
      await expect('OM verifies order', 'POST', `/orders/${orderId}/verify`, {
        token: om,
        status: [200, 201],
        body: { outcome: 'confirmed', note: 'role test', shippingMethod: 'local_shipping' },
      });
      await new Promise((r) => setTimeout(r, 400));
      const smVerified = (await call('GET', '/notifications/unread-count', { token: sm })).data?.data?.unread ?? 0;
      record('order_verified notifies Stock Manager', smVerified > smBefore, `${smBefore} → ${smVerified}`);

      // OM cannot pick-pack (stock action); SM can.
      await expect('BLOCK OM pick-pack', 'POST', `/fulfillment/${orderId}/pick-pack`, { token: om, status: 403 });
      await expect('OM can read shipment-status', 'GET', `/fulfillment/${orderId}/shipment-status`, {
        token: om,
        status: [200, 404],
      });
      await expect('SM pick-pack (local shipping)', 'POST', `/fulfillment/${orderId}/pick-pack`, { token: sm, status: [200, 201] });

      // Notification mark-read flow.
      const list = (await call('GET', '/notifications', { token: om })).data?.data;
      const first = list?.items?.[0];
      if (first) {
        await expect('OM mark notification read', 'POST', `/notifications/${first._id}/read`, { token: om });
      }
      await expect('OM mark all read', 'POST', '/notifications/read-all', { token: om });

      // Local-shipping delivery flow (real statuses, UI-relabeled): dispatched
      // (picked_up_by_bosta) → out for delivery (in_transit) → delivered.
      await expect('OM mark out for delivery (in_transit)', 'POST', `/orders/${orderId}/transition`, {
        token: om,
        status: [200, 201],
        body: { toStatus: 'in_transit', note: 'role test' },
      });
      await expect('OM mark delivered (closes order)', 'POST', `/orders/${orderId}/transition`, {
        token: om,
        status: [200, 201],
        body: { toStatus: 'delivered', note: 'role test' },
      });
    }
  }

  /* ---------------- CUSTOMER ORDER HISTORY (new feature) ---------------- */
  section = 'CUSTOMER_ORDERS';
  console.log('\n[CUSTOMER ORDER HISTORY]');
  if (!customerId) {
    const { data: cl } = await call('GET', '/customers?limit=1', { token: admin });
    customerId = cl.customers?.[0]?._id || cl.data?.[0]?._id;
  }
  if (customerId) {
    const res = await expect('OM reads customer all-orders', 'GET', `/customers/${customerId}/orders`, { token: om });
    record('customer-orders returns a source', Boolean(res.data?.data?.source), res.data?.data?.source || 'none');
    await expect('BLOCK SM customer-orders', 'GET', `/customers/${customerId}/orders`, { token: sm, status: 403 });
  } else {
    record('customer available for history test', false, 'no customer found');
  }

  /* ---------------- ADMIN STOCK OPS ---------------- */
  section = 'ADMIN_STOCK';
  console.log('\n[ADMIN STOCK OPS]');
  if (variantId) {
    const before = (await call('GET', `/inventory/variants/${variantId}`, { token: admin })).data?.data?.realStock ?? 0;
    const intake = await expect('admin stock intake +2', 'POST', '/inventory/stock-intake', {
      token: admin,
      status: [200, 201],
      body: { variantId, quantity: 2, reasonCode: 'restock', syncToShopify: false },
    });
    if (intake.status < 300) {
      const after = (await call('GET', `/inventory/variants/${variantId}`, { token: admin })).data?.data?.realStock ?? 0;
      record('realStock increased', after > before, `${before} → ${after}`);
      await expect('admin adjust -2 (revert)', 'POST', `/inventory/variants/${variantId}/adjust`, {
        token: admin,
        status: [200, 201],
        body: { quantityDelta: -2, reasonCode: 'stocktake_correction', syncToShopify: false },
      });
    }
  }

  /* ---------------- SUMMARY ---------------- */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n========================================`);
  console.log(`RESULT: ${passed}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`\nFAILURES (${failed.length}):`);
    for (const f of failed) console.log(`  ✗ [${f.section}] ${f.name} — ${f.detail}`);
    process.exit(1);
  }
  console.log('All role features & permissions verified ✓');
}

run().catch((err) => {
  console.error('\nTest run aborted:', err);
  process.exit(1);
});
