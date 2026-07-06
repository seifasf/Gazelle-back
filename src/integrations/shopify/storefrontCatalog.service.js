import Product from '../../models/Product.js';
import Variant from '../../models/Variant.js';
import Settings from '../../models/Settings.js';
import { config } from '../../config/index.js';
import { parseVariantOptions } from './queries/products.js';
import logger from '../../utils/logger.js';

const DEFAULT_SHOP_DOMAIN = 'gazellefootwear.com';
const PAGE_SIZE = 250;

const COLOR_NAMES = ['color', 'colour', 'لون', 'اللون'];
const SIZE_NAMES = ['size', 'مقاس', 'المقاس', 'eu', 'us', 'uk'];

export function resolveShopDomain(settings) {
  const raw =
    config.SHOPIFY_SHOP_DOMAIN ||
    settings?.shopifyShopDomain ||
    settings?.shopifyPublicDomain ||
    DEFAULT_SHOP_DOMAIN;
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function parseStorefrontOptions(product, variant) {
  const options = product.options || [];
  const values = [variant.option1, variant.option2, variant.option3].filter(Boolean);
  const selectedOptions = options.map((opt, index) => ({
    name: opt.name,
    value: values[index],
  }));
  const parsed = parseVariantOptions(selectedOptions, options);

  if (!parsed.color && !parsed.size && values.length >= 2) {
    const firstName = (options[0]?.name || '').toLowerCase();
    if (SIZE_NAMES.some((s) => firstName.includes(s))) {
      return { size: values[0], color: values[1] };
    }
    if (COLOR_NAMES.some((c) => firstName.includes(c))) {
      return { color: values[0], size: values[1] };
    }
    return { size: values[0], color: values[1] };
  }

  return parsed;
}

function variantImageUrl(product, variant) {
  if (variant.featured_image?.src) return variant.featured_image.src;
  if (variant.featured_image?.id && product.images?.length) {
    const match = product.images.find((img) => img.id === variant.featured_image.id);
    if (match?.src) return match.src;
  }
  return product.images?.[0]?.src || null;
}

function mapStorefrontStatus(publishedAt) {
  return publishedAt ? 'active' : 'draft';
}

async function fetchStorefrontPage(shopDomain, page) {
  const url = `https://${shopDomain}/products.json?limit=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`Storefront catalog fetch failed (${res.status})`);
    err.statusCode = res.status === 404 ? 404 : 502;
    throw err;
  }
  return res.json();
}

export async function syncCatalogFromStorefront({ shopDomain } = {}) {
  const settings = await Settings.findOne({ key: 'global' });
  const domain = shopDomain || resolveShopDomain(settings);
  const allProducts = [];
  let page = 1;

  while (true) {
    const data = await fetchStorefrontPage(domain, page);
    const batch = data.products || [];
    if (!batch.length) break;
    allProducts.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page += 1;
  }

  let variantCount = 0;

  for (const sp of allProducts) {
    const shopifyProductId = `gid://shopify/Product/${sp.id}`;
    const featuredImage = sp.images?.[0]?.src || null;
    const tags = typeof sp.tags === 'string'
      ? sp.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : sp.tags || [];

    const product = await Product.findOneAndUpdate(
      { shopifyProductId },
      {
        $set: {
          shopifyProductId,
          title: sp.title,
          handle: sp.handle,
          vendor: sp.vendor || '',
          productType: sp.product_type || '',
          imageUrl: featuredImage,
          tags,
          status: mapStorefrontStatus(sp.published_at),
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    for (const sv of sp.variants || []) {
      const shopifyVariantId = `gid://shopify/ProductVariant/${sv.id}`;
      const existing = await Variant.findOne({ shopifyVariantId });
      const { color, size } = parseStorefrontOptions(sp, sv);
      const imageUrl = variantImageUrl(sp, sv) || featuredImage;

      const update = {
        productId: product._id,
        shopifyVariantId,
        shopifyInventoryItemId: existing?.shopifyInventoryItemId || `storefront:${sv.id}`,
        sku: sv.sku || `variant-${sv.id}`,
        barcode: sv.barcode || '',
        title: sv.title || product.title,
        color,
        size,
        imageUrl,
        sellingPrice: parseFloat(sv.price) || 0,
        compareAtPrice: sv.compare_at_price ? parseFloat(sv.compare_at_price) : null,
        shopifyAvailable: sv.available === true,
        lastSyncedAt: new Date(),
      };

      if (!existing) {
        update.onHoldStock = 0;
        update.realStock = 0;
        update.onlineStock = 0;
      }

      await Variant.findOneAndUpdate(
        { shopifyVariantId },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      variantCount += 1;
    }
  }

  await Settings.findOneAndUpdate(
    { key: 'global' },
    {
      shopifyShopDomain: domain,
      shopifyPublicDomain: domain,
      shopifyCatalogMode: 'storefront',
      shopifyLastSyncAt: new Date(),
      shopifyConnectionHealthy: true,
      shopifyShopName: settings?.shopifyShopName || 'Gazelle Footwear',
    },
    { upsert: true }
  );

  logger.info(
    { domain, products: allProducts.length, variants: variantCount, mode: 'storefront' },
    'Storefront catalog synced (read-only)'
  );

  return { products: allProducts.length, variants: variantCount, mode: 'storefront', domain };
}

export default { syncCatalogFromStorefront, resolveShopDomain };
