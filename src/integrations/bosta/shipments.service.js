import { bostaRequest } from './client.js';
import { config } from '../../config/index.js';

/**
 * Create a Bosta delivery for a verified order.
 * Payload shape may need adjustment against live Bosta API docs.
 */
export async function createDelivery(order, customer) {
  const shipping = order.shippingAddress;
  const codAmount = order.totalSellingPrice;

  const payload = {
    type: 10, // COD send — confirm with Bosta docs
    specs: {
      packageDetails: {
        itemsCount: order.items.reduce((s, i) => s + i.quantity, 0),
        description: `Order ${order.shopifyOrderId}`,
      },
    },
    receiver: {
      firstName: shipping.fullName || customer.fullName,
      phone: shipping.phone || customer.phone,
      address: {
        firstLine: shipping.line1,
        secondLine: shipping.line2 || '',
        city: shipping.city,
        zone: shipping.zone || '',
      },
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
