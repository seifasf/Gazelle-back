import Product from '../../models/Product.js';
import Variant from '../../models/Variant.js';
import Settings from '../../models/Settings.js';
import { fetchAllProducts, parseVariantOptions } from './queries/products.js';
import { isShopifyConfigured } from './credentials.js';
import { syncCatalogFromStorefront } from './storefrontCatalog.service.js';
import logger from '../../utils/logger.js';

function mapShopifyStatus(status) {
  const map = { ACTIVE: 'active', ARCHIVED: 'archived', DRAFT: 'draft' };
  return map[status] || 'active';
}

export async function syncCatalogFromShopify() {
  if (!(await isShopifyConfigured())) {
    logger.warn('Shopify not configured, skipping catalog sync');
    return { synced: 0 };
  }

  const shopifyProducts = await fetchAllProducts();
  let variantCount = 0;

  for (const sp of shopifyProducts) {
    const product = await Product.findOneAndUpdate(
      { shopifyProductId: sp.id },
      {
        $set: {
          shopifyProductId: sp.id,
          title: sp.title,
          handle: sp.handle,
          vendor: sp.vendor,
          productType: sp.productType,
          imageUrl: sp.featuredImageUrl || sp.featuredImage?.url,
          tags: sp.tagsList || sp.tags || [],
          status: mapShopifyStatus(sp.status),
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    for (const { node: sv } of sp.variants.edges) {
      const existing = await Variant.findOne({ shopifyVariantId: sv.id });
      const { color, size } = parseVariantOptions(sv.selectedOptions, sp.options);
      const update = {
        productId: product._id,
        shopifyVariantId: sv.id,
        shopifyInventoryItemId: sv.inventoryItem?.id || '',
        sku: sv.sku || sv.id,
        barcode: sv.barcode || '',
        title: sv.title || product.title,
        color: sv.resolvedColor || color,
        size: sv.resolvedSize || size,
        imageUrl: sv.resolvedImageUrl || product.imageUrl,
        sellingPrice: parseFloat(sv.price) || 0,
        compareAtPrice: sv.resolvedCompareAtPrice,
        onlineStock: sv.resolvedOnlineStock ?? sv.inventoryQuantity ?? 0,
        lastSyncedAt: new Date(),
      };

      if (!existing) {
        update.onHoldStock = 0;
        update.realStock = 0;
      }

      await Variant.findOneAndUpdate(
        { shopifyVariantId: sv.id },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      variantCount += 1;
    }
  }

  await Settings.findOneAndUpdate(
    { key: 'global' },
    {
      shopifyLastSyncAt: new Date(),
      shopifyConnectionHealthy: true,
      shopifyCatalogMode: 'admin',
    },
    { upsert: true }
  );

  logger.info({ products: shopifyProducts.length, variants: variantCount }, 'Shopify catalog synced');
  return { products: shopifyProducts.length, variants: variantCount, mode: 'admin' };
}

export async function syncCatalog({ preferStorefront = false } = {}) {
  const adminConfigured = await isShopifyConfigured();
  if (adminConfigured && !preferStorefront) {
    return syncCatalogFromShopify();
  }
  return syncCatalogFromStorefront();
}

// Tracks an in-flight catalog sync so the API can kick it off without being tied
// to an HTTP request timeout. A full admin sync paginates many product pages and
// can take a few minutes; the frontend polls /status (shopifyLastSyncAt) instead.
const catalogSyncState = { running: false, startedAt: null, finishedAt: null, result: null, error: null };

export function getCatalogSyncState() {
  return { ...catalogSyncState };
}

export function startCatalogSyncInBackground(opts = {}) {
  if (catalogSyncState.running) return { started: false, ...getCatalogSyncState() };
  catalogSyncState.running = true;
  catalogSyncState.startedAt = new Date();
  catalogSyncState.finishedAt = null;
  catalogSyncState.error = null;

  syncCatalog(opts)
    .then((result) => {
      catalogSyncState.result = result;
      logger.info({ result }, 'Background catalog sync finished');
    })
    .catch((err) => {
      catalogSyncState.error = err?.message || String(err);
      logger.error({ err }, 'Background catalog sync failed');
    })
    .finally(() => {
      catalogSyncState.running = false;
      catalogSyncState.finishedAt = new Date();
    });

  return { started: true, ...getCatalogSyncState() };
}

export default {
  syncCatalogFromShopify,
  syncCatalog,
  startCatalogSyncInBackground,
  getCatalogSyncState,
};
