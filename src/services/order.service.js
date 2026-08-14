import Order from '../models/Order.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import Variant from '../models/Variant.js';
import Customer from '../models/Customer.js';
import mongoose from 'mongoose';
import { withTransaction } from '../utils/transaction.js';
import { isManualOrderRef } from '../utils/orderRefs.js';
import Settings from '../models/Settings.js';
import { assertTransition, isTerminalStatus } from './orderStateMachine.js';
import {
  applyLedgerEntries,
  notifyNegativeStockCrossings,
  buildHoldReserveEntries,
  buildDeliveryEntries,
  buildDeliveryStockEntries,
  buildMissingHoldEntries,
  buildPreDeliveryReleaseEntries,
  buildPostDeliveryReturnEntries,
  buildOutstandingReturnRestockEntries,
  buildOutstandingHoldReleaseEntries,
  buildManualAdjustmentEntry,
  buildStockIntakeEntries,
  netOrderLedgerQty,
} from './inventory.service.js';
import {
  TERMINAL_ORDER_STATUSES,
  ORDER_STATUSES,
  ORDERS_PLACED_FROM_YMD,
  LOCAL_SHIPPING_FEE,
  DEFAULT_BOSTA_SHIPPING_FEE,
  JOB_NAMES,
} from '../constants/index.js';
import { resolveShopifyZoneShippingFee } from '../constants/shippingZones.js';
import { phoneMatchRegexes, normalizeEgPhoneDigits } from '../utils/phone.js';
import { getAgenda } from '../config/agenda.js';
import {
  notifyOrderVerified,
  notifyFailedDelivery,
  notifyReturnToOrigin,
  notifyNewOrder,
  checkVariantsLowStock,
} from './notification.service.js';
import { recordDeliveryJournal } from './accounting.service.js';
import { recordCustomerCancellation } from './customer.service.js';
import logger from '../utils/logger.js';

async function recordStatusChange(
  { orderId, fromStatus, toStatus, source, actorUserId, note },
  session
) {
  await OrderStatusHistory.create(
    [{ orderId, fromStatus, toStatus, source, actorUserId, note }],
    { session }
  );
}

async function transitionOrder(order, toStatus, meta, session) {
  const fromStatus = order.internalStatus;
  assertTransition(fromStatus, toStatus);

  const $set = {
    internalStatus: toStatus,
    lastStatusUpdateAt: new Date(),
  };
  const $unset = {};

  if (toStatus === 'verified_ready_for_shipping') {
    $set.verifiedAt = new Date();
    if (fromStatus === 'out_of_stock') {
      $set.returnedFromOutOfStockAt = new Date();
    }
  }
  if (
    fromStatus === 'verified_ready_for_shipping'
    && toStatus !== 'verified_ready_for_shipping'
  ) {
    $unset.returnedFromOutOfStockAt = 1;
  }
  if (toStatus === 'delivered') {
    $set.deliveredAt = new Date();
    $set.closedAt = new Date();
  }
  if (TERMINAL_ORDER_STATUSES.includes(toStatus)) {
    $set.closedAt = new Date();
  }

  const mongoUpdate = { $set };
  if (Object.keys($unset).length) mongoUpdate.$unset = $unset;

  await Order.updateOne({ _id: order._id }, mongoUpdate, { session });
  await recordStatusChange(
    {
      orderId: order._id,
      fromStatus,
      toStatus,
      source: meta.source,
      actorUserId: meta.actorUserId,
      note: meta.note,
    },
    session
  );

  return { fromStatus, toStatus };
}

function collectVariantIds(ledgerDocs, items = []) {
  const ids = new Set();
  for (const d of ledgerDocs || []) {
    const vid = d?.variantId?._id ?? d?.variantId;
    if (vid != null) ids.add(String(vid));
  }
  for (const item of items || []) {
    const vid = item?.variantId?._id ?? item?.variantId;
    if (vid != null) ids.add(String(vid));
  }
  return [...ids];
}

