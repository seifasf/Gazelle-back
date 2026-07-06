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

export async function listCustomers({ search, limit = 50, skip = 0 }) {
  const filter = {};
  if (search) {
    filter.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }
  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Customer.countDocuments(filter),
  ]);
  return { customers, total };
}

export default { findOrCreateCustomer, getCustomerById, getCustomerShopifyOrders, updateCustomerRiskFlag, listCustomers };
