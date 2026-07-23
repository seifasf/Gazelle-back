import Order from '../models/Order.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import Variant from '../models/Variant.js';
import Customer from '../models/Customer.js';
import { withTransaction } from '../utils/transaction.js';
import { assertTransition, isTerminalStatus } from './orderStateMachine.js';
import {
  applyLedgerEntries,
  notifyNegativeStockCrossings,
  buildHoldReserveEntries,
  buildDeliveryEntries,
  buildPreDeliveryReleaseEntries,
  buildPostDeliveryReturnEntries,
  buildManualAdjustmentEntry,
  buildStockIntakeEntries,
} from './inventory.service.js';
import { TERMINAL_ORDER_STATUSES, ORDER_STATUSES, ORDERS_PLACED_FROM_YMD } from '../constants/index.js';
import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';
import {
  notifyOrderVerified,
  notifyFailedDelivery,
  notifyReturnToOrigin,
  notifyNewOrder,
  checkVariantsLowStock,
} from './notification.service.js';
import { recordDeliveryJournal } from './accounting.service.js';
import { recordCustomerCancellation } from './customer.service.js';

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

  const updates = {
    internalStatus: toStatus,
    lastStatusUpdateAt: new Date(),
  };

  if (toStatus === 'verified_ready_for_shipping') {
    updates.verifiedAt = new Date();
  }
  if (toStatus === 'delivered') {
    updates.deliveredAt = new Date();
    updates.closedAt = new Date();
  }
  if (TERMINAL_ORDER_STATUSES.includes(toStatus)) {
    updates.closedAt = new Date();
  }

  await Order.updateOne({ _id: order._id }, updates, { session });
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

async function enqueueShopifySync(ledgerDocs) {
  // Open-stock mode: OMS does not push inventory to Shopify (brand-owned).
  // Kept as a no-op-safe helper for any leftover pending online ledger rows.
  const pending = (ledgerDocs || []).filter(
    (doc) => doc.ledgerType === 'online_stock_increment_api' && doc.shopifySyncStatus === 'pending'
  );
  if (pending.length === 0) return;

  try {
    const agenda = getAgenda();
    for (const doc of pending) {
      await agenda.now(JOB_NAMES.SHOPIFY_OUTBOUND_INVENTORY, { ledgerId: doc._id.toString() });
    }
  } catch {
    // Agenda may not be initialized in tests
  }
}

async function afterLedgerApplied(ledgerDocs) {
  await notifyNegativeStockCrossings(ledgerDocs?._negativeCrossings || []);
  await enqueueShopifySync(ledgerDocs);
}

export async function verifyOrder(orderId, actorUserId, { outcome, note, totalCogsSnapshot, shippingMethod }) {
  const order = await Order.findById(orderId).populate('items.variantId');
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
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

  if (outcome !== 'confirmed') {
    order.verificationLog.push({ outcome, note, actorUserId });
    await order.save();
    return order;
  }

  const updates = { totalCogsSnapshot };
  if (!order.assignedOrdersManagerId) {
    updates.assignedOrdersManagerId = actorUserId;
  }

  const verified = await withTransaction(async (session) => {
    const fresh = await Order.findById(orderId).session(session);
    fresh.verificationLog.push({ outcome, note, actorUserId });
    if (totalCogsSnapshot != null) fresh.totalCogsSnapshot = totalCogsSnapshot;
    if (!fresh.assignedOrdersManagerId) fresh.assignedOrdersManagerId = actorUserId;
    if (shippingMethod) fresh.shippingMethod = shippingMethod;
    fresh.delayedUntil = undefined;
    fresh.delayNote = undefined;
    fresh.delayNotifiedOn = undefined;
    await fresh.save({ session });
    await Order.updateOne(
      { _id: fresh._id },
      { $unset: { delayedUntil: 1, delayNote: 1, delayNotifiedOn: 1 } },
      { session }
    );

    if (fresh.orderSource === 'manual') {
      await reserveStockForOrder(fresh._id, fresh.items, session);
    }

    await transitionOrder(
      fresh,
      'verified_ready_for_shipping',
      { source: 'user_action', actorUserId, note },
      session
    );
    return Order.findById(orderId).session(session);
  });

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

    const cancellable = ['pending_verification', 'verified_ready_for_shipping'];
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
  const ledgerEntries = buildDeliveryEntries(order._id, order.items);
  let ledgerDocs = [];
  try {
    ledgerDocs = await applyLedgerEntries(ledgerEntries, session);
  } catch (err) {
    // Historical Shopify imports / Bosta backfill often never reserved hold stock.
    // Still mark delivered so COD + courier status stay truthful; log the inventory gap.
    if (source === 'bosta_webhook' || source === 'shopify_import') {
      const logger = (await import('../utils/logger.js')).default;
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

export async function confirmReturnedToStock(orderId, actorUserId, note) {
  const result = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    if (order.internalStatus !== 'returned_awaiting_receipt') {
      const err = new Error('Only warehouse-received returns can be confirmed back into stock');
      err.statusCode = 400;
      throw err;
    }

    // Post-delivery return vs RTO (never delivered) — warehouse only, no Shopify push.
    const ledgerDocs = await applyLedgerEntries(
      order.deliveredAt
        ? buildPostDeliveryReturnEntries(order._id, order.items)
        : buildPreDeliveryReleaseEntries(order._id, order.items),
      session
    );

    await transitionOrder(
      order,
      'returned_to_stock',
      { source: 'user_action', actorUserId, note },
      session
    );

    await Customer.updateOne(
      { _id: order.customerId },
      { $inc: { lifetimeRejectedOrReturned: 1 } },
      { session }
    );

    return { order: await Order.findById(orderId).session(session), ledgerDocs };
  });

  await afterLedgerApplied(result.ledgerDocs);
  return result.order;
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

    await transitionOrder(order, toStatus, meta, session);
    return Order.findById(orderId).session(session);
  });

  if (toStatus === 'delivered') {
    await afterLedgerApplied(updated?._ledgerDocs);
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

export async function manualStockAdjustment({ variantId, quantityDelta, reasonCode, actorUserId }) {
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
  await afterLedgerApplied(result.ledgerDocs);
  await checkVariantsLowStock([variantId]);
  return result;
}

export async function stockIntake({ variantId, quantity, reasonCode, note, actorUserId }) {
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
  });
}