async function enqueueShopifySync(ledgerDocs, { forcePolicyFull = true, variantIds: extraIds = [] } = {}) {
  const docs = Array.isArray(ledgerDocs) ? ledgerDocs : [];
  const variantIds = [
    ...new Set([
      ...collectVariantIds(docs),
      ...(Array.isArray(extraIds) ? extraIds.map((id) => (id != null ? String(id) : null)) : []),
    ].filter(Boolean)),
  ];
  if (!variantIds.length) return { synced: [], failed: [] };

  const { syncVariantAvailableToShopify } = await import(
    '../integrations/shopify/pushWarehouseStock.service.js'
  );
  const { getShopifyWritePolicy, enableShopifyInventorySync } = await import(
    '../integrations/shopify/writePolicy.js'
  );

  // Stock moves must always reach Shopify — keep write policy enabled.
  if (forcePolicyFull) {
    await enableShopifyInventorySync();
  } else {
    const policy = await getShopifyWritePolicy();
    if (policy !== 'full') return { synced: [], failed: [], skippedPolicy: true };
  }

  const synced = [];
  const failed = [];

  for (const variantId of variantIds) {
    let lastErr = null;
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await syncVariantAvailableToShopify(variantId);
        synced.push({ variantId, ...(result || {}) });
        ok = true;
        break;
      } catch (err) {
        lastErr = err;
        logger.warn(
          { err: err?.message || err, variantId, attempt },
          'Shopify stock sync attempt failed'
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    if (!ok) {
      failed.push({ variantId, error: lastErr?.message || String(lastErr) });
      try {
        const agenda = getAgenda();
        await agenda.now(JOB_NAMES.SHOPIFY_OUTBOUND_INVENTORY, { variantId });
      } catch {
        // Agenda may not be initialized in scripts/tests
      }
    }
  }

  if (failed.length) {
    logger.error(
      { failedCount: failed.length, failed },
      'Shopify stock sync still failing after retries — queued Agenda jobs'
    );
  }

  return { synced, failed };
}

async function afterLedgerApplied(ledgerDocs, opts = {}) {
  await notifyNegativeStockCrossings(ledgerDocs?._negativeCrossings || []);
  return enqueueShopifySync(ledgerDocs, { forcePolicyFull: true, ...opts });
}

/** Public: push Shopify sellable (real − all holds) after hold/real ledger commits. */
export async function syncShopifySellableAfterLedger(ledgerDocs, opts = {}) {
  return afterLedgerApplied(ledgerDocs, opts);
}

/** Force-push current OMS sellable for explicit variant ids (returns / intakes). */
export async function forceSyncVariantsToShopify(variantIds = []) {
  return enqueueShopifySync([], { forcePolicyFull: true, variantIds });
}

/**
 * When Shopify available increases above OMS sellable (admin edit on Shopify),
 * raise warehouse realStock so sellable matches, then auto-release OOS orders.
 * Decreases on Shopify are ignored here (OMS / order webhooks own outbound sales).
 */
const SHOPIFY_INVENTORY_ECHO_MS = 120_000;

export async function ingestShopifyAvailableIncrease(variantId, shopifyAvailable) {
  const targetAvail = Math.max(0, Math.round(Number(shopifyAvailable)));
  if (!Number.isFinite(Number(shopifyAvailable))) return null;

  const variant = await Variant.findById(variantId);
  if (!variant) return null;

  const real = Number(variant.realStock) || 0;
  const hold = Math.max(0, Number(variant.onHoldStock) || 0);
  const omsSellable = Math.max(0, real - hold);
  const previousOnline = variant.onlineStock ?? null;
  const lastPushAt = variant.lastSyncedAt ? new Date(variant.lastSyncedAt).getTime() : 0;

  // Ignore stale high-available webhooks echoing an intermediate OMS push (common after OOS release).
  if (
    targetAvail > omsSellable &&
    lastPushAt &&
    Date.now() - lastPushAt < SHOPIFY_INVENTORY_ECHO_MS &&
    previousOnline != null &&
    targetAvail > previousOnline
  ) {
    logger.info(
      {
        variantId: String(variant._id),
        sku: variant.sku,
        targetAvail,
        previousOnline,
        omsSellable,
      },
      'Ignoring likely Shopify inventory webhook echo'
    );
    return { adjusted: false, ignoredEcho: true };
  }

  if (targetAvail > omsSellable) {
    const delta = targetAvail - omsSellable;
    logger.info(
      { variantId: String(variant._id), sku: variant.sku, omsSellable, targetAvail, delta },
      'Shopify available higher than OMS — ingesting into warehouse realStock'
    );
    return manualStockAdjustment({
      variantId: variant._id,
      quantityDelta: delta,
      reasonCode: 'shopify_restock',
      actorUserId: null,
      skipOosAutoRelease: false,
    });
  }

  // Stock already covers Shopify figure — still try freeing OOS orders.
  const oosReleased = await releaseOutOfStockOrdersIfRestocked([variant._id], {
    note: 'Auto: stock available (Shopify/OMS) — back to Ready to ship',
  });

  if (targetAvail < omsSellable) {
    try {
      const { reportOnlineStockDrift } = await import('./discrepancy.service.js');
      await reportOnlineStockDrift(variant._id, targetAvail);
    } catch {
      /* non-fatal */
    }
  }

  if ((variant.onlineStock ?? null) !== targetAvail) {
    await Variant.updateOne(
      { _id: variant._id },
      {
        $set: {
          onlineStock: targetAvail,
          shopifyAvailable: targetAvail > 0,
        },
      }
    );
  }

  return { adjusted: false, oosReleased };
}

export async function verifyOrder(orderId, actorUserId, { outcome, note, totalCogsSnapshot, shippingMethod }) {
  const order = await Order.findById(orderId).populate('items.variantId');
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  const verifiable = ['pending_verification', 'no_response'];
  if (!verifiable.includes(order.internalStatus)) {
    const err = new Error('Order is not waiting for verification');
    err.statusCode = 400;
    throw err;
  }

  if (outcome === 'customer_cancelled') {
    const cancelNote = typeof note === 'string' ? note.trim() : '';
    if (!cancelNote) {
      const err = new Error('A cancellation note is required');
      err.statusCode = 400;
      throw err;
    }
    return cancelOrder(orderId, actorUserId, { reason: 'customer_changed_mind', note: cancelNote });
  }

  if (outcome === 'no_response') {
    const updated = await withTransaction(async (session) => {
      const fresh = await Order.findById(orderId).session(session);
      fresh.verificationLog.push({ outcome, note, actorUserId });
      if (!fresh.assignedOrdersManagerId) fresh.assignedOrdersManagerId = actorUserId;
      await fresh.save({ session });
      if (fresh.internalStatus !== 'no_response') {
        await transitionOrder(
          fresh,
          'no_response',
          {
            source: 'user_action',
            actorUserId,
            note: note || 'Customer did not respond',
          },
          session
        );
      }
      return Order.findById(orderId).session(session);
    });
    return updated;
  }

  if (outcome !== 'confirmed') {
    // e.g. customer_requested_changes — log only, stay in current queue state.
    order.verificationLog.push({ outcome, note, actorUserId });
    await order.save();
    return order;
  }

  const verified = await withTransaction(async (session) => {
    const fresh = await Order.findById(orderId).session(session);
    fresh.verificationLog.push({ outcome, note, actorUserId });
    if (totalCogsSnapshot != null) fresh.totalCogsSnapshot = totalCogsSnapshot;
    if (!fresh.assignedOrdersManagerId) fresh.assignedOrdersManagerId = actorUserId;
    if (shippingMethod) {
      fresh.shippingMethod = shippingMethod;
      if (shippingMethod === 'local_shipping') {
        fresh.shippingFee = LOCAL_SHIPPING_FEE;
      } else if (shippingMethod === 'pickup') {
        fresh.shippingFee = 0;
      }
    }
    fresh.delayedUntil = undefined;
    fresh.delayNote = undefined;
    fresh.delayNotifiedOn = undefined;
    await fresh.save({ session });
    await Order.updateOne(
      { _id: fresh._id },
      { $unset: { delayedUntil: 1, delayNote: 1, delayNotifiedOn: 1 } },
      { session }
    );

    let ledgerDocs = [];
    if (fresh.orderSource === 'manual') {
      ledgerDocs = await reserveStockForOrder(fresh._id, fresh.items, session);
    } else {
      // Shopify already reserves at ingest — top up if hold is missing.
      ledgerDocs = await ensureOrderStockHeld(fresh._id, fresh.items, session);
    }

    await transitionOrder(
      fresh,
      'verified_ready_for_shipping',
      { source: 'user_action', actorUserId, note },
      session
    );
    const updated = await Order.findById(orderId).session(session);
    updated._ledgerDocs = ledgerDocs;
    return updated;
  });

  await afterLedgerApplied(verified?._ledgerDocs, {
    variantIds: collectVariantIds(verified?._ledgerDocs, verified?.items),
  });

  if (verified?.orderSource !== 'manual' && !isManualOrderRef(verified?.shopifyOrderId)) {
    try {
      const { markShopifyOrderFulfilled } = await import(
        '../integrations/shopify/fulfillShopifyOrder.service.js'
      );
      await markShopifyOrderFulfilled(verified);
    } catch (err) {
      logger.warn(
        { err: err?.message || err, orderId: String(verified?._id) },
        'Shopify fulfill on verify failed — OMS verified; retry from admin if needed'
      );
    }
  }

  await notifyOrderVerified(verified);
  return verified;
}

export async function cancelOrder(orderId, actorUserId, { reason, note, source = 'user_action' }) {
  const cancelNote = typeof note === 'string' ? note.trim() : '';
  // Shopify-originated cancels already have context; staff cancels need an explicit note.
  if (source !== 'shopify_webhook' && !cancelNote) {
    const err = new Error('A cancellation note is required');
    err.statusCode = 400;
    throw err;
  }

  let newlyCancelled = false;
  const cancelled = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    if (isTerminalStatus(order.internalStatus)) {
      if (order.internalStatus === 'cancelled') {
        return Order.findById(orderId).session(session);
      }
      const err = new Error('Order already in terminal state');
      err.statusCode = 400;
      throw err;
    }

    const shopifyDriven = source === 'shopify_webhook' || source === 'shopify_import';
    const cancellable = shopifyDriven
      ? [
          'pending_verification',
          'no_response',
          'verified_ready_for_shipping',
          'out_of_stock',
          'local_shipping',
          'awaiting_bosta_pickup',
          'picked_up_by_bosta',
          'in_transit',
          'failed_delivery',
        ]
      : [
          'pending_verification',
          'no_response',
          'verified_ready_for_shipping',
          'out_of_stock',
          'local_shipping',
        ];
    if (!cancellable.includes(order.internalStatus)) {
      const err = new Error('Order cannot be cancelled at this stage');
      err.statusCode = 400;
      throw err;
    }

    const ledgerEntries = buildPreDeliveryReleaseEntries(order._id, order.items);
    const ledgerDocs = await applyLedgerEntries(ledgerEntries, session);

    order.cancellationReason = reason;
    await order.save({ session });

    await transitionOrder(
      order,
      'cancelled',
      { source, actorUserId, note: cancelNote || reason },
      session
    );

    await recordCustomerCancellation(order.customerId, session);

    newlyCancelled = true;
    return { order: await Order.findById(orderId).session(session), ledgerDocs };
  });

  await afterLedgerApplied(cancelled?.ledgerDocs);

  const cancelledOrder = cancelled?.order || cancelled;

  // Cancel on Shopify after OMS commit (skip when Shopify already cancelled / manual orders).
  if (
    newlyCancelled &&
    source !== 'shopify_webhook' &&
    cancelledOrder?.orderSource === 'shopify' &&
    cancelledOrder?.shopifyOrderId
  ) {
    try {
      const { cancelShopifyOrder } = await import('../integrations/shopify/mutations/orderCancel.js');
      await cancelShopifyOrder({
        shopifyOrderId: cancelledOrder.shopifyOrderId,
        reason,
        staffNote: cancelNote || reason,
        notifyCustomer: false,
        refund: cancelledOrder.paymentMethod === 'online',
      });
    } catch (err) {
      // OMS cancel already succeeded — surface Shopify failure without rolling back.
      const logger = (await import('../utils/logger.js')).default;
      logger.error(
        { err: err?.message || err, orderId: String(cancelledOrder._id), shopifyOrderId: cancelledOrder.shopifyOrderId },
        'Failed to cancel order on Shopify after OMS cancel'
      );
      cancelledOrder.shopifyCancelWarning = err?.message || 'Failed to cancel on Shopify';
    }
  }

  return cancelledOrder;
}

async function executeDelivered(order, { source, actorUserId, note }, session) {
  // Release remaining hold for this order + always decrement warehouse stock.
  const ledgerEntries = await buildDeliveryStockEntries(order._id, order.items, session);
  let ledgerDocs = [];
  try {
    if (ledgerEntries.length) {
      ledgerDocs = await applyLedgerEntries(ledgerEntries, session);
    }
  } catch (err) {
    // Historical imports / courier / Shopify fulfill: still mark delivered; log inventory gap.
    if (source === 'bosta_webhook' || source === 'shopify_import' || source === 'shopify_webhook') {
      logger.warn(
        { err: err.message, orderId: order._id, source },
        'Delivery stock ledger skipped (insufficient stock) — status still applied'
      );
    } else {
      throw err;
    }
  }
  await transitionOrder(order, 'delivered', { source, actorUserId, note }, session);
  await Customer.updateOne({ _id: order.customerId }, { $inc: { lifetimeDelivered: 1 } }, { session });
  const delivered = await Order.findById(order._id).session(session);
  // Best-effort accounting — must not block delivery.
  await recordDeliveryJournal(delivered, actorUserId);
  delivered._ledgerDocs = ledgerDocs;
  return delivered;
}

export async function markDelivered(orderId, source, actorUserId, note, existingSession) {
  const run = async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    return executeDelivered(order, { source, actorUserId, note }, session);
  };

  if (existingSession) return run(existingSession);
  const delivered = await withTransaction(run);
  await afterLedgerApplied(delivered?._ledgerDocs);
  // Delivery decrements warehouse stock — flag anything that dropped low / negative.
  await checkVariantsLowStock((delivered?.items || []).map((i) => i.variantId));
  return delivered;
}

/**
 * Local shipping partial delivery:
 * - deliveredQuantity → finalize stock (release hold + decrement real)
 * - remaining units → release hold only (back to sellable warehouse/Shopify)
 * Order is marked delivered with only the delivered lines/qty kept.
 */
