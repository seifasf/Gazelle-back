import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import bwipjs from 'bwip-js';
import { barcodeValueForVariant } from './barcode.service.js';
import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import {
  createDelivery,
  getAwb,
  getDelivery,
  updateDeliveryPackageDescription,
  updateDeliveryAddressAndCod,
} from '../integrations/bosta/shipments.service.js';
import orderService from '../services/order.service.js';
import logger from '../utils/logger.js';
import { syncShopifyMoneyOntoOrder } from '../integrations/shopify/syncOrderMoney.service.js';
import { bostaCodAmountForOrder, isOrderPrepaidForBosta } from '../integrations/bosta/shipments.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = resolve(__dirname, '../assets/gazelle-logo.png');

function getLogoBase64() {
  try {
    const buf = readFileSync(LOGO_PATH);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function isForeignBostaDelivery(delivery) {
  const src = String(delivery?.creationSrc || delivery?.source || '').toUpperCase();
  if (src === 'WOOCOMMERCE' || src === 'WOO') return true;
  const ref = String(delivery?.businessReference || '').trim().toLowerCase();
  if (ref.startsWith('woocommerce') || ref.startsWith('woo_') || ref.startsWith('woo-')) return true;
  return false;
}

/** True when Bosta delivery belongs to this Gazelle order. */
function deliveryBelongsToOrder(delivery, order) {
  if (!delivery || !order) return false;
  if (isForeignBostaDelivery(delivery)) return false;
  const ref = String(delivery.businessReference || '').trim();
  if (ref) {
    if (ref === String(order._id)) return true;
    // Legacy Gazelle creates may have used Shopify id; accept only if not foreign.
    if (order.shopifyOrderId && ref === String(order.shopifyOrderId)) return true;
    return false;
  }
  // Missing businessReference: keep only if id/tracking already match this order
  // (do not clear+recreate a valid Gazelle AWB just because GET omitted the ref).
  const liveId = String(delivery._id || delivery.id || '');
  const liveTracking =
    delivery.trackingNumber != null ? String(delivery.trackingNumber) : '';
  if (order.bostaDeliveryId && liveId && String(order.bostaDeliveryId) === liveId) {
    return true;
  }
  if (
    order.bostaTrackingNumber &&
    liveTracking &&
    String(order.bostaTrackingNumber) === liveTracking
  ) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearWrongBostaLink(order, reason) {
  const previous = {
    deliveryId: order.bostaDeliveryId,
    tracking: order.bostaTrackingNumber,
  };
  order.bostaDeliveryId = undefined;
  order.bostaTrackingNumber = undefined;
  order.bostaShipmentStatus = 'none';
  order.bostaShipmentError = null;
  await order.save();
  logger.warn(
    { orderId: order._id, ...previous, reason },
    'Cleared wrong / foreign Bosta link from order'
  );
}

export async function checkStockAvailability(order) {
  const warnings = [];
  for (const item of order.items || []) {
    const variant = await Variant.findById(item.variantId);
    if (!variant) {
      warnings.push({ sku: item.sku, message: 'Variant not found' });
      continue;
    }
    if (variant.realStock < item.quantity) {
      warnings.push({
        sku: item.sku,
        message: `Real stock ${variant.realStock} < required ${item.quantity}`,
        realStock: variant.realStock,
        required: item.quantity,
      });
    }
  }
  return warnings;
}

function assertBostaShipable(order) {
  if (order.shippingMethod === 'pickup' || order.shippingMethod === 'local_shipping') {
    const err = new Error('This order does not use Bosta shipping');
    err.statusCode = 400;
    throw err;
  }
  if (!order.shippingAddress?.line1 || !String(order.shippingAddress?.city || '').trim()) {
    const err = new Error(
      'Order is missing street or city. Open the order, fix the shipping address, then retry.'
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Create the Bosta delivery if missing (or retry after failure).
 * Does NOT change internalStatus — used for print-policy-before-confirm.
 */
export async function ensureBostaDeliveryForOrder(orderId, actorUserId) {
  let order = await Order.findById(orderId).populate('customerId');
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  // Refresh Shopify city shipping fee + paid status before AWB (COD must be 0 if paid).
  order = (await syncShopifyMoneyOntoOrder(order)) || order;

  assertBostaShipable(order);

  logger.info(
    {
      orderId: String(order._id),
      name: order.shopifyOrderName,
      city: order.shippingAddress?.city,
      shippingFee: order.shippingFee,
      prepaid: isOrderPrepaidForBosta(order),
      bostaCod: bostaCodAmountForOrder(order),
      paymentMethod: order.paymentMethod,
    },
    'Preparing Bosta delivery (shipping + COD)'
  );

  if (order.bostaDeliveryId || order.bostaTrackingNumber) {
    // Reject WooCommerce / phone-match leftovers — create a real Gazelle delivery instead.
    // Prefer tracking lookup: GET /deliveries/:id often 404s on Bosta v2 for valid API shipments.
    let live = null;
    const lookupKeys = [
      order.bostaTrackingNumber,
      order.bostaDeliveryId,
    ].filter(Boolean).map(String);
    const tried = new Set();
    for (const key of lookupKeys) {
      if (tried.has(key)) continue;
      tried.add(key);
      try {
        live = await getDelivery(key);
        if (live) break;
      } catch (err) {
        logger.warn(
          { err: err.message, orderId, key },
          'Could not fetch linked Bosta delivery key'
        );
      }
    }
    if (!live) {
      logger.warn(
        { orderId, deliveryId: order.bostaDeliveryId, tracking: order.bostaTrackingNumber },
        'Could not fetch linked Bosta delivery — will clear and recreate'
      );
    }

    if (!live || !deliveryBelongsToOrder(live, order)) {
      await clearWrongBostaLink(
        order,
        live
          ? `foreign/mismatched ref=${live.businessReference || ''} src=${live.creationSrc || ''}`
          : 'linked delivery not found'
      );
    } else {
      if (order.bostaShipmentStatus !== 'created') {
        order.bostaShipmentStatus = 'created';
        order.bostaShipmentError = null;
      }
      if (actorUserId && !order.assignedStockManagerId) {
        order.assignedStockManagerId = actorUserId;
      }
      // Keep tracking in sync with live Bosta
      const liveTracking =
        live.trackingNumber != null ? String(live.trackingNumber) : order.bostaTrackingNumber;
      const liveId = String(live._id || live.id || order.bostaDeliveryId);
      if (liveTracking && order.bostaTrackingNumber !== liveTracking) {
        order.bostaTrackingNumber = liveTracking;
      }
      if (liveId && order.bostaDeliveryId !== liveId) {
        order.bostaDeliveryId = liveId;
      }
      await order.save();
      try {
        // Re-pull Shopify ship-to + money, then push onto the existing AWB.
        order = (await syncShopifyMoneyOntoOrder(order)) || order;
        order = await Order.findById(orderId).populate('customerId');
        await updateDeliveryAddressAndCod(order.bostaDeliveryId, order, order.customerId);
        await updateDeliveryPackageDescription(order.bostaDeliveryId, order);
      } catch (err) {
        logger.warn(
          { err: err.message, orderId, deliveryId: order.bostaDeliveryId },
          'Could not refresh Bosta address/COD/description from Shopify'
        );
      }
      return {
        deliveryId: order.bostaDeliveryId,
        trackingNumber: order.bostaTrackingNumber,
        orderId,
        created: false,
      };
    }
  }

  // Atomic claim — prevents double-create from concurrent print/pick-pack/jobs.
  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      $and: [
        {
          $or: [{ bostaDeliveryId: null }, { bostaDeliveryId: { $exists: false } }],
        },
        {
          $or: [
            { bostaShipmentStatus: { $nin: ['creating'] } },
            { bostaShipmentStatus: null },
            { bostaShipmentStatus: { $exists: false } },
          ],
        },
      ],
    },
    {
      $set: {
        bostaShipmentStatus: 'creating',
        bostaShipmentError: null,
        ...(actorUserId ? { assignedStockManagerId: actorUserId } : {}),
      },
    },
    { new: true }
  ).populate('customerId');

  if (!claimed) {
    for (let i = 0; i < 10; i += 1) {
      await sleep(500);
      const fresh = await Order.findById(orderId).select(
        'bostaDeliveryId bostaTrackingNumber bostaShipmentStatus bostaShipmentError'
      );
      if (fresh?.bostaDeliveryId) {
        return {
          deliveryId: fresh.bostaDeliveryId,
          trackingNumber: fresh.bostaTrackingNumber,
          orderId,
          created: false,
        };
      }
      if (fresh?.bostaShipmentStatus === 'failed') {
        const err = new Error(fresh.bostaShipmentError || 'Bosta shipment create failed');
        err.statusCode = 502;
        throw err;
      }
    }
    const err = new Error('Bosta delivery is already being created — retry in a moment');
    err.statusCode = 409;
    throw err;
  }

  try {
    const result = await createDelivery(claimed, claimed.customerId);
    const deliveryId = result._id || result.id || result.data?._id;
    const trackingNumber = result.trackingNumber || result.tracking_number;

    // Atomic write — avoid stuck "creating" if document.save() fails after Bosta succeeded.
    const saved = await Order.findByIdAndUpdate(
      orderId,
      {
        $set: {
          bostaDeliveryId: deliveryId,
          bostaTrackingNumber: trackingNumber,
          bostaShipmentStatus: 'created',
          bostaShipmentError: null,
        },
      },
      { new: true }
    );
    if (!saved?.bostaDeliveryId) {
      const err = new Error('Bosta delivery created but could not be saved on the order — contact admin');
      err.statusCode = 500;
      throw err;
    }

    return {
      deliveryId,
      trackingNumber,
      orderId,
      created: true,
    };
  } catch (error) {
    await Order.findByIdAndUpdate(orderId, {
      $set: {
        bostaShipmentStatus: 'failed',
        bostaShipmentError: error.message,
      },
    });
    logger.error({ err: error.message, orderId }, 'Bosta shipment create failed');
    throw error;
  }
}

/**
 * Ensure Bosta delivery exists, then fetch the AWB (بوليصة) PDF URL.
 * Moves Ready → Awaiting Bosta pickup once the delivery exists.
 */
export async function prepareAwbForOrder(orderId, actorUserId) {
  const shipment = await ensureBostaDeliveryForOrder(orderId, actorUserId);
  const order = await Order.findById(orderId).select('internalStatus');
  if (order?.internalStatus === 'verified_ready_for_shipping') {
    await orderService.transitionOrderStatus(orderId, 'awaiting_bosta_pickup', {
      source: 'user_action',
      actorUserId,
      note: shipment.created
        ? 'Bosta AWB created — awaiting courier pickup'
        : 'Bosta AWB printed — awaiting courier pickup',
    });
  }
  const awb = await getAwb(shipment.deliveryId, shipment.trackingNumber);
  return {
    url: awb?.url || null,
    deliveryId: shipment.deliveryId,
    trackingNumber: shipment.trackingNumber,
    orderId,
    created: shipment.created,
  };
}

/**
 * Create the Bosta delivery (if needed) and move the order to awaiting_bosta_pickup.
 * Used by pick-pack and the Agenda job. Courier collection → picked_up_by_bosta via webhook.
 */
export async function createBostaShipmentForOrder(orderId, actorUserId) {
  const shipment = await ensureBostaDeliveryForOrder(orderId, actorUserId);

  const order = await Order.findById(orderId).select('internalStatus');
  if (order?.internalStatus === 'verified_ready_for_shipping') {
    await orderService.transitionOrderStatus(orderId, 'awaiting_bosta_pickup', {
      source: 'system',
      actorUserId,
      note: shipment.created
        ? 'Bosta shipment created — awaiting courier pickup'
        : 'Bosta shipment confirmed — awaiting courier pickup',
    });
  } else if (order?.internalStatus === 'awaiting_bosta_pickup') {
    // Already waiting — keep status.
  }

  return {
    deliveryId: shipment.deliveryId,
    trackingNumber: shipment.trackingNumber,
    orderId,
  };
}

export async function pickAndPackOrder(orderId, actorUserId) {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  if (order.internalStatus !== 'verified_ready_for_shipping') {
    const err = new Error('Order is not ready for shipping');
    err.statusCode = 400;
    throw err;
  }

  if (order.shippingMethod === 'pickup') {
    order.assignedStockManagerId = actorUserId;
    await order.save();
    await orderService.transitionOrderStatus(orderId, 'delivered', {
      source: 'user_action',
      actorUserId,
      note: 'Customer pickup — scanned & handed over by stock manager',
    });
    return { queued: false, pickup: true, orderId, stockWarnings: [] };
  }

  if (order.shippingMethod === 'local_shipping') {
    order.localShippingMarkedAt = new Date();
    order.localShippingNote = order.localShippingNote || 'Marked ready for local delivery';
    order.assignedStockManagerId = actorUserId;
    await order.save();

    await orderService.transitionOrderStatus(orderId, 'local_shipping', {
      source: 'user_action',
      actorUserId,
      note: 'Handed to local shipping',
    });

    return { queued: false, localShipping: true, orderId, stockWarnings: [] };
  }

  // Fast path: policy already printed → Bosta delivery exists → awaiting courier pickup.
  if (order.bostaDeliveryId && order.bostaShipmentStatus === 'created') {
    if (actorUserId && !order.assignedStockManagerId) {
      order.assignedStockManagerId = actorUserId;
      await order.save();
    } else if (actorUserId) {
      await Order.updateOne(
        { _id: orderId, assignedStockManagerId: { $exists: false } },
        { $set: { assignedStockManagerId: actorUserId } }
      );
    }
    await orderService.transitionOrderStatus(orderId, 'awaiting_bosta_pickup', {
      source: 'user_action',
      actorUserId,
      note: 'Pick & pack confirmed — Bosta AWB printed, awaiting courier pickup',
    });
    return {
      queued: false,
      bosta: true,
      awaitingPickup: true,
      orderId,
      deliveryId: order.bostaDeliveryId,
      trackingNumber: order.bostaTrackingNumber,
      stockWarnings: [],
    };
  }

  // No AWB yet — create shipment (slower path) → awaiting_bosta_pickup.
  try {
    const shipment = await createBostaShipmentForOrder(orderId, actorUserId);
    return {
      queued: false,
      bosta: true,
      awaitingPickup: true,
      orderId,
      deliveryId: shipment.deliveryId,
      trackingNumber: shipment.trackingNumber,
      stockWarnings: [],
    };
  } catch (error) {
    const err = new Error(error.message || 'Failed to create Bosta shipment');
    err.statusCode = error.statusCode || 502;
    err.stockWarnings = [];
    throw err;
  }
}

export async function getPickList() {
  const { ORDERS_PLACED_FROM_YMD } = await import('../constants/index.js');
  const OrderStatusHistory = (await import('../models/OrderStatusHistory.js')).default;
  const cutoff = new Date(`${ORDERS_PLACED_FROM_YMD}T00:00:00+03:00`);
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const todayEnd = new Date(`${todayYmd}T23:59:59.999+03:00`);

  const orders = await Order.find({
    internalStatus: 'verified_ready_for_shipping',
    placedAt: { $gte: cutoff },
    // Hide manual/Shopify ship-after delays until the Cairo calendar day arrives.
    $or: [
      { delayedUntil: null },
      { delayedUntil: { $exists: false } },
      { delayedUntil: { $lte: todayEnd } },
    ],
  })
    // Newest ready-to-ship first so newly joined orders are easy to spot/select.
    .sort({ verifiedAt: -1, placedAt: -1 })
    .populate('customerId', 'fullName phone riskFlag lifetimeCancelled')
    .populate({
      path: 'items.variantId',
      select: 'sku title color size imageUrl productId',
      populate: { path: 'productId', select: 'title' },
    });

  // Backfill “from OOS” for ready orders that returned before the stamp field existed.
  const missingStamp = orders.filter((o) => !o.returnedFromOutOfStockAt);
  if (missingStamp.length) {
    const ids = missingStamp.map((o) => o._id);
    const rows = await OrderStatusHistory.aggregate([
      {
        $match: {
          orderId: { $in: ids },
          fromStatus: 'out_of_stock',
          toStatus: 'verified_ready_for_shipping',
        },
      },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$orderId', at: { $first: '$createdAt' } } },
    ]);
    const atById = new Map(rows.map((r) => [String(r._id), r.at]));
    for (const order of missingStamp) {
      const at = atById.get(String(order._id));
      if (at) {
        order.returnedFromOutOfStockAt = at;
        // Persist so later pick-lists skip the history scan for this order.
        Order.updateOne(
          { _id: order._id, returnedFromOutOfStockAt: { $exists: false } },
          { $set: { returnedFromOutOfStockAt: at } }
        ).catch(() => {});
      }
    }
  }

  return orders;
}

/**
 * Park a Ready-to-ship order as out_of_stock (warehouse missing SKUs).
 * Stock hold stays reserved until cancel or ship.
 *
 * Multi-item orders should pass `lines` so staff choose per SKU:
 * - action `oos` — this line is why the order parks as Out of stock
 * - action `remove` — wrong item / wrong number → quantity 0 (remove line), release hold
 * - action `keep` — leave on the order
 *
 * If OOS lines are all removed and only `keep` lines remain → stays Ready to ship.
 */
export async function markOrderOutOfStock(orderId, actorUserId, { note, lines } = {}) {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }
  if (order.internalStatus !== 'verified_ready_for_shipping') {
    const err = new Error('Only Ready to ship orders can move to Out of stock');
    err.statusCode = 400;
    throw err;
  }

  const itemCount = (order.items || []).length;
  const lineActions = Array.isArray(lines) ? lines : null;

  if (itemCount > 1 && (!lineActions || !lineActions.length)) {
    const err = new Error(
      'This order has multiple items — choose which line is out of stock, or set a wrong line to quantity 0'
    );
    err.statusCode = 400;
    err.code = 'OOS_LINES_REQUIRED';
    throw err;
  }

  const reason =
    typeof note === 'string' && note.trim() ? note.trim() : 'Warehouse: item(s) out of stock';

  if (!lineActions?.length) {
    return orderService.transitionOrderStatus(orderId, 'out_of_stock', {
      source: 'user_action',
      actorUserId,
      note: reason,
    });
  }

  const { withTransaction } = await import('../utils/transaction.js');
  const { applyLedgerEntries, netOrderLedgerQty } = await import('./inventory.service.js');

  const edit = await withTransaction(async (session) => {
    const fresh = await Order.findById(orderId).session(session);
    if (!fresh || fresh.internalStatus !== 'verified_ready_for_shipping') {
      const err = new Error('Only Ready to ship orders can move to Out of stock');
      err.statusCode = 400;
      throw err;
    }

    const byId = new Map(
      lineActions.filter((l) => l?.itemId).map((l) => [String(l.itemId), l])
    );

    const removedLabels = [];
    const oosLabels = [];
    let ledgerDocs = [];

    for (const item of [...(fresh.items || [])]) {
      const action = byId.get(String(item._id));
      if (!action || action.action !== 'remove') continue;

      const lineQty = Number(item.quantity) || 0;
      if (lineQty < 1) continue;

      const netHold = Math.max(
        0,
        await netOrderLedgerQty(
          fresh._id,
          item.variantId,
          ['on_hold_reserve', 'on_hold_release'],
          session
        )
      );
      const releaseQty = Math.min(lineQty, netHold);
      if (releaseQty > 0) {
        const released = await applyLedgerEntries(
          [
            {
              variantId: item.variantId,
              orderId: fresh._id,
              ledgerType: 'on_hold_release',
              quantityDelta: -releaseQty,
              reasonCode: 'oos_wrong_line_zero',
              actorUserId,
            },
          ],
          session
        );
        ledgerDocs = [...ledgerDocs, ...released];
      }

      removedLabels.push(`${item.sku || '?'}×${lineQty}`);
      item.deleteOne();
    }

    let hasOos = false;
    for (const item of fresh.items || []) {
      const action = byId.get(String(item._id));
      if (action?.action === 'oos') {
        hasOos = true;
        oosLabels.push(`${item.sku || '?'}×${item.quantity || 0}`);
      }
    }

    // Multi-item: must mark at least one remaining line as OOS, or only remove wrong lines.
    if (itemCount > 1 && !hasOos && !removedLabels.length) {
      const err = new Error('Select at least one out-of-stock item, or set a wrong item to quantity 0');
      err.statusCode = 400;
      throw err;
    }

    const unitsLeft = (fresh.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    if (unitsLeft < 1) {
      const err = new Error(
        'Cannot set every line to zero — cancel the order instead, or leave at least one item'
      );
      err.statusCode = 400;
      throw err;
    }

    const goodsSum = fresh.items.reduce(
      (sum, i) => sum + (Number(i.unitSellingPrice) || 0) * (Number(i.quantity) || 0),
      0
    );
    const pct = Number(fresh.discountPercent) || 0;
    fresh.merchandiseSubtotal = goodsSum;
    if (pct > 0 && goodsSum > 0) {
      fresh.discountAmount = Math.round(((goodsSum * pct) / 100) * 100) / 100;
      fresh.totalSellingPrice = Math.max(
        0,
        Math.round((goodsSum - fresh.discountAmount) * 100) / 100
      );
    } else {
      fresh.discountPercent = 0;
      fresh.discountAmount = 0;
      fresh.totalSellingPrice = goodsSum;
    }

    const detailParts = [];
    if (oosLabels.length) detailParts.push(`OOS: ${oosLabels.join(', ')}`);
    if (removedLabels.length) detailParts.push(`zeroed: ${removedLabels.join(', ')}`);
    const staffNote = [reason, detailParts.join(' · ')].filter(Boolean).join(' — ');

    fresh.verificationLog = fresh.verificationLog || [];
    fresh.verificationLog.push({
      outcome: 'customer_requested_changes',
      note: staffNote,
      actorUserId,
    });
    await fresh.save({ session });

    return {
      order: await Order.findById(fresh._id).session(session),
      ledgerDocs,
      hasOos,
      staffNote,
      removedLabels,
    };
  });

  await orderService.syncShopifySellableAfterLedger(edit.ledgerDocs, {
    forcePolicyFull: true,
    variantIds: (edit.order.items || []).map((i) => i.variantId),
  });

  if (edit.hasOos) {
    return orderService.transitionOrderStatus(orderId, 'out_of_stock', {
      source: 'user_action',
      actorUserId,
      note: edit.staffNote,
    });
  }

  // Only wrong lines zeroed — remaining items stay Ready to ship.
  return edit.order;
}

export async function getShipmentStatus(orderId) {
  const order = await Order.findById(orderId).select(
    'bostaShipmentStatus bostaShipmentError bostaDeliveryId bostaTrackingNumber internalStatus shippingMethod localShippingNote localShippingMarkedAt'
  );
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }
  return {
    status: order.bostaShipmentStatus,
    error: order.bostaShipmentError,
    deliveryId: order.bostaDeliveryId,
    trackingNumber: order.bostaTrackingNumber,
    orderStatus: order.internalStatus,
    shippingMethod: order.shippingMethod,
    localShippingNote: order.localShippingNote,
    localShippingMarkedAt: order.localShippingMarkedAt,
  };
}

export async function getAwbForOrder(orderId) {
  const order = await Order.findById(orderId);
  if (order?.shippingMethod === 'local_shipping' || order?.shippingMethod === 'pickup') {
    const err = new Error('This shipping method does not have a Bosta AWB');
    err.statusCode = 400;
    throw err;
  }
  if (!order?.bostaDeliveryId) {
    const err = new Error('No Bosta delivery for this order');
    err.statusCode = 404;
    throw err;
  }
  const awb = await getAwb(order.bostaDeliveryId, order.bostaTrackingNumber);
  return {
    url: awb?.url || null,
    deliveryId: order.bostaDeliveryId,
    trackingNumber: order.bostaTrackingNumber,
    ...awb,
  };
}

export async function buildOrderSheet(orderId) {
  const order = await Order.findById(orderId)
    .populate('customerId', 'fullName phone email')
    .populate('items.variantId', 'sku title color size imageUrl barcode');

  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  const itemsWithQr = await Promise.all(
    order.items.map(async (item) => {
      const variant = item.variantId;
      const sku = variant?.sku || item.sku;
      const codeValue = barcodeValueForVariant(variant || { sku });
      let barcodeDataUrl = null;
      try {
        const png = await bwipjs.toBuffer({
          bcid: 'code128',
          text: codeValue,
          scale: 2,
          height: 10,
          includetext: true,
          textxalign: 'center',
        });
        barcodeDataUrl = `data:image/png;base64,${png.toString('base64')}`;
      } catch {
        barcodeDataUrl = null;
      }
      return {
        sku,
        barcodeValue: codeValue,
        title: variant?.title || sku,
        color: variant?.color || '',
        size: variant?.size || '',
        quantity: item.quantity,
        unitSellingPrice: item.unitSellingPrice,
        barcodeDataUrl,
        qrDataUrl: barcodeDataUrl,
      };
    })
  );

  return {
    order: {
      ref: order.shopifyOrderId,
      placedAt: order.placedAt,
      totalSellingPrice: order.totalSellingPrice,
      shippingMethod: order.shippingMethod,
      isCreatorOrder: order.isCreatorOrder,
      bostaTrackingNumber: order.bostaTrackingNumber,
    },
    customer: {
      fullName: order.customerId?.fullName || order.shippingAddress?.fullName,
      phone: order.customerId?.phone || order.shippingAddress?.phone,
      email: order.customerId?.email,
    },
    shippingAddress: order.shippingAddress,
    items: itemsWithQr,
    logoBase64: getLogoBase64(),
  };
}

export default {
  pickAndPackOrder,
  ensureBostaDeliveryForOrder,
  prepareAwbForOrder,
  createBostaShipmentForOrder,
  getPickList,
  markOrderOutOfStock,
  getShipmentStatus,
  getAwbForOrder,
  checkStockAvailability,
  buildOrderSheet,
};
