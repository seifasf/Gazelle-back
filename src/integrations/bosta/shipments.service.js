import { bostaRequest } from './client.js';
import { config } from '../../config/index.js';
import Settings from '../../models/Settings.js';

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
  const codAmount = (order.totalSellingPrice || 0) + (order.shippingFee || 0);
  const { firstName, lastName } = splitName(shipping.fullName || customer.fullName);
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
      phone: shipping.phone || customer.phone,
      address,
    },
    businessReference: order._id.toString(),
    webhookUrl: `${config.APP_URL}/webhooks/bosta`,
    cod: codAmount,
  };

  return bostaRequest('/deliveries', { method: 'POST', body: payload });
}

export async function getDelivery(deliveryId) {
  return bostaRequest(`/deliveries/${deliveryId}`);
}

export async function getAwb(deliveryId) {
  return bostaRequest(`/deliveries/${deliveryId}/awb`);
}

export default { createDelivery, getDelivery, getAwb };
