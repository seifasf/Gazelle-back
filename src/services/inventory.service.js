import Variant from '../models/Variant.js';
import InventoryLedger from '../models/InventoryLedger.js';
import { LEDGER_TYPES } from '../constants/index.js';
import logger from '../utils/logger.js';

const STOCK_FIELD_MAP = {
  on_hold_reserve: 'onHoldStock',
  on_hold_release: 'onHoldStock',
  real_stock_decrement: 'realStock',
  real_stock_increment_manual: 'realStock',
  real_stock_increment_return: 'realStock',
  online_stock_increment_api: 'onlineStock',
};

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
  if (!variant) {
    const err = new Error(`Variant not found: ${variantId}`);
    err.statusCode = 404;
    throw err;
  }

  const previous = variant[stockField] ?? 0;
  const newValue = previous + quantityDelta;
  if (stockField === 'onHoldStock' && newValue < 0) {
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
        quantityDelta,
        reasonCode,
        actorUserId,
        shopifySyncStatus,
      },
    ],
    { session }
  );

  await Variant.updateOne({ _id: variantId }, { $inc: { [stockField]: quantityDelta } }, { session });

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
    results.push(applied.ledger);

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
 * Pre-delivery cancel / failed delivery: release hold only.
 * Shopify inventory is brand-owned — OMS does not restore online stock.
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
 * Post-delivery return: increment warehouse real stock only.
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

export default {
  applyLedgerEntries,
  notifyNegativeStockCrossings,
  buildHoldReserveEntries,
  buildDeliveryEntries,
  buildPreDeliveryReleaseEntries,
  buildPostDeliveryReturnEntries,
  buildManualAdjustmentEntry,
  buildStockIntakeEntries,
};