export async function partialLocalDelivery(orderId, actorUserId, { deliveries = [], note } = {}) {
  const delivered = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    if (order.shippingMethod !== 'local_shipping') {
      const err = new Error('Partial delivery is only for local shipping orders');
      err.statusCode = 400;
      throw err;
    }
    if (order.internalStatus !== 'local_shipping') {
      const err = new Error('Order must be in Local shipping to partial-deliver');
      err.statusCode = 400;
      throw err;
    }

    const totalUnits = (order.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    if (totalUnits < 2) {
      const err = new Error('Partial delivery needs more than one piece on the order');
      err.statusCode = 400;
      throw err;
    }

    const byItemId = new Map(
      (Array.isArray(deliveries) ? deliveries : []).map((d) => [
        String(d.itemId || d._id || ''),
        Math.floor(Number(d.deliveredQuantity ?? d.deliveredQty ?? d.quantity)),
      ])
    );

    const deliveredLines = [];
    const undeliveredLines = [];
    const deliveredLabels = [];
    const returnedLabels = [];

    for (const item of order.items || []) {
      const lineQty = Number(item.quantity) || 0;
      if (lineQty < 1 || !item.variantId) continue;

      const key = String(item._id);
      if (!byItemId.has(key)) {
        const err = new Error(`Missing delivery qty for item ${item.sku || key}`);
        err.statusCode = 400;
        throw err;
      }
      const deliveredQty = byItemId.get(key);
      if (!Number.isFinite(deliveredQty) || deliveredQty < 0 || deliveredQty > lineQty) {
        const err = new Error(
          `Delivered qty for ${item.sku || 'item'} must be between 0 and ${lineQty}`
        );
        err.statusCode = 400;
        throw err;
      }
      const returnedQty = lineQty - deliveredQty;

      if (deliveredQty > 0) {
        deliveredLines.push({
          variantId: item.variantId,
          sku: item.sku,
          quantity: deliveredQty,
          unitSellingPrice: item.unitSellingPrice,
          unitCogs: item.unitCogs,
        });
        deliveredLabels.push(`${item.sku}×${deliveredQty}`);
      }
      if (returnedQty > 0) {
        undeliveredLines.push({
          variantId: item.variantId,
          sku: item.sku,
          quantity: returnedQty,
        });
        returnedLabels.push(`${item.sku}×${returnedQty}`);
      }
    }

    const deliveredUnits = deliveredLines.reduce((s, i) => s + i.quantity, 0);
    const returnedUnits = undeliveredLines.reduce((s, i) => s + i.quantity, 0);
    if (deliveredUnits < 1) {
      const err = new Error('Select at least one piece as delivered (or cancel the order)');
      err.statusCode = 400;
      throw err;
    }
    if (returnedUnits < 1) {
      const err = new Error('All pieces marked delivered — use full Delivered instead');
      err.statusCode = 400;
      throw err;
    }

    // Finalize stock for delivered units; release hold only for returned units.
    const deliveryEntries = await buildDeliveryStockEntries(order._id, deliveredLines, session);
    const releaseEntries = buildPreDeliveryReleaseEntries(order._id, undeliveredLines);
    const ledgerEntries = [...deliveryEntries, ...releaseEntries];
    let ledgerDocs = [];
    if (ledgerEntries.length) {
      ledgerDocs = await applyLedgerEntries(ledgerEntries, session);
    }

    const newTotal = deliveredLines.reduce(
      (s, i) => s + (Number(i.unitSellingPrice) || 0) * i.quantity,
      0
    );
    const newCogs = deliveredLines.reduce(
      (s, i) => s + (Number(i.unitCogs) || 0) * i.quantity,
      0
    );

    const staffNote =
      (typeof note === 'string' && note.trim()) ||
      `Partial local delivery · delivered ${deliveredLabels.join(', ')} · returned to stock ${returnedLabels.join(', ')}`;

    order.items = deliveredLines;
    order.totalSellingPrice = Math.round(newTotal * 100) / 100;
    order.totalCogsSnapshot = Math.round(newCogs * 100) / 100;
    order.verificationLog = order.verificationLog || [];
    order.verificationLog.push({
      outcome: 'confirmed',
      note: staffNote,
      actorUserId,
    });
    await order.save({ session });

    await transitionOrder(
      order,
      'delivered',
      { source: 'user_action', actorUserId, note: staffNote },
      session
    );
    await Customer.updateOne({ _id: order.customerId }, { $inc: { lifetimeDelivered: 1 } }, { session });

    const fresh = await Order.findById(order._id).session(session);
    await recordDeliveryJournal(fresh, actorUserId);
    fresh._ledgerDocs = ledgerDocs;
    fresh._partialSummary = {
      deliveredUnits,
      returnedUnits,
      deliveredLabels,
      returnedLabels,
    };
    return fresh;
  });

  await afterLedgerApplied(delivered?._ledgerDocs);
  await checkVariantsLowStock((delivered?.items || []).map((i) => i.variantId));
  return delivered;
}

export async function confirmReturnedToStock(orderId, actorUserId, note) {
  const result = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    const confirmable = ['returned_awaiting_receipt', 'returning_to_origin'];
    if (!confirmable.includes(order.internalStatus)) {
      const err = new Error('Only returning / Back at Bosta orders can be confirmed into warehouse stock');
      err.statusCode = 400;
      throw err;
    }

    /**
     * What physically arrives at the warehouse:
     * - Exchange (sold): COLLECT lines (bostaReturnItems) → +real stock
     * - Exchange (never sold): outbound package came back → release hold only
     * - Refund CRP: pickup lines → +real stock
     * - Post-sale RTO: order.items that were decremented → +real stock
     * - Pre-sale refused: release remaining hold on order.items only
     *
     * Use ledger truth (decrement vs return) — do not trust deliveredAt alone.
     */
    const collectLines =
      Array.isArray(order.bostaReturnItems) && order.bostaReturnItems.length > 0
        ? order.bostaReturnItems
        : order.items;

    const fmtLines = (lines) =>
      (lines || []).map((i) => `${i.sku || '?'}×${i.quantity || 0}`).join(', ') || 'none';

    let ledgerEntries = [];
    let restockVariantIds = [];
    let confirmNote;

    if (order.isExchangeOrder) {
      const collectRestock = await buildOutstandingReturnRestockEntries(
        order._id,
        collectLines,
        session
      );
      const outboundRestock = await buildOutstandingReturnRestockEntries(
        order._id,
        order.items,
        session
      );
      const outboundHold = await buildOutstandingHoldReleaseEntries(order._id, order.items, session);

      // Sold exchange: restock what the courier collected (preferred) and/or sold outbound.
      if (collectRestock.length || (order.deliveredAt && collectLines?.length)) {
        ledgerEntries = collectRestock.length
          ? collectRestock
          : await buildOutstandingReturnRestockEntries(order._id, collectLines, session);
        // If collect lines never decremented (customer return of different SKUs), still +real
        // for the collect quantities when this is an explicit exchange collect.
        if (!ledgerEntries.length && collectLines?.length) {
          ledgerEntries = buildPostDeliveryReturnEntries(order._id, collectLines);
        }
        restockVariantIds = (collectLines || []).map((i) => i.variantId).filter(Boolean);
        confirmNote =
          note || `Exchange collect received — restocked ${fmtLines(collectLines)}`;
      } else if (outboundRestock.length) {
        ledgerEntries = outboundRestock;
        restockVariantIds = (order.items || []).map((i) => i.variantId).filter(Boolean);
        confirmNote =
          note || `Exchange package returned after sale — restocked ${fmtLines(order.items)}`;
      } else {
        ledgerEntries = outboundHold;
        confirmNote =
          note ||
          `Exchange not delivered — released hold on ${fmtLines(order.items)}`;
      }
    } else if (order.isReturnOrder) {
      ledgerEntries = await buildOutstandingReturnRestockEntries(order._id, collectLines, session);
      if (!ledgerEntries.length && collectLines?.length) {
        // Refund pickup: goods were never decremented against this CRP order — always +real.
        ledgerEntries = buildPostDeliveryReturnEntries(order._id, collectLines);
      }
      restockVariantIds = (collectLines || []).map((i) => i.variantId).filter(Boolean);
      confirmNote =
        note || `Refund pickup received — restocked ${fmtLines(collectLines)}`;
    } else {
      const restock = await buildOutstandingReturnRestockEntries(order._id, order.items, session);
      if (restock.length) {
        ledgerEntries = restock;
        restockVariantIds = (order.items || []).map((i) => i.variantId).filter(Boolean);
        confirmNote =
          note || `Physical receipt confirmed — returned to warehouse stock (${fmtLines(order.items)})`;
      } else {
        ledgerEntries = await buildOutstandingHoldReleaseEntries(order._id, order.items, session);
        confirmNote =
          note ||
          (ledgerEntries.length
            ? `Physical receipt confirmed — hold released, never sold (${fmtLines(order.items)})`
            : `Physical receipt confirmed — stock already aligned (${fmtLines(order.items)})`);
      }
    }

    const ledgerDocs = ledgerEntries.length
      ? await applyLedgerEntries(ledgerEntries, session)
      : [];

    await transitionOrder(
      order,
      'returned_to_stock',
      {
        source: 'user_action',
        actorUserId,
        note: confirmNote,
      },
      session
    );

    await Customer.updateOne(
      { _id: order.customerId },
      { $inc: { lifetimeRejectedOrReturned: 1 } },
      { session }
    );

    return {
      order: await Order.findById(orderId).session(session),
      ledgerDocs,
      restockVariantIds,
      syncVariantIds: [
        ...new Set(
          [
            ...(order.items || []).map((i) => i.variantId),
            ...(order.bostaReturnItems || []).map((i) => i.variantId),
            ...restockVariantIds,
          ]
            .map((id) => (id != null ? String(id) : null))
            .filter(Boolean)
        ),
      ],
    };
  });

  // Always force Shopify for every SKU on the return — even if ledger was hold-only
  // or a prior push failed. Retries + Agenda backup live inside enqueueShopifySync.
  await afterLedgerApplied(result.ledgerDocs, {
    forcePolicyFull: true,
    variantIds: result.syncVariantIds,
  });

  // Restock (exchange collect / refund / post-delivery return) may unblock Out of stock orders.
  if (result.restockVariantIds?.length) {
    await releaseOutOfStockOrdersIfRestocked(result.restockVariantIds, {
      actorUserId,
      note: 'Auto: return/exchange restocked SKUs — back to Ready to ship',
    });
  }
  return result.order;
}

