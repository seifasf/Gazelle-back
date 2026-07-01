import { resetShopifyClient } from '../integrations/shopify/client.js';
import {
  testShopifyConnection,
  getShopifyStatus,
  fullShopifySync,
} from '../integrations/shopify/setup.service.js';
import {
  syncCatalog as runCatalogSync,
  startCatalogSyncInBackground,
  getCatalogSyncState,
} from '../integrations/shopify/sync.service.js';
import { registerShopifyWebhooks } from '../integrations/shopify/webhooks.service.js';
import Settings from '../models/Settings.js';

function normalizeShopDomain(domain) {
  if (!domain) return null;
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export async function getStatus(req, res, next) {
  try {
    const status = await getShopifyStatus();
    res.json({ data: status });
  } catch (err) {
    next(err);
  }
}

export async function connect(req, res, next) {
  try {
    const {
      shopDomain,
      accessToken,
      clientId,
      clientSecret,
      webhookSecret,
      locationId,
      apiVersion,
    } = req.body;

    const update = {};
    if (shopDomain != null) update.shopifyShopDomain = normalizeShopDomain(shopDomain);
    if (accessToken) update.shopifyAccessToken = accessToken;
    if (clientId != null) update.shopifyClientId = clientId;
    if (clientSecret) update.shopifyClientSecret = clientSecret;
    if (webhookSecret) update.shopifyWebhookSecret = webhookSecret;
    if (locationId != null) update.shopifyLocationId = locationId;
    if (apiVersion) update.shopifyApiVersion = apiVersion;

    // When switching to client-credentials, invalidate any stale cached token so
    // the next call fetches a fresh one with the new credentials.
    if (clientId || clientSecret) {
      update.shopifyAccessToken = accessToken || null;
      update.shopifyTokenExpiresAt = null;
    }

    await Settings.findOneAndUpdate({ key: 'global' }, update, { upsert: true });
    resetShopifyClient();

    const test = await testShopifyConnection();
    res.json({
      data: {
        connected: true,
        shop: test.shop,
        locations: test.locations,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function testConnection(req, res, next) {
  try {
    const result = await testShopifyConnection();
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function importOrders(req, res, next) {
  try {
    const { importOpenShopifyOrders, importRecentShopifyOrders, importAllShopifyOrders } = await import(
      '../integrations/shopify/setup.service.js'
    );
    // Default: import only OPEN (not closed) orders — the live work queue.
    // { all: true } forces a full historical backfill; { orderLimit } imports the
    // most recent N orders regardless of status.
    if (req.body?.all) {
      const orders = await importAllShopifyOrders();
      return res.json({ data: { orders } });
    }
    if (req.body?.orderLimit) {
      const orders = await importRecentShopifyOrders({ limit: Number(req.body.orderLimit) });
      return res.json({ data: { orders } });
    }
    const orders = await importOpenShopifyOrders();
    res.json({ data: { orders } });
  } catch (err) {
    next(err);
  }
}

export async function importCustomers(req, res, next) {
  try {
    const { importAllShopifyCustomers } = await import('../integrations/shopify/setup.service.js');
    const customers = await importAllShopifyCustomers();
    res.json({ data: { customers } });
  } catch (err) {
    next(err);
  }
}

export async function syncCatalog(req, res, next) {
  try {
    const importOrders = req.body?.importOrders === true;
    const orderLimit = Number(req.body?.orderLimit) || 50;

    if (importOrders) {
      const result = await fullShopifySync({ importOrders: true, orderLimit });
      res.json({ data: result });
    } else if (req.body?.wait === true) {
      // Synchronous mode (used by scripts/tests) — waits for completion.
      const catalog = await runCatalogSync();
      res.json({ data: { catalog } });
    } else {
      // Kick the (potentially long) admin catalog sync off in the background and
      // return immediately. The UI polls /status for shopifyLastSyncAt.
      const state = startCatalogSyncInBackground();
      res.status(202).json({ data: { catalogSync: state } });
    }
  } catch (err) {
    next(err);
  }
}

export async function syncStatus(req, res, next) {
  try {
    res.json({ data: getCatalogSyncState() });
  } catch (err) {
    next(err);
  }
}

export async function registerWebhooks(req, res, next) {
  try {
    const result = await registerShopifyWebhooks();
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getLocations(req, res, next) {
  try {
    const result = await testShopifyConnection();
    res.json({ data: result.locations });
  } catch (err) {
    next(err);
  }
}

export default {
  getStatus,
  connect,
  testConnection,
  syncCatalog,
  syncStatus,
  importOrders,
  importCustomers,
  registerWebhooks,
  getLocations,
};
