/**
 * One-time bootstrap: copy Shopify online stock into warehouse realStock
 * for variants that still have realStock = 0.
 *
 * Does NOT overwrite existing warehouse counts.
 * Creates inventory ledger rows for audit.
 *
 * Usage:
 *   DRY_RUN=1 node scripts/seed-real-stock-from-shopify.js
 *   node scripts/seed-real-stock-from-shopify.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Variant from '../src/models/Variant.js';
import InventoryLedger from '../src/models/InventoryLedger.js';

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function run() {
  await connectDatabase();

  const candidates = await Variant.find({
    realStock: 0,
    onlineStock: { $gt: 0 },
  }).select('sku title onlineStock onHoldStock realStock');

  console.log(`Found ${candidates.length} variants with realStock=0 and onlineStock>0`);
  if (!candidates.length) {
    await disconnectDatabase();
    return;
  }

  let updated = 0;
  let units = 0;

  for (const variant of candidates) {
    const qty = variant.onlineStock;
    if (!qty || qty <= 0) continue;

    console.log(`  ${variant.sku}: real 0 → ${qty} (from Shopify online)`);
    units += qty;

    if (DRY_RUN) {
      updated += 1;
      continue;
    }

    await Variant.updateOne({ _id: variant._id, realStock: 0 }, { $set: { realStock: qty } });
    await InventoryLedger.create({
      variantId: variant._id,
      ledgerType: 'real_stock_increment_manual',
      quantityDelta: qty,
      reasonCode: 'stocktake_correction',
      shopifySyncStatus: 'synced',
    });
    updated += 1;
  }

  console.log(
    DRY_RUN
      ? `DRY RUN — would update ${updated} variants (${units} units)`
      : `Updated ${updated} variants (${units} units) into warehouse realStock`
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
