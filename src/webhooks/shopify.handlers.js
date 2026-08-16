import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import Settings from '../models/Settings.js';
import WebhookReceipt from '../models/WebhookReceipt.js';
import { withTransaction } from '../utils/transaction.js';
import { findOrCreateCustomer } from '../services/customer.service.js';
import { reserveStockForOrder, cancelOrder, syncShopifySellableAfterLedger, queueShopifyInventoryIngest } from '../services/order.service.js';
import { notifyNewOrder } from '../services/notification.service.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import { reportOnlineStockDrift } from '../services/discrepancy.service.js';
import logger from '../utils/logger.js';
import {
  mapShopifyPaymentMethod,
  mapShopifyShippingFee,
  applyShopifyMoneyFields,
  isShopifyOrderPaid,
} from '../integrations/shopify/orderMoney.js';

export { mapShopifyPaymentMethod, mapShopifyShippingFee };

async function resolveVariant(lineItem) {
  if (!lineItem.variant_id && !lineItem.sku) return null;

  const gid = lineItem.variant_id
    ? `gid://shopify/ProductVariant/${lineItem.variant_id}`
    : null;

  const orClauses = [];
  if (gid) {
    orClauses.push({ shopifyVariantId: gid }, { shopifyVariantId: String(lineItem.variant_id) });
  }

  let variant = orClauses.length
    ? await Variant.findOne({ $or: orClauses })
    : null;

  if (!variant && lineItem.sku) {
    variant = await Variant.findOne({ sku: lineItem.sku });
  }

  return variant;
}

function shopifyOrderNameFromPayload(payload = {}) {
  if (payload.name && String(payload.name).trim()) return String(payload.name).trim();
  if (payload.order_number != null && String(payload.order_number).trim()) {
    return `#${String(payload.order_number).trim()}`;
  }
  return null;
}

/** Map a Shopify order payload to an internal OMS status for historical imports. */
function mapImportedOrderStatus(payload) {
  if (payload.cancelled_at) return 'cancelled';
  // Shopify "fulfilled" is NOT delivery — OMS marks Shopify fulfilled on verify (cleanup).
  // Only treat as delivered when Shopify already closed the order (archived history).
  if (payload.closed_at && payload.fulfillment_status === 'fulfilled') return 'delivered';
  return 'pending_verification';
}

export async function handleOrdersCreate(payload, { reserveStock = true, statusOverride, source = 'shopify_webhook' } = {}) {
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
    shopifyCustomerId: customerPayload.id,
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

  const internalStatus = statusOverride || 'pending_verification';
  // Only hold stock for genuinely-open orders. Historical (delivered/cancelled)
  // imports must not distort warehouse on-hold inventory.
  const shouldReserve = reserveStock && internalStatus === 'pending_verification';
  const deliveredAt =
    internalStatus === 'delivered'
      ? new Date(payload.updated_at || payload.closed_at || payload.created_at || Date.now())
      : undefined;
  const paymentMethod = mapShopifyPaymentMethod(payload);
  const shippingFee = mapShopifyShippingFee(payload);
  const onlinePaid = paymentMethod === 'online' && isShopifyOrderPaid(payload);

  const order = await withTransaction(async (session) => {
    let ledgerDocs = [];
    const [created] = await Order.create(
      [
        {
          shopifyOrderId,
          ...(shopifyOrderNameFromPayload(payload)
            ? { shopifyOrderName: shopifyOrderNameFromPayload(payload) }
            : {}),
          customerId: customer._id,
          shippingAddress,
          shippingMethod: 'bosta',
          paymentMethod,
          shippingFee,
          ...(onlinePaid
            ? {
                onlinePaymentStatus: 'paid',
                onlinePaymentProvider: 'shopify',
                onlinePaymentAmount: parseFloat(payload.total_price) || 0,
                onlinePaidAt: new Date(payload.processed_at || payload.created_at || Date.now()),
              }
            : {}),
          internalStatus,
          totalSellingPrice: Math.max(
            0,
            (parseFloat(payload.total_price) || 0) - shippingFee
          ),
          items,
          placedAt: new Date(payload.created_at || Date.now()),
          ...(deliveredAt ? { deliveredAt } : {}),
        },
      ],
      { session }
    );

    if (shouldReserve) {
      ledgerDocs = await reserveStockForOrder(created._id, created.items, session);
    }

    await OrderStatusHistory.create(
      [
        {
          orderId: created._id,
          fromStatus: null,
          toStatus: internalStatus,
          source,
          note: source === 'shopify_import' ? 'Imported from Shopify' : 'Order ingested from Shopify',
        },
      ],
      { session }
    );

    return { order: created, ledgerDocs };
  });

  await syncShopifySellableAfterLedger(order.ledgerDocs);

  // Only alert on genuine real-time orders — bulk imports must not spam the feed.
  if (source === 'shopify_webhook' && internalStatus === 'pending_verification') {
    await notifyNewOrder(order.order, { source: 'shopify' });
  }

  return order.order;
}

