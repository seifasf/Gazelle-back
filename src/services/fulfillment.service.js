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
} from '../integrations/bosta/shipments.service.js';
import orderService from '../services/order.service.js';
import logger from '../utils/logger.js';

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
  const order = await Order.findById(orderId).populate('customerId');
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  assertBostaShipable(order);

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
        await updateDeliveryPackageDescription(order.bostaDeliveryId, order);
      } catch (err) {
        logger.warn(
          { err: err.message, orderId, deliveryId: order.bostaDeliveryId },
          'Could not refresh Bosta package description'
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

    claimed.bostaDeliveryId = deliveryId;
    claimed.bostaTrackingNumber = trackingNumber;
    claimed.bostaShipmentStatus = 'created';
    await claimed.save();

    return {
      deliveryId,
      trackingNumber,
      orderId,
      created: true,
    };
  } catch (error) {
    claimed.bostaShipmentStatus = 'failed';
    claimed.bostaShipmentError = error.message;
    await claimed.save();
    logger.error({ err: error.message, orderId }, 'Bosta shipment create failed');
    throw error;
  }
}

/**
 * Ensure Bosta delivery exists, then fetch the AWB (بوليصة) PDF URL.
 */
export async function prepareAwbForOrder(orderId, actorUserId) {
  const shipment = await ensureBostaDeliveryForOrder(orderId, actorUserId);
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
 * Create the Bosta delivery (if needed) and move the order to picked_up_by_bosta.
 * Used by pick-pack and the Agenda job.
 */
export async function createBostaShipmentForOrder(orderId, actorUserId) {
  const shipment = await ensureBostaDeliveryForOrder(orderId, actorUserId);

  await orderService.transitionOrderStatus(orderId, 'picked_up_by_bosta', {
    source: 'system',
    actorUserId,
    note: shipment.created ? 'Bosta shipment created' : 'Bosta shipment confirmed for pickup',
  });

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

  const stockWarnings = await checkStockAvailability(order);

  if (order.shippingMethod === 'pickup') {
    order.assignedStockManagerId = actorUserId;
    await order.save();
    await orderService.transitionOrderStatus(orderId, 'delivered', {
      source: 'user_action',
      actorUserId,
      note: 'Customer pickup — scanned & handed over by stock manager',
    });
    return { queued: false, pickup: true, orderId, stockWarnings };
  }

  if (order.shippingMethod === 'local_shipping') {
    order.localShippingMarkedAt = new Date();
    order.localShippingNote = order.localShippingNote || 'Marked ready for local delivery';
    order.assignedStockManagerId = actorUserId;
    await order.save();

    await orderService.transitionOrderStatus(orderId, 'picked_up_by_bosta', {
      source: 'user_action',
      actorUserId,
      note: 'Handed to local shipping',
    });

    return { queued: false, localShipping: true, orderId, stockWarnings };
  }

  // Bosta — reuse delivery from print-policy step when present; otherwise create + transition.
  try {
    const shipment = await createBostaShipmentForOrder(orderId, actorUserId);
    return {
      queued: false,
      bosta: true,
      orderId,
      deliveryId: shipment.deliveryId,
      trackingNumber: shipment.trackingNumber,
      stockWarnings,
    };
  } catch (error) {
    const err = new Error(error.message || 'Failed to create Bosta shipment');
    err.statusCode = error.statusCode || 502;
    err.stockWarnings = stockWarnings;
    throw err;
  }
}

export async function getPickList() {
  const { ORDERS_PLACED_FROM_YMD } = await import('../constants/index.js');
  const cutoff = new Date(`${ORDERS_PLACED_FROM_YMD}T00:00:00+03:00`);
  return Order.find({
    internalStatus: 'verified_ready_for_shipping',
    placedAt: { $gte: cutoff },
  })
    .sort({ placedAt: 1 })
    .populate('customerId', 'fullName phone riskFlag lifetimeCancelled')
    .populate({
      path: 'items.variantId',
      select: 'sku title color size imageUrl productId',
      populate: { path: 'productId', select: 'title' },
    });
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
  getShipmentStatus,
  getAwbForOrder,
  checkStockAvailability,
  buildOrderSheet,
};
