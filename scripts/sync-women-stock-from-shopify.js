/**
 * Pull live Shopify available qty for Women's products → OMS realStock,
 * then release Out-of-stock orders that are now fully covered.
 *
 * Usage:
 *   DRY_RUN=1 node scripts/sync-women-stock-from-shopify.js
 *   node scripts/sync-women-stock-from-shopify.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Product from '../src/models/Product.js';
import Variant from '../src/models/Variant.js';
import Order from '../src/models/Order.js';
import { fetchAllProducts } from '../src/integrations/shopify/queries/products.js';
import { isShopifyConfigured } from '../src/integrations/shopify/credentials.js';
import {
  setRealStockBatch,
  releaseOutOfStockOrdersIfRestocked,
} from '../src/services/order.service.js';

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const CHUNK = 40;

function isWomenShopifyProduct(sp) {
  const type = String(sp.productType || '');
  if (/^women\b/i.test(type)) return true;
  const tags = (sp.tagsList || sp.tags || []).map((t) => String(t));
  const hasWomenTag = tags.some((t) => /^women$/i.test(t.trim()));
  if (hasWomenTag && !/^men\b/i.test(type)) return true;
  if (/^women\b/i.test(String(sp.title || ''))) return true;
  return false;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function run() {
  await connectDatabase();

  if (!(await isShopifyConfigured())) {
    throw new Error('Shopify is not configured');
  }

  console.log('Fetching live Shopify catalog…');
  const shopifyProducts = await fetchAllProducts();
  const womenShopify = shopifyProducts.filter(
    (sp) => sp.status === 'ACTIVE' && isWomenShopifyProduct(sp)
  );
  console.log(
    `Shopify active products: ${shopifyProducts.filter((p) => p.status === 'ACTIVE').length}`
  );
  console.log(`Women products (Shopify): ${womenShopify.length}`);

  const items = [];
  const unmatched = [];
  let shopifyUnits = 0;

  for (const sp of womenShopify) {
    for (const { node: sv } of sp.variants.edges) {
      const shopifyQty = Math.max(0, Math.round(Number(sv.resolvedOnlineStock ?? sv.inventoryQuantity ?? 0)));
      shopifyUnits += shopifyQty;
      const variant = await Variant.findOne({ shopifyVariantId: sv.id }).select(
        '_id sku realStock onlineStock productId'
      );
      if (!variant) {
        unmatched.push({ sku: sv.sku || sv.id, title: sp.title, shopifyQty });
        continue;
      }
      const previous = variant.realStock ?? 0;
      items.push({
        variantId: String(variant._id),
        sku: variant.sku,
        title: sp.title,
        previous,
        realStock: shopifyQty,
        onlineStock: shopifyQty,
        changed: previous !== shopifyQty,
      });
    }
  }

  const toChange = items.filter((i) => i.changed);
  const unchanged = items.length - toChange.length;
  console.log(`Matched OMS variants: ${items.length}`);
  console.log(`Unmatched Shopify variants: ${unmatched.length}`);
  console.log(`Will update: ${toChange.length} · unchanged: ${unchanged}`);
  console.log(`Shopify women units (sum available): ${shopifyUnits}`);

  if (toChange.length) {
    const sample = toChange
      .slice(0, 15)
      .map((i) => `  ${i.sku}: ${i.previous} → ${i.realStock} (${i.title})`);
    console.log('Sample changes:\n' + sample.join('\n'));
  }

  if (DRY_RUN) {
    console.log('DRY RUN — no writes. Re-run without DRY_RUN=1 to apply.');
    await disconnectDatabase();
    return;
  }

  // Keep onlineStock mirror in sync with what we just pulled.
  for (const part of chunk(items, 100)) {
    await Promise.all(
      part.map((i) =>
        Variant.updateOne({ _id: i.variantId }, { $set: { onlineStock: i.onlineStock, lastSyncedAt: new Date() } })
      )
    );
  }

  let changedCount = 0;
  let oosFromSet = { released: [], checked: 0 };
  for (const part of chunk(toChange, CHUNK)) {
    const batch = await setRealStockBatch({
      items: part.map((i) => ({ variantId: i.variantId, realStock: i.realStock })),
      reasonCode: 'stock_count',
      actorUserId: null,
    });
    changedCount += batch.results.filter((r) => r.changed).length;
    if (batch.oosReleased?.released?.length) {
      oosFromSet.released.push(...batch.oosReleased.released);
      oosFromSet.checked += batch.oosReleased.checked || 0;
    }
    process.stdout.write('.');
  }
  if (toChange.length) console.log('');
  console.log(`Updated realStock for ${changedCount} variants`);

  // Full OOS sweep: any order now covered by warehouse stock (women or otherwise).
  const oosOrders = await Order.find({ internalStatus: 'out_of_stock' })
    .select('_id items shopifyOrderName shopifyOrderId')
    .lean();
  const allVariantIds = [
    ...new Set(
      oosOrders.flatMap((o) => (o.items || []).map((i) => String(i.variantId)).filter(Boolean))
    ),
  ];
  console.log(`OOS orders before release sweep: ${oosOrders.length}`);

  const sweep = await releaseOutOfStockOrdersIfRestocked(allVariantIds, {
    actorUserId: null,
    note: 'Auto: women Shopify stock sync — back to Ready to ship',
  });

  const releasedIds = [...new Set([...(oosFromSet.released || []), ...(sweep.released || [])])];
  const stillOos = await Order.countDocuments({ internalStatus: 'out_of_stock' });
  const ready = await Order.countDocuments({ internalStatus: 'verified_ready_for_shipping' });

  console.log('\n=== DONE ===');
  console.log(`Women Shopify products: ${womenShopify.length}`);
  console.log(`Variants updated: ${changedCount}`);
  console.log(`OOS released → Ready to ship: ${releasedIds.length}`);
  console.log(`OOS remaining: ${stillOos}`);
  console.log(`Ready to ship now: ${ready}`);

  if (releasedIds.length) {
    const releasedOrders = await Order.find({ _id: { $in: releasedIds } })
      .select('shopifyOrderName shopifyOrderId')
      .lean();
    console.log(
      'Released:',
      releasedOrders.map((o) => o.shopifyOrderName || o.shopifyOrderId || String(o._id)).join(', ')
    );
  }

  if (unmatched.length) {
    console.log(`\nUnmatched (no OMS variant): ${unmatched.length}`);
    unmatched.slice(0, 10).forEach((u) => console.log(`  ${u.sku} · ${u.title} · qty ${u.shopifyQty}`));
  }

  // Touch women product sync stamp
  const womenShopifyIds = womenShopify.map((p) => p.id);
  await Product.updateMany(
    { shopifyProductId: { $in: womenShopifyIds } },
    { $set: { lastSyncedAt: new Date() } }
  );

  await disconnectDatabase();
}

run().catch(async (err) => {
  console.error(err);
  try {
    await disconnectDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
