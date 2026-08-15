import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import { shopifyRest } from '../integrations/shopify/client.js';
import { isShopifyConfigured } from '../integrations/shopify/credentials.js';
import logger from '../utils/logger.js';
import { isManualOrderRef } from '../utils/orderRefs.js';
import { normalizeEgPhoneDigits, phoneMatchRegexes } from '../utils/phone.js';
import { resolveGender } from '../utils/gender.js';
import { workbookBuffer, styleHeaderRow } from '../utils/excelExport.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasOrderItemFilters(q = {}) {
  return Boolean(
    q.size ||
      q.color ||
      q.sku ||
      q.productId ||
      q.productSearch ||
      q.itemSearch ||
      q.orderStatus ||
      q.placedFrom ||
      q.placedTo ||
      q.shippingMethod
  );
}

/**
 * Resolve customer IDs that ordered matching variants / order criteria.
 * Size/color/sku/product filters join Order.items → Variant (+ Product title).
 */
export async function findCustomerIdsByOrderFilters({
  size,
  color,
  sku,
  productId,
  productSearch,
  itemSearch,
  orderStatus,
  placedFrom,
  placedTo,
  shippingMethod,
} = {}) {
  const orderMatch = { customerId: { $ne: null } };
  if (orderStatus && orderStatus !== 'all') orderMatch.internalStatus = String(orderStatus);
  if (shippingMethod && shippingMethod !== 'all') orderMatch.shippingMethod = String(shippingMethod);
  if (placedFrom || placedTo) {
    orderMatch.placedAt = {};
    if (placedFrom) orderMatch.placedAt.$gte = new Date(placedFrom);
    if (placedTo) {
      const end = new Date(placedTo);
      if (!Number.isNaN(end.getTime())) {
        end.setHours(23, 59, 59, 999);
        orderMatch.placedAt.$lte = end;
      }
    }
  }

  const variantNeeds =
    Boolean(size) || Boolean(color) || Boolean(sku) || Boolean(productId) || Boolean(productSearch) || Boolean(itemSearch);

  if (variantNeeds) {
    const variantFilter = {};
    if (size) variantFilter.size = String(size).trim();
    if (color) variantFilter.color = { $regex: `^${escapeRegex(String(color).trim())}$`, $options: 'i' };
    if (sku) variantFilter.sku = { $regex: escapeRegex(String(sku).trim()), $options: 'i' };
    if (productId && mongoose.Types.ObjectId.isValid(productId)) {
      variantFilter.productId = new mongoose.Types.ObjectId(productId);
    }

    const text = String(productSearch || itemSearch || '').trim();
    if (text) {
      const regex = { $regex: escapeRegex(text), $options: 'i' };
      const products = await Product.find({ title: regex }).select('_id').lean();
      const productIds = products.map((p) => p._id);
      const textOr = [{ sku: regex }];
      if (productIds.length) textOr.push({ productId: { $in: productIds } });
      variantFilter.$or = textOr;
    }

    const variants = await Variant.find(variantFilter).select('_id').lean();
    if (!variants.length) return [];
    orderMatch['items.variantId'] = { $in: variants.map((v) => v._id) };
  }

  const ids = await Order.distinct('customerId', orderMatch);
  return ids.filter(Boolean);
}

async function findCustomerIdsByCity(city) {
  const term = String(city || '').trim();
  if (!term) return null;
  const regex = { $regex: escapeRegex(term), $options: 'i' };
  const [fromAddresses, fromOrders] = await Promise.all([
    Customer.distinct('_id', { 'addresses.city': regex }),
    Order.distinct('customerId', { 'shippingAddress.city': regex }),
  ]);
  const set = new Set([...fromAddresses, ...fromOrders].map(String));
  return [...set].map((id) => new mongoose.Types.ObjectId(id));
}

