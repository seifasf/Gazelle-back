import Order from '../../models/Order.js';
import BostaStatusMapping from '../../models/BostaStatusMapping.js';
import { getDelivery } from './shipments.service.js';
import orderService from '../../services/order.service.js';
import logger from '../../utils/logger.js';

export async function mapBostaStateToInternal(bostaState) {
  const mapping = await BostaStatusMapping.findOne({
    bostaState: { $regex: new RegExp(`^${bostaState}$`, 'i') },
    isActive: true,
  });
  return mapping?.internalStatus || null;
}

export async function processBostaStatusUpdate({ deliveryId, state, note }) {
  const order = await Order.findOne({ bostaDeliveryId: deliveryId });
  if (!order) {
    logger.warn({ deliveryId }, 'Bosta webhook for unknown delivery');
    return null;
  }

  const internalStatus = await mapBostaStateToInternal(state);
  if (!internalStatus) {
    logger.warn({ state, deliveryId }, 'Unmapped Bosta state');
    return order;
  }

  if (order.internalStatus === internalStatus) {
    return order;
  }

  return orderService.transitionOrderStatus(order._id, internalStatus, {
    source: 'bosta_webhook',
    note: note || `Bosta state: ${state}`,
  });
}

export async function pollStuckOrders(thresholdHours = 48) {
  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);
  const stuck = await Order.find({
    internalStatus: {
      $in: ['picked_up_by_bosta', 'in_transit', 'failed_delivery', 'returning_to_origin'],
    },
    lastStatusUpdateAt: { $lt: cutoff },
    bostaDeliveryId: { $exists: true, $ne: null },
  }).limit(50);

  const results = [];
  for (const order of stuck) {
    try {
      const delivery = await getDelivery(order.bostaDeliveryId);
      const state = delivery?.state || delivery?.status;
      if (state) {
        await processBostaStatusUpdate({
          deliveryId: order.bostaDeliveryId,
          state,
          note: 'Polling fallback',
        });
        results.push({ orderId: order._id, state });
      }
    } catch (err) {
      logger.error({ err, orderId: order._id }, 'Bosta polling failed');
    }
  }
  return results;
}

export default { mapBostaStateToInternal, processBostaStatusUpdate, pollStuckOrders };
