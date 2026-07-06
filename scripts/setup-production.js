/**
 * One-shot production setup: test Shopify + Bosta, register webhooks, sync cities.
 * Usage:
 *   API_BASE=https://gazelle-back-qre2.onrender.com/api/v1 \
 *   ADMIN_EMAIL=admin@gazelle.local \
 *   ADMIN_PASSWORD=changeme123 \
 *   node scripts/setup-production.js
 */
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.API_BASE || 'https://gazelle-back-qre2.onrender.com/api/v1';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@gazelle.local';
const PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

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
    data = { raw: text?.slice(0, 300) };
  }
  return { status: res.status, data, ok: res.ok };
}

function log(step, res) {
  const icon = res.ok ? '✓' : '✗';
  console.log(`${icon} ${step} → ${res.status}`, res.ok ? '' : JSON.stringify(res.data).slice(0, 200));
}

async function main() {
  console.log('Production setup for', BASE, '\n');

  const login = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (!login.ok) {
    console.error('Login failed:', login.data);
    process.exit(1);
  }
  const token = login.data.token;
  log('Login', login);

  const health = await call('GET', '/integrations/health', { token });
  log('Integration health', health);
  if (!health.ok) {
    console.error('\n⚠ Deploy the latest backend first — /integrations/* routes missing on this server.');
    process.exit(1);
  }

  const shopifyTest = await call('POST', '/integrations/shopify/test', { token });
  log('Shopify connection test', shopifyTest);

  const webhooks = await call('POST', '/integrations/shopify/register-webhooks', { token });
  log('Register Shopify webhooks', webhooks);
  if (webhooks.ok) {
    const ok = webhooks.data?.data?.successCount ?? webhooks.data?.successCount;
    console.log(`   Registered ${ok ?? '?'} webhooks (APP_URL must be your Render URL)`);
  }

  const sync = await call('POST', '/integrations/shopify/sync', {
    token,
    body: { importOrders: false },
  });
  log('Shopify catalog sync', sync);

  const bosta = await call('POST', '/reference/bosta-cities/sync', { token });
  log('Bosta cities sync', bosta);

  const final = await call('GET', '/integrations/health', { token });
  if (final.ok) {
    const d = final.data?.data || final.data;
    console.log('\n--- Final status ---');
    console.log('Shopify:', d.shopify?.configured ? 'connected' : 'not configured', '| healthy:', d.shopify?.healthy);
    console.log('Bosta:', d.bosta?.configured ? 'connected' : 'not configured', '| healthy:', d.bosta?.healthy);
    console.log('Shopify last webhook:', d.shopify?.lastWebhookAt || 'never');
    console.log('Bosta last webhook:', d.bosta?.lastWebhookAt || 'never');
  }
  console.log('\nDone. Set Vercel VITE_API_BASE to', BASE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
