import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import WebhookReceipt from '../models/WebhookReceipt.js';
import { withTransaction } from '../utils/transaction.js';
import { findOrCreateCustomer } from '../services/customer.service.js';
import { reserveStockForOrder, cancelOrder } from '../services/order.service.js';
import { notifyNewOrder } from '../services/notification.service.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import { reportOnlineStockDrift } from '../services/discrepancy.service.js';
import logger from '../utils/logger.js';

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

/** Map a Shopify order payload to an internal OMS status for historical imports. */
function mapImportedOrderStatus(payload) {
  if (payload.cancelled_at) return 'cancelled';
  if (payload.fulfillment_status === 'fulfilled') return 'delivered';
  return 'pending_verification';
}

/**
 * Infer Gazelle payment method from Shopify gateways / financial status.
 * Cash-on-delivery gateways (Bosta COD, manual COD, etc.) → cod; otherwise online.
 */
export function mapShopifyPaymentMethod(payload = {}) {
  const gateways = [
    ...(Array.isArray(payload.payment_gateway_names) ? payload.payment_gateway_names : []),
    payload.gateway,
    payload.payment_gateway,
  ]
    .filter(Boolean)
    .map((g) => String(g).toLowerCase());

  const joined = gateways.join(' ');
  const codHints = ['cod', 'cash on delivery', 'cash_on_delivery', 'bosta', 'manual'];
  if (codHints.some((h) => joined.includes(h))) return 'cod';

  // Paid online before fulfillment.
  if (payload.financial_status === 'paid' || payload.financial_status === 'partially_paid') {
    if (!joined || joined.includes('shopify_payments') || joined.includes('paymob') || joined.includes('stripe') || joined.includes('paypal')) {
      return 'online';
    }
    // Unknown gateway but marked paid → online
    if (!codHints.some((h) => joined.includes(h))) return 'online';
  }

  // Default Egypt storefront path is COD when unpaid / pending.
  if (payload.financial_status === 'pending' || payload.financial_status === 'authorized') {
    return 'cod';
  }

  return 'cod';
}

function mapShopifyShippingFee(payload = {}) {
  const fromSet = parseFloat(payload.total_shipping_price_set?.shop_money?.amount);
  if (Number.isFinite(fromSet)) return fromSet;
  const lines = payload.shipping_lines || [];
  const sum = lines.reduce((s, l) => s + (parseFloat(l.price) || 0), 0);
  return Number.isFinite(sum) ? sum : 0;
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
  const onlinePaid =
    paymentMethod === 'online' &&
    (payload.financial_status === 'paid' || payload.financial_status === 'partially_paid');

  const order = await withTransaction(async (session) => {
    const [created] = await Order.create(
      [
        {
          shopifyOrderId,
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
      await reserveStockForOrder(created._id, created.items, session);
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

    return created;
  });

  // Only alert on genuine real-time orders — bulk imports must not spam the feed.
  if (source === 'shopify_webhook' && internalStatus === 'pending_verification') {
    await notifyNewOrder(order, { source: 'shopify' });
  }

  return order;
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
