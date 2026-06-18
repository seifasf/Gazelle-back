import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import WebhookReceipt from '../models/WebhookReceipt.js';
import { withTransaction } from '../utils/transaction.js';
import { findOrCreateCustomer } from '../services/customer.service.js';
import { reserveStockForOrder, cancelOrder } from '../services/order.service.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import { reportOnlineStockDrift } from '../services/discrepancy.service.js';
import logger from '../utils/logger.js';

async function resolveVariant(lineItem) {
  const gid = lineItem.variant_id
    ? `gid://shopify/ProductVariant/${lineItem.variant_id}`
    : shopifyVariantId;

  let variant = await Variant.findOne({
    $or: [{ shopifyVariantId: gid }, { shopifyVariantId: String(lineItem.variant_id) }],
  });

  if (!variant && lineItem.sku) {
    variant = await Variant.findOne({ sku: lineItem.sku });
  }

  return variant;
}

export async function handleOrdersCreate(payload) {
  const shopifyOrderId = String(payload.id);
  const existing = await Order.findOne({ shopifyOrderId });
  if (existing) {
    logger.info({ shopifyOrderId }, 'Order already ingested');
    return existing;
  }

  const customerPayload = payload.customer || {};
  const shipping = payload.shipping_address || payload.billing_address || {};
  const shippingAddress = {
    fullName: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim() || 'Unknown',
    line1: shipping.address1 || '',
    line2: shipping.address2,
    city: shipping.city || '',
    zone: shipping.province || shipping.city,
    phone: shipping.phone || customerPayload.phone,
  };

  const customer = await findOrCreateCustomer({
    fullName:
      `${customerPayload.first_name || ''} ${customerPayload.last_name || ''}`.trim() ||
      shippingAddress.fullName,
    phone: customerPayload.phone || shipping.phone || 'unknown',
    email: customerPayload.email,
    shippingAddress,
  });

  const items = [];
  for (const line of payload.line_items || []) {
    const variant = await resolveVariant(line);
    if (!variant) {
      logger.warn({ sku: line.sku, variantId: line.variant_id }, 'Variant not found for line item');
      continue;
    }
    items.push({
      variantId: variant._id,
      sku: line.sku || variant.sku,
      quantity: line.quantity,
      unitSellingPrice: parseFloat(line.price) || variant.sellingPrice,
      unitCogs: variant.cogs,
    });
  }

  if (items.length === 0) {
    throw new Error('No resolvable line items for order');
  }

  return withTransaction(async (session) => {
    const [order] = await Order.create(
      [
        {
          shopifyOrderId,
          customerId: customer._id,
          shippingAddress,
          internalStatus: 'pending_verification',
          totalSellingPrice: parseFloat(payload.total_price) || 0,
          items,
          placedAt: new Date(payload.created_at || Date.now()),
        },
      ],
      { session }
    );

    await reserveStockForOrder(order._id, order.items, session);

    await OrderStatusHistory.create(
      [
        {
          orderId: order._id,
          fromStatus: null,
          toStatus: 'pending_verification',
          source: 'shopify_webhook',
          note: 'Order ingested from Shopify',
        },
      ],
      { session }
    );

    return order;
  });
}

export async function handleOrdersCancelled(payload) {
  const shopifyOrderId = String(payload.id);
  const order = await Order.findOne({ shopifyOrderId });
  if (!order) return null;

  return cancelOrder(order._id, null, {
    reason: 'customer_changed_mind',
    note: 'Cancelled via Shopify webhook',
    source: 'shopify_webhook',
  });
}

export async function handleOrdersUpdated(payload) {
  const shopifyOrderId = String(payload.id);
  const order = await Order.findOne({ shopifyOrderId });
  if (!order) return null;

  const shipping = payload.shipping_address;
  if (shipping) {
    order.shippingAddress = {
      fullName: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
      line1: shipping.address1 || order.shippingAddress.line1,
      line2: shipping.address2,
      city: shipping.city || order.shippingAddress.city,
      zone: shipping.province,
      phone: shipping.phone,
    };
    await order.save();
  }
  return order;
}

export async function handleProductsUpdate(payload) {
  const shopifyProductId = payload.admin_graphql_api_id || `gid://shopify/Product/${payload.id}`;
  const product = await Product.findOneAndUpdate(
    { shopifyProductId },
    {
      shopifyProductId,
      title: payload.title,
      status: payload.status === 'active' ? 'active' : payload.status,
      lastSyncedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  for (const variant of payload.variants || []) {
    const gid = variant.admin_graphql_api_id || `gid://shopify/ProductVariant/${variant.id}`;
    await Variant.findOneAndUpdate(
      { shopifyVariantId: gid },
      {
        productId: product._id,
        shopifyVariantId: gid,
        shopifyInventoryItemId: variant.inventory_item_id
          ? `gid://shopify/InventoryItem/${variant.inventory_item_id}`
          : '',
        sku: variant.sku || gid,
        title: variant.title || product.title,
        sellingPrice: parseFloat(variant.price) || 0,
        lastSyncedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  return product;
}

export async function handleInventoryLevelsUpdate(payload) {
  const inventoryItemId = payload.inventory_item_id
    ? `gid://shopify/InventoryItem/${payload.inventory_item_id}`
    : payload.admin_graphql_api_id;

  const variant = await Variant.findOne({ shopifyInventoryItemId: inventoryItemId });
  if (!variant) return null;

  const shopifyAvailable = payload.available ?? payload.available_adjustment;
  if (shopifyAvailable != null) {
    await reportOnlineStockDrift(variant._id, shopifyAvailable);
  }
  return variant;
}

export async function processShopifyWebhookJob({ receiptId, topic }) {
  const receipt = await WebhookReceipt.findById(receiptId);
  if (!receipt || receipt.processedAt) return;

  const payload = receipt.payload;
  let result;

  try {
    switch (topic) {
      case 'orders/create':
        result = await handleOrdersCreate(payload);
        break;
      case 'orders/cancelled':
        result = await handleOrdersCancelled(payload);
        break;
      case 'orders/updated':
        result = await handleOrdersUpdated(payload);
        break;
      case 'products/update':
        result = await handleProductsUpdate(payload);
        break;
      case 'inventory_levels/update':
        result = await handleInventoryLevelsUpdate(payload);
        break;
      case 'refunds/create':
        logger.info({ orderId: payload.order_id }, 'Refund webhook received — cross-check in OMS');
        result = { acknowledged: true };
        break;
      default:
        logger.warn({ topic }, 'Unhandled Shopify webhook topic');
    }

    receipt.processedAt = new Date();
    await receipt.save();
    return result;
  } catch (error) {
    receipt.error = error.message;
    await receipt.save();
    throw error;
  }
}

export default {
  handleOrdersCreate,
  handleOrdersCancelled,
  handleOrdersUpdated,
  handleProductsUpdate,
  handleInventoryLevelsUpdate,
  processShopifyWebhookJob,
};
