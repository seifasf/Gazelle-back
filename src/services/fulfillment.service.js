import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import bwipjs from 'bwip-js';
import { barcodeValueForVariant } from './barcode.service.js';
import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import { createDelivery, getAwb } from '../integrations/bosta/shipments.service.js';
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

/**
 * Create the Bosta delivery and move the order to picked_up_by_bosta.
 * Used synchronously from pick-pack so stock managers get immediate feedback
 * (Agenda queue alone can stall on free-tier / cold hosts).
 */
export async function createBostaShipmentForOrder(orderId, actorUserId) {
  const order = await Order.findById(orderId).populate('customerId');
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

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

  order.bostaShipmentStatus = 'creating';
  order.bostaShipmentError = null;
  if (actorUserId) order.assignedStockManagerId = actorUserId;
  await order.save();

  try {
    const result = await createDelivery(order, order.customerId);
    const deliveryId = result._id || result.id || result.data?._id;
    const trackingNumber = result.trackingNumber || result.tracking_number;

    order.bostaDeliveryId = deliveryId;
    order.bostaTrackingNumber = trackingNumber;
    order.bostaShipmentStatus = 'created';
    await order.save();

    await orderService.transitionOrderStatus(orderId, 'picked_up_by_bosta', {
      source: 'system',
      actorUserId,
      note: 'Bosta shipment created',
    });

    return {
      deliveryId,
      trackingNumber,
      orderId,
    };
  } catch (error) {
    order.bostaShipmentStatus = 'failed';
    order.bostaShipmentError = error.message;
    await order.save();
    logger.error({ err: error.message, orderId }, 'Bosta shipment create failed');
    throw error;
  }
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

  // Bosta — create shipment now so the stock manager sees success/failure immediately.
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
  return Order.find({ internalStatus: 'verified_ready_for_shipping' })
    .sort({ placedAt: 1 })
    .populate('customerId', 'fullName phone riskFlag lifetimeCancelled')
    .populate('items.variantId', 'sku title color size imageUrl');
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
  return getAwb(order.bostaDeliveryId);
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
  createBostaShipmentForOrder,
  getPickList,
  getShipmentStatus,
  getAwbForOrder,
  checkStockAvailability,
  buildOrderSheet,
};
