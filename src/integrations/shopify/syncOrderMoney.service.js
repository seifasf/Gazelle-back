import Order from '../../models/Order.js';
import { shopifyRest } from './client.js';
import { applyShopifyMoneyFields } from './orderMoney.js';
import logger from '../../utils/logger.js';

/**
 * Pull latest Shopify shipping fee (by city/zone) + payment status onto the OMS order.
 * Ensures Bosta AWB COD = 0 for paid orders and COD includes the correct shipping fee.
 */
export async function syncShopifyMoneyOntoOrder(order) {
  if (!order?.shopifyOrderId || order.orderSource === 'manual') {
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
    };

    applyShopifyMoneyFields(order, payload);
    await order.save();

    logger.info(
      {
        orderId: String(order._id),
        name: order.shopifyOrderName,
        before,
        after: {
          shippingFee: order.shippingFee,
          paymentMethod: order.paymentMethod,
          onlinePaymentStatus: order.onlinePaymentStatus,
        },
        city: order.shippingAddress?.city,
      },
      'Synced Shopify shipping/payment onto order before Bosta'
    );

    return order;
  } catch (err) {
    logger.warn(
      { err: err.message, orderId: String(order._id), shopifyOrderId: order.shopifyOrderId },
      'Could not sync Shopify money fields — using OMS values'
    );
    return order;
  }
}

export async function syncShopifyMoneyByOrderId(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return null;
  return syncShopifyMoneyOntoOrder(order);
}

export default { syncShopifyMoneyOntoOrder, syncShopifyMoneyByOrderId };
