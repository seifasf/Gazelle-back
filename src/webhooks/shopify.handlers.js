import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import Settings from '../models/Settings.js';
import WebhookReceipt from '../models/WebhookReceipt.js';
import { withTransaction } from '../utils/transaction.js';
import { findOrCreateCustomer } from '../services/customer.service.js';
import Customer from '../models/Customer.js';
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
import { isCodFeeLine, shopifyMerchandiseTotal } from '../utils/shopifyPaymentIncentives.js';
import {
  hasCompleteShopifyAddress,
  mapShopifyShippingAddress,
  applyKnownCustomerContact,
  shopifyCustomerPhone,
  isPlaceholderCustomerName,
  isPlaceholderPhone,
  isPlaceholderStreet,
} from '../utils/shopifyShippingAddress.js';

export { mapShopifyPaymentMethod, mapShopifyShippingFee };

/**
 * Webhooks on Basic/unapproved apps often omit PII. After switching to an
 * approved Partner app token, Admin GraphQL can still return name/phone/street
 * — backfill placeholders so OMS does not stay on "Address not available".
 */
async function enrichContactFromShopifyGraphql(payload, shippingAddress) {
  const needsName = isPlaceholderCustomerName(shippingAddress?.fullName);
  const needsPhone = isPlaceholderPhone(shippingAddress?.phone);
  const needsStreet = isPlaceholderStreet(shippingAddress?.line1);
  const needsCity = !String(shippingAddress?.city || '').trim() || shippingAddress?.city === 'Unknown';
  if (!needsName && !needsPhone && !needsStreet && !needsCity) return shippingAddress;

  try {
    const { shopifyGraphQL } = await import('../integrations/shopify/client.js');
    const gid = payload.admin_graphql_api_id || `gid://shopify/Order/${payload.id}`;
    const res = await shopifyGraphQL(
      `query ($id: ID!) {
        order(id: $id) {
          phone
          email
          shippingAddress {
            name firstName lastName phone
            address1 address2 city province country zip
          }
          billingAddress {
            name firstName lastName phone
            address1 address2 city province country zip
          }
          customer { firstName lastName phone email }
        }
      }`,
      { id: gid }
    );
    const order = res?.order;
    if (!order) return shippingAddress;

    const ship = order.shippingAddress || {};
    const bill = order.billingAddress || {};
    const cust = order.customer || {};
    const next = { ...shippingAddress };

    if (needsName) {
      const fullName =
        String(ship.name || '').trim() ||
        `${ship.firstName || ''} ${ship.lastName || ''}`.trim() ||
        String(bill.name || '').trim() ||
        `${bill.firstName || ''} ${bill.lastName || ''}`.trim() ||
        `${cust.firstName || ''} ${cust.lastName || ''}`.trim();
      if (fullName) next.fullName = fullName;
    }

    if (needsPhone) {
      const phone =
        String(ship.phone || '').trim() ||
        String(bill.phone || '').trim() ||
        String(order.phone || '').trim() ||
        String(cust.phone || '').trim();
      if (phone) next.phone = phone;
    }

    if (needsStreet) {
      const line1 = String(ship.address1 || bill.address1 || '').trim();
      if (line1) {
        next.line1 = line1;
        next.line2 = ship.address2 || bill.address2 || next.line2;
      }
    }

    const city = String(ship.city || bill.city || '').trim();
    if (city && needsCity) {
      next.city = city;
      next.zone = ship.province || bill.province || next.zone;
    } else if (city && (!next.city || next.city === 'Unknown')) {
      next.city = city;
      next.zone = ship.province || bill.province || next.zone;
    }

    return next;
  } catch (err) {
    logger.warn(
      { err: err?.message || err, shopifyOrderId: payload?.id },
      'Shopify contact enrich skipped'
    );
  }
  return shippingAddress;
}

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
  let shippingAddress = mapShopifyShippingAddress(payload);
  shippingAddress = await enrichContactFromShopifyGraphql(payload, shippingAddress);

  let customer;
  try {
    customer = await findOrCreateCustomer({
      fullName:
        `${customerPayload.first_name || ''} ${customerPayload.last_name || ''}`.trim() ||
        shippingAddress.fullName,
      phone: shopifyCustomerPhone(payload, shippingAddress),
      email: customerPayload.email,
      shopifyCustomerId: customerPayload.id,
      shippingAddress: hasCompleteShopifyAddress(payload) ? shippingAddress : null,
    });
  } catch (err) {
    logger.warn({ err: err?.message || err, shopifyOrderId }, 'Customer create failed — using fallback customer');
    customer = await Customer.findOne({ shopifyCustomerId: String(customerPayload.id || '') });
    if (!customer) {
      customer = await Customer.create({
        fullName: shippingAddress.fullName || 'Unknown',
        phone: shopifyCustomerPhone(payload, shippingAddress),
        shopifyCustomerId: customerPayload.id ? String(customerPayload.id) : undefined,
        addresses: [],
      });
    }
  }

  shippingAddress = applyKnownCustomerContact(shippingAddress, customer);

  const items = [];
  for (const line of payload.line_items || []) {
    if (isCodFeeLine(line)) continue;
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
    logger.error(
      {
        shopifyOrderId,
        name: shopifyOrderNameFromPayload(payload),
        skus: (payload.line_items || []).map((l) => l.sku || l.title),
      },
      'Shopify order has no catalog variants — ingesting anyway so it still appears in OMS'
    );
  }

  const internalStatus = statusOverride || 'pending_verification';
  // Only hold stock for genuinely-open orders. Historical (delivered/cancelled)
  // imports must not distort warehouse on-hold inventory.
  const shouldReserve = reserveStock && internalStatus === 'pending_verification' && items.length > 0;
  const deliveredAt =
    internalStatus === 'delivered'
      ? new Date(payload.updated_at || payload.closed_at || payload.created_at || Date.now())
      : undefined;
  const paymentMethod = mapShopifyPaymentMethod(payload);
  const shippingFee = mapShopifyShippingFee(payload);
  const onlinePaid = paymentMethod === 'online' && isShopifyOrderPaid(payload);

  let order;
  try {
  order = await withTransaction(async (session) => {
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
          totalSellingPrice: shopifyMerchandiseTotal(payload, shippingFee),
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
          note: source === 'shopify_import'
            ? 'Imported from Shopify'
            : hasCompleteShopifyAddress(payload)
              ? 'Order ingested from Shopify'
              : 'Order ingested from Shopify — street/phone withheld (Shopify PII). Confirm address on verification call.',
        },
      ],
      { session }
    );

    return { order: created, ledgerDocs };
  });
  } catch (err) {
    logger.error(
      { err: err?.message || err, shopifyOrderId, name: shopifyOrderNameFromPayload(payload) },
      'Shopify ingest transaction failed — creating a stub so the order still appears'
    );
    const existing = await Order.findOne({ shopifyOrderId });
    if (existing) return existing;
    const stub = await Order.create({
      shopifyOrderId,
      ...(shopifyOrderNameFromPayload(payload)
        ? { shopifyOrderName: shopifyOrderNameFromPayload(payload) }
        : {}),
      customerId: customer._id,
      shippingAddress,
      shippingMethod: 'bosta',
      paymentMethod,
      shippingFee: Number.isFinite(Number(shippingFee)) ? shippingFee : 0,
      internalStatus: 'pending_verification',
      totalSellingPrice: Number(shopifyMerchandiseTotal(payload, shippingFee)) || 0,
      items,
      placedAt: new Date(payload.created_at || Date.now()),
    });
    order = { order: stub, ledgerDocs: [] };
  }

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
  let order = await Order.findOne({ shopifyOrderId });
  if (!order) {
    return handleOrdersCreate(payload, { source: 'shopify_webhook' });
  }

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

  const current = order.shippingAddress?.toObject?.() || order.shippingAddress || {};
  if (
    isPlaceholderCustomerName(current.fullName) ||
    isPlaceholderPhone(current.phone) ||
    isPlaceholderStreet(current.line1)
  ) {
    order.shippingAddress = await enrichContactFromShopifyGraphql(payload, current);
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
    const sku = String(variant.sku || '').trim();
    if (!sku) {
      await Variant.deleteOne({ shopifyVariantId: gid });
      continue;
    }
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
        sku,
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
    if (topic === 'orders/create' || topic === 'orders/updated') {
      logger.error({ err: error.message, topic, name: payload?.name }, 'Shopify order webhook failed — will retry on sync');
      return null;
    }
    throw error;
  }
}

export async function retryFailedShopifyOrderCreates({ limit = 40 } = {}) {
  const receipts = await WebhookReceipt.find({
    source: 'shopify',
    topic: { $in: ['orders/create', 'orders/updated'] },
    $or: [{ processedAt: { $exists: false } }, { processedAt: null }],
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  let recovered = 0;
  for (const receipt of receipts) {
    try {
      await handleOrdersCreate(receipt.payload, { source: 'shopify_import' });
      receipt.processedAt = new Date();
      receipt.error = undefined;
      await receipt.save();
      recovered += 1;
    } catch (err) {
      receipt.error = err.message;
      await receipt.save();
    }
  }
  if (recovered) logger.info({ recovered, scanned: receipts.length }, 'Retried failed Shopify order webhooks');
  return { recovered, scanned: receipts.length };
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
  retryFailedShopifyOrderCreates,
};
