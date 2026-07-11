import Product from '../../models/Product.js';
import Variant from '../../models/Variant.js';
import Order from '../../models/Order.js';
import Customer from '../../models/Customer.js';
import Settings from '../../models/Settings.js';
import { config } from '../../config/index.js';
import { fetchShopInfo } from './queries/shop.js';
import { fetchLocations } from './queries/locations.js';
import { syncCatalogFromShopify, syncCatalog } from './sync.service.js';
import { isShopifyConfigured } from './credentials.js';
import { shopifyRest, shopifyRestPaginated } from './client.js';
import { handleOrdersCreate, mapImportedOrderStatus } from '../../webhooks/shopify.handlers.js';
import logger from '../../utils/logger.js';

export async function testShopifyConnection() {
  if (!(await isShopifyConfigured())) {
    const err = new Error('Shopify credentials not configured');
    err.statusCode = 400;
    throw err;
  }

  const shop = await fetchShopInfo();
  const locations = await fetchLocations();
  const settings = await Settings.findOne({ key: 'global' });

  let locationId = settings?.shopifyLocationId || config.SHOPIFY_LOCATION_ID;
  if (!locationId && locations.length) {
    const primary = locations.find((l) => l.isActive) || locations[0];
    locationId = primary.id;
  }

  const settingsUpdate = {
    shopifyShopName: shop.name,
    shopifyShopDomain: shop.myshopifyDomain,
    shopifyConnectionHealthy: true,
  };
  if (locationId && !settings?.shopifyLocationId && !config.SHOPIFY_LOCATION_ID) {
    settingsUpdate.shopifyLocationId = locationId;
  }

  await Settings.findOneAndUpdate({ key: 'global' }, settingsUpdate, { upsert: true });

  return {
    shop: {
      name: shop.name,
      domain: shop.myshopifyDomain,
      currency: shop.currencyCode,
      url: shop.primaryDomain?.url,
    },
    locations,
  };
}

export async function getShopifyStatus() {
  const configured = await isShopifyConfigured();
  const settings = await Settings.findOne({ key: 'global' });
  const [productCount, variantCount, orderCount, customerCount] = await Promise.all([
    Product.countDocuments(),
    Variant.countDocuments({ shopifyVariantId: { $exists: true, $ne: '' } }),
    Order.countDocuments(),
    Customer.countDocuments(),
  ]);

  const authMode = config.SHOPIFY_ACCESS_TOKEN
    ? 'static_token'
    : settings?.shopifyClientId
      ? 'client_credentials'
      : settings?.shopifyAccessToken
        ? 'static_token'
        : 'none';

  const inferredMode =
    settings?.shopifyCatalogMode ||
    (configured ? 'admin' : productCount > 0 ? 'storefront' : 'none');

  return {
    configured,
    authMode,
    catalogMode: inferredMode,
    healthy: settings?.shopifyConnectionHealthy ?? false,
    shopName: settings?.shopifyShopName,
    shopDomain: settings?.shopifyShopDomain || settings?.shopifyPublicDomain,
    locationId: settings?.shopifyLocationId,
    lastSyncAt: settings?.shopifyLastSyncAt,
    webhooksRegisteredAt: settings?.shopifyWebhooksRegisteredAt,
    writePolicy: settings?.shopifyWritePolicy || 'oms_only',
    lastWebhookAt: settings?.shopifyLastWebhookAt,
    counts: {
      products: productCount,
      variants: variantCount,
      orders: orderCount,
      customers: customerCount,
    },
  };
}

export async function importRecentShopifyOrders({ limit = 50 } = {}) {
  if (!(await isShopifyConfigured())) {
    const err = new Error('Shopify credentials not configured');
    err.statusCode = 400;
    throw err;
  }

  const data = await shopifyRest(`/orders.json?status=any&limit=${limit}&order=created_at desc`);
  const orders = data.orders || [];
  const results = { imported: 0, skipped: 0, errors: [] };

  for (const order of orders) {
    try {
      const existing = await Order.findOne({ shopifyOrderId: String(order.id) });
      if (existing) {
        results.skipped += 1;
        continue;
      }
      const statusOverride = mapImportedOrderStatus(order);
      await handleOrdersCreate(order, { statusOverride, source: 'shopify_import' });
      results.imported += 1;
    } catch (error) {
      results.errors.push({ orderId: order.id, error: error.message });
      logger.warn({ orderId: order.id, err: error }, 'Order import failed');
    }
  }

  await Settings.findOneAndUpdate({ key: 'global' }, { shopifyLastSyncAt: new Date() }, { upsert: true });
  return results;
}

