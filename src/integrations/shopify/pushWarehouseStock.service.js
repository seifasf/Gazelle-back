import Variant from '../../models/Variant.js';
import Settings from '../../models/Settings.js';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';
import { inventorySetQuantities } from './mutations/inventorySet.js';
import { fetchLocations } from './queries/locations.js';

const BATCH_SIZE = 25;

function isRealShopifyInventoryItem(id) {
  return Boolean(id) && String(id).startsWith('gid://shopify/InventoryItem/');
}

/**
 * Push OMS warehouse realStock → Shopify available (absolute set).
 * Also updates local onlineStock to match what we pushed.
 * One-shot / admin-triggered — does not change ongoing write policy.
 */
export async function pushWarehouseStockToShopify({ dryRun = false } = {}) {
  const settings = await Settings.findOne({ key: 'global' }).lean();
  let locationId = settings?.shopifyLocationId || config.SHOPIFY_LOCATION_ID || null;

  if (!locationId) {
    const locations = await fetchLocations();
    const primary = locations.find((l) => l.isActive) || locations[0];
    locationId = primary?.id || null;
    if (locationId) {
      await Settings.findOneAndUpdate(
        { key: 'global' },
        { shopifyLocationId: locationId },
        { upsert: true }
      );
    }
  }

  if (!locationId) {
    const err = new Error('Shopify location is not configured');
    err.statusCode = 400;
    throw err;
  }

  const variants = await Variant.find({})
    .select('sku realStock onlineStock shopifyInventoryItemId shopifyVariantId')
    .lean();

  const eligible = variants.filter((v) => isRealShopifyInventoryItem(v.shopifyInventoryItemId));
  const skipped = variants.length - eligible.length;

  const plan = eligible.map((v) => {
    const target = Math.max(0, Math.round(Number(v.realStock) || 0));
    return {
      variantId: String(v._id),
      sku: v.sku,
      inventoryItemId: v.shopifyInventoryItemId,
      previousOnline: v.onlineStock ?? 0,
      warehouse: v.realStock ?? 0,
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

    // gentle pacing between batches
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

export default { pushWarehouseStockToShopify };