/**
 * After warehouse stock increases, move Out of stock orders back to Ready to ship
 * when every line can be covered by free warehouse stock + that order's existing hold.
 */
export async function releaseOutOfStockOrdersIfRestocked(
  variantIds,
  { actorUserId = null, note } = {}
) {
  const ids = [
    ...new Set(
      (variantIds || [])
        .map((id) => String(id || '').trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  if (!ids.length) return { released: [], checked: 0 };

  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const candidates = await Order.find({
    internalStatus: 'out_of_stock',
    'items.variantId': { $in: objectIds },
  })
    .sort({ verifiedAt: 1, placedAt: 1 })
    .select('_id items sku shopifyOrderName');

  if (!candidates.length) return { released: [], checked: 0 };

  const neededVariantIds = [
    ...new Set(
      candidates.flatMap((o) => (o.items || []).map((i) => String(i.variantId))).filter(Boolean)
    ),
  ];
  const variants = await Variant.find({ _id: { $in: neededVariantIds } }).select(
    'realStock onHoldStock sku'
  );
  const stockById = new Map(
    variants.map((v) => [
      String(v._id),
      { real: v.realStock ?? 0, hold: Math.max(0, v.onHoldStock ?? 0) },
    ])
  );

  const released = [];
  const releaseNote = note || 'Auto: stock restocked — back to Ready to ship';

  for (const order of candidates) {
    const lines = order.items || [];
    if (!lines.length) continue;

    let fullyStocked = true;
    for (const item of lines) {
      const need = Number(item.quantity) || 0;
      const stock = stockById.get(String(item.variantId));
      if (!stock || need < 1) {
        fullyStocked = false;
        break;
      }
      const orderHold = Math.max(
        0,
        await netOrderLedgerQty(order._id, item.variantId, [
          'on_hold_reserve',
          'on_hold_release',
        ])
      );
      // Free sellable + units already reserved for this OOS order.
      const availableForOrder = stock.real - stock.hold + orderHold;
      if (availableForOrder < need) {
        fullyStocked = false;
        break;
      }
    }
    if (!fullyStocked) continue;

    try {
      let ledgerDocs = [];
      const didRelease = await withTransaction(async (session) => {
        const fresh = await Order.findById(order._id).session(session);
        if (!fresh || fresh.internalStatus !== 'out_of_stock') return false;
        ledgerDocs = await ensureOrderStockHeld(fresh._id, fresh.items, session);
        await transitionOrder(
          fresh,
          'verified_ready_for_shipping',
          {
            source: 'system',
            actorUserId,
            note: releaseNote,
          },
          session
        );
        return true;
      });
      if (didRelease) {
        await afterLedgerApplied(ledgerDocs);
        released.push(String(order._id));
        // Refresh in-memory stock map so the next OOS order sees updated holds.
        for (const item of lines) {
          const key = String(item.variantId);
          const stock = stockById.get(key);
          if (!stock) continue;
          const v = await Variant.findById(item.variantId).select('realStock onHoldStock');
          if (v) {
            stockById.set(key, {
              real: v.realStock ?? 0,
              hold: Math.max(0, v.onHoldStock ?? 0),
            });
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err: err?.message || err, orderId: String(order._id) },
        'Failed to auto-release out_of_stock order after restock'
      );
    }
  }

  if (released.length) {
    logger.info(
      { released: released.length, variantIds: ids },
      'Auto-released out_of_stock orders after restock'
    );
  }

  return { released, checked: candidates.length };
}

export async function transitionOrderStatus(orderId, toStatus, meta) {
  const updated = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    if (toStatus === 'delivered') {
      return executeDelivered(order, meta, session);
    }

    let ledgerDocs = [];
    if (toStatus === 'verified_ready_for_shipping') {
      ledgerDocs = await ensureOrderStockHeld(order._id, order.items, session);
    }

    await transitionOrder(order, toStatus, meta, session);
    const fresh = await Order.findById(orderId).session(session);
    fresh._ledgerDocs = ledgerDocs;
    return fresh;
  });

  if (toStatus === 'delivered' || toStatus === 'verified_ready_for_shipping') {
    await afterLedgerApplied(updated?._ledgerDocs, {
      variantIds: collectVariantIds(updated?._ledgerDocs, updated?.items),
    });
  } else if (toStatus === 'out_of_stock') {
    // Hold unchanged — re-push sellable (real − hold) in case create-time sync failed.
    await afterLedgerApplied([], {
      forcePolicyFull: true,
      variantIds: collectVariantIds([], updated?.items),
    });
  }
  if (toStatus === 'verified_ready_for_shipping') await notifyOrderVerified(updated);
  else if (toStatus === 'failed_delivery') await notifyFailedDelivery(updated);
  else if (toStatus === 'returned_awaiting_receipt' || toStatus === 'returning_to_origin') {
    await notifyReturnToOrigin(updated);
  } else if (toStatus === 'delivered') {
    await checkVariantsLowStock((updated?.items || []).map((i) => i.variantId));
  }

  return updated;
}

export async function reserveStockForOrder(orderId, items, session) {
  const entries = buildHoldReserveEntries(orderId, items);
  return applyLedgerEntries(entries, session);
}

/** Top up on_hold for any units not already reserved against this order. */
export async function ensureOrderStockHeld(orderId, items, session) {
  const entries = await buildMissingHoldEntries(orderId, items, session);
  if (!entries.length) return [];
  return applyLedgerEntries(entries, session);
}

export async function manualStockAdjustment({
  variantId,
  quantityDelta,
  reasonCode,
  actorUserId,
  skipOosAutoRelease = false,
}) {
  const result = await withTransaction(async (session) => {
    const entries = buildStockIntakeEntries({
      variantId,
      quantityDelta,
      reasonCode,
      actorUserId,
    });
    const ledgerDocs = await applyLedgerEntries(entries, session);
    const variant = await Variant.findById(variantId).session(session);
    return { variant, ledger: ledgerDocs[0], ledgerDocs, shopifySyncQueued: false };
  });
  // Stock intake / adjustments always write sellable qty to Shopify.
  await afterLedgerApplied(result.ledgerDocs, { forcePolicyFull: true });
  await checkVariantsLowStock([variantId]);
  if (!skipOosAutoRelease && quantityDelta > 0) {
    result.oosReleased = await releaseOutOfStockOrdersIfRestocked([variantId], {
      actorUserId,
      note: 'Auto: stock intake restocked SKUs — back to Ready to ship',
    });
  }
  return result;
}

export async function stockIntake({
  variantId,
  quantity,
  reasonCode,
  note,
  actorUserId,
  skipOosAutoRelease = false,
}) {
  if (quantity <= 0) {
    const err = new Error('Stock intake quantity must be positive');
    err.statusCode = 400;
    throw err;
  }
  return manualStockAdjustment({
    variantId,
    quantityDelta: quantity,
    reasonCode: reasonCode || 'restock',
    actorUserId,
    skipOosAutoRelease,
  });
}

/**
 * Set absolute warehouse realStock for many variants (open-stock count / Excel import).
 * Always pushes sellable qty (realStock − onHoldStock) to Shopify — all order holds count.
 */
export async function setRealStockBatch({ items, reasonCode = 'stock_count', actorUserId }) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('items array is required');
    err.statusCode = 400;
    throw err;
  }

  const results = [];
  const allCrossings = [];
  const ledgerForShopify = [];

  for (const item of items) {
    const variantId = item.variantId;
    const target = Number(item.realStock ?? item.target ?? item.quantity);
    if (!variantId || !Number.isFinite(target)) continue;

    const outcome = await withTransaction(async (session) => {
      const variant = await Variant.findById(variantId).session(session);
      if (!variant) {
        const err = new Error(`Variant not found: ${variantId}`);
        err.statusCode = 404;
        throw err;
      }
      const current = variant.realStock ?? 0;
      const delta = target - current;
      if (delta === 0) {
        return { variantId, sku: variant.sku, previous: current, realStock: current, changed: false };
      }
      const ledgerDocs = await applyLedgerEntries(
        [
          buildManualAdjustmentEntry({
            variantId,
            quantityDelta: delta,
            reasonCode,
            actorUserId,
          }),
        ],
        session
      );
      const updated = await Variant.findById(variantId).session(session);
      return {
        variantId,
        sku: updated.sku,
        previous: current,
        realStock: updated.realStock,
        changed: true,
        ledgerDocs,
      };
    });

    if (outcome.ledgerDocs?._negativeCrossings?.length) {
      allCrossings.push(...outcome.ledgerDocs._negativeCrossings);
    }
    if (outcome.changed && Array.isArray(outcome.ledgerDocs)) {
      ledgerForShopify.push(...outcome.ledgerDocs);
    }
    results.push({
      variantId: outcome.variantId,
      sku: outcome.sku,
      previous: outcome.previous,
      realStock: outcome.realStock,
      changed: outcome.changed,
    });
  }

  await notifyNegativeStockCrossings(allCrossings);
  // Push sellable (real − hold) for every row in the upload — including unchanged
  // realStock where holds moved since the last Shopify write.
  await enqueueShopifySync(ledgerForShopify, {
    forcePolicyFull: true,
    variantIds: items.map((i) => i.variantId).filter(Boolean),
  });
  await checkVariantsLowStock(results.map((r) => r.variantId));

  const increasedIds = results
    .filter((r) => r.changed && r.realStock > r.previous)
    .map((r) => r.variantId);
  let oosReleased = { released: [], checked: 0 };
  if (increasedIds.length) {
    oosReleased = await releaseOutOfStockOrdersIfRestocked(increasedIds, {
      actorUserId,
      note: 'Auto: stock count restocked SKUs — back to Ready to ship',
    });
  }

  if (!results.length) {
    const err = new Error('No valid stock set rows');
    err.statusCode = 400;
    throw err;
  }

  return { results, count: results.length, oosReleased };
}

