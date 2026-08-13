import Variant from '../../models/Variant.js';
import Settings from '../../models/Settings.js';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';
import { inventorySetQuantities } from './mutations/inventorySet.js';
import { fetchLocations } from './queries/locations.js';
import { assertShopifyInventoryWriteAllowed } from './writePolicy.js';

const BATCH_SIZE = 25;

function isRealShopifyInventoryItem(id) {
  return Boolean(id) && String(id).startsWith('gid://shopify/InventoryItem/');
}

/**
 * Sellable on Shopify = warehouse real − all OMS holds (Shopify + manual/pickup).
 * Every open order that holds stock must reduce website availability.
 */
export function shopifyAvailableFromVariant(variant) {
  const real = Number(variant?.realStock) || 0;
  const hold = Math.max(0, Number(variant?.onHoldStock) || 0);
  return Math.max(0, Math.round(real - hold));
}

export async function resolveShopifyLocationId() {
  const settings = await Settings.findOne({ key: 'global' });
  let locationId = settings?.shopifyLocationId || config.SHOPIFY_LOCATION_ID || null;

  // Ignore placeholder / test location ids from older setups.
  if (!locationId || /\/Location\/test$/i.test(String(locationId))) {
    locationId = null;
  }

  if (!locationId) {
    const locations = await fetchLocations();
    const primary = locations.find((l) => l.isActive) || locations[0];
    locationId = primary?.id || null;
    if (locationId) {
      await Settings.findOneAndUpdate(
        { key: 'global' },
        { $set: { shopifyLocationId: locationId } },
        { upsert: true }
      );
    }
  }

  if (!locationId) {
    const err = new Error('Shopify location is not configured');
    err.statusCode = 400;
    throw err;
  }
  return locationId;
}

/**
 * Push one variant's sellable qty (real − hold) to Shopify available.
 */
export async function syncVariantAvailableToShopify(variantId) {
  await assertShopifyInventoryWriteAllowed();

  const variant = await Variant.findById(variantId);
  if (!variant) {
    const err = new Error('Variant not found');
    err.statusCode = 404;
    throw err;
  }
  if (!isRealShopifyInventoryItem(variant.shopifyInventoryItemId)) {
    return { skipped: true, reason: 'no_shopify_inventory_item', sku: variant.sku };
  }

  const locationId = await resolveShopifyLocationId();
  const target = shopifyAvailableFromVariant(variant);

  const result = await inventorySetQuantities({
    locationId,
    quantities: [
      {
        inventoryItemId: variant.shopifyInventoryItemId,
        quantity: target,
      },
    ],
    reason: 'correction',
    referenceDocumentUri: `gid://gazelle/VariantSync/${variant._id}/${Date.now()}`,
  });

  const userErrors = result?.inventorySetQuantities?.userErrors || [];
  if (userErrors.length) {
    const err = new Error(userErrors.map((e) => e.message).join('; '));
    err.statusCode = 400;
    throw err;
  }

  variant.onlineStock = target;
  variant.shopifyAvailable = target > 0;
  variant.lastSyncedAt = new Date();
  // Avoid full-document validate — open stock may already be negative on realStock.
  await Variant.updateOne(
    { _id: variant._id },
    {
      $set: {
        onlineStock: target,
        shopifyAvailable: target > 0,
        lastSyncedAt: new Date(),
      },
    }
  );

  return { sku: variant.sku, available: target, locationId };
}

/**
 * Push OMS sellable stock (real − hold) → Shopify available for the catalog.
 */
export async function pushWarehouseStockToShopify({ dryRun = false } = {}) {
  await assertShopifyInventoryWriteAllowed();
  const locationId = await resolveShopifyLocationId();

  const variants = await Variant.find({})
    .select('sku realStock onHoldStock onlineStock shopifyInventoryItemId shopifyVariantId')
    .lean();

  const eligible = variants.filter((v) => isRealShopifyInventoryItem(v.shopifyInventoryItemId));
  const skipped = variants.length - eligible.length;

  const plan = eligible.map((v) => {
    const target = shopifyAvailableFromVariant(v);
    return {
      variantId: String(v._id),
      sku: v.sku,
      inventoryItemId: v.shopifyInventoryItemId,
      previousOnline: v.onlineStock ?? 0,
      warehouse: v.realStock ?? 0,
      onHold: v.onHoldStock ?? 0,
      target,
      changed: target !== (v.onlineStock ?? 0),
    };
  });

  if (dryRun) {
    return {
      dryRun: true,
      locationId,
      totalVariants: variants.length,
      eligible: eligible.length,
      skipped,
      wouldUpdate: plan.filter((p) => p.changed).length,
      sample: plan.filter((p) => p.changed).slice(0, 10),
    };
  }

  let updated = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < plan.length; i += BATCH_SIZE) {
    const chunk = plan.slice(i, i + BATCH_SIZE);
    try {
      const result = await inventorySetQuantities({
        locationId,
        quantities: chunk.map((p) => ({
          inventoryItemId: p.inventoryItemId,
          quantity: p.target,
        })),
        reason: 'correction',
        referenceDocumentUri: `gid://gazelle/WarehouseStockPush/${new Date().toISOString().slice(0, 10)}`,
      });

      const userErrors = result?.inventorySetQuantities?.userErrors || [];
      if (userErrors.length) {
        failed += chunk.length;
        errors.push({
          batch: i / BATCH_SIZE,
          messages: userErrors.map((e) => e.message),
        });
        logger.warn({ userErrors, batch: i }, 'Shopify inventorySetQuantities userErrors');
        continue;
      }

      const ops = chunk.map((p) => ({
        updateOne: {
          filter: { _id: p.variantId },
          update: {
            $set: {
              onlineStock: p.target,
              shopifyAvailable: p.target > 0,
              lastSyncedAt: new Date(),
            },
          },
        },
      }));
      if (ops.length) await Variant.bulkWrite(ops);
      updated += chunk.length;
    } catch (err) {
      failed += chunk.length;
      errors.push({ batch: i / BATCH_SIZE, message: err.message });
      logger.error({ err, batch: i }, 'Shopify warehouse stock push batch failed');
    }

    await new Promise((r) => setTimeout(r, 350));
  }

  return {
    dryRun: false,
    locationId,
    totalVariants: variants.length,
    eligible: eligible.length,
    skipped,
    updated,
    failed,
    errors: errors.slice(0, 20),
  };
}

export default {
  shopifyAvailableFromVariant,
  resolveShopifyLocationId,
  syncVariantAvailableToShopify,
  pushWarehouseStockToShopify,
};
