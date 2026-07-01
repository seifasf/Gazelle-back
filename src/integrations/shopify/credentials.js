import Settings from '../../models/Settings.js';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

export async function getShopifyCredentials() {
  const settings = await Settings.findOne({ key: 'global' });

  return {
    shopDomain: config.SHOPIFY_SHOP_DOMAIN || settings?.shopifyShopDomain || null,
    accessToken: config.SHOPIFY_ACCESS_TOKEN || settings?.shopifyAccessToken || null,
    clientId: config.SHOPIFY_CLIENT_ID || settings?.shopifyClientId || null,
    clientSecret: config.SHOPIFY_CLIENT_SECRET || settings?.shopifyClientSecret || null,
    tokenExpiresAt: settings?.shopifyTokenExpiresAt || null,
    webhookSecret: config.SHOPIFY_WEBHOOK_SECRET || settings?.shopifyWebhookSecret || null,
    locationId: config.SHOPIFY_LOCATION_ID || settings?.shopifyLocationId || null,
    apiVersion: config.SHOPIFY_API_VERSION || settings?.shopifyApiVersion || '2025-01',
    shopName: settings?.shopifyShopName || null,
  };
}

/** True when the app uses the client credentials grant (Dev Dashboard app). */
function usesClientCredentials(creds) {
  return Boolean(creds.shopDomain && creds.clientId && creds.clientSecret);
}

/**
 * Exchange the app's client id/secret for a fresh Admin API access token using
 * the client credentials grant (server-to-server, same-org apps). Tokens last
 * ~24h, so we persist the token + expiry and reuse until shortly before expiry.
 */
async function fetchClientCredentialsToken(creds) {
  const url = `https://${creds.shopDomain}/admin/oauth/access_token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || !data.access_token) {
    const message =
      data.error_description ||
      data.error ||
      `Failed to obtain Shopify access token (HTTP ${response.status})`;
    const err = new Error(message);
    err.statusCode = response.status === 401 || response.status === 400 ? 400 : 502;
    throw err;
  }

  const expiresInMs = (data.expires_in ? data.expires_in : 86400) * 1000;
  const expiresAt = new Date(Date.now() + expiresInMs);

  await Settings.findOneAndUpdate(
    { key: 'global' },
    { shopifyAccessToken: data.access_token, shopifyTokenExpiresAt: expiresAt },
    { upsert: true }
  );

  logger.info({ expiresAt }, 'Refreshed Shopify access token via client credentials');
  return data.access_token;
}

/**
 * Return a usable Admin API access token. For client-credentials apps the token
 * is refreshed automatically when missing/expired. For a static token (env var
 * or legacy admin-created custom app) the stored token is returned as-is.
 */
export async function getValidAccessToken() {
  const creds = await getShopifyCredentials();

  // Explicit static token from environment always wins.
  if (config.SHOPIFY_ACCESS_TOKEN) return config.SHOPIFY_ACCESS_TOKEN;

  if (usesClientCredentials(creds)) {
    const stillValid =
      creds.accessToken &&
      creds.tokenExpiresAt &&
      new Date(creds.tokenExpiresAt).getTime() - 60_000 > Date.now();
    if (stillValid) return creds.accessToken;
    return fetchClientCredentialsToken(creds);
  }

  // Legacy admin-created custom app token (no client credentials available).
  return creds.accessToken;
}

export async function isShopifyConfigured() {
  const creds = await getShopifyCredentials();
  if (!creds.shopDomain) return false;
  return Boolean(creds.accessToken || usesClientCredentials(creds));
}

export function maskSecret(value) {
  if (!value) return null;
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
