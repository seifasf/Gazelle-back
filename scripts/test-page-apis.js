/**
 * Smoke-test every API endpoint used by the frontend pages.
 * Usage: API_BASE=https://gazelle-back-qre2.onrender.com/api/v1 node scripts/test-page-apis.js
 */
import dotenv from 'dotenv';

dotenv.config();

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@gazelle.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'changeme123';

const results = [];

async function call(method, path, { token, body, expect = 200 } = {}) {
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
    data = { raw: text?.slice(0, 120) };
  }

  const allowed = Array.isArray(expect) ? expect : [expect];
  const ok = allowed.includes(res.status);
  results.push({ path, status: res.status, ok, error: data.error });
  console.log(`${ok ? '✓' : '✗'} ${method} ${path} → ${res.status}${data.error ? ` (${data.error})` : ''}`);
  return { status: res.status, data, ok };
}

async function login() {
  const { data } = await call('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    expect: 200,
  });
  if (!data.token) throw new Error('Admin login failed — set TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD');
  return data.token;
}

async function run() {
  console.log(`\nPage API smoke test → ${BASE}\n`);
  const token = await login();

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const endpoints = [
    ['GET', `/reports/dashboard?preset=day&date=${today}`],
    ['GET', '/reports/profitability'],
    ['GET', '/reports/audit?limit=5'],
    ['GET', '/integrations/health'],
    ['GET', '/integrations/shopify/status'],
    ['GET', '/orders/counts'],
    ['GET', '/orders?limit=5'],
    ['GET', '/customers?limit=5'],
    ['GET', '/inventory/variants?limit=5'],
    ['GET', '/inventory/catalog?limit=2'],
    ['GET', '/inventory/discrepancies?limit=5'],
    ['GET', '/products'],
    ['GET', '/users'],
    ['GET', '/settings'],
    ['GET', '/fulfillment/pick-list'],
    ['GET', '/manufacturing/factories'],
    ['GET', '/manufacturing/purchase-orders?limit=10'],
    ['GET', '/accounting/accounts'],
    ['GET', '/accounting/journal?limit=5'],
    ['GET', '/accounting/reports/pl'],
    ['GET', '/accounting/reports/top-products?days=30'],
    ['GET', '/hr/employees'],
    ['GET', '/hr/leave-requests?status=pending'],
    ['GET', `/hr/payroll-summary?month=${month}`],
    ['GET', '/notifications/unread-count'],
    ['GET', '/reference/bosta-cities'],
  ];

  for (const [method, path] of endpoints) {
    await call(method, path, { token });
  }

  const employees = await call('GET', '/hr/employees', { token });
  const employeeId = employees.data?.data?.[0]?._id;
  if (employeeId) {
    await call('GET', `/hr/employees/${employeeId}`, { token });
  }

  const orders = await call('GET', '/orders?limit=1', { token });
  const orderId = orders.data?.orders?.[0]?._id;
  if (orderId) {
    await call('GET', `/orders/${orderId}`, { token });
    await call('GET', `/orders/${orderId}/history`, { token });
  }

  const pos = await call('GET', '/manufacturing/purchase-orders?limit=1', { token });
  const poId = pos.data?.orders?.[0]?._id;
  if (poId) {
    await call('GET', `/manufacturing/purchase-orders/${poId}`, { token });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  ${f.path} → ${f.status} ${f.error || ''}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