/** Sequential manual codes: M-1000, M-1001, … (atomic via Settings). */
async function allocateManualOrderRef(session) {
  const START = 1000;
  const doc = await Settings.findOneAndUpdate(
    { key: 'global' },
    [
      {
        $set: {
          key: { $ifNull: ['$key', 'global'] },
          manualOrderNextSeq: {
            $add: [{ $ifNull: ['$manualOrderNextSeq', START - 1] }, 1],
          },
        },
      },
    ],
    { new: true, upsert: true, session }
  );
  const n = doc?.manualOrderNextSeq;
  if (!n || !Number.isFinite(n)) {
    const err = new Error('Failed to allocate manual order number');
    err.statusCode = 500;
    throw err;
  }
  return `M-${n}`;
}

/** Parse YYYY-MM-DD as Cairo noon; reject past dates. */
function parseCairoDelayDate(delayedUntil) {
  const ymd = String(delayedUntil || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const err = new Error('delayedUntil must be YYYY-MM-DD');
    err.statusCode = 400;
    throw err;
  }
  const until = new Date(`${ymd}T12:00:00+03:00`);
  if (Number.isNaN(until.getTime())) {
    const err = new Error('Invalid delay date');
    err.statusCode = 400;
    throw err;
  }
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  if (ymd < todayYmd) {
    const err = new Error('Delay date must be today or later');
    err.statusCode = 400;
    throw err;
  }
  return { ymd, until };
}

