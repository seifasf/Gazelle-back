import Variant from '../models/Variant.js';
import InventoryLedger from '../models/InventoryLedger.js';
import { LEDGER_TYPES } from '../constants/index.js';
import logger from '../utils/logger.js';
import { isManualOrderRef } from '../utils/orderRefs.js';
import mongoose from 'mongoose';

const STOCK_FIELD_MAP = {
  on_hold_reserve: 'onHoldStock',
  on_hold_release: 'onHoldStock',
  real_stock_decrement: 'realStock',
  real_stock_increment_manual: 'realStock',
  real_stock_increment_return: 'realStock',
  online_stock_increment_api: 'onlineStock',
};

/**
 * Net ledger quantity for an order line (sum of quantityDelta for given types).
 */
export async function netOrderLedgerQty(orderId, variantId, ledgerTypes, session = null) {
  if (!orderId || !variantId) return 0;
  const match = {
    orderId: new mongoose.Types.ObjectId(String(orderId)),
    variantId: new mongoose.Types.ObjectId(String(variantId)),
    ledgerType: { $in: ledgerTypes },
  };
  const pipeline = [{ $match: match }, { $group: { _id: null, net: { $sum: '$quantityDelta' } } }];
  const rows = session
    ? await InventoryLedger.aggregate(pipeline).session(session)
    : await InventoryLedger.aggregate(pipeline);
  return Number(rows[0]?.net) || 0;
}

/**
 * Apply a single ledger entry and update the corresponding variant stock field.
 * Must be called within an active MongoDB session/transaction.
 *
 * Open stock: realStock may go negative. onHoldStock still cannot go below 0.
 */
async function applyLedgerEntry(entry, session) {
  const { variantId, ledgerType, quantityDelta, orderId, reasonCode, actorUserId, shopifySyncStatus } =
    entry;

  if (!LEDGER_TYPES.includes(ledgerType)) {
    throw new Error(`Unknown ledger type: ${ledgerType}`);
  }

  const stockField = STOCK_FIELD_MAP[ledgerType];
  const variant = await Variant.findById(variantId).session(session);
  // Cancel / release / return on old orders (deleted SKUs) must not block OMS.
  if (!variant) {
    if (ledgerType === 'on_hold_release' || ledgerType === 'real_stock_increment_return') {
      logger.warn(
        { variantId: String(variantId), orderId: orderId ? String(orderId) : null, ledgerType },
        'Skipping stock update — variant deleted; writing ledger only'
      );
      const ledgerDoc = await InventoryLedger.create(
        [
          {
            variantId,
            orderId,
            ledgerType,
            quantityDelta,
            reasonCode: reasonCode || 'variant_missing_on_stock_op',
            actorUserId,
            shopifySyncStatus: shopifySyncStatus || 'synced',
          },
        ],
        { session }
      );
      return {
        ledger: ledgerDoc[0],
        variantId,
        stockField,
        previous: 0,
        next: 0,
        orderId: orderId || null,
        skippedVariant: true,
      };
    }
    const err = new Error(`Variant not found: ${variantId}`);
    err.statusCode = 404;
    throw err;
  }

  const previous = variant[stockField] ?? 0;
  let appliedDelta = quantityDelta;
  let newValue = previous + quantityDelta;
  // Clamp hold release so partial / stale holds never block cancel.
  if (stockField === 'onHoldStock' && quantityDelta < 0 && newValue < 0) {
    appliedDelta = -previous;
    newValue = 0;
    if (appliedDelta === 0) {
      logger.warn(
        { variantId: String(variantId), orderId: orderId ? String(orderId) : null },
        'No on-hold left to release — skipping stock update'
      );
      return {
        ledger: null,
        variantId,
        stockField,
        previous,
        next: previous,
        orderId: orderId || null,
        skippedEmptyHold: true,
      };
    }
  } else if (stockField === 'onHoldStock' && newValue < 0) {
    const err = new Error(
      `Stock would go negative: ${stockField}=${previous} delta=${quantityDelta}`
    );
    err.statusCode = 409;
    throw err;
  }

  const ledgerDoc = await InventoryLedger.create(
    [
      {
        variantId,
        orderId,
        ledgerType,
        quantityDelta: appliedDelta,
        reasonCode,
        actorUserId,
        shopifySyncStatus,
      },
    ],
    { session }
  );

  await Variant.updateOne(
    { _id: variantId },
    { $inc: { [stockField]: appliedDelta } },
    { session }
  );

  return {
    ledger: ledgerDoc[0],
    variantId,
    stockField,
    previous,
    next: newValue,
    orderId: orderId || null,
  };
}

