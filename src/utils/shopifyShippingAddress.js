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