function buildCustomerFieldParts(query = {}) {
  const {
    search,
    riskFlag,
    segment,
    minOrders,
    maxOrders,
    minDelivered,
    maxDelivered,
    hasEmail,
  } = query;
  const parts = [];

  if (search) {
    const term = String(search).trim();
    const regex = { $regex: escapeRegex(term), $options: 'i' };
    const phoneOr = phoneMatchRegexes(term).map((re) => ({ phone: { $regex: re } }));
    parts.push({
      $or: [{ fullName: regex }, { phone: regex }, { email: regex }, ...phoneOr],
    });
  }
  if (riskFlag && riskFlag !== 'all') parts.push({ riskFlag });
  const segmentFilter = buildCustomerSegmentFilter(segment);
  if (segmentFilter) parts.push(segmentFilter);

  const minO = parseOptionalNumber(minOrders);
  const maxO = parseOptionalNumber(maxOrders);
  if (minO != null || maxO != null) {
    const lifetimeOrders = {};
    if (minO != null) lifetimeOrders.$gte = minO;
    if (maxO != null) lifetimeOrders.$lte = maxO;
    parts.push({ lifetimeOrders });
  }
  const minD = parseOptionalNumber(minDelivered);
  const maxD = parseOptionalNumber(maxDelivered);
  if (minD != null || maxD != null) {
    const lifetimeDelivered = {};
    if (minD != null) lifetimeDelivered.$gte = minD;
    if (maxD != null) lifetimeDelivered.$lte = maxD;
    parts.push({ lifetimeDelivered });
  }
  if (hasEmail === 'yes' || hasEmail === true || hasEmail === 'true') {
    parts.push({ email: { $exists: true, $nin: [null, ''] } });
  } else if (hasEmail === 'no' || hasEmail === false || hasEmail === 'false') {
    parts.push({
      $or: [{ email: { $exists: false } }, { email: null }, { email: '' }],
    });
  }

  return parts;
}

async function resolveFilteredCustomerQuery(query = {}) {
  const parts = buildCustomerFieldParts(query);
  const idSets = [];

  if (hasOrderItemFilters(query)) {
    const orderIds = await findCustomerIdsByOrderFilters(query);
    if (!orderIds.length) {
      return { filter: { _id: { $in: [] } }, needsGenderPass: Boolean(query.gender && query.gender !== 'all') };
    }
    idSets.push(orderIds.map(String));
  }

  if (query.city) {
    const cityIds = await findCustomerIdsByCity(query.city);
    if (!cityIds?.length) {
      return { filter: { _id: { $in: [] } }, needsGenderPass: Boolean(query.gender && query.gender !== 'all') };
    }
    idSets.push(cityIds.map(String));
  }

  if (idSets.length) {
    let intersection = new Set(idSets[0]);
    for (let i = 1; i < idSets.length; i += 1) {
      const next = new Set(idSets[i]);
      intersection = new Set([...intersection].filter((id) => next.has(id)));
    }
    parts.push({
      _id: { $in: [...intersection].map((id) => new mongoose.Types.ObjectId(id)) },
    });
  }

  // Stored gender only when not inferring from name (male/female still use resolveGender pass).
  if (query.gender === 'unknown') {
    parts.push({ gender: 'unknown' });
  }

  const filter = parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
  const needsGenderPass = query.gender === 'male' || query.gender === 'female';
  return { filter, needsGenderPass, genderTarget: query.gender };
}

function customerCity(customer) {
  const addr =
    (customer.addresses || []).find((a) => a.isDefault) || (customer.addresses || [])[0] || null;
  return addr?.city || '';
}

/**
 * Find an existing customer by phone (handles 010 / +2010 / 2010 variants).
 * Returns customer + last shipping address from their most recent order when available.
 */
export async function findCustomerByPhone(phone) {
  const core = normalizeEgPhoneDigits(phone);
  if (core.length < 7) return null;

  const regexes = phoneMatchRegexes(phone);
  const or = [
    { phone: core },
    { phone: `0${core}` },
    { phone: `20${core}` },
    { phone: `+20${core}` },
    ...regexes.map((re) => ({ phone: { $regex: re } })),
  ];

  let customer = await Customer.findOne({ $or: or }).sort({ updatedAt: -1 }).lean();

  // Fallback: phone only on a past order's shipping address.
  if (!customer) {
    const orderHit = await Order.findOne({
      $or: [
        { 'shippingAddress.phone': { $regex: core } },
        ...regexes.map((re) => ({ 'shippingAddress.phone': { $regex: re } })),
      ],
    })
      .sort({ placedAt: -1 })
      .select('customerId')
      .lean();
    if (orderHit?.customerId) {
      customer = await Customer.findById(orderHit.customerId).lean();
    }
  }

  if (!customer) return null;

  const lastOrder = await Order.findOne({ customerId: customer._id })
    .sort({ placedAt: -1 })
    .select('shippingAddress shippingMethod shippingFee shopifyOrderName shopifyOrderId placedAt')
    .lean();

  const addr =
    lastOrder?.shippingAddress ||
    (customer.addresses || []).find((a) => a.isDefault) ||
    (customer.addresses || [])[0] ||
    null;

  return {
    customer,
    shippingAddress: addr
      ? {
          line1: addr.line1 || '',
          line2: addr.line2 || '',
          city: addr.city || '',
          zone: addr.zone || '',
          fullName: addr.fullName || customer.fullName || '',
          phone: addr.phone || customer.phone || '',
        }
      : null,
    lastOrder: lastOrder
      ? {
          _id: lastOrder._id,
          shopifyOrderName: lastOrder.shopifyOrderName,
          shopifyOrderId: lastOrder.shopifyOrderId,
          shippingMethod: lastOrder.shippingMethod,
          shippingFee: lastOrder.shippingFee,
          placedAt: lastOrder.placedAt,
        }
      : null,
  };
}