/** Ready-to-ship orders with a future ship-after date stay out of pick/fulfillment. */
function cairoTodayEnd() {
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${todayYmd}T23:59:59.999+03:00`);
}

function shipAfterNotDueFilter() {
  const todayEnd = cairoTodayEnd();
  return {
    $or: [
      { delayedUntil: null },
      { delayedUntil: { $exists: false } },
      { delayedUntil: { $lte: todayEnd } },
    ],
  };
}

export async function createManualOrder({
  manualSource,
  shippingMethod,
  paymentMethod,
  shippingFee,
  customer,
  shippingAddress,
  items,
  totalSellingPrice,
  note,
  actorUserId,
  isCreatorOrder = false,
  isExchangeOrder = false,
  exchangeFromOrderId = null,
  isReturnOrder = false,
  returnFromOrderId = null,
  bostaReturnItems = null,
  delayedUntil: delayedUntilInput = null,
  delayNote: delayNoteInput = null,
}) {
  const exchange = Boolean(isExchangeOrder);
  const customerReturn = Boolean(isReturnOrder);

  if (exchange && customerReturn) {
    const err = new Error('Choose either Exchange or Return — not both');
    err.statusCode = 400;
    throw err;
  }

  if (exchange && !exchangeFromOrderId) {
    const err = new Error('Select the previous order this exchange replaces');
    err.statusCode = 400;
    throw err;
  }

  if (customerReturn && !returnFromOrderId) {
    const err = new Error('Select the previous order this return is for');
    err.statusCode = 400;
    throw err;
  }

  if (exchange && (!Array.isArray(bostaReturnItems) || bostaReturnItems.length < 1)) {
    const err = new Error('Select the items to collect from the customer for this exchange');
    err.statusCode = 400;
    throw err;
  }

  if (
    customerReturn &&
    (!Array.isArray(bostaReturnItems) || bostaReturnItems.length < 1) &&
    (!Array.isArray(items) || items.length < 1)
  ) {
    const err = new Error('Select the items to pick up for this return');
    err.statusCode = 400;
    throw err;
  }

  // Refund: if only collect lines were sent, mirror them into `items` (order schema requires items).
  const outboundItemsInput =
    customerReturn && (!Array.isArray(items) || items.length < 1) && Array.isArray(bostaReturnItems)
      ? bostaReturnItems.map((r) => ({
          variantId: r.variantId,
          quantity: r.quantity || 1,
          unitSellingPrice: 0,
        }))
      : items;

  const manualOrder = await withTransaction(async (session) => {
    const ref = await allocateManualOrderRef(session);
    let populatedLedger = [];
    let priorOrder = null;
    const priorId = exchange ? exchangeFromOrderId : customerReturn ? returnFromOrderId : null;
    if (priorId) {
      priorOrder = await Order.findById(priorId).session(session);
      if (!priorOrder) {
        const err = new Error('Previous order not found');
        err.statusCode = 404;
        throw err;
      }
    }

    let customerDoc = await Customer.findOne({ phone: customer.phone }).session(session);
    if (!customerDoc) {
      const core = normalizeEgPhoneDigits(customer.phone);
      if (core.length >= 7) {
        customerDoc = await Customer.findOne({
          $or: phoneMatchRegexes(customer.phone).map((re) => ({ phone: { $regex: re } })),
        }).session(session);
      }
    }
    if (!customerDoc) {
      [customerDoc] = await Customer.create(
        [{
          fullName: customer.fullName,
          phone: customer.phone,
          email: customer.email,
          riskFlag: customer.riskFlag || 'none',
        }],
        { session }
      );
    } else {
      // Keep customer profile current so name/phone search stays accurate.
      const patch = {};
      if (customer.fullName && customer.fullName !== customerDoc.fullName) patch.fullName = customer.fullName;
      if (customer.email && customer.email !== customerDoc.email) patch.email = customer.email;
      if (Object.keys(patch).length) {
        Object.assign(customerDoc, patch);
        await customerDoc.save({ session });
      }
    }

    const orderItems = [];
    let outboundGoodsValue = 0;
    for (const item of outboundItemsInput || []) {
      const variant = await Variant.findById(item.variantId).session(session);
      if (!variant) {
        const err = new Error(`Variant not found: ${item.variantId}`);
        err.statusCode = 404;
        throw err;
      }
      const catalogUnit = Number(variant.sellingPrice) || 0;
      const inputUnit = Number(item.unitSellingPrice);
      const unitForDiff =
        Number.isFinite(inputUnit) && inputUnit > 0 ? inputUnit : catalogUnit;
      outboundGoodsValue += unitForDiff * (Number(item.quantity) || 0);
      orderItems.push({
        variantId: variant._id,
        sku: variant.sku,
        quantity: item.quantity,
        // Exchange line prices stay 0 on the order; upgrade amount lives in totalSellingPrice.
        unitSellingPrice: exchange || customerReturn ? 0 : (item.unitSellingPrice ?? variant.sellingPrice),
        unitCogs: variant.cogs,
      });
    }

    if (!orderItems.length) {
      const err = new Error(customerReturn ? 'Select the items to pick up for this return' : 'Add at least one item');
      err.statusCode = 400;
      throw err;
    }

    // Exchange: signed (new − old). Upgrade → totalSellingPrice; downgrade → exchangeCreditAmount.
    // COD = upgrade + shipping − credit (customer still pays shipping when old is more expensive).
    let returnGoodsValue = 0;
    if (exchange && Array.isArray(bostaReturnItems)) {
      const priorUnitByVariant = new Map();
      for (const pi of priorOrder?.items || []) {
        const vid = String(pi.variantId?._id || pi.variantId || '');
        if (!vid) continue;
        priorUnitByVariant.set(vid, Number(pi.unitSellingPrice) || 0);
      }
      for (const r of bostaReturnItems) {
        const vid = String(r.variantId || '');
        const qty = Number(r.quantity) || 0;
        if (!vid || qty < 1) continue;
        let unit = priorUnitByVariant.has(vid) ? priorUnitByVariant.get(vid) : null;
        if (unit == null) {
          const variant = await Variant.findById(vid).session(session);
          unit = Number(variant?.sellingPrice) || 0;
        }
        returnGoodsValue += unit * qty;
      }
    }

    const signedDiff = exchange
      ? Math.round((outboundGoodsValue - returnGoodsValue) * 100) / 100
      : 0;
    const exchangePriceDiff = exchange ? Math.max(0, signedDiff) : 0;
    const exchangeCreditAmount = exchange ? Math.max(0, -signedDiff) : 0;

    const total = customerReturn
      ? 0
      : exchange
        ? exchangePriceDiff
        : totalSellingPrice ?? orderItems.reduce(
            (sum, i) => sum + i.unitSellingPrice * i.quantity,
            0
          );

    // Exchange: COD = (new−old) + shipping; if old > new, credit reduces COD but shipping still applies.
    // Bosta shipping = Shopify zone rates (free ≥ 2999 on zones 1–4). Local = fixed LOCAL_SHIPPING_FEE.
    // Return pickup: no COD / no shipping collect — courier must not give cash to customer.
    const feeRaw = shippingFee != null ? Number(shippingFee) : null;
    const method = shippingMethod || 'bosta';
    const destCity = shippingAddress?.city || priorOrder?.shippingAddress?.city;
    const zoneResolved = resolveShopifyZoneShippingFee(destCity, total);
    const finalShippingFee = customerReturn
      ? 0
      : method === 'local_shipping'
        ? LOCAL_SHIPPING_FEE
        : method === 'pickup'
          ? 0
          : exchange
            ? await resolveExchangeShippingFee({
                shippingFee: Number.isFinite(feeRaw) && feeRaw > 0 ? feeRaw : null,
                priorOrder,
                city: destCity,
                goodsTotal: total,
              })
            : (() => {
                // Always use Shopify zone from destination city (ignore stale client defaults like 90).
                if (destCity) return zoneResolved.fee;
                if (Number.isFinite(feeRaw) && feeRaw > 0) return feeRaw;
                return DEFAULT_BOSTA_SHIPPING_FEE;
              })();

    const finalShippingAddress =
      method === 'pickup'
        ? undefined
        : {
            ...(shippingAddress || {}),
            phone: shippingAddress?.phone || customer.phone,
            fullName: shippingAddress?.fullName || customer.fullName,
          };

    const priorLabel = priorOrder
      ? priorOrder.shopifyOrderName || priorOrder.shopifyOrderId || priorOrder._id
      : null;
    const linkNote = exchange
      ? `Exchange for ${priorLabel}`
      : customerReturn
        ? `Return pickup for ${priorLabel}`
        : null;

    if (exchange && method === 'pickup') {
      const err = new Error('Exchange cannot use customer pickup — choose Bosta or Local shipping');
      err.statusCode = 400;
      throw err;
    }

    let shipDelay = null;
    if (delayedUntilInput && !customerReturn) {
      shipDelay = parseCairoDelayDate(delayedUntilInput);
    }
    const delayNoteText =
      typeof delayNoteInput === 'string' ? delayNoteInput.trim().slice(0, 500) : '';

    const isPickup = method === 'pickup' && !exchange && !customerReturn;
    const now = new Date();

    // Manual orders skip call-center verify:
    // - normal / exchange / local / bosta / customer pickup → Ready to ship
    // - refund / return → Returning to Warehouse (track inbound)
    // - optional ship-after date → still Ready (stock held) but hidden from pick until that day
    let initialStatus = 'verified_ready_for_shipping';
    if (customerReturn) initialStatus = 'returning_to_origin';

    // Enrich collect lines with SKU/title from variants so Bosta policy + warehouse confirm are accurate.
    let normalizedReturnItems = [];
    if (Array.isArray(bostaReturnItems) && bostaReturnItems.length) {
      for (const r of bostaReturnItems) {
        const variant = await Variant.findById(r.variantId).session(session);
        if (!variant) {
          const err = new Error(`Return variant not found: ${r.variantId}`);
          err.statusCode = 404;
          throw err;
        }
        normalizedReturnItems.push({
          variantId: variant._id,
          sku: r.sku || variant.sku,
          quantity: r.quantity || 1,
          title: r.title || variant.title,
          color: r.color || variant.color,
          size: r.size || variant.size,
        });
      }
    } else if (customerReturn) {
      normalizedReturnItems = orderItems.map((i) => ({
        variantId: i.variantId,
        sku: i.sku,
        quantity: i.quantity,
      }));
    }

    const [order] = await Order.create(
      [{
        shopifyOrderId: ref,
        shopifyOrderName: ref,
        orderSource: 'manual',
        manualSource,
        shippingMethod: method,
        paymentMethod: customerReturn ? 'cod' : (paymentMethod || 'cod'),
        shippingFee: finalShippingFee,
        onlinePaymentReference: paymentMethod === 'online' && !customerReturn ? ref : undefined,
        customerId: customerDoc._id,
        shippingAddress: finalShippingAddress,
        internalStatus: initialStatus,
        verifiedAt: now,
        deliveredAt: undefined,
        closedAt: undefined,
        isCreatorOrder: exchange || customerReturn ? false : Boolean(isCreatorOrder),
        isExchangeOrder: exchange,
        exchangeFromOrderId: exchange ? priorOrder._id : undefined,
        exchangeCreditAmount: exchange ? exchangeCreditAmount : 0,
        isReturnOrder: customerReturn,
        returnFromOrderId: customerReturn ? priorOrder._id : undefined,
        bostaReturnItems: normalizedReturnItems,
        totalSellingPrice: total,
        totalCogsSnapshot: orderItems.reduce((s, i) => s + (i.unitCogs || 0) * i.quantity, 0),
        items: orderItems,
        placedAt: now,
        assignedOrdersManagerId: actorUserId,
        ...(shipDelay
          ? {
              delayedUntil: shipDelay.until,
              delayNote: delayNoteText || `Ship after ${shipDelay.ymd}`,
            }
          : {}),
        verificationLog: [
          ...(note ? [{ outcome: 'confirmed', note, actorUserId }] : []),
          ...(linkNote
            ? [{ outcome: 'confirmed', note: linkNote, actorUserId }]
            : []),
          {
            outcome: 'confirmed',
            note: customerReturn
              ? 'Return / refund auto-verified · Returning to Warehouse · Bosta CRP · COD 0'
              : isPickup
                ? 'Pickup auto-verified · Ready to ship · print Gazelle policy on Fulfillment'
                : exchange
                  ? exchangeCreditAmount > 0
                    ? `Exchange auto-verified · Ready to ship · customer credit EGP ${exchangeCreditAmount} · shipping EGP ${finalShippingFee} · net COD EGP ${Math.max(0, total + finalShippingFee - exchangeCreditAmount)} · ${method === 'local_shipping' ? 'Local courier' : 'Bosta EXCHANGE'}`
                    : `Exchange auto-verified · Ready to ship · upgrade EGP ${total} + shipping EGP ${finalShippingFee} · ${method === 'local_shipping' ? 'Local courier' : 'Bosta EXCHANGE'}`
                  : shipDelay
                    ? `Manual order auto-verified · Ready to ship after ${shipDelay.ymd}${delayNoteText ? ` — ${delayNoteText}` : ''}`
                    : 'Manual order auto-verified · Ready to ship',
            actorUserId,
          },
        ],
      }],
      { session }
    );

    if (customerReturn) {
      // Inbound only — no warehouse hold. Stock increments when confirmed in warehouse.
    } else {
      // Ready to ship (normal, creator, exchange, local, pickup, Bosta).
      const ledgerDocs = await reserveStockForOrder(order._id, orderItems, session);
      populatedLedger = ledgerDocs;
    }

    await recordStatusChange(
      {
        orderId: order._id,
        fromStatus: null,
        toStatus: initialStatus,
        source: 'user_action',
        actorUserId,
        note: customerReturn
          ? `Return pickup from ${manualSource} (for ${priorLabel}) · Returning to Warehouse · COD 0`
          : isPickup
            ? `Pickup from ${manualSource} · Ready to ship`
            : exchange
              ? exchangeCreditAmount > 0
                ? `Exchange from ${manualSource} (for ${priorLabel}) · Ready to ship · credit EGP ${exchangeCreditAmount} · shipping EGP ${finalShippingFee}`
                : `Exchange from ${manualSource} (for ${priorLabel}) · Ready to ship · upgrade EGP ${total} + shipping EGP ${finalShippingFee}`
              : `Manual order from ${manualSource} · Ready to ship`,
      },
      session
    );

    await Customer.updateOne({ _id: customerDoc._id }, { $inc: { lifetimeOrders: 1 } }, { session });

    const populated = await Order.findById(order._id)
      .session(session)
      .populate('customerId')
      .populate('exchangeFromOrderId', 'shopifyOrderId shopifyOrderName internalStatus shippingFee')
      .populate('returnFromOrderId', 'shopifyOrderId shopifyOrderName internalStatus shippingFee')
      .populate('items.variantId', 'title color size imageUrl sku realStock onHoldStock');

    populated._ledgerDocs = populatedLedger;
    return populated;
  });

  // Always pass line variant ids — _ledgerDocs alone can be empty/missing variantId after populate.
  await afterLedgerApplied(manualOrder?._ledgerDocs, {
    variantIds: collectVariantIds(manualOrder?._ledgerDocs, manualOrder?.items),
  });
  await notifyNewOrder(manualOrder, { source: 'manual' });
  if (!manualOrder.isReturnOrder && manualOrder.internalStatus === 'verified_ready_for_shipping') {
    try {
      await notifyOrderVerified(manualOrder);
    } catch {
      /* non-blocking */
    }
  }

  // Refund / return pickups: create Bosta CRP (type 25, COD 0) immediately.
  // Status stays Returning to Warehouse — do not move to awaiting_bosta_pickup.
  if (manualOrder.isReturnOrder) {
    try {
      const { ensureBostaDeliveryForOrder } = await import('./fulfillment.service.js');
      await ensureBostaDeliveryForOrder(manualOrder._id, actorUserId);
    } catch (err) {
      logger.error(
        { err: err?.message || err, orderId: String(manualOrder._id) },
        'Return order created but Bosta CRP failed — print CRP from Returns to retry'
      );
    }
    const refreshed = await Order.findById(manualOrder._id)
      .populate('customerId')
      .populate('returnFromOrderId', 'shopifyOrderId shopifyOrderName internalStatus shippingFee')
      .populate('items.variantId', 'title color size imageUrl sku realStock onHoldStock');
    if (refreshed) return refreshed;
  }

  return manualOrder;
}

/**
 * Resolve a prior order for exchange / return by Shopify order number.
 * Always searches Shopify for the entered id (any age), then upserts into OMS.
 * Local-only fallback for manual orders (M-1000 / legacy MAN-…) or Mongo ids.
 */
export async function findOrderForExchange(query) {
  const raw = String(query || '').trim();
  if (!raw) {
    const err = new Error('Enter a Shopify order number');
    err.statusCode = 400;
    throw err;
  }

  const withHash = raw.startsWith('#') ? raw : `#${raw.replace(/^#/, '')}`;
  const digits = raw.replace(/\D/g, '');
  const isManualOrMongo = isManualOrderRef(raw) || /^[a-f\d]{24}$/i.test(raw);

  async function populateOrder(docOrId) {
    const id = docOrId?._id || docOrId;
    if (!id) return null;
    return Order.findById(id)
      .populate('customerId', 'fullName phone email')
      .populate('items.variantId', 'title color size imageUrl sku sellingPrice productId')
      .lean();
  }

  // Shopify path: any numeric / #order entered → search Shopify live.
  if (!isManualOrMongo && digits) {
    try {
      const { importShopifyOrderByName } = await import('../integrations/shopify/setup.service.js');
      const imported = await importShopifyOrderByName(raw);
      const order = await populateOrder(imported);
      if (order) return order;
    } catch (err) {
      if (err.statusCode && err.statusCode !== 404 && err.statusCode !== 400) throw err;
      // Continue to local fallback below.
    }
  }

  // Local fallback (manual orders, Mongo id, or Shopify already in OMS if API failed).
  const or = [
    { shopifyOrderName: withHash },
    { shopifyOrderName: raw },
    { shopifyOrderId: raw },
  ];
  if (digits) {
    or.push({ shopifyOrderId: digits });
    or.push({ shopifyOrderName: `#${digits}` });
  }
  if (/^[a-f\d]{24}$/i.test(raw)) or.push({ _id: raw });

  const local = await Order.findOne({ $or: or })
    .sort({ placedAt: -1 })
    .populate('customerId', 'fullName phone email')
    .populate('items.variantId', 'title color size imageUrl sku sellingPrice productId')
    .lean();

  if (!local) {
    const err = new Error(
      `Order ${withHash} not found on Shopify. Check the order number and try again.`
    );
    err.statusCode = 404;
    throw err;
  }

  return local;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shopify zone shipping for a destination city (Bosta / online).
 * Local courier stays LOCAL_SHIPPING_FEE and is handled by callers.
 */
export async function suggestShippingFeeByCity(city, goodsTotal = 0) {
  const { fee } = resolveShopifyZoneShippingFee(city, goodsTotal);
  return fee;
}

/**
 * Resolve exchange / Bosta shipping: explicit fee → Shopify zone by city → prior → default.
 */
export async function resolveExchangeShippingFee({
  shippingFee,
  priorOrder,
  city,
  goodsTotal = 0,
} = {}) {
  const feeRaw = shippingFee != null ? Number(shippingFee) : null;
  if (Number.isFinite(feeRaw) && feeRaw > 0) {
    return Math.round(feeRaw * 100) / 100;
  }
  const destCity = city || priorOrder?.shippingAddress?.city;
  const zone = resolveShopifyZoneShippingFee(destCity, goodsTotal);
  if (destCity && (zone.fee === 0 || zone.fee > 0)) {
    return zone.fee;
  }
  const prior = Number(priorOrder?.shippingFee);
  if (Number.isFinite(prior) && prior > 0) {
    return Math.round(prior * 100) / 100;
  }
  return DEFAULT_BOSTA_SHIPPING_FEE;
}

function ordersPlacedFromCutoff() {
  // Cairo midnight for ORDERS_PLACED_FROM_YMD (Egypt is UTC+2 / +3 — use +03:00 bound).
  const ymd = ORDERS_PLACED_FROM_YMD;
  return new Date(`${ymd}T00:00:00+03:00`);
}

export async function getOrderStateCounts() {
  const cutoff = ordersPlacedFromCutoff();
  const pipeline = [
    { $match: { placedAt: { $gte: cutoff } } },
    { $group: { _id: '$internalStatus', count: { $sum: 1 } } },
  ];
  const rows = await Order.aggregate(pipeline);
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const row of rows) {
    counts[row._id] = row.count;
  }
  counts.total = rows.reduce((sum, r) => sum + r.count, 0);

  // Refund pickups have their own tab — keep classic return lanes free of isReturnOrder.
  const [returningExRefund, awaitingExRefund, stockedExRefund, refundOrders] = await Promise.all([
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      internalStatus: 'returning_to_origin',
      isReturnOrder: { $ne: true },
    }),
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      internalStatus: 'returned_awaiting_receipt',
      isReturnOrder: { $ne: true },
    }),
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      internalStatus: 'returned_to_stock',
      isReturnOrder: { $ne: true },
    }),
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      isReturnOrder: true,
    }),
  ]);
  counts.returning_to_origin = returningExRefund;
  counts.returned_awaiting_receipt = awaitingExRefund;
  counts.returned_to_stock = stockedExRefund;
  counts.refund_orders = refundOrders;

  // Fulfillment queue excludes customer pickup (handled on the order page)
  // and orders with a future ship-after date.
  const shipReady = shipAfterNotDueFilter();
  const [fulfillmentReady, pickupReady] = await Promise.all([
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      internalStatus: 'verified_ready_for_shipping',
      shippingMethod: { $ne: 'pickup' },
      ...shipReady,
    }),
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      internalStatus: 'verified_ready_for_shipping',
      shippingMethod: 'pickup',
      ...shipReady,
    }),
  ]);
  counts.fulfillment_ready = fulfillmentReady;
  counts.pickup_ready = pickupReady;

  // Delayed: verify callbacks + ready-to-ship orders waiting for ship-after date.
  const todayEnd = cairoTodayEnd();
  counts.delayed = await Order.countDocuments({
    placedAt: { $gte: cutoff },
    delayedUntil: { $exists: true, $ne: null },
    $or: [
      { internalStatus: { $in: ['pending_verification', 'no_response'] } },
      {
        internalStatus: 'verified_ready_for_shipping',
        delayedUntil: { $gt: todayEnd },
      },
    ],
  });

  return counts;
}

