/**
 * Shopify Basic / unapproved custom apps strip customer PII from Admin API
 * and webhooks. Province/country often remain; street, city, name, phone do not.
 * OMS still requires line1 + city on orders — use explicit fallbacks so ingest
 * does not drop the order.
 */

export const SHOPIFY_ADDRESS_PLACEHOLDER = 'Address not available from Shopify';

export function rawShopifyAddress(payload = {}) {
  return payload.shipping_address || payload.billing_address || {};
}

export function hasCompleteShopifyAddress(payload = {}) {
  const shipping = rawShopifyAddress(payload);
  return Boolean(String(shipping.address1 || '').trim() && String(shipping.city || '').trim());
}

export function mapShopifyShippingAddress(payload = {}) {
  const shipping = rawShopifyAddress(payload);
  const customer = payload.customer || {};
  const fullName =
    `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim() ||
    `${customer.first_name || ''} ${customer.last_name || ''}`.trim() ||
    'Unknown';
  const line1 = String(shipping.address1 || '').trim() || SHOPIFY_ADDRESS_PLACEHOLDER;
  const city =
    String(shipping.city || '').trim() ||
    String(shipping.province || '').trim() ||
    'Unknown';
  return {
    fullName,
    line1,
    line2: shipping.address2,
    city,
    zone: shipping.province || shipping.city,
    phone: shipping.phone || customer.phone || payload.phone,
  };
}

export function shopifyCustomerPhone(payload = {}, shippingAddress = {}) {
  const raw = shippingAddress.phone || payload.customer?.phone || payload.phone;
  if (raw && String(raw).trim()) return String(raw).trim();
  if (payload.customer?.id) return `shopify-cust-${payload.customer.id}`;
  if (payload.id) return `shopify-order-${payload.id}`;
  return 'unknown';
}

export function isPlaceholderPhone(phone) {
  const p = String(phone || '').trim();
  if (!p || /^unknown$/i.test(p)) return true;
  if (/^shopify-(cust|order)-/i.test(p)) return true;
  return String(p).replace(/\D/g, '').length < 10;
}

export function isPlaceholderCustomerName(name) {
  const n = String(name || '').trim();
  return !n || /^unknown$/i.test(n);
}

export function isPlaceholderStreet(line1) {
  const s = String(line1 || '').trim();
  return !s || s === SHOPIFY_ADDRESS_PLACEHOLDER;
}

/** Confirmed verification needs a real name, EG phone, and street from Shopify Admin. */
export function assertContactReadyToConfirm(order) {
  const addr = order?.shippingAddress || {};
  if (isPlaceholderCustomerName(addr.fullName)) {
    const err = new Error('Save the customer name from Shopify Admin before confirming');
    err.statusCode = 400;
    throw err;
  }
  if (isPlaceholderPhone(addr.phone)) {
    const err = new Error('Save a real phone number from Shopify Admin before confirming');
    err.statusCode = 400;
    throw err;
  }
  if (order?.shippingMethod !== 'pickup' && isPlaceholderStreet(addr.line1)) {
    const err = new Error('Save the street address from Shopify Admin before confirming');
    err.statusCode = 400;
    throw err;
  }
  if (order?.shippingMethod !== 'pickup' && !String(addr.city || '').trim()) {
    const err = new Error('Save the city from Shopify Admin before confirming');
    err.statusCode = 400;
    throw err;
  }
}