export async function findOrCreateCustomer({ fullName, phone, email, shopifyCustomerId, shippingAddress }) {
  let customer = shopifyCustomerId
    ? await Customer.findOne({ shopifyCustomerId: String(shopifyCustomerId) })
    : null;
  if (!customer) {
    const byPhone = await findCustomerByPhone(phone);
    customer = byPhone?.customer
      ? await Customer.findById(byPhone.customer._id)
      : null;
  }
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
    if (fullName && fullName !== customer.fullName) patch.fullName = fullName;
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
        shopifyOrderName: o.name,
        name: o.name,
        totalPrice: parseFloat(o.total_price) || 0,
        currency: o.currency,
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status || 'unfulfilled',
        cancelledAt: o.cancelled_at,
        createdAt: o.created_at,
        lineItemCount: (o.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0),
      }));
      // Enrich with Gazelle Bosta tracking when we have a matching local order
      const local = await Order.find({ customerId })
        .select('shopifyOrderId shopifyOrderName bostaTrackingNumber internalStatus')
        .lean();
      const byShopifyId = new Map(local.map((lo) => [String(lo.shopifyOrderId), lo]));
      const byName = new Map(
        local.filter((lo) => lo.shopifyOrderName).map((lo) => [String(lo.shopifyOrderName), lo])
      );
      for (const row of orders) {
        const match = byShopifyId.get(row.shopifyOrderId) || byName.get(row.name);
        if (match) {
          row._id = match._id;
          row.bostaTrackingNumber = match.bostaTrackingNumber || null;
          row.internalStatus = match.internalStatus;
          row.shopifyOrderName = match.shopifyOrderName || row.name;
        }
      }
      return { source: 'shopify', orders };
    } catch (err) {
      logger.warn({ err, customerId }, 'Shopify customer order history fetch failed — using local');
    }
  }

  const local = await Order.find({ customerId })
    .sort({ placedAt: -1 })
    .select('shopifyOrderId shopifyOrderName bostaTrackingNumber internalStatus totalSellingPrice placedAt');
  return {
    source: 'local',
    orders: local.map((o) => ({
      _id: o._id,
      shopifyOrderId: o.shopifyOrderId,
      shopifyOrderName: o.shopifyOrderName,
      name: o.shopifyOrderName || (isManualOrderRef(o.shopifyOrderId) ? o.shopifyOrderId : `#${o.shopifyOrderId}`),
      bostaTrackingNumber: o.bostaTrackingNumber || null,
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
    .select('shopifyOrderId shopifyOrderName bostaTrackingNumber internalStatus totalSellingPrice placedAt deliveredAt');

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

/**
 * List customers with CRM + order/product filters.
 * Supported query keys: search, riskFlag, segment, gender, city, size, color, sku,
 * productId, productSearch|itemSearch, orderStatus, shippingMethod, placedFrom, placedTo,
 * minOrders, maxOrders, minDelivered, maxDelivered, hasEmail, limit, skip.
 */
export async function listCustomers(query = {}) {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const skip = Math.max(Number(query.skip) || 0, 0);
  const { filter, needsGenderPass, genderTarget } = await resolveFilteredCustomerQuery(query);

  if (!needsGenderPass) {
    const [customers, total] = await Promise.all([
      Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Customer.countDocuments(filter),
    ]);
    return {
      customers: customers.map((c) => ({
        ...c,
        effectiveGender: resolveGender(c.gender, c.fullName),
      })),
      total,
    };
  }

  // Gender male/female: infer from name when stored gender is unknown.
  const all = await Customer.find(filter).sort({ createdAt: -1 }).lean();
  const matched = all.filter((c) => resolveGender(c.gender, c.fullName) === genderTarget);
  const total = matched.length;
  const customers = matched.slice(skip, skip + limit).map((c) => ({
    ...c,
    effectiveGender: genderTarget,
  }));
  return { customers, total };
}

export async function getCustomerFilterOptions() {
  const [sizes, colors, citiesFromCustomers, citiesFromOrders, products] = await Promise.all([
    Variant.distinct('size'),
    Variant.distinct('color'),
    Customer.distinct('addresses.city'),
    Order.distinct('shippingAddress.city'),
    Product.find({ status: { $ne: 'archived' } })
      .sort({ title: 1 })
      .select('_id title')
      .limit(500)
      .lean(),
  ]);

  const citySet = new Set(
    [...citiesFromCustomers, ...citiesFromOrders]
      .map((c) => String(c || '').trim())
      .filter(Boolean)
  );

  const sortAlpha = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

  return {
    sizes: sizes.filter(Boolean).sort(sortAlpha),
    colors: colors.filter(Boolean).sort(sortAlpha),
    cities: [...citySet].sort(sortAlpha),
    products: products.map((p) => ({ value: String(p._id), label: p.title })),
  };
}

export async function exportCustomersExcel(query = {}) {
  const { filter, needsGenderPass, genderTarget } = await resolveFilteredCustomerQuery(query);
  let customers = await Customer.find(filter).sort({ createdAt: -1 }).lean();
  if (needsGenderPass) {
    customers = customers.filter((c) => resolveGender(c.gender, c.fullName) === genderTarget);
  }

  const customerIds = customers.map((c) => c._id);
  const lastOrders = customerIds.length
    ? await Order.aggregate([
        { $match: { customerId: { $in: customerIds } } },
        { $sort: { placedAt: -1 } },
        {
          $group: {
            _id: '$customerId',
            placedAt: { $first: '$placedAt' },
            city: { $first: '$shippingAddress.city' },
            orderName: { $first: '$shopifyOrderName' },
            status: { $first: '$internalStatus' },
          },
        },
      ])
    : [];
  const lastByCustomer = new Map(lastOrders.map((r) => [String(r._id), r]));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Customers');
  sheet.columns = [
    { header: 'Name', key: 'fullName', width: 28 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Gender', key: 'gender', width: 10 },
    { header: 'Risk', key: 'riskFlag', width: 12 },
    { header: 'Orders', key: 'lifetimeOrders', width: 10 },
    { header: 'Delivered', key: 'lifetimeDelivered', width: 10 },
    { header: 'Cancelled', key: 'lifetimeCancelled', width: 10 },
    { header: 'Rejected/Returned', key: 'lifetimeRejectedOrReturned', width: 16 },
    { header: 'City', key: 'city', width: 18 },
    { header: 'Last order', key: 'lastOrderName', width: 14 },
    { header: 'Last order date', key: 'lastOrderDate', width: 14 },
    { header: 'Last order status', key: 'lastOrderStatus', width: 22 },
    { header: 'Customer ID', key: 'id', width: 26 },
  ];

  for (const c of customers) {
    const last = lastByCustomer.get(String(c._id));
    sheet.addRow({
      fullName: c.fullName || '',
      phone: c.phone || '',
      email: c.email || '',
      gender: resolveGender(c.gender, c.fullName),
      riskFlag: c.riskFlag || 'none',
      lifetimeOrders: c.lifetimeOrders || 0,
      lifetimeDelivered: c.lifetimeDelivered || 0,
      lifetimeCancelled: c.lifetimeCancelled || 0,
      lifetimeRejectedOrReturned: c.lifetimeRejectedOrReturned || 0,
      city: customerCity(c) || last?.city || '',
      lastOrderName: last?.orderName || '',
      lastOrderDate: last?.placedAt ? new Date(last.placedAt).toISOString().slice(0, 10) : '',
      lastOrderStatus: last?.status || '',
      id: String(c._id),
    });
  }
  styleHeaderRow(sheet);

  const buffer = await workbookBuffer(workbook);
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `gazelle-customers-${stamp}.xlsx`, total: customers.length };
}

export default {
  findOrCreateCustomer,
  findCustomerByPhone,
  getCustomerById,
  getCustomerShopifyOrders,
  updateCustomerRiskFlag,
  recordCustomerCancellation,
  listCustomers,
  getCustomerFilterOptions,
  exportCustomersExcel,
  findCustomerIdsByOrderFilters,
  buildCustomerSegmentFilter,
  FREQUENT_CANCEL_THRESHOLD,
  VIP_ORDER_THRESHOLD,
};
