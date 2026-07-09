/**
 * Extended API smoke tests — manufacturing, accounting, HR, integrations.
 * Usage: node scripts/test-extended-features.js
 */
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';
const results = [];

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
    data = { raw: text?.slice(0, 200) };
  }
  return { status: res.status, data };
}

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function expect(name, method, path, { token, body, status = 200 } = {}) {
  const allowed = Array.isArray(status) ? status : [status];
  const res = await call(method, path, { token, body });
  const ok = allowed.includes(res.status);
  record(name, ok, ok ? `${res.status}` : `got ${res.status}: ${JSON.stringify(res.data).slice(0, 150)}`);
  return res;
}

async function login(email, password) {
  const { data } = await call('POST', '/auth/login', { body: { email, password } });
  return data.token;
}

async function run() {
  console.log('\n=== Extended feature tests ===\n');
  const admin = await login('admin@gazelle.local', 'changeme123');
  if (!admin) throw new Error('Admin login failed');

  console.log('[INTEGRATIONS & REFERENCE]');
  await expect('health', 'GET', '/health');
  await expect('integration health', 'GET', '/integrations/health', { token: admin });
  await expect('bosta cities', 'GET', '/reference/bosta-cities', { token: admin });

  console.log('\n[MANUFACTURING]');
  const factories = await expect('list factories', 'GET', '/manufacturing/factories', { token: admin });
  const factoryList = factories.data?.data || [];
  record('factories seeded (5+)', factoryList.length >= 5, `${factoryList.length} factories`);
  const joki = factoryList.find((f) => f.name === 'Joki');
  if (joki) {
    record('Joki lead time = 10', joki.leadTimeDays === 10, `${joki.leadTimeDays}`);
    record('avg lead time null until 3 POs', joki.avgLeadTimeDays == null, joki.completedPoCount != null ? `${joki.completedPoCount} POs` : '');
  }

  await expect('list purchase orders', 'GET', '/manufacturing/purchase-orders', { token: admin });

  const catalog = await call('GET', '/inventory/catalog?limit=1', { token: admin });
  const variant = catalog.data?.catalog?.[0]?.variants?.[0];
  let poId;
  if (joki && variant?._id) {
    const created = await expect('create PO', 'POST', '/manufacturing/purchase-orders', {
      token: admin,
      status: [200, 201],
      body: {
        factoryId: joki._id,
        items: [{ variantId: variant._id, quantity: 1, unitCost: 100, currency: 'EGP' }],
        notes: 'Extended test PO',
      },
    });
    poId = created.data?.data?._id;
    if (poId) {
      await expect('get PO detail', 'GET', `/manufacturing/purchase-orders/${poId}`, { token: admin });
      await expect('mark PO sent', 'PATCH', `/manufacturing/purchase-orders/${poId}`, {
        token: admin,
        body: { status: 'sent' },
      });
      await expect('receive PO (stock intake)', 'POST', `/manufacturing/purchase-orders/${poId}/receive`, {
        token: admin,
        status: [200, 201],
      });
      await expect('PO export excel', 'GET', `/manufacturing/purchase-orders/${poId}/export`, { token: admin });
    }
  } else {
    record('PO lifecycle', false, 'missing factory or variant');
  }

  console.log('\n[ACCOUNTING]');
  await expect('chart of accounts', 'GET', '/accounting/accounts', { token: admin });
  await expect('journal entries', 'GET', '/accounting/journal', { token: admin });
  await expect('P&L report', 'GET', '/accounting/reports/pl', { token: admin });
  await expect('balance sheet', 'GET', '/accounting/reports/balance-sheet', { token: admin });
  await expect('top products', 'GET', '/accounting/reports/top-products', { token: admin });
  await expect('BLOCK SM accounting', 'GET', '/accounting/accounts', { token: await login('sm@test.local', 'testpass123'), status: 403 });

  console.log('\n[HR]');
  await expect('employees list', 'GET', '/hr/employees', { token: admin });
  await expect('leave requests', 'GET', '/hr/leave-requests', { token: admin });
  await expect('payroll summary', 'GET', '/hr/payroll-summary', { token: admin });
  await expect('BLOCK OM HR', 'GET', '/hr/employees', { token: await login('om@test.local', 'testpass123'), status: 403 });

  console.log('\n[INVENTORY EXTRAS]');
  await expect('low stock variants', 'GET', '/inventory/variants?lowStock=true&limit=5', { token: admin });
  await expect('catalog all status', 'GET', '/inventory/catalog?status=all&limit=2', { token: admin });

  console.log('\n[FULFILLMENT EXTRAS]');
  const pick = await call('GET', '/fulfillment/pick-list', { token: await login('sm@test.local', 'testpass123') });
  const readyOrder = pick.data?.orders?.[0];
  if (readyOrder?._id) {
    await expect('stock check', 'GET', `/fulfillment/${readyOrder._id}/stock-check`, { token: admin });
    await expect('shipment status', 'GET', `/fulfillment/${readyOrder._id}/shipment-status`, { token: admin, status: [200, 404, 502] });
  } else {
    record('fulfillment extras', true, 'no ready orders (skipped)');
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n========================================`);
  console.log(`RESULT: ${passed}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
  console.log('Extended features verified ✓');
}

run().catch((err) => {
  console.error('Aborted:', err);
  process.exit(1);
});
