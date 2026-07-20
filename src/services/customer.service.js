import Customer from '../models/Customer.js';
import Order from '../models/Order.js';
import { shopifyRest } from '../integrations/shopify/client.js';
import { isShopifyConfigured } from '../integrations/shopify/credentials.js';
import logger from '../utils/logger.js';

export async function findOrCreateCustomer({ fullName, phone, email, shopifyCustomerId, shippingAddress }) {
  let customer = shopifyCustomerId
    ? await Customer.findOne({ shopifyCustomerId: String(shopifyCustomerId) })
    : null;
  if (!customer) customer = await Customer.findOne({ phone, fullName });

  if (!customer) {
    customer = await Customer.create({
      fullName,
      phone,
      email,
      shopifyCustomerId: shopifyCustomerId ? String(shopifyCustomerId) : undefined,
      addresses: shippingAddress
        ? [
            {
              label: 'Shipping',
              line1: shippingAddress.line1,
              line2: shippingAddress.line2,
              city: shippingAddress.city,
              zone: shippingAddress.zone,
              isDefault: true,
            },
          ]
        : [],
    });
  } else {
    const patch = {};
    if (email && !customer.email) patch.email = email;
    if (shopifyCustomerId && !customer.shopifyCustomerId) patch.shopifyCustomerId = String(shopifyCustomerId);
    if (Object.keys(patch).length) {
      Object.assign(customer, patch);
      await customer.save();
    }
  }

  await Customer.updateOne({ _id: customer._id }, { $inc: { lifetimeOrders: 1 } });
  return customer;
}

/**
 * Fetch the FULL order history a customer made directly from Shopify (read-only).
 * Falls back to the orders stored locally in the OMS when the customer isn't
 * linked to a Shopify customer id or Shopify isn't reachable.
 */
export async function getCustomerShopifyOrders(customerId) {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    const err = new Error('Customer not found');
    err.statusCode = 404;
    throw err;
  }

  if (customer.shopifyCustomerId && (await isShopifyConfigured())) {
    try {
      const data = await shopifyRest(
        `/customers/${customer.shopifyCustomerId}/orders.json?status=any&limit=100`
      );
      const orders = (data.orders || []).map((o) => ({
        shopifyOrderId: String(o.id),
        name: o.name,
        totalPrice: parseFloat(o.total_price) || 0,
        currency: o.currency,
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status || 'unfulfilled',
        cancelledAt: o.cancelled_at,
        createdAt: o.created_at,
        lineItemCount: (o.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0),
      }));
      return { source: 'shopify', orders };
    } catch (err) {
      logger.warn({ err, customerId }, 'Shopify customer order history fetch failed — using local');
    }
  }

  const local = await Order.find({ customerId })
    .sort({ placedAt: -1 })
    .select('shopifyOrderId internalStatus totalSellingPrice placedAt');
  return {
    source: 'local',
    orders: local.map((o) => ({
      shopifyOrderId: o.shopifyOrderId,
      name: `#${o.shopifyOrderId}`,
      totalPrice: o.totalSellingPrice,
      internalStatus: o.internalStatus,
      createdAt: o.placedAt,
    })),
  };
}

export async function getCustomerById(customerId) {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    const err = new Error('Customer not found');
    err.statusCode = 404;
    throw err;
  }

  const orders = await Order.find({ customerId })
    .sort({ placedAt: -1 })
    .limit(20)
    .select('shopifyOrderId internalStatus totalSellingPrice placedAt deliveredAt');

  const deliveryReliabilityScore =
    customer.lifetimeOrders > 0
      ? Math.round((customer.lifetimeDelivered / customer.lifetimeOrders) * 100)
      : null;

  return { customer, orders, deliveryReliabilityScore };
}

export async function updateCustomerRiskFlag(customerId, riskFlag) {
  return Customer.findByIdAndUpdate(customerId, { riskFlag }, { new: true });
}

/** Threshold: more than 2 cancellations → show cancel-risk flag. */
export const FREQUENT_CANCEL_THRESHOLD = 2;

/**
 * Increment cancel count and auto-flag customers who cancel more than twice.
 * Does not downgrade vip / high_risk.
 */
export async function recordCustomerCancellation(customerId, session) {
  const customer = await Customer.findByIdAndUpdate(
    customerId,
    { $inc: { lifetimeCancelled: 1, lifetimeRejectedOrReturned: 1 } },
    { new: true, session }
  );
  if (!customer) return null;

  if (
    customer.lifetimeCancelled > FREQUENT_CANCEL_THRESHOLD &&
    (!customer.riskFlag || customer.riskFlag === 'none')
  ) {
    customer.riskFlag = 'watch';
    await customer.save({ session });
  }

  return customer;
}

/** VIP = more than 4 lifetime orders from the brand. */
export const VIP_ORDER_THRESHOLD = 4;

/**
 * Build Mongo filter for customer segments derived from order history:
 * - green: received deliveries well (delivered > 0, cancels ≤ 2)
 * - red: cancel / delivery risk (cancels > 2, rejects ≥ delivered when ordered, or high_risk)
 * - vip: lifetimeOrders > 4
 */
export function buildCustomerSegmentFilter(segment) {
  if (!segment || segment === 'all') return null;
  if (segment === 'vip') {
    return { lifetimeOrders: { $gt: VIP_ORDER_THRESHOLD } };
  }
  if (segment === 'green') {
    return {
      lifetimeDelivered: { $gte: 1 },
      lifetimeCancelled: { $lte: FREQUENT_CANCEL_THRESHOLD },
    };
  }
  if (segment === 'red') {
    return {
      $or: [
        { lifetimeCancelled: { $gt: FREQUENT_CANCEL_THRESHOLD } },
        { riskFlag: 'high_risk' },
        {
          $expr: {
            $and: [
              { $gt: ['$lifetimeOrders', 0] },
              { $gte: ['$lifetimeRejectedOrReturned', '$lifetimeDelivered'] },
            ],
          },
        },
      ],
    };
  }
  return null;
}

export async function listCustomers({ search, riskFlag, segment, limit = 50, skip = 0 }) {
  const parts = [];
  if (search) {
    parts.push({
      $or: [
        { fullName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ],
    });
  }
  if (riskFlag && riskFlag !== 'all') parts.push({ riskFlag });
  const segmentFilter = buildCustomerSegmentFilter(segment);
  if (segmentFilter) parts.push(segmentFilter);

  const filter = parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(Number(skip) || 0).limit(Number(limit) || 50),
    Customer.countDocuments(filter),
  ]);
  return { customers, total };
}

export default {
  findOrCreateCustomer,
  getCustomerById,
  getCustomerShopifyOrders,
  updateCustomerRiskFlag,
  recordCustomerCancellation,
  listCustomers,
  buildCustomerSegmentFilter,
  FREQUENT_CANCEL_THRESHOLD,
  VIP_ORDER_THRESHOLD,
};
