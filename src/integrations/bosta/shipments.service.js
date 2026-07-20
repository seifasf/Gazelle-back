import { bostaRequest } from './client.js';
import { config } from '../../config/index.js';
import Settings from '../../models/Settings.js';
import { bostaWebhookUrl } from './webhookPayload.js';

function splitName(fullName) {
  const parts = (fullName || 'Customer').trim().split(/\s+/);
  return {
    firstName: parts[0] || 'Customer',
    lastName: parts.slice(1).join(' ') || '.',
  };
}

async function resolveBostaCityId(cityName) {
  if (!cityName) return null;
  const settings = await Settings.findOne({ key: 'global' });
  const cities = settings?.bostaCities || [];
  const normalized = cityName.trim().toLowerCase();
  const match = cities.find(
    (c) =>
      c.name?.toLowerCase() === normalized ||
      c.nameAr?.toLowerCase() === normalized ||
      c.code?.toLowerCase() === normalized
  );
  return match?.id || match?.code || null;
}

export async function createDelivery(order, customer) {
  const shipping = order.shippingAddress;
  if (!shipping?.line1 || !shipping?.city) {
    const err = new Error('Shipping address (street + city) is required to create a Bosta delivery');
    err.statusCode = 400;
    throw err;
  }

  const phone = shipping.phone || customer?.phone;
  if (!phone) {
    const err = new Error('Customer phone is required to create a Bosta delivery');
    err.statusCode = 400;
    throw err;
  }

  const codAmount = (order.totalSellingPrice || 0) + (order.shippingFee || 0);
  const { firstName, lastName } = splitName(shipping.fullName || customer?.fullName);
  const cityId = await resolveBostaCityId(shipping.city);

  const address = {
    firstLine: shipping.line1,
    secondLine: shipping.line2 || '',
    zone: shipping.zone || '',
  };

  if (cityId) {
    address.cityId = cityId;
  } else {
    address.city = shipping.city;
  }

  const payload = {
    type: 10,
    specs: {
      packageDetails: {
        itemsCount: order.items.reduce((s, i) => s + i.quantity, 0),
        description: `Order ${order.shopifyOrderId}`,
      },
    },
    receiver: {
      firstName,
      lastName,
      phone,
      address,
    },
    businessReference: order._id.toString(),
    webhookUrl: bostaWebhookUrl(config.APP_URL),
    cod: codAmount,
  };

  const response = await bostaRequest('/deliveries', { method: 'POST', body: payload });
  return response?.data || response;
}

export async function getDelivery(deliveryIdOrTracking) {
  const key = String(deliveryIdOrTracking || '').trim();
  if (!key) {
    const err = new Error('Missing Bosta delivery id/tracking');
    err.statusCode = 400;
    throw err;
  }

  // Prefer business tracking lookup — GET /deliveries/:id often 404s for plugin-created shipments.
  if (/^\d{8,}$/.test(key)) {
    const byTracking = await bostaRequest(`/deliveries/business/${encodeURIComponent(key)}`);
    return byTracking?.data || byTracking;
  }

  try {
    const response = await bostaRequest(`/deliveries/${encodeURIComponent(key)}`);
    return response?.data || response;
  } catch (err) {
    // Fall back: treat key as tracking if id lookup fails.
    const byTracking = await bostaRequest(`/deliveries/business/${encodeURIComponent(key)}`);
    return byTracking?.data || byTracking;
  }
}

export async function getAwb(deliveryId) {
  const response = await bostaRequest(`/deliveries/${deliveryId}/awb`);
  return response?.data || response;
}

export default { createDelivery, getDelivery, getAwb };
