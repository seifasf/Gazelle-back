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

function ymd(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  const cairo = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return cairo.toISOString().slice(0, 10);
}

function paymentTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString().replace('T', ' ').replace('Z', ' +0000');
}

export function flextockCustomerAddress(order, customer) {
  const shipping = order?.shippingAddress || {};
  const name = splitCustomerName(shipping.fullName || customer?.fullName);
  const city = String(shipping.city || '').trim();
  const area = String(shipping.zone || '').trim() || city;
  return {
    country: 'Egypt',
    city,
    area,
    address_line1: String(shipping.line1 || '').trim(),
    address_line2: String(shipping.line2 || '').trim() || String(shipping.line1 || '').trim(),
    building_no: '',
    floor_no: '',
    apartment_no: '',
    is_work_address: false,
    first_name: name.first_name,
    last_name: name.last_name,
    phone_number: String(shipping.phone || customer?.phone || '').trim(),
    secondary_phone_number: '',
    note: '',
  };
}

export function flextockProductFromVariant(variant, { price, name, imageUrl } = {}) {
  const sku = String(variant?.sku || '').trim();
  const title = String(
    name
    || variant?.title
    || [variant?.color, variant?.size].filter(Boolean).join(' ')
    || sku
  ).trim();
  const img = imageUrl || variant?.imageUrl || variant?.productImageUrl || '';
  return {
    sku_code: sku,
    sku_name: title || sku,
    sku_description: title || sku,
    sku_image_url: typeof img === 'string' && /^https?:\/\//i.test(img) ? img : '',
    price: Number(price ?? variant?.price ?? 0) || 0,
  };
}

export function flextockLineItems(order, variantsById = new Map()) {
  const lines = [];
  const seen = new Set();
  for (const item of order?.items || []) {
    const sku = String(item.sku || '').trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    const variantId = item.variantId?._id || item.variantId;
    const variant =
      (item.variantId && typeof item.variantId === 'object' && item.variantId.sku)
        ? item.variantId
        : variantsById.get(String(variantId)) || {};
    const promo = item.unitCompareAtPrice != null && Number(item.unitCompareAtPrice) > Number(item.unitSellingPrice)
      ? Number(item.unitSellingPrice)
      : null;
    lines.push({
      sku_code: sku,
      quantity: Number(item.quantity) || 1,
      sku_price: Number(item.unitCompareAtPrice || item.unitSellingPrice) || 0,
      sku_promotional_price: promo,
    });
  }
  return lines;
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
        payment_timestamp: paymentTimestamp(order.onlinePaidAt || order.placedAt),
      },
    ];
  }
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

export function buildCreateOrderPayload(order, customer, variantsById = new Map()) {
  const shippingFee = Number(order?.shippingFee) || 0;
  const payload = {
    order_code: flextockMerchantOrderCode(order),
    order_date: ymd(order?.placedAt),
    shipping_fees: shippingFee,
    is_free_shipping: shippingFee === 0,
    is_gift_order: false,
    order_currency: config.FLEXTOCK_CURRENCY || 'EGP',
    integration_source: config.FLEXTOCK_INTEGRATION_SOURCE || 'gazelle',
    vendor_name: config.FLEXTOCK_VENDOR_NAME || 'gazelle',
    customer_address: flextockCustomerAddress(order, customer),
    line_items: flextockLineItems(order, variantsById),
    extra_fees: flextockExtraFees(order),
    payment_data: flextockPaymentData(order),
    discounts_data: Number(order?.discountAmount) > 0
      ? [{
        value: Number(order.discountAmount),
        discount_type: 'fixed',
        discount_code: order.discountPercent ? `PCT-${order.discountPercent}` : 'GAZELLE',
      }]
      : [],
    // false = Flextock last-mile. true would mean Gazelle delivers with shipment_data.
    requires_self_delivery: Boolean(config.FLEXTOCK_REQUIRES_SELF_DELIVERY),
  };
  return payload;
}

export function buildCreateProductsPayload(products) {
  return { products: (products || []).slice(0, 100) };
}

export function buildCancelOrderPayload(orderCode, orderType = 'outbound') {
  return {
    order_code: String(orderCode || '').trim(),
    order_type: orderType,
  };
}

export function buildReturnOrderPayload(order, customer, {
  outboundOrderCode,
  returnSkus,
} = {}) {
  return {
    order_date: ymd(order?.placedAt || Date.now()),
    integration_source: config.FLEXTOCK_INTEGRATION_SOURCE || 'gazelle',
    customer_address: flextockCustomerAddress(order, customer),
    outbound_order_code: String(outboundOrderCode || '').trim(),
    return_skus: (returnSkus || []).map((sku) => ({
      sku_code: String(sku.sku_code || sku.sku || '').trim(),
      quantity: Number(sku.quantity) || 1,
      is_damaged: Boolean(sku.is_damaged),
    })),
    cash_returned: Number(order?.refundAmount) || 0,
    requires_self_delivery: Boolean(config.FLEXTOCK_REQUIRES_SELF_DELIVERY),
  };
}

export default {
  flextockMerchantOrderCode,
  splitCustomerName,
  flextockCustomerAddress,
  flextockProductFromVariant,
  flextockLineItems,
  flextockPaymentData,
  buildCreateOrderPayload,
  buildCreateProductsPayload,
  buildCancelOrderPayload,
  buildReturnOrderPayload,
};