export async function listOrders({
  status,
  search,
  orderSource,
  shippingMethod,
  isExchangeOrder,
  isReturnOrder,
  delayed,
  limit = 50,
  skip = 0,
  sort = { placedAt: -1 },
}) {
  const filter = {
    // Hide pre-cutover orders from queues / lists; money KPIs still use full ranges.
    placedAt: { $gte: ordersPlacedFromCutoff() },
  };
  if (status) {
    const statuses = typeof status === 'string' && status.includes(',')
      ? status.split(',').map((s) => s.trim())
      : status;
    filter.internalStatus = Array.isArray(statuses) ? { $in: statuses } : statuses;
  }
  if (orderSource) filter.orderSource = orderSource;
  if (shippingMethod) filter.shippingMethod = shippingMethod;
  if (isExchangeOrder === true || isExchangeOrder === 'true') filter.isExchangeOrder = true;
  if (isReturnOrder === true || isReturnOrder === 'true') filter.isReturnOrder = true;
  if (isReturnOrder === false || isReturnOrder === 'false') {
    filter.isReturnOrder = { $ne: true };
  }
  if (delayed === true || delayed === '1' || delayed === 'true') {
    filter.delayedUntil = { $exists: true, $ne: null };
    if (!status) {
      const todayEnd = cairoTodayEnd();
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { internalStatus: { $in: ['pending_verification', 'no_response'] } },
            {
              internalStatus: 'verified_ready_for_shipping',
              delayedUntil: { $gt: todayEnd },
            },
          ],
        },
      ];
    }
  }
  // Ready-to-ship queue hides future ship-after dates (manual delay shipping).
  const readyOnly =
    filter.internalStatus === 'verified_ready_for_shipping'
    || (Array.isArray(filter.internalStatus?.$in)
      && filter.internalStatus.$in.length === 1
      && filter.internalStatus.$in[0] === 'verified_ready_for_shipping');
  if (readyOnly) {
    filter.$and = [...(filter.$and || []), shipAfterNotDueFilter()];
  }
  if (search) {
    const term = String(search).trim();
    if (term) {
      const regex = { $regex: escapeRegex(term), $options: 'i' };
      // Match customer name/phone/email too — UI shows customerId.fullName,
      // and pickup/manual orders often have no searchable shippingAddress.
      const matchingCustomers = await Customer.find({
        $or: [
          { fullName: regex },
          { phone: regex },
          { email: regex },
          ...phoneMatchRegexes(term).map((re) => ({ phone: { $regex: re } })),
        ],
      })
        .select('_id')
        .lean();
      const customerIds = matchingCustomers.map((c) => c._id);

      const digits = term.replace(/^#/, '').trim();
      const withHash = digits.startsWith('#') ? digits : `#${digits}`;
      const digitsRegex = digits ? { $regex: escapeRegex(digits), $options: 'i' } : null;
      const hashRegex = digits ? { $regex: escapeRegex(withHash), $options: 'i' } : null;
      const phoneRes = phoneMatchRegexes(term);

      filter.$or = [
        { shopifyOrderId: regex },
        { shopifyOrderName: regex },
        { bostaTrackingNumber: regex },
        { bostaDeliveryId: regex },
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.city': regex },
        { 'items.sku': regex },
        ...phoneRes.map((re) => ({ 'shippingAddress.phone': { $regex: re } })),
        ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : []),
      ];

      // Order # as shown in UI (#44004) — match with/without hash on name + id.
      if (digits && digitsRegex) {
        filter.$or.push(
          { shopifyOrderId: digitsRegex },
          { shopifyOrderName: digitsRegex },
          { shopifyOrderName: hashRegex },
          { bostaTrackingNumber: digitsRegex },
          { bostaDeliveryId: digitsRegex },
          { 'items.sku': digitsRegex }
        );
      }
    }
  }
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('customerId', 'fullName phone riskFlag lifetimeCancelled')
      .populate({
        path: 'items.variantId',
        select: 'title color size sku productId',
        populate: { path: 'productId', select: 'title' },
      }),
    Order.countDocuments(filter),
  ]);
  return { orders, total };
}

