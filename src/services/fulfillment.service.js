import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';
import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import { getAwb } from '../integrations/bosta/shipments.service.js';
import orderService from '../services/order.service.js';

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
    await orderService.transitionOrderStatus(orderId, 'delivered', {
      source: 'user_action',
      actorUserId,
      note: 'Customer pickup',
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

  order.bostaShipmentStatus = 'queued';
  order.bostaShipmentError = null;
  order.assignedStockManagerId = actorUserId;
  await order.save();

  const agenda = getAgenda();
  await agenda.now(JOB_NAMES.BOSTA_CREATE_SHIPMENT, { orderId: orderId.toString(), actorUserId });

  return { queued: true, orderId, stockWarnings };
}

export async function getPickList() {
  return Order.find({ internalStatus: 'verified_ready_for_shipping' })
    .sort({ placedAt: 1 })
    .populate('customerId', 'fullName phone riskFlag');
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
  if (order?.shippingMethod === 'local_shipping') {
    const err = new Error('Local shipping orders do not have a Bosta AWB');
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
    .populate('items.variantId', 'sku title color size imageUrl');

  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  const itemsWithQr = await Promise.all(
    order.items.map(async (item) => {
      const variant = item.variantId;
      const sku = variant?.sku || item.sku;
      const qrDataUrl = await QRCode.toDataURL(sku, { width: 120, margin: 1 });
      return {
        sku,
        title: variant?.title || sku,
        color: variant?.color || '',
        size: variant?.size || '',
        quantity: item.quantity,
        unitSellingPrice: item.unitSellingPrice,
        qrDataUrl,
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
  getPickList,
  getShipmentStatus,
  getAwbForOrder,
  checkStockAvailability,
  buildOrderSheet,
};
