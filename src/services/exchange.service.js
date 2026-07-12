import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import { withTransaction } from '../utils/transaction.js';
import { applyLedgerEntries } from './inventory.service.js';

/**
 * Exchange variant before shipment (O2.2).
 */
export async function processExchange(orderId, actorUserId, { fromItemId, toVariantId, note }) {
  const exchangeNote = typeof note === 'string' ? note.trim() : '';
  if (!exchangeNote) {
    const err = new Error('An exchange note is required (e.g. wrong size / color)');
    err.statusCode = 400;
    throw err;
  }

  return withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    const allowed = ['pending_verification', 'verified_ready_for_shipping'];
    if (!allowed.includes(order.internalStatus)) {
      const err = new Error('Exchange only allowed before shipment');
      err.statusCode = 400;
      throw err;
    }

    const item = order.items.id(fromItemId);
    if (!item) {
      const err = new Error('Order item not found');
      err.statusCode = 404;
      throw err;
    }

    const newVariant = await Variant.findById(toVariantId).session(session);
    if (!newVariant) {
      const err = new Error('Replacement variant not found');
      err.statusCode = 404;
      throw err;
    }

    if (String(item.variantId) === String(newVariant._id)) {
      const err = new Error('Replacement variant must be different from the current item');
      err.statusCode = 400;
      throw err;
    }

    const available = newVariant.realStock - newVariant.onHoldStock;
    if (available < item.quantity) {
      const err = new Error('Insufficient stock for exchange variant');
      err.statusCode = 409;
      throw err;
    }

    const previousSku = item.sku;

    await applyLedgerEntries(
      [
        {
          variantId: item.variantId,
          orderId: order._id,
          ledgerType: 'on_hold_release',
          quantityDelta: -item.quantity,
          actorUserId,
        },
        {
          variantId: newVariant._id,
          orderId: order._id,
          ledgerType: 'on_hold_reserve',
          quantityDelta: item.quantity,
          actorUserId,
        },
      ],
      session
    );

    item.variantId = newVariant._id;
    item.sku = newVariant.sku;
    item.unitSellingPrice = newVariant.sellingPrice;
    item.unitCogs = newVariant.cogs;

    order.totalSellingPrice = order.items.reduce(
      (sum, i) => sum + i.unitSellingPrice * i.quantity,
      0
    );

    order.verificationLog.push({
      outcome: 'customer_requested_changes',
      note: `Exchange ${previousSku} → ${newVariant.sku}: ${exchangeNote}`,
      actorUserId,
    });

    await order.save({ session });
    return order;
  });
}

export default { processExchange };