export async function getOrderById(orderId) {
  return Order.findById(orderId)
    .populate('customerId')
    .populate('assignedOrdersManagerId', 'name email')
    .populate('assignedStockManagerId', 'name email')
    .populate({
      path: 'items.variantId',
      select: 'title color size imageUrl sku realStock onHoldStock productId',
      populate: { path: 'productId', select: 'title imageUrl' },
    });
}

export async function getOrderStatusHistory(orderId) {
  return OrderStatusHistory.find({ orderId }).sort({ createdAt: -1 });
}

export async function claimOrder(orderId, actorUserId, role) {
  const field = role === 'stock_manager' ? 'assignedStockManagerId' : 'assignedOrdersManagerId';
  return Order.findOneAndUpdate(
    { _id: orderId, [field]: { $in: [null, undefined] } },
    { [field]: actorUserId },
    { new: true }
  );
}

/**
 * Customer asked to delay — stay in pending_verification until callback day.
 * @param {string} delayedUntil - YYYY-MM-DD (Cairo business day)
 */
export async function delayOrder(orderId, actorUserId, { delayedUntil, note }) {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }
  if (order.internalStatus !== 'pending_verification' && order.internalStatus !== 'no_response') {
    const err = new Error('Only pending verification / no-response orders can be delayed');
    err.statusCode = 400;
    throw err;
  }

  const { ymd, until } = parseCairoDelayDate(delayedUntil);

  order.delayedUntil = until;
  order.delayNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  order.delayNotifiedOn = undefined;
  if (!order.assignedOrdersManagerId) order.assignedOrdersManagerId = actorUserId;
  order.verificationLog.push({
    outcome: 'no_response',
    note: `Delayed until ${ymd}${order.delayNote ? ` — ${order.delayNote}` : ''}`,
    actorUserId,
  });
  await order.save();
  return order;
}

/**
 * Daily job: notify OM for delays due today (Cairo).
 */
export async function processDelayCallbacksDue() {
  const { notifyOrderCallbackDue } = await import('./notification.service.js');
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const dayStart = new Date(`${todayYmd}T00:00:00+03:00`);
  const dayEnd = new Date(`${todayYmd}T23:59:59.999+03:00`);

  const due = await Order.find({
    internalStatus: { $in: ['pending_verification', 'no_response'] },
    delayedUntil: { $gte: dayStart, $lte: dayEnd },
    $or: [{ delayNotifiedOn: { $exists: false } }, { delayNotifiedOn: null }, { delayNotifiedOn: { $ne: todayYmd } }],
  }).limit(200);

  let notified = 0;
  for (const order of due) {
    await notifyOrderCallbackDue(order);
    order.delayNotifiedOn = todayYmd;
    await order.save();
    notified += 1;
  }
  return { date: todayYmd, notified };
}

const DISCOUNT_PERCENTS = [5, 10, 15, 20, 25, 30];
const DISCOUNTABLE_STATUSES = [
  'pending_verification',
  'no_response',
  'verified_ready_for_shipping',
  'out_of_stock',
];

/**
 * Apply % discount on merchandise (totalSellingPrice), never on shippingFee.
 * percent 0 clears the discount and restores merchandiseSubtotal.
 */
export async function applyOrderDiscount(orderId, actorUserId, { percent }) {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  if (!DISCOUNTABLE_STATUSES.includes(order.internalStatus)) {
    const err = new Error('Discount can only be set before the order is handed to courier');
    err.statusCode = 400;
    throw err;
  }

  if (order.bostaDeliveryId || ['queued', 'creating', 'created'].includes(order.bostaShipmentStatus)) {
    const err = new Error('Cannot change discount after a Bosta shipment was created');
    err.statusCode = 400;
    throw err;
  }

  if (order.isExchangeOrder || order.isCreatorOrder || order.isReturnOrder) {
    const err = new Error('Discount is not available on exchange / creator / return orders');
    err.statusCode = 400;
    throw err;
  }

  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct < 0) {
    const err = new Error('Invalid discount percent');
    err.statusCode = 400;
    throw err;
  }
  if (pct !== 0 && !DISCOUNT_PERCENTS.includes(pct)) {
    const err = new Error(`Discount must be one of: ${DISCOUNT_PERCENTS.join(', ')}% (or 0 to clear)`);
    err.statusCode = 400;
    throw err;
  }

  const base =
    order.merchandiseSubtotal != null && order.merchandiseSubtotal > 0
      ? Number(order.merchandiseSubtotal)
      : Number(order.totalSellingPrice || 0) + Number(order.discountAmount || 0);

  if (!(base > 0) && pct > 0) {
    const err = new Error('Order has no merchandise total to discount');
    err.statusCode = 400;
    throw err;
  }

  const discountAmount = pct === 0 ? 0 : Math.round((base * pct) / 100 * 100) / 100;
  const totalSellingPrice = Math.max(0, Math.round((base - discountAmount) * 100) / 100);

  order.merchandiseSubtotal = base;
  order.discountPercent = pct;
  order.discountAmount = discountAmount;
  order.totalSellingPrice = totalSellingPrice;
  await order.save();

  await OrderStatusHistory.create({
    orderId: order._id,
    fromStatus: order.internalStatus,
    toStatus: order.internalStatus,
    source: 'user_action',
    actorUserId,
    note:
      pct === 0
        ? `Cleared merchandise discount — total ${totalSellingPrice} EGP (shipping unchanged)`
        : `Applied ${pct}% discount on merchandise (−${discountAmount} EGP) — goods ${totalSellingPrice} EGP + shipping ${order.shippingFee || 0} EGP`,
  });

  return order;
}

/**
 * Apply the same verify/cancel outcome to many orders (queue bulk actions).
 * Each order is processed independently; failures are collected, not fatal for the batch.
 */
export async function bulkVerifyOrders(orderIds, actorUserId, { outcome, note, shippingMethod } = {}) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    const err = new Error('Select at least one order');
    err.statusCode = 400;
    throw err;
  }
  if (!['confirmed', 'no_response', 'customer_cancelled'].includes(outcome)) {
    const err = new Error('outcome must be confirmed, no_response, or customer_cancelled');
    err.statusCode = 400;
    throw err;
  }

  const uniqueIds = [...new Set(orderIds.map((id) => String(id)).filter(Boolean))];
  if (uniqueIds.length > 100) {
    const err = new Error('Maximum 100 orders per bulk action');
    err.statusCode = 400;
    throw err;
  }

  const results = { ok: [], failed: [] };
  const resolvedNote =
    (note && String(note).trim()) ||
    (outcome === 'customer_cancelled' ? 'Bulk cancel from verification queue' : undefined);

  for (const id of uniqueIds) {
    try {
      const body = { outcome };
      if (resolvedNote) body.note = resolvedNote;
      if (shippingMethod && outcome === 'confirmed') body.shippingMethod = shippingMethod;
      await verifyOrder(id, actorUserId, body);
      results.ok.push(id);
    } catch (err) {
      results.failed.push({
        id,
        message: err.message || 'Failed',
      });
    }
  }

  return results;
}

export default {
  verifyOrder,
  bulkVerifyOrders,
  cancelOrder,
  markDelivered,
  partialLocalDelivery,
  confirmReturnedToStock,
  transitionOrderStatus,
  reserveStockForOrder,
  ensureOrderStockHeld,
  manualStockAdjustment,
  stockIntake,
  setRealStockBatch,
  releaseOutOfStockOrdersIfRestocked,
  createManualOrder,
  findOrderForExchange,
  suggestShippingFeeByCity,
  resolveExchangeShippingFee,
  getOrderStateCounts,
  getOrderById,
  listOrders,
  getOrderStatusHistory,
  claimOrder,
  delayOrder,
  processDelayCallbacksDue,
  applyOrderDiscount,
  syncShopifySellableAfterLedger,
  forceSyncVariantsToShopify,
  ingestShopifyAvailableIncrease,
};
