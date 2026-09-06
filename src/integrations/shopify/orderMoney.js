/**
 * Shopify order → OMS shipping / payment helpers.
 * Shipping fee comes from Shopify (city/zone rates configured there).
 */

const PICKUP_REGEX =
  /\b(pickup|pick[\s_-]*up|bopis|curbside)\b|store[\s_-]*pickup|local[\s_-]*pickup|warehouse[\s_-]*pickup|branch[\s_-]*pickup|استلام/i;
const SHOPIFY_PICKUP_CARRIER_ID = '650f1a14fa979ec5c74d063e968411d4';

/**
 * Detect if an order was placed on Shopify as a pickup / local pickup order.
 */
export function isShopifyOrderPickup(payload = {}, fulfillmentOrders = null) {
  if (!payload || typeof payload !== 'object') return false;

  // 1. Direct pickup boolean flag
  if (payload.pickup_in_store === true) return true;

  // 2. Shipping lines check
  const lines = Array.isArray(payload.shipping_lines) ? payload.shipping_lines : [];
  for (const l of lines) {
    if (l.carrier_identifier === SHOPIFY_PICKUP_CARRIER_ID) return true;
    if (l.source === 'pickup' || l.source === 'local_pickup') return true;
    const title = String(l.title || '');
    const code = String(l.code || '');
    if (PICKUP_REGEX.test(title) || PICKUP_REGEX.test(code)) return true;
  }

  // 3. Tags check
  const tags = Array.isArray(payload.tags)
    ? payload.tags.join(' ')
    : String(payload.tags || '');
  if (PICKUP_REGEX.test(tags)) return true;

  // 4. Note / Note attributes
  const note = String(payload.note || '');
  if (PICKUP_REGEX.test(note)) return true;
  const noteAttrs = Array.isArray(payload.note_attributes) ? payload.note_attributes : [];
  for (const attr of noteAttrs) {
    if (PICKUP_REGEX.test(String(attr.name || '')) || PICKUP_REGEX.test(String(attr.value || ''))) {
      return true;
    }
  }

  // 5. GraphQL / REST fulfillmentOrders check
  const foNodes = Array.isArray(fulfillmentOrders)
    ? fulfillmentOrders
    : Array.isArray(fulfillmentOrders?.nodes)
      ? fulfillmentOrders.nodes
      : Array.isArray(payload.fulfillment_orders)
        ? payload.fulfillment_orders
        : [];
  for (const fo of foNodes) {
    const methodType = String(
      fo?.deliveryMethod?.methodType ||
      fo?.delivery_method?.method_type ||
      ''
    ).toUpperCase();
    if (methodType === 'PICK_UP' || methodType === 'PICKUP_POINT') return true;
  }

  return false;
}

export function mapShopifyShippingFee(payload = {}) {
  // If order was made as pickup on website, shipping is always 0.
  if (isShopifyOrderPickup(payload)) {
    return 0;
  }

  const candidates = [
    payload.total_shipping_price_set?.shop_money?.amount,
    payload.total_shipping_price_set?.presentment_money?.amount,
    payload.shipping_price,
    payload.total_shipping_price,
  ];
  for (const raw of candidates) {
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
  }

  const lines = Array.isArray(payload.shipping_lines) ? payload.shipping_lines : [];
  if (lines.length) {
    const sum = lines.reduce((s, l) => {
      const discounted = parseFloat(l.discounted_price ?? l.discounted_price_set?.shop_money?.amount);
      if (Number.isFinite(discounted) && discounted >= 0) return s + discounted;
      const price = parseFloat(l.price ?? l.price_set?.shop_money?.amount);
      return s + (Number.isFinite(price) && price >= 0 ? price : 0);
    }, 0);
    return Math.round(sum * 100) / 100;
  }

  return 0;
}

/**
 * Infer Gazelle payment method from Shopify gateways / financial status.
 * Paid → online (Bosta COD must be 0). COD gateways / pending → cod.
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
  const financial = String(payload.financial_status || '').toLowerCase();
  const codHints = ['cod', 'cash on delivery', 'cash_on_delivery', 'cash-on-delivery'];

  // Already paid → never create a Bosta COD ask (double charge).
  if (financial === 'paid' || financial === 'partially_paid') {
    return 'online';
  }

  if (codHints.some((h) => joined.includes(h))) return 'cod';

  if (financial === 'pending' || financial === 'authorized') {
    return 'cod';
  }

  return 'cod';
}

export function isShopifyOrderPaid(payload = {}) {
  const financial = String(payload.financial_status || '').toLowerCase();
  return financial === 'paid' || financial === 'partially_paid';
}

/**
 * Apply shipping fee + payment fields from a Shopify order payload onto an OMS order doc.
 * Does not save — caller saves.
 */
export function applyShopifyMoneyFields(order, payload = {}) {
  if (!order || !payload) return order;

  const isPickup = isShopifyOrderPickup(payload) || order.shippingMethod === 'pickup';
  if (isPickup) {
    order.shippingMethod = 'pickup';
    order.shippingFee = 0;
  } else {
    const shippingFee = mapShopifyShippingFee(payload);
    if (Number.isFinite(shippingFee) && shippingFee >= 0) {
      order.shippingFee = shippingFee;
    }
  }

  const paymentMethod = mapShopifyPaymentMethod(payload);
  order.paymentMethod = paymentMethod;

  if (isShopifyOrderPaid(payload)) {
    order.paymentMethod = 'online';
    order.onlinePaymentStatus = 'paid';
    order.onlinePaymentProvider =
      order.onlinePaymentProvider ||
      (Array.isArray(payload.payment_gateway_names) && payload.payment_gateway_names[0]) ||
      'shopify';
    if (!order.onlinePaidAt) {
      order.onlinePaidAt = new Date(payload.processed_at || payload.updated_at || Date.now());
    }
    const paidAmount = parseFloat(payload.total_price);
    if (Number.isFinite(paidAmount)) {
      order.onlinePaymentAmount = paidAmount;
    }
  }

  return order;
}