export async function handleOrdersCancelled(payload) {
  const shopifyOrderId = String(payload.id);
  const order = await Order.findOne({ shopifyOrderId });
  if (!order) return null;
  // Already cancelled in Gazelle (e.g. staff cancel that also cancelled Shopify).
  if (order.internalStatus === 'cancelled') return order;

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

  // Shopify cancel is authoritative when staff cancel in Admin.
  if (payload.cancelled_at && order.internalStatus !== 'cancelled') {
    try {
      return await cancelOrder(order._id, null, {
        reason: 'customer_changed_mind',
        note: 'Cancelled via Shopify order update',
        source: 'shopify_webhook',
      });
    } catch (err) {
      logger.warn(
        { err: err?.message || err, shopifyOrderId, status: order.internalStatus },
        'Shopify cancel could not apply to OMS order'
      );
    }
  }

  const name = shopifyOrderNameFromPayload(payload);
  if (name && order.shopifyOrderName !== name) {
    order.shopifyOrderName = name;
  }

  // Sync shipping fee from Shopify (city / zone rates) + paid → online (Bosta COD = 0).
  applyShopifyMoneyFields(order, payload);

  const shipping = payload.shipping_address;
  if (shipping) {
    const fullName = `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim();
    const prev = order.shippingAddress?.toObject?.() || order.shippingAddress || {};
    order.shippingAddress = {
      fullName: fullName || prev.fullName || 'Customer',
      line1: shipping.address1 || prev.line1,
      line2: shipping.address2 != null ? shipping.address2 : prev.line2,
      city: shipping.city || prev.city,
      zone: shipping.province || prev.zone,
      phone: shipping.phone || prev.phone,
    };
  }
  await order.save();

  // Do NOT map Shopify "fulfilled" → OMS delivered.
  // Shopify fulfillment is verify cleanup only (markShopifyOrderFulfilled on confirm).
  // Bosta (or local/pickup confirmation in OMS) is the source of truth for delivery.

  return order;
}

export async function handleProductsUpdate(payload) {
  const shopifyProductId = payload.admin_graphql_api_id || `gid://shopify/Product/${payload.id}`;
  const productImage = payload.image?.src || payload.images?.[0]?.src;

  const product = await Product.findOneAndUpdate(
    { shopifyProductId },
    {
      shopifyProductId,
      title: payload.title,
      handle: payload.handle,
      vendor: payload.vendor,
      productType: payload.product_type,
      imageUrl: productImage,
      status: payload.status === 'active' ? 'active' : payload.status,
      lastSyncedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  for (const variant of payload.variants || []) {
    const gid = variant.admin_graphql_api_id || `gid://shopify/ProductVariant/${variant.id}`;
    const color = variant.option1 || variant.option2;
    const size = variant.option2 && variant.option1 ? variant.option2 : variant.option3;
    await Variant.findOneAndUpdate(
      { shopifyVariantId: gid },
      {
        productId: product._id,
        shopifyVariantId: gid,
        shopifyInventoryItemId: variant.inventory_item_id
          ? `gid://shopify/InventoryItem/${variant.inventory_item_id}`
          : '',
        sku: variant.sku || gid,
        barcode: variant.barcode || '',
        title: variant.title || product.title,
        color: color || undefined,
        size: size || undefined,
        imageUrl: variant.image_id ? productImage : product.imageUrl,
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

  const settings = await Settings.findOne({ key: 'global' }).select('shopifyLocationId').lean();
  const configuredLocation = String(settings?.shopifyLocationId || '')
    .replace(/^gid:\/\/shopify\/Location\//, '');
  const incomingLocation = payload.location_id != null
    ? String(payload.location_id).replace(/^gid:\/\/shopify\/Location\//, '')
    : '';
  if (configuredLocation && incomingLocation && incomingLocation !== configuredLocation) {
    logger.info(
      { sku: variant.sku, incomingLocation, configuredLocation },
      'Ignoring Shopify inventory update from a non-warehouse location'
    );
    return variant;
  }

  const shopifyAvailable =
    payload.available != null
      ? payload.available
      : payload.available_adjustment != null && variant.onlineStock != null
        ? Number(variant.onlineStock) + Number(payload.available_adjustment)
        : null;

  if (shopifyAvailable == null || !Number.isFinite(Number(shopifyAvailable))) {
    return variant;
  }

  try {
    await queueShopifyInventoryIngest(variant._id, shopifyAvailable);
  } catch (err) {
    logger.warn(
      { err: err?.message || err, sku: variant.sku, shopifyAvailable },
      'Shopify inventory ingest failed'
    );
    await reportOnlineStockDrift(variant._id, shopifyAvailable).catch(() => null);
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

export { mapImportedOrderStatus };

export default {
  handleOrdersCreate,
  mapImportedOrderStatus,
  handleOrdersCancelled,
  handleOrdersUpdated,
  handleProductsUpdate,
  handleInventoryLevelsUpdate,
  processShopifyWebhookJob,
};
