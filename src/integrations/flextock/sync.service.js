import Order from '../../models/Order.js';
import Settings from '../../models/Settings.js';
import { isFlextockConfigured, testFlextockConnection } from './client.js';
import { getFlextockOrderStatus } from './orders.service.js';
import { mapFlextockStatusToInternal } from './states.js';
import * as orderService from '../../services/order.service.js';
import logger from '../../utils/logger.js';

const OPEN_STATUSES = [
  'verified_ready_for_shipping',
  'repaired_shoe',
  'awaiting_bosta_pickup',
  'picked_up_by_bosta',
  'in_transit',
  'failed_delivery',
  'returning_to_origin',
  'back_from_flextock',
];

export async function applyFlextockStatusToOrder(order, live) {
  if (!order || !live) return { updated: false };
  const nextStatus = live.order_status != null ? String(live.order_status) : order.flextockOrderStatus;
  const tracking = live.tracking_number != null ? String(live.tracking_number) : order.flextockTrackingNumber;
  const url = live.tracking_url != null ? String(live.tracking_url) : order.flextockTrackingUrl;
  const courier = live.courier_name != null ? String(live.courier_name) : order.flextockCourierName;

  const patch = {
    flextockOrderStatus: nextStatus,
    flextockTrackingNumber: tracking || undefined,
    flextockTrackingUrl: url || undefined,
    flextockCourierName: courier || undefined,
    flextockSyncedAt: new Date(),
    flextockShipmentStatus: 'created',
    flextockShipmentError: null,
  };
  await Order.updateOne({ _id: order._id }, { $set: patch });

  const mapped = mapFlextockStatusToInternal(nextStatus);
  if (mapped && mapped !== order.internalStatus) {
    try {
      await orderService.transitionOrderStatus(order._id, mapped, {
        source: 'flextock_poll',
        note: `Flextock ${nextStatus}${tracking ? ` · ${tracking}` : ''}`,
      });
    } catch (err) {
      logger.warn(
        { err: err.message, orderId: String(order._id), from: order.internalStatus, to: mapped },
        'Flextock status mapped but OMS transition skipped'
      );
    }
  }
  return { updated: true, mapped };
}

export async function syncFlextockOrderStates({ limit = 80 } = {}) {
  if (!isFlextockConfigured()) return { skipped: true, reason: 'not_configured' };

  // Always probe auth — previously we marked healthy=true even with zero orders (false green).
  const probe = await testFlextockConnection();
  await Settings.updateOne(
    { key: 'global' },
    {
      $set: {
        flextockLastSyncAt: new Date(),
        flextockConnectionHealthy: Boolean(probe.ok),
        flextockLastError: probe.ok ? null : (probe.error || 'Flextock auth failed'),
      },
    },
    { upsert: true }
  );
  if (!probe.ok) {
    logger.warn({ err: probe.error }, 'Flextock sync skipped — auth failed');
    return { skipped: true, reason: 'auth_failed', error: probe.error, checked: 0, updated: 0 };
  }

  const orders = await Order.find({
    shippingMethod: 'flextock',
    flextockOrderCode: { $exists: true, $ne: null },
    internalStatus: { $in: OPEN_STATUSES },
  })
    .sort({ flextockSyncedAt: 1, updatedAt: 1 })
    .limit(limit)
    .select('flextockOrderCode flextockOrderStatus flextockTrackingNumber internalStatus');

  let checked = 0;
  let updated = 0;
  for (const order of orders) {
    checked += 1;
    try {
      const live = await getFlextockOrderStatus(order.flextockOrderCode);
      const result = await applyFlextockStatusToOrder(order, live);
      if (result.updated) updated += 1;
    } catch (err) {
      logger.warn({ err: err.message, orderId: String(order._id) }, 'Flextock status poll failed');
      await Order.updateOne(
        { _id: order._id },
        { $set: { flextockShipmentError: err.message, flextockSyncedAt: new Date() } }
      );
    }
  }

  return { skipped: false, checked, updated, authOk: true };
}

export default { syncFlextockOrderStates, applyFlextockStatusToOrder };
