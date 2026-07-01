import Variant from '../models/Variant.js';
import InventoryLedger from '../models/InventoryLedger.js';
import { LEDGER_TYPES } from '../constants/index.js';

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

  const newValue = variant[stockField] + quantityDelta;
  if ((stockField === 'onHoldStock' || stockField === 'realStock') && newValue < 0) {
    const err = new Error(
      `Stock would go negative: ${stockField}=${variant[stockField]} delta=${quantityDelta}`
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

  return ledgerDoc[0];
}

/**
 * Apply multiple ledger entries atomically within a transaction session.
 * @param {Array} entries - ledger entry objects
 * @param {import('mongoose').ClientSession} session
 * @returns {Promise<Array>} created ledger documents
 */
export async function applyLedgerEntries(entries, session) {
  const results = [];
  for (const entry of entries) {
    results.push(await applyLedgerEntry(entry, session));
  }
  return results;
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
 * Pre-delivery cancel / failed delivery: release hold + queue online restore.
 */
export function buildPreDeliveryReleaseEntries(orderId, items) {
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
      ledgerType: 'online_stock_increment_api',
      quantityDelta: item.quantity,
      shopifySyncStatus: 'pending',
    });
  }
  return entries;
}

/**
 * Post-delivery return: increment real + online restore.
 */
export function buildPostDeliveryReturnEntries(orderId, items) {
  const entries = [];
  for (const item of items) {
    entries.push({
      variantId: item.variantId,
      orderId,
      ledgerType: 'real_stock_increment_return',
      quantityDelta: item.quantity,
    });
    entries.push({
      variantId: item.variantId,
      orderId,
      ledgerType: 'online_stock_increment_api',
      quantityDelta: item.quantity,
      shopifySyncStatus: 'pending',
    });
  }
  return entries;
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
 * Admin stock intake: positive real stock + optional Shopify online sync.
 */
export function buildStockIntakeEntries({ variantId, quantityDelta, reasonCode, actorUserId, syncToShopify }) {
  const entries = [
    buildManualAdjustmentEntry({ variantId, quantityDelta, reasonCode, actorUserId }),
  ];
  if (syncToShopify && quantityDelta > 0) {
    entries.push({
      variantId,
      ledgerType: 'online_stock_increment_api',
      quantityDelta,
      reasonCode: reasonCode || 'stock_intake',
      actorUserId,
      shopifySyncStatus: 'pending',
    });
  }
  return entries;
}

export default {
  applyLedgerEntries,
  buildHoldReserveEntries,
  buildDeliveryEntries,
  buildPreDeliveryReleaseEntries,
  buildPostDeliveryReturnEntries,
  buildManualAdjustmentEntry,
  buildStockIntakeEntries,
};