/**
 * Apply multiple ledger entries atomically within a transaction session.
 * @returns {Promise<Array>} created ledger documents (same shape as before for callers)
 */
export async function applyLedgerEntries(entries, session) {
  const results = [];
  const negativeCrossings = [];

  for (const entry of entries) {
    const applied = await applyLedgerEntry(entry, session);
    if (applied.ledger) results.push(applied.ledger);

    if (
      applied.stockField === 'realStock' &&
      applied.previous >= 0 &&
      applied.next < 0
    ) {
      negativeCrossings.push({
        variantId: applied.variantId,
        realStock: applied.next,
        orderId: applied.orderId,
      });
    }
  }

  // Fire notifications after the transaction commits (callers schedule via returned meta).
  // Attach for order.service to flush post-commit.
  results._negativeCrossings = negativeCrossings;
  return results;
}

/** Flush factory-restock alerts after a successful transaction. */
export async function notifyNegativeStockCrossings(crossings = []) {
  if (!crossings.length) return;
  try {
    const { notifyFactoryRestockNeeded } = await import('./notification.service.js');
    for (const c of crossings) {
      await notifyFactoryRestockNeeded(c.variantId, {
        orderId: c.orderId,
        realStock: c.realStock,
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Factory restock notify failed');
  }
}

/**
 * Reserve on_hold stock for order line items.
 */
export function buildHoldReserveEntries(orderId, items) {
  return items.map((item) => ({
    variantId: item.variantId,
    orderId,
    ledgerType: 'on_hold_reserve',
    quantityDelta: item.quantity,
  }));
}

/**
 * Release on_hold and decrement real_stock on delivery.
 * Prefer buildDeliveryStockEntries (idempotent / partial-hold safe) for live deliveries.
 */
export function buildDeliveryEntries(orderId, items) {
  const entries = [];
  for (const item of items) {
    entries.push({
      variantId: item.variantId,
      orderId,
      ledgerType: 'on_hold_release',
      quantityDelta: -item.quantity,
    });
    entries.push({
      variantId: item.variantId,
      orderId,
      ledgerType: 'real_stock_decrement',
      quantityDelta: -item.quantity,
    });
  }
  return entries;
}

/**
 * Build delivery ledger entries that:
 * - release only remaining hold for this order line
 * - always decrement real stock for any units not already decremented
 */
export async function buildDeliveryStockEntries(orderId, items, session) {
  const entries = [];
  for (const item of items || []) {
    const qty = Number(item.quantity) || 0;
    if (qty < 1 || !item.variantId) continue;

    const netHold = await netOrderLedgerQty(
      orderId,
      item.variantId,
      ['on_hold_reserve', 'on_hold_release'],
      session
    );
    const releaseQty = Math.min(qty, Math.max(0, netHold));
    if (releaseQty > 0) {
      entries.push({
        variantId: item.variantId,
        orderId,
        ledgerType: 'on_hold_release',
        quantityDelta: -releaseQty,
      });
    }

    const alreadyDec = Math.abs(
      await netOrderLedgerQty(orderId, item.variantId, ['real_stock_decrement'], session)
    );
    const needDec = Math.max(0, qty - alreadyDec);
    if (needDec > 0) {
      entries.push({
        variantId: item.variantId,
        orderId,
        ledgerType: 'real_stock_decrement',
        quantityDelta: -needDec,
      });
    }
  }
  return entries;
}

/**
 * Ensure ready-to-ship lines have matching on_hold_reserve (top up missing qty only).
 */
export async function buildMissingHoldEntries(orderId, items, session) {
  const entries = [];
  for (const item of items || []) {
    const qty = Number(item.quantity) || 0;
    if (qty < 1 || !item.variantId) continue;
    const netHold = await netOrderLedgerQty(
      orderId,
      item.variantId,
      ['on_hold_reserve', 'on_hold_release'],
      session
    );
    const need = Math.max(0, qty - Math.max(0, netHold));
    if (need > 0) {
      entries.push({
        variantId: item.variantId,
        orderId,
        ledgerType: 'on_hold_reserve',
        quantityDelta: need,
      });
    }
  }
  return entries;
}

/**
 * Pre-delivery cancel / failed delivery: release hold only.
 * Shopify available rises when hold drops (synced after ledger apply).
 */
export function buildPreDeliveryReleaseEntries(orderId, items) {
  return items.map((item) => ({
    variantId: item.variantId,
    orderId,
    ledgerType: 'on_hold_release',
    quantityDelta: -item.quantity,
  }));
}

/**
 * Post-delivery return / refund received at warehouse: +real stock (then Shopify sync).
 */
export function buildPostDeliveryReturnEntries(orderId, items) {
  return items.map((item) => ({
    variantId: item.variantId,
    orderId,
    ledgerType: 'real_stock_increment_return',
    quantityDelta: item.quantity,
  }));
}

/**
 * Restock only units that were sold (real_stock_decrement) and not yet returned.
 * Prefer this over deliveredAt — that flag can be missing after imports / status repairs.
 */
export async function buildOutstandingReturnRestockEntries(orderId, items, session) {
  const entries = [];
  for (const item of items || []) {
    const qty = Number(item.quantity) || 0;
    if (qty < 1 || !item.variantId) continue;

    const decremented = Math.abs(
      await netOrderLedgerQty(orderId, item.variantId, ['real_stock_decrement'], session)
    );
    const alreadyReturned = Math.max(
      0,
      await netOrderLedgerQty(orderId, item.variantId, ['real_stock_increment_return'], session)
    );
    const need = Math.max(0, Math.min(qty, decremented - alreadyReturned));
    if (need > 0) {
      entries.push({
        variantId: item.variantId,
        orderId,
        ledgerType: 'real_stock_increment_return',
        quantityDelta: need,
      });
    }
  }
  return entries;
}

/**
 * Release only remaining on-hold for this order's lines (idempotent).
 */
export async function buildOutstandingHoldReleaseEntries(orderId, items, session) {
  const entries = [];
  for (const item of items || []) {
    const qty = Number(item.quantity) || 0;
    if (qty < 1 || !item.variantId) continue;
    const netHold = await netOrderLedgerQty(
      orderId,
      item.variantId,
      ['on_hold_reserve', 'on_hold_release'],
      session
    );
    const releaseQty = Math.min(qty, Math.max(0, netHold));
    if (releaseQty > 0) {
      entries.push({
        variantId: item.variantId,
        orderId,
        ledgerType: 'on_hold_release',
        quantityDelta: -releaseQty,
      });
    }
  }
  return entries;
}

/**
 * Release ALL remaining on-hold for an order (every variant with net hold > 0).
 * Use on cancel so edited/removed lines cannot leave orphan holds.
 */
export async function buildFullOrderHoldReleaseEntries(orderId, session = null) {
  if (!orderId) return [];
  const oid = new mongoose.Types.ObjectId(String(orderId));
  const pipeline = [
    {
      $match: {
        orderId: oid,
        ledgerType: { $in: ['on_hold_reserve', 'on_hold_release'] },
      },
    },
    { $group: { _id: '$variantId', net: { $sum: '$quantityDelta' } } },
    { $match: { net: { $gt: 0 } } },
  ];
  const rows = session
    ? await InventoryLedger.aggregate(pipeline).session(session)
    : await InventoryLedger.aggregate(pipeline);

  return rows
    .filter((r) => r._id && Number(r.net) > 0)
    .map((r) => ({
      variantId: r._id,
      orderId: oid,
      ledgerType: 'on_hold_release',
      quantityDelta: -Number(r.net),
      reasonCode: 'cancel_release_hold',
    }));
}

/**
 * Recompute Variant.onHoldStock from open order ledger holds.
 * Keeps the puzzle piece (field) locked to ledger truth.
 */
export async function reconcileVariantOnHoldFromLedger(variantId, session = null) {
  if (!variantId) return null;
  const vid = new mongoose.Types.ObjectId(String(variantId));
  const pipeline = [
    {
      $match: {
        variantId: vid,
        orderId: { $ne: null },
        ledgerType: { $in: ['on_hold_reserve', 'on_hold_release'] },
      },
    },
    { $group: { _id: '$orderId', net: { $sum: '$quantityDelta' } } },
    { $match: { net: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$net' } } },
  ];
  const rows = session
    ? await InventoryLedger.aggregate(pipeline).session(session)
    : await InventoryLedger.aggregate(pipeline);
  const target = Math.max(0, Number(rows[0]?.total) || 0);

  const variant = session
    ? await Variant.findById(vid).session(session)
    : await Variant.findById(vid);
  if (!variant) return null;

  const previous = Math.max(0, variant.onHoldStock ?? 0);
  if (previous === target) {
    return { variantId: String(vid), sku: variant.sku, previous, next: target, changed: false };
  }

  variant.onHoldStock = target;
  await variant.save(session ? { session } : undefined);
  logger.info(
    { sku: variant.sku, previous, next: target },
    'Reconciled variant onHoldStock from ledger'
  );
  return { variantId: String(vid), sku: variant.sku, previous, next: target, changed: true };
}

/**
 * Full stock puzzle repair:
 * 1) Clear leftover holds on cancelled / returned_to_stock orders
 * 2) Reconcile every variant's onHoldStock to open ledger holds
 */
export async function repairStockIntegrity({ actorUserId = null } = {}) {
  const Order = (await import('../models/Order.js')).default;
  const { withTransaction } = await import('../utils/transaction.js');

  const holdNets = await InventoryLedger.aggregate([
    {
      $match: {
        orderId: { $ne: null },
        ledgerType: { $in: ['on_hold_reserve', 'on_hold_release'] },
      },
    },
    {
      $group: {
        _id: { orderId: '$orderId', variantId: '$variantId' },
        net: { $sum: '$quantityDelta' },
      },
    },
    { $match: { net: { $gt: 0 } } },
  ]);

  const orphanOrderIds = new Set();
  for (const row of holdNets) {
    const order = await Order.findById(row._id.orderId).select('internalStatus').lean();
    if (
      order
      && (order.internalStatus === 'cancelled' || order.internalStatus === 'returned_to_stock')
    ) {
      orphanOrderIds.add(String(row._id.orderId));
    }
  }

  let orphanHoldsReleased = 0;
  const touchedVariants = new Set();

  for (const orderId of orphanOrderIds) {
    const outcome = await withTransaction(async (session) => {
      const entries = await buildFullOrderHoldReleaseEntries(orderId, session);
      if (!entries.length) return [];
      for (const e of entries) {
        e.reasonCode = 'integrity_orphan_hold_release';
        e.actorUserId = actorUserId || undefined;
      }
      return applyLedgerEntries(entries, session);
    });
    orphanHoldsReleased += outcome.length;
    for (const doc of outcome) {
      if (doc?.variantId) touchedVariants.add(String(doc.variantId));
    }
  }

  // Reconcile all variants that have ledger activity or onHoldStock set.
  const variantIds = await InventoryLedger.distinct('variantId', {
    ledgerType: { $in: ['on_hold_reserve', 'on_hold_release'] },
  });
  const fieldHoldIds = await Variant.find({ onHoldStock: { $gt: 0 } }).distinct('_id');
  const allIds = [...new Set([...variantIds, ...fieldHoldIds].map(String))];

  let holdsReconciled = 0;
  for (const id of allIds) {
    const result = await reconcileVariantOnHoldFromLedger(id);
    if (result?.changed) {
      holdsReconciled += 1;
      touchedVariants.add(id);
    }
  }

  return {
    orphanOrdersCleared: orphanOrderIds.size,
    orphanHoldsReleased,
    holdsReconciled,
    variantIds: [...touchedVariants],
  };
}

/**
 * Manual warehouse adjustment on real_stock.
 */
export function buildManualAdjustmentEntry({ variantId, quantityDelta, reasonCode, actorUserId }) {
  return {
    variantId,
    ledgerType: 'real_stock_increment_manual',
    quantityDelta,
    reasonCode,
    actorUserId,
  };
}

/**
 * Admin stock intake: warehouse real stock only (never pushes to Shopify).
 */
export function buildStockIntakeEntries({ variantId, quantityDelta, reasonCode, actorUserId }) {
  return [
    buildManualAdjustmentEntry({ variantId, quantityDelta, reasonCode, actorUserId }),
  ];
}

/**
 * Open on-hold units by order + SKU (net reserve − release from ledger).
 */
export async function listOnHoldItems({ search, limit = 500 } = {}) {
  const Order = (await import('../models/Order.js')).default;
  const Variant = (await import('../models/Variant.js')).default;
  await import('../models/Customer.js');
  await import('../models/Product.js');

  const capped = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const rows = await InventoryLedger.aggregate([
    {
      $match: {
        orderId: { $ne: null },
        ledgerType: { $in: ['on_hold_reserve', 'on_hold_release'] },
      },
    },
    {
      $group: {
        _id: { orderId: '$orderId', variantId: '$variantId' },
        quantity: { $sum: '$quantityDelta' },
        lastAt: { $max: '$createdAt' },
      },
    },
    { $match: { quantity: { $gt: 0 } } },
    { $sort: { lastAt: -1 } },
    { $limit: capped },
  ]);

  if (!rows.length) return { items: [], total: 0, totalUnits: 0 };

  const orderIds = [...new Set(rows.map((r) => String(r._id.orderId)))];
  const variantIds = [...new Set(rows.map((r) => String(r._id.variantId)))];

  const [orders, variants] = await Promise.all([
    Order.find({ _id: { $in: orderIds } })
      .select(
        'shopifyOrderName shopifyOrderId internalStatus shippingMethod placedAt customerId shippingAddress.fullName shippingAddress.phone'
      )
      .populate('customerId', 'fullName phone')
      .lean(),
    Variant.find({ _id: { $in: variantIds } })
      .select('sku title color size imageUrl realStock onHoldStock productId')
      .populate('productId', 'title imageUrl')
      .lean(),
  ]);

  const orderMap = new Map(orders.map((o) => [String(o._id), o]));
  const variantMap = new Map(variants.map((v) => [String(v._id), v]));

  let items = rows
    .map((r) => {
      const order = orderMap.get(String(r._id.orderId)) || null;
      const variant = variantMap.get(String(r._id.variantId)) || null;
      const orderNumber =
        order?.shopifyOrderName
        || (order?.shopifyOrderId
          ? isManualOrderRef(order.shopifyOrderId)
            ? String(order.shopifyOrderId)
            : `#${order.shopifyOrderId}`
          : null);
      return {
        orderId: String(r._id.orderId),
        orderNumber: orderNumber || String(r._id.orderId).slice(-8),
        orderStatus: order?.internalStatus || null,
        shippingMethod: order?.shippingMethod || null,
        placedAt: order?.placedAt || null,
        customerName:
          order?.customerId?.fullName || order?.shippingAddress?.fullName || null,
        customerPhone:
          order?.customerId?.phone || order?.shippingAddress?.phone || null,
        variantId: String(r._id.variantId),
        sku: variant?.sku || '—',
        title: variant?.productId?.title || variant?.title || variant?.sku || '—',
        color: variant?.color || null,
        size: variant?.size ?? null,
        imageUrl: variant?.imageUrl || variant?.productId?.imageUrl || null,
        quantity: r.quantity,
        variantOnHold: variant?.onHoldStock ?? null,
        variantRealStock: variant?.realStock ?? null,
        lastHoldAt: r.lastAt,
      };
    })
    // Cancelled / returned-to-stock must not appear as open holds.
    .filter(
      (row) =>
        row.quantity > 0
        && row.orderStatus
        && row.orderStatus !== 'cancelled'
        && row.orderStatus !== 'returned_to_stock'
    );

  const term = String(search || '').trim().toLowerCase();
  if (term) {
    items = items.filter((row) => {
      const hay = [
        row.orderNumber,
        row.sku,
        row.title,
        row.color,
        row.size,
        row.customerName,
        row.customerPhone,
        row.orderStatus,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(term);
    });
  }

  const totalUnits = items.reduce((s, r) => s + (r.quantity || 0), 0);
  return { items, total: items.length, totalUnits };
}

export default {
  applyLedgerEntries,
  notifyNegativeStockCrossings,
  netOrderLedgerQty,
  buildHoldReserveEntries,
  buildDeliveryEntries,
  buildDeliveryStockEntries,
  buildMissingHoldEntries,
  buildPreDeliveryReleaseEntries,
  buildPostDeliveryReturnEntries,
  buildOutstandingReturnRestockEntries,
  buildOutstandingHoldReleaseEntries,
  buildFullOrderHoldReleaseEntries,
  reconcileVariantOnHoldFromLedger,
  repairStockIntegrity,
  buildManualAdjustmentEntry,
  buildStockIntakeEntries,
  listOnHoldItems,
};
