import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';
import Order from '../models/Order.js';
import { getAwb } from '../integrations/bosta/shipments.service.js';

export async function pickAndPackOrder(orderId, actorUserId) {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  if (order.internalStatus !== 'verified_ready_for_shipping') {
    const err = new Error('Order is not ready for shipping');
    err.statusCode = 400;
    throw err;
  }

  const agenda = getAgenda();
  await agenda.now(JOB_NAMES.BOSTA_CREATE_SHIPMENT, { orderId: orderId.toString(), actorUserId });

  return { queued: true, orderId };
}

export async function getPickList() {
  return Order.find({ internalStatus: 'verified_ready_for_shipping' })
    .sort({ placedAt: 1 })
    .populate('customerId', 'fullName phone');
}

export async function getAwbForOrder(orderId) {
  const order = await Order.findById(orderId);
  if (!order?.bostaDeliveryId) {
    const err = new Error('No Bosta delivery for this order');
    err.statusCode = 404;
    throw err;
  }
  return getAwb(order.bostaDeliveryId);
}

export default { pickAndPackOrder, getPickList, getAwbForOrder };
