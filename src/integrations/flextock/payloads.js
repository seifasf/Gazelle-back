import { config } from '../../config/index.js';
import { omsCodCollectAmount, omsCodFeeEgp, isOrderPrepaid } from '../../utils/omsCod.js';

export function flextockMerchantOrderCode(order) {
  const name = String(order?.shopifyOrderName || '').trim();
  if (name) return name.replace(/^#/, '');
  const id = String(order?.shopifyOrderId || '').trim();
  if (id) return id.replace(/^#/, '');
  return String(order?._id || '');
}

export function splitCustomerName(fullName) {
  const parts = String(fullName || 'Customer').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || 'Customer',
    last_name: parts.slice(1).join(' ') || parts[0] || 'Customer',
  };
}

/** Flextock examples use local 01… numbers, not +20. */
export function normalizeFlextockPhone(phone) {
  let p = String(phone || '').replace(/[\s\-()]/g, '');
  if (!p) return '';
  if (p.startsWith('+20')) p = `0${p.slice(3)}`;
  else if (p.startsWith('0020')) p = `0${p.slice(4)}`;
  else if (/^20\d{9,}$/.test(p)) p = `0${p.slice(2)}`;
  return p;
}

/** Cairo calendar date YYYY-MM-DD (PDF order_date). */
export function flextockOrderDate(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(d.getTime())) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * PDF example: "2024-12-03 13:46:14.000 +0200"
 */
export function flextockPaymentTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(safe);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  const ms = String(safe.getMilliseconds()).padStart(3, '0');
  // Egypt is UTC+2 (or +3 briefly); Flextock examples use +0200.
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}.${ms} +0200`;
}

export function flextockMerchantLabels(settings = null) {
  return {
    integration_source:
      cleanLabel(settings?.flextockIntegrationSource)
      || cleanLabel(config.FLEXTOCK_INTEGRATION_SOURCE)
      || 'gazelle',
    vendor_name:
      cleanLabel(settings?.flextockVendorName)
      || cleanLabel(config.FLEXTOCK_VENDOR_NAME)
      || 'gazelle',
    order_currency: cleanLabel(config.FLEXTOCK_CURRENCY) || 'EGP',
    requires_self_delivery: Boolean(config.FLEXTOCK_REQUIRES_SELF_DELIVERY),
  };
}

function cleanLabel(value) {
  return String(value || '').trim() || '';
}

export function flextockCustomerAddress(order, customer) {
  const shipping = order?.shippingAddress || {};
  const name = splitCustomerName(shipping.fullName || customer?.fullName);
  const city = String(shipping.city || '').trim();
  const area = String(shipping.zone || '').trim() || city;
  const phone = normalizeFlextockPhone(shipping.phone || customer?.phone);
  return {
    country: 'Egypt',
    city,
    area,
    address_line1: String(shipping.line1 || '').trim(),
    address_line2: String(shipping.line2 || '').trim() || String(shipping.line1 || '').trim(),
    building_no: String(shipping.buildingNo || shipping.building || '').trim(),
    floor_no: String(shipping.floorNo || shipping.floor || '').trim(),
    apartment_no: String(shipping.apartmentNo || shipping.apartment || '').trim(),
    is_work_address: Boolean(shipping.isWorkAddress),
    first_name: name.first_name,
    last_name: name.last_name,
    phone_number: phone,
    // PDF examples always include a secondary number — reuse primary when missing.
    secondary_phone_number: phone,
    note: String(order?.shippingNote || shipping.note || '').trim(),
  };
}

/**
 * Create Product body fields (PDF §2).
 * Optional merchant_promotional_price when the SKU is on promo.
 */
export function flextockProductFromVariant(variant, { price, compareAtPrice, name, imageUrl } = {}) {
  const sku = String(variant?.sku || '').trim();
  const title = String(
    name
    || variant?.title
    || [variant?.color, variant?.size].filter(Boolean).join(' ')
    || sku
  ).trim();
  const img = imageUrl || variant?.imageUrl || variant?.productImageUrl || '';
  const unit = Number(price ?? variant?.price ?? 0) || 0;
  const compare = Number(compareAtPrice ?? variant?.compareAtPrice);
  const product = {
    sku_code: sku,
    sku_name: title || sku,
    sku_description: title || sku,
    sku_image_url: typeof img === 'string' && /^https?:\/\//i.test(img) ? img : '',
    price: unit,
  };
  if (Number.isFinite(compare) && compare > unit) {
    product.merchant_promotional_price = unit;
    product.price = compare;
  }
  return product;
}

/**
 * PDF: line_items must not duplicate sku_code — merge quantities instead.
 * sku_promotional_price must be a number or null.
 */
export function flextockLineItems(order, variantsById = new Map()) {
  const bySku = new Map();
  for (const item of order?.items || []) {
    const sku = String(item.sku || '').trim();
    if (!sku) continue;
    const qty = Number(item.quantity) || 0;
    if (!(qty > 0)) continue;

    const variantId = item.variantId?._id || item.variantId;
    const variant =
      (item.variantId && typeof item.variantId === 'object' && item.variantId.sku)
        ? item.variantId
        : variantsById.get(String(variantId)) || {};
    const selling = Number(item.unitSellingPrice) || 0;
    const compare = Number(item.unitCompareAtPrice);
    const hasPromo = Number.isFinite(compare) && compare > selling;
    const skuPrice = hasPromo ? compare : (compare || selling || Number(variant.price) || 0);
    const promo = hasPromo ? selling : null;

    const existing = bySku.get(sku);
    if (existing) {
      existing.quantity += qty;
      continue;
    }
    bySku.set(sku, {
      sku_code: sku,
      quantity: qty,
      sku_price: skuPrice,
      sku_promotional_price: promo,
    });
  }
  return [...bySku.values()];
}

export function flextockPaymentData(order) {
  const prepaid = isOrderPrepaid(order);
  if (prepaid) {
    const value =
      Number(order.onlinePaymentAmount) > 0
        ? Number(order.onlinePaymentAmount)
        : (Number(order.totalSellingPrice) || 0) + (Number(order.shippingFee) || 0);
    return [
      {
        value,
        payment_type: 'prepaid',
        payment_method: String(order.onlinePaymentProvider || 'online'),
        payment_reference: String(order.onlinePaymentReference || flextockMerchantOrderCode(order)),
        payment_timestamp: flextockPaymentTimestamp(order.onlinePaidAt || order.placedAt),
      },
    ];
  }
  // PDF: payment_type must be cash_on_delivery or prepaid
  return [
    {
      value: omsCodCollectAmount(order),
      payment_type: 'cash_on_delivery',
    },
  ];
}

export function flextockExtraFees(order) {
  const fee = omsCodFeeEgp(order);
  if (!(fee > 0)) return [];
  return [{ name: 'COD Fees', value: fee }];
}

export function buildCreateOrderPayload(order, customer, variantsById = new Map(), settings = null) {
  const shippingFee = Number(order?.shippingFee) || 0;
  const labels = flextockMerchantLabels(settings);
  const payload = {
    order_code: flextockMerchantOrderCode(order),
    order_date: flextockOrderDate(order?.placedAt),
    shipping_fees: shippingFee,
    is_free_shipping: shippingFee === 0,
    is_gift_order: false,
    order_currency: labels.order_currency,
    integration_source: labels.integration_source,
    vendor_name: labels.vendor_name,
    customer_address: flextockCustomerAddress(order, customer),
    line_items: flextockLineItems(order, variantsById),
    extra_fees: flextockExtraFees(order),
    payment_data: flextockPaymentData(order),
    discounts_data: Number(order?.discountAmount) > 0
      ? [{
        value: Number(order.discountAmount),
        // PDF supported types: fixed & percentage (example also shows "Fixed")
        discount_type: 'fixed',
        discount_code: order.discountPercent ? `PCT-${order.discountPercent}` : 'GAZELLE',
      }]
      : [],
    // false = Flextock last-mile (default). true requires shipment_data (self delivery).
    requires_self_delivery: labels.requires_self_delivery,
  };
  if (payload.requires_self_delivery) {
    payload.shipment_data = {
      courier_name_code: String(order?.flextockCourierNameCode || config.FLEXTOCK_SELF_COURIER_CODE || '').trim(),
      tracking_number: String(order?.flextockSelfTrackingNumber || order?.bostaTrackingNumber || '').trim(),
    };
  }
  return payload;
}

export function buildCreateProductsPayload(products) {
  return { products: (products || []).slice(0, 100) };
}

export function buildCancelOrderPayload(orderCode, orderType = 'outbound') {
  const type = String(orderType || 'outbound').trim().toLowerCase();
  const allowed = new Set(['outbound', 'exchange', 'return']);
  return {
    order_code: String(orderCode || '').trim(),
    order_type: allowed.has(type) ? type : 'outbound',
  };
}

export function buildReturnOrderPayload(order, customer, {
  outboundOrderCode,
  returnSkus,
  settings = null,
} = {}) {
  const labels = flextockMerchantLabels(settings);
  const payload = {
    order_date: flextockOrderDate(order?.placedAt || Date.now()),
    integration_source: labels.integration_source,
    customer_address: flextockCustomerAddress(order, customer),
    outbound_order_code: String(outboundOrderCode || '').trim(),
    return_skus: (returnSkus || []).map((sku) => ({
      sku_code: String(sku.sku_code || sku.sku || '').trim(),
      quantity: Number(sku.quantity) || 1,
      is_damaged: Boolean(sku.is_damaged),
    })),
    // PDF: cash_returned is required (0 when refunded online)
    cash_returned: Number(order?.refundAmount) || 0,
    requires_self_delivery: labels.requires_self_delivery,
  };
  if (payload.requires_self_delivery) {
    payload.shipment_data = {
      courier_name_code: String(order?.flextockCourierNameCode || config.FLEXTOCK_SELF_COURIER_CODE || '').trim(),
      tracking_number: String(order?.flextockSelfTrackingNumber || '').trim(),
    };
  }
  return payload;
}

export function validateCreateOrderPayload(payload) {
  const errors = [];
  if (!payload?.order_code) errors.push('order_code is required');
  if (!Array.isArray(payload?.line_items) || !payload.line_items.length) {
    errors.push('Line items cannot be empty');
  }
  const seen = new Set();
  for (const line of payload?.line_items || []) {
    if (!line.sku_code) errors.push('SKU code cannot be empty');
    if (!(Number(line.quantity) > 0)) errors.push(`SKU ${line.sku_code || '?'} quantity should be greater than 0`);
    if (seen.has(line.sku_code)) errors.push(`Duplicate SKU sku_code: ${line.sku_code}`);
    seen.add(line.sku_code);
  }
  const addr = payload?.customer_address || {};
  if (!addr.first_name && !addr.last_name) {
    errors.push('First name or Last name are required for customer contact');
  }
  if (!addr.city) errors.push('customer_address.city is required');
  if (!addr.area) errors.push('customer_address.area is required');
  if (!addr.address_line1) errors.push('customer_address.address_line1 is required');
  if (!addr.phone_number) errors.push('customer_address.phone_number is required');
  if (payload?.requires_self_delivery) {
    if (!payload?.shipment_data?.courier_name_code || !payload?.shipment_data?.tracking_number) {
      errors.push('shipment_data is required when requires_self_delivery is true');
    }
  }
  return errors;
}

export default {
  flextockMerchantOrderCode,
  splitCustomerName,
  normalizeFlextockPhone,
  flextockOrderDate,
  flextockPaymentTimestamp,
  flextockMerchantLabels,
  flextockCustomerAddress,
  flextockProductFromVariant,
  flextockLineItems,
  flextockPaymentData,
  flextockExtraFees,
  buildCreateOrderPayload,
  buildCreateProductsPayload,
  buildCancelOrderPayload,
  buildReturnOrderPayload,
  validateCreateOrderPayload,
};