/**
 * Pull Shopify orders created since `since` (ISO date or Date).
 * Used by the live sync job so yesterday/today sales appear without manual import.
 */
export async function importShopifyOrdersSince({ since, maxItems = 250 } = {}) {
  if (!(await isShopifyConfigured())) {
    const err = new Error('Shopify credentials not configured');
    err.statusCode = 400;
    throw err;
  }

  const sinceDate = since instanceof Date ? since : new Date(since || Date.now() - 3 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(sinceDate.getTime())) {
    const err = new Error('Invalid since date');
    err.statusCode = 400;
    throw err;
  }

  const createdAtMin = encodeURIComponent(sinceDate.toISOString());
  const results = { fetched: 0, imported: 0, skipped: 0, errors: [], since: sinceDate.toISOString() };

  await shopifyRestPaginated(
    `/orders.json?status=any&created_at_min=${createdAtMin}&limit=250&order=created_at%20asc`,
    'orders',
    {
      maxItems,
      onPage: async (orders) => {
        for (const order of orders) {
          results.fetched += 1;
          try {
            const existing = await Order.findOne({ shopifyOrderId: String(order.id) });
            if (existing) {
              results.skipped += 1;
              continue;
            }
            const statusOverride = mapImportedOrderStatus(order);
            await handleOrdersCreate(order, { statusOverride, source: 'shopify_import' });
            results.imported += 1;
          } catch (error) {
            results.errors.push({ orderId: order.id, error: error.message });
            logger.warn({ orderId: order.id, err: error }, 'Order since-import failed');
          }
        }
      },
    }
  );

  await Settings.findOneAndUpdate({ key: 'global' }, { shopifyLastSyncAt: new Date() }, { upsert: true });
  logger.info(results, 'Shopify orders since-import complete');
  return results;
}

/**
 * Import every order from Shopify using cursor pagination. Historical orders are
 * mapped to a sensible status (delivered/cancelled/pending) and only open orders
 * reserve warehouse stock so inventory isn't distorted by past orders.
 */
export async function importAllShopifyOrders({ maxItems = Infinity } = {}) {
  if (!(await isShopifyConfigured())) {
    const err = new Error('Shopify credentials not configured');
    err.statusCode = 400;
    throw err;
  }

  const results = { fetched: 0, imported: 0, skipped: 0, errors: [] };

  await shopifyRestPaginated('/orders.json?status=any&limit=250', 'orders', {
    maxItems,
    onPage: async (orders) => {
      for (const order of orders) {
        results.fetched += 1;
        try {
          const existing = await Order.findOne({ shopifyOrderId: String(order.id) });
          if (existing) {
            results.skipped += 1;
            continue;
          }
          const statusOverride = mapImportedOrderStatus(order);
          await handleOrdersCreate(order, { statusOverride, source: 'shopify_import' });
          results.imported += 1;
        } catch (error) {
          results.errors.push({ orderId: order.id, error: error.message });
          logger.warn({ orderId: order.id, err: error }, 'Order import failed');
        }
      }
    },
  });

  await Settings.findOneAndUpdate({ key: 'global' }, { shopifyLastSyncAt: new Date() }, { upsert: true });
  return results;
}

/**
 * Import only OPEN, NOT-CLOSED orders from Shopify — i.e. orders that still need
 * operational action: not archived/closed, not cancelled, and not fully
 * fulfilled. This is the live work queue the OMS cares about (closed/historical
 * orders are intentionally excluded). Read-only against Shopify.
 */
export async function importOpenShopifyOrders({ maxItems = Infinity } = {}) {
  if (!(await isShopifyConfigured())) {
    const err = new Error('Shopify credentials not configured');
    err.statusCode = 400;
    throw err;
  }

  const results = { fetched: 0, imported: 0, skipped: 0, errors: [] };

  await shopifyRestPaginated(
    '/orders.json?status=open&fulfillment_status=unfulfilled&limit=250',
    'orders',
    {
      maxItems,
      onPage: async (orders) => {
        for (const order of orders) {
          results.fetched += 1;
          try {
            const existing = await Order.findOne({ shopifyOrderId: String(order.id) });
            if (existing) {
              results.skipped += 1;
              continue;
            }
            // Open + unfulfilled orders are active work → verify + reserve stock.
            await handleOrdersCreate(order, { source: 'shopify_import' });
            results.imported += 1;
          } catch (error) {
            results.errors.push({ orderId: order.id, error: error.message });
            logger.warn({ orderId: order.id, err: error }, 'Open order import failed');
          }
        }
      },
    }
  );

  await Settings.findOneAndUpdate({ key: 'global' }, { shopifyLastSyncAt: new Date() }, { upsert: true });
  return results;
}

