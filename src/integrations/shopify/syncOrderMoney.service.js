import Order from '../../models/Order.js';
import { shopifyRest } from './client.js';
import { applyShopifyMoneyFields } from './orderMoney.js';
import { isManualOrderRef } from '../../utils/orderRefs.js';
import logger from '../../utils/logger.js';

/**
 * Copy Shopify shipping_address onto the OMS order (ship-to name/phone/street/city).
 * Bosta receiver must match this — not the Shopify customer account name.
 */
export function applyShopifyShippingAddress(order, payload) {
  const shipping = payload?.shipping_address || payload?.billing_address;
  if (!shipping) return false;

  const fullName = `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim();
  const prev = order.shippingAddress?.toObject?.() || order.shippingAddress || {};

  order.shippingAddress = {
    fullName: fullName || prev.fullName || 'Customer',
    line1: String(shipping.address1 || prev.line1 || '').trim(),
    line2:
      shipping.address2 != null && String(shipping.address2).trim() !== ''
        ? String(shipping.address2).trim()
        : prev.line2 || undefined,
    city: String(shipping.city || prev.city || '').trim(),
    zone: shipping.province || prev.zone || undefined,
    phone: shipping.phone || prev.phone || undefined,
  };
  return true;
}

/**
 * Pull latest Shopify money + shipping onto the OMS order before Bosta AWB.
 * Ensures receiver / address / COD match Shopify at print time.
 */
export async function syncShopifyMoneyOntoOrder(order) {
  if (!order?.shopifyOrderId || order.orderSource === 'manual' || isManualOrderRef(order.shopifyOrderId)) {
    return order;
  }

  try {
    const data = await shopifyRest(`/orders/${order.shopifyOrderId}.json`);
    const payload = data?.order;
    if (!payload) return order;

    const before = {
      shippingFee: order.shippingFee,
      paymentMethod: order.paymentMethod,
      onlinePaymentStatus: order.onlinePaymentStatus,
      shipTo: order.shippingAddress?.fullName,
      phone: order.shippingAddress?.phone,
      city: order.shippingAddress?.city,
      line1: order.shippingAddress?.line1,
    };

    applyShopifyMoneyFields(order, payload);
    applyShopifyShippingAddress(order, payload);
    await order.save();

    logger.info(
      {
        orderId: String(order._id),
        name: order.shopifyOrderName || payload.name,
        before,
        after: {
          shippingFee: order.shippingFee,
          paymentMethod: order.paymentMethod,
          onlinePaymentStatus: order.onlinePaymentStatus,
          shipTo: order.shippingAddress?.fullName,
          phone: order.shippingAddress?.phone,
          city: order.shippingAddress?.city,
          line1: order.shippingAddress?.line1,
        },
      },
      'Synced Shopify shipping + payment onto order before Bosta'
    );

    return order;
  } catch (err) {
    logger.warn(
      { err: err.message, orderId: String(order._id), shopifyOrderId: order.shopifyOrderId },
      'Could not sync Shopify fields — using OMS values'
    );
    return order;
  }
}

export async function syncShopifyMoneyByOrderId(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return null;
  return syncShopifyMoneyOntoOrder(order);
}

export default {
  applyShopifyShippingAddress,
  syncShopifyMoneyOntoOrder,
  syncShopifyMoneyByOrderId,
};
