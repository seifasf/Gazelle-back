import Product from '../../models/Product.js';
import Variant from '../../models/Variant.js';
import Settings from '../../models/Settings.js';
import { fetchAllProducts } from './queries/products.js';
import { isShopifyConfigured } from './client.js';
import logger from '../../utils/logger.js';

function mapShopifyStatus(status) {
  const map = { ACTIVE: 'active', ARCHIVED: 'archived', DRAFT: 'draft' };
  return map[status] || 'active';
}

export async function syncCatalogFromShopify() {
  if (!isShopifyConfigured()) {
    logger.warn('Shopify not configured, skipping catalog sync');
    return { synced: 0 };
  }

  const shopifyProducts = await fetchAllProducts();
  let variantCount = 0;

  for (const sp of shopifyProducts) {
    const product = await Product.findOneAndUpdate(
      { shopifyProductId: sp.id },
      {
        shopifyProductId: sp.id,
        title: sp.title,
        status: mapShopifyStatus(sp.status),
        lastSyncedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    for (const { node: sv } of sp.variants.edges) {
      await Variant.findOneAndUpdate(
        { shopifyVariantId: sv.id },
        {
          productId: product._id,
          shopifyVariantId: sv.id,
          shopifyInventoryItemId: sv.inventoryItem?.id || '',
          sku: sv.sku || sv.id,
          title: sv.title || product.title,
          sellingPrice: parseFloat(sv.price) || 0,
          onlineStock: sv.inventoryQuantity ?? 0,
          lastSyncedAt: new Date(),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      variantCount += 1;
    }
  }

  await Settings.findOneAndUpdate(
    { key: 'global' },
    { shopifyLastSyncAt: new Date(), shopifyConnectionHealthy: true },
    { upsert: true }
  );

  logger.info({ products: shopifyProducts.length, variants: variantCount }, 'Shopify catalog synced');
  return { products: shopifyProducts.length, variants: variantCount };
}

export default { syncCatalogFromShopify };