/**
 * Set absolute warehouse realStock for many variants (open-stock count / Excel import).
 * Never writes to Shopify.
 */
export async function setRealStockBatch({ items, reasonCode = 'stock_count', actorUserId }) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('items array is required');
    err.statusCode = 400;
    throw err;
  }

  const results = [];
  const allCrossings = [];

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
    results.push({
      variantId: outcome.variantId,
      sku: outcome.sku,
      previous: outcome.previous,
      realStock: outcome.realStock,
      changed: outcome.changed,
    });
  }

  await notifyNegativeStockCrossings(allCrossings);
  await checkVariantsLowStock(results.map((r) => r.variantId));

  if (!results.length) {
    const err = new Error('No valid stock set rows');
    err.statusCode = 400;
    throw err;
  }

  return { results, count: results.length };
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
}) {
  const ref = `MAN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const exchange = Boolean(isExchangeOrder);

  if (exchange && !exchangeFromOrderId) {
    const err = new Error('Select the previous order this exchange replaces');
    err.statusCode = 400;
    throw err;
  }

  const manualOrder = await withTransaction(async (session) => {
    let priorOrder = null;
    if (exchange) {
      priorOrder = await Order.findById(exchangeFromOrderId).session(session);
      if (!priorOrder) {
        const err = new Error('Previous exchange order not found');
        err.statusCode = 404;
        throw err;
      }
    }

    let customerDoc = await Customer.findOne({ phone: customer.phone }).session(session);
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
    for (const item of items) {
      const variant = await Variant.findById(item.variantId).session(session);
      if (!variant) {
        const err = new Error(`Variant not found: ${item.variantId}`);
        err.statusCode = 404;
        throw err;
      }
      orderItems.push({
        variantId: variant._id,
        sku: variant.sku,
        quantity: item.quantity,
        unitSellingPrice: exchange ? 0 : (item.unitSellingPrice ?? variant.sellingPrice),
        unitCogs: variant.cogs,
      });
    }

    const total = exchange
      ? 0
      : totalSellingPrice ?? orderItems.reduce(
          (sum, i) => sum + i.unitSellingPrice * i.quantity,
          0
        );

    const finalShippingAddress =
      shippingMethod === 'pickup'
        ? undefined
        : {
            ...(shippingAddress || {}),
            phone: shippingAddress?.phone || customer.phone,
            fullName: shippingAddress?.fullName || customer.fullName,
          };

    const exchangeNote = priorOrder
      ? `Exchange for ${priorOrder.shopifyOrderName || priorOrder.shopifyOrderId || priorOrder._id}`
      : null;

    const [order] = await Order.create(
      [{
        shopifyOrderId: ref,
        orderSource: 'manual',
        manualSource,
        shippingMethod: shippingMethod || 'bosta',
        paymentMethod: paymentMethod || 'cod',
        shippingFee: exchange ? 0 : (shippingFee ?? 0),
        onlinePaymentReference: paymentMethod === 'online' ? ref : undefined,
        customerId: customerDoc._id,
        shippingAddress: finalShippingAddress,
        internalStatus: 'pending_verification',
        isCreatorOrder: Boolean(isCreatorOrder),
        isExchangeOrder: exchange,
        exchangeFromOrderId: exchange ? priorOrder._id : undefined,
        totalSellingPrice: total,
        totalCogsSnapshot: orderItems.reduce((s, i) => s + (i.unitCogs || 0) * i.quantity, 0),
        items: orderItems,
        placedAt: new Date(),
        assignedOrdersManagerId: actorUserId,
        verificationLog: [
          ...(note ? [{ outcome: 'confirmed', note, actorUserId }] : []),
          ...(exchangeNote ? [{ outcome: 'confirmed', note: exchangeNote, actorUserId }] : []),
        ],
      }],
      { session }
    );

    await recordStatusChange(
      {
        orderId: order._id,
        fromStatus: null,
        toStatus: 'pending_verification',
        source: 'user_action',
        actorUserId,
        note: exchange
          ? `Exchange order from ${manualSource} (for ${priorOrder.shopifyOrderName || priorOrder.shopifyOrderId})`
          : `Manual order from ${manualSource}`,
      },
      session
    );

    await Customer.updateOne({ _id: customerDoc._id }, { $inc: { lifetimeOrders: 1 } }, { session });

    return Order.findById(order._id).session(session).populate('customerId').populate('exchangeFromOrderId', 'shopifyOrderId shopifyOrderName internalStatus');
  });

  await notifyNewOrder(manualOrder, { source: 'manual' });
  return manualOrder;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ordersPlacedFromCutoff() {
  // Cairo midnight for ORDERS_PLACED_FROM_YMD (Egypt is UTC+2 / +3 — use +03:00 bound).
  const ymd = ORDERS_PLACED_FROM_YMD;
  return new Date(`${ymd}T00:00:00+03:00`);
}

export async function getOrderStateCounts() {
  const pipeline = [
    { $match: { placedAt: { $gte: ordersPlacedFromCutoff() } } },
    { $group: { _id: '$internalStatus', count: { $sum: 1 } } },
  ];
  const rows = await Order.aggregate(pipeline);
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const row of rows) {
    counts[row._id] = row.count;
  }
  counts.total = rows.reduce((sum, r) => sum + r.count, 0);
  return counts;
}

export async function listOrders({ status, search, orderSource, shippingMethod, limit = 50, skip = 0, sort = { placedAt: -1 } }) {
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
        ],
      })
        .select('_id')
        .lean();
      const customerIds = matchingCustomers.map((c) => c._id);

      filter.$or = [
        { shopifyOrderId: regex },
        { bostaTrackingNumber: regex },
        { bostaDeliveryId: regex },
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.city': regex },
        ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : []),
      ];
      // Allow searching with a leading # (UI shows Shopify as #123…).
      const digits = term.replace(/^#/, '').trim();
      if (digits && digits !== term) {
        const digitsRegex = { $regex: escapeRegex(digits), $options: 'i' };
        filter.$or.push(
          { shopifyOrderId: digitsRegex },
          { bostaTrackingNumber: digitsRegex },
          { bostaDeliveryId: digitsRegex }
        );
      }
    }
  }
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('customerId', 'fullName phone riskFlag lifetimeCancelled'),
    Order.countDocuments(filter),
  ]);
  return { orders, total };
}

export async function getOrderById(orderId) {
  return Order.findById(orderId)
    .populate('customerId')
    .populate('assignedOrdersManagerId', 'name email')
    .populate('assignedStockManagerId', 'name email')
    .populate('items.variantId', 'title color size imageUrl sku realStock onHoldStock');
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
  if (order.internalStatus !== 'pending_verification') {
    const err = new Error('Only pending verification orders can be delayed');
    err.statusCode = 400;
    throw err;
  }

  const ymd = String(delayedUntil || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const err = new Error('delayedUntil must be YYYY-MM-DD');
    err.statusCode = 400;
    throw err;
  }

  // Store as noon UTC-ish for the Cairo calendar day via Egypt offset approximation:
  // Use start-of-day Cairo by constructing ISO with +03:00 (EET/EEST approx; fine for date-only).
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
    internalStatus: 'pending_verification',
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

export default {
  verifyOrder,
  cancelOrder,
  markDelivered,
  confirmReturnedToStock,
  transitionOrderStatus,
  reserveStockForOrder,
  manualStockAdjustment,
  stockIntake,
  setRealStockBatch,
  createManualOrder,
  getOrderStateCounts,
  getOrderById,
  listOrders,
  getOrderStatusHistory,
  claimOrder,
  delayOrder,
  processDelayCallbacksDue,
};
