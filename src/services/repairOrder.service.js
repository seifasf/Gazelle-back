import Order from '../models/Order.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import Customer from '../models/Customer.js';
import { withTransaction } from '../utils/transaction.js';
import { MANUAL_ORDER_SOURCES, SHIPPING_METHODS } from '../constants/index.js';
import { allocateManualOrderRef, findOrCreateManualCustomer } from './order.service.js';
import { notifyRepairOrderReady } from './notification.service.js';
import logger from '../utils/logger.js';

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Brand repair policy: the shoe is already repaired in-house. Customer either picks it up
 * at the store or we ship it (Bosta / local courier). No catalog items, no stock moves.
 * `totalAmount` is exactly what is collected (shipping included, no COD fee).
 */
export async function createRepairOrder({
  customer = {},
  shippingMethod,
  shippingAddress,
  repairItemName,
  totalAmount,
  repairNote,
  manualSource = 'other',
  actorUserId,
}) {
  const fullName = String(customer.fullName || '').trim();
  const phone = String(customer.phone || '').trim();
  if (!fullName || !phone) throw badRequest('Customer name and phone are required');

  const shoeName = String(repairItemName || '').trim();
  if (!shoeName) throw badRequest('Enter the name of the repaired shoe');

  const total = Number(totalAmount);
  if (!Number.isFinite(total) || total < 0) throw badRequest('Total amount must be 0 or more');

  const method = shippingMethod || 'bosta';
  if (!SHIPPING_METHODS.includes(method)) throw badRequest('Choose Bosta, Local shipping, or Pickup');

  const address = shippingAddress || {};
  if (method !== 'pickup' && (!String(address.line1 || '').trim() || !String(address.city || '').trim())) {
    throw badRequest('Street and city are required to ship the repaired shoe');
  }

  const source = MANUAL_ORDER_SOURCES.includes(manualSource) ? manualSource : 'other';
  const note = typeof repairNote === 'string' ? repairNote.trim().slice(0, 500) : '';
  const methodLabel = method === 'pickup' ? 'Store pickup' : method === 'local_shipping' ? 'Local courier' : 'Bosta';

  const created = await withTransaction(async (session) => {
    const ref = await allocateManualOrderRef(session);
    const customerDoc = await findOrCreateManualCustomer({ ...customer, fullName, phone }, session);
    const now = new Date();

    const [order] = await Order.create(
      [{
        shopifyOrderId: ref,
        shopifyOrderName: ref,
        orderSource: 'manual',
        manualSource: source,
        shippingMethod: method,
        paymentMethod: 'cod',
        shippingFee: 0,
        customerId: customerDoc._id,
        shippingAddress:
          method === 'pickup'
            ? undefined
            : {
                ...address,
                fullName: address.fullName || fullName,
                phone: address.phone || phone,
              },
        internalStatus: 'repaired_shoe',
        verifiedAt: now,
        isRepairOrder: true,
        repairItemName: shoeName,
        ...(note ? { repairNote: note } : {}),
        totalSellingPrice: total,
        totalCogsSnapshot: 0,
        items: [],
        placedAt: now,
        assignedOrdersManagerId: actorUserId,
        verificationLog: [
          {
            outcome: 'confirmed',
            note: `Repair order · ${shoeName} · ${methodLabel} · collect EGP ${total}${note ? ` — ${note}` : ''}`,
            actorUserId,
          },
        ],
      }],
      { session }
    );

    await OrderStatusHistory.create(
      [{
        orderId: order._id,
        fromStatus: null,
        toStatus: 'repaired_shoe',
        source: 'user_action',
        actorUserId,
        note: `Repair order from ${source} · ${methodLabel} · Repaired shoe`,
      }],
      { session }
    );

    await Customer.updateOne({ _id: customerDoc._id }, { $inc: { lifetimeOrders: 1 } }, { session });
    return order;
  });

  const populated = await Order.findById(created._id).populate('customerId');
  try {
    await notifyRepairOrderReady(populated);
  } catch (err) {
    logger.warn({ err: err?.message || err, orderId: String(created._id) }, 'Repair order notification failed');
  }
  return populated;
}

export default { createRepairOrder };