/**
 * Seed the OMS with open Shopify orders on first boot if it has none yet.
 * Read-only against Shopify (inserts into MongoDB only).
 *
 * The connected store holds tens of thousands of historical/closed orders, which
 * are intentionally NOT imported. We only pull OPEN, unfulfilled orders — the
 * live work queue. A full historical import remains available on demand via the
 * admin "Import orders" action (with { all: true }).
 */
export async function ensureOrdersLoaded() {
  if (!(await isShopifyConfigured())) return { skipped: 'not_configured' };
  const existing = await Order.countDocuments();
  if (existing === 0) {
    logger.info('No orders in OMS — importing open (not closed) Shopify orders (read-only)');
    const orders = await importOpenShopifyOrders().catch((err) => {
      logger.warn({ err }, 'Startup order import failed');
      return null;
    });
    logger.info({ orders }, 'Startup Shopify import complete');
    return { orders };
  }

  // Catch up recent orders so dashboard stays live even if webhooks were missed.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const catchUp = await importShopifyOrdersSince({ since, maxItems: 250 }).catch((err) => {
    logger.warn({ err }, 'Startup order catch-up failed');
    return null;
  });
  return { skipped: 'already_loaded', orders: existing, catchUp };
}

function mapShopifyCustomer(sc) {
  const addr = sc.default_address || {};
  const fullName =
    `${sc.first_name || ''} ${sc.last_name || ''}`.trim() ||
    `${addr.first_name || ''} ${addr.last_name || ''}`.trim() ||
    'Unknown';
  const phone = sc.phone || addr.phone || `shopify-${sc.id}`;
  const addresses = addr.address1
    ? [{
        label: 'Shipping',
        line1: addr.address1,
        line2: addr.address2 || undefined,
        city: addr.city || 'Unknown',
        zone: addr.province || addr.city || undefined,
        isDefault: true,
      }]
    : [];

  return {
    shopifyCustomerId: String(sc.id),
    fullName,
    phone,
    email: sc.email || undefined,
    lifetimeOrders: sc.orders_count ?? 0,
    addresses,
  };
}

/** Import every customer from Shopify, upserting by Shopify customer id. */
export async function importAllShopifyCustomers({ maxItems = Infinity } = {}) {
  if (!(await isShopifyConfigured())) {
    const err = new Error('Shopify credentials not configured');
    err.statusCode = 400;
    throw err;
  }

  const results = { fetched: 0, imported: 0, updated: 0, errors: [] };

  await shopifyRestPaginated('/customers.json?limit=250', 'customers', {
    maxItems,
    onPage: async (customers) => {
      for (const sc of customers) {
        results.fetched += 1;
        try {
          const mapped = mapShopifyCustomer(sc);
          const existing = await Customer.findOne({
            $or: [
              { shopifyCustomerId: mapped.shopifyCustomerId },
              ...(mapped.phone && !mapped.phone.startsWith('shopify-')
                ? [{ phone: mapped.phone, fullName: mapped.fullName }]
                : []),
            ],
          });

          if (existing) {
            existing.shopifyCustomerId = existing.shopifyCustomerId || mapped.shopifyCustomerId;
            if (!existing.email && mapped.email) existing.email = mapped.email;
            if ((!existing.addresses || !existing.addresses.length) && mapped.addresses.length) {
              existing.addresses = mapped.addresses;
            }
            await existing.save();
            results.updated += 1;
          } else {
            await Customer.create(mapped);
            results.imported += 1;
          }
        } catch (error) {
          results.errors.push({ customerId: sc.id, error: error.message });
          logger.warn({ customerId: sc.id, err: error }, 'Customer import failed');
        }
      }
    },
  });

  return results;
}

export async function fullShopifySync({ importOrders = true, orderLimit = 50 } = {}) {
  await testShopifyConnection();
  const catalog = await syncCatalogFromShopify();
  let orders = null;
  if (importOrders) {
    orders = await importRecentShopifyOrders({ limit: orderLimit });
  }
  return { catalog, orders };
}

export default {
  testShopifyConnection,
  getShopifyStatus,
  importRecentShopifyOrders,
  importShopifyOrdersSince,
  importAllShopifyOrders,
  importOpenShopifyOrders,
  importAllShopifyCustomers,
  ensureOrdersLoaded,
  fullShopifySync,
};
