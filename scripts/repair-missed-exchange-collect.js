/**
 * +real Bosta collect SKUs for exchanges confirmed into stock after the
 * 20 Jul 2026 order cutover, when confirm only released outbound hold.
 *
 *   node scripts/repair-missed-exchange-collect.js          # dry-run
 *   node scripts/repair-missed-exchange-collect.js --apply
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { applyLedgerEntries } from '../src/services/inventory.service.js';
import { withTransaction } from '../src/utils/transaction.js';
import {
  syncShopifySellableAfterLedger,
  releaseOutOfStockOrdersIfRestocked,
} from '../src/services/order.service.js';

const EXCEL_CUTOFF = new Date('2026-07-20T00:00:00.000Z');
const apply = process.argv.includes('--apply');

await connectDatabase();
const db = mongoose.connection.db;
const orders = db.collection('orders');
const ledgers = db.collection('inventoryledgers');
const hist = db.collection('orderstatushistories');
const variants = db.collection('variants');

const confirms = await hist
  .find({ toStatus: 'returned_to_stock', createdAt: { $gt: EXCEL_CUTOFF } })
  .project({ orderId: 1, createdAt: 1 })
  .toArray();

const orderIds = [...new Set(confirms.map((h) => String(h.orderId)))].map(
  (id) => new mongoose.Types.ObjectId(id)
);
const orderDocs = await orders.find({ _id: { $in: orderIds } }).toArray();
const byId = Object.fromEntries(orderDocs.map((o) => [String(o._id), o]));

const entries = [];
const report = [];

for (const h of confirms) {
  const o = byId[String(h.orderId)];
  if (!o?.isExchangeOrder || o.skipCollectRestock) continue;
  if (o.internalStatus !== 'returned_to_stock') continue;
  const collect = o.bostaReturnItems || [];
  if (!collect.length) continue;

  const returned = await ledgers
    .aggregate([
      { $match: { orderId: o._id, ledgerType: 'real_stock_increment_return' } },
      { $group: { _id: '$variantId', qty: { $sum: '$quantityDelta' } } },
    ])
    .toArray();
  const returnedMap = Object.fromEntries(returned.map((r) => [String(r._id), r.qty]));

  for (const line of collect) {
    if (!line.variantId) continue;
    const qty = Number(line.quantity) || 0;
    const already = returnedMap[String(line.variantId)] || 0;
    const need = Math.max(0, qty - already);
    const v = await variants.findOne(
      { _id: line.variantId },
      { projection: { sku: 1, realStock: 1, onHoldStock: 1, size: 1 } }
    );
    const row = {
      orderId: String(o._id),
      name: o.shopifyOrderName || o.orderNumber || String(o._id),
      tracking: o.bostaTrackingNumber || '',
      confirmedAt: h.createdAt,
      sku: String(line.sku || v?.sku || '').toUpperCase(),
      size: line.size ?? v?.size,
      need,
      already,
      realStockBefore: v?.realStock,
    };
    report.push(row);
    if (need > 0) {
      entries.push({
        variantId: line.variantId,
        orderId: o._id,
        ledgerType: 'real_stock_increment_return',
        quantityDelta: need,
        reasonCode: 'exchange_collect_missed_after_count',
      });
    }
  }
}

const needed = report.filter((r) => r.need > 0);
console.log(
  JSON.stringify(
    {
      excelCutoff: EXCEL_CUTOFF.toISOString(),
      apply,
      lines: needed,
      skippedAlreadyReturned: report.filter((r) => r.need === 0),
      totalPairs: needed.reduce((s, r) => s + r.need, 0),
    },
    null,
    2
  )
);

if (!apply) {
  console.log('Dry-run only. Pass --apply to write warehouse stock and push Shopify.');
  await disconnectDatabase();
  process.exit(0);
}

if (!entries.length) {
  console.log('Nothing to apply.');
  await disconnectDatabase();
  process.exit(0);
}

const ledgerDocs = await withTransaction(async (session) => applyLedgerEntries(entries, session));
const variantIds = [...new Set(entries.map((e) => String(e.variantId)))];
await syncShopifySellableAfterLedger(ledgerDocs, {
  oosNote: 'Auto: missed exchange collect restock after warehouse count',
});
await releaseOutOfStockOrdersIfRestocked(variantIds, {
  note: 'Auto: missed exchange collect restock after warehouse count',
});

const after = await variants
  .find({ _id: { $in: entries.map((e) => e.variantId) } })
  .project({ sku: 1, realStock: 1, onHoldStock: 1 })
  .toArray();
console.log('applied', ledgerDocs.length, 'after', after);
await disconnectDatabase();
