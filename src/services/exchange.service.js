import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import { withTransaction } from '../utils/transaction.js';
import { applyLedgerEntries } from './inventory.service.js';

const EDITABLE = [
  'pending_verification',
  'no_response',
  'verified_ready_for_shipping',
  'out_of_stock',
];

function recalcMerchandiseTotals(order) {
  const goodsSum = order.items.reduce(
    (sum, i) => sum + (Number(i.unitSellingPrice) || 0) * (Number(i.quantity) || 0),
    0
  );
  const pct = Number(order.discountPercent) || 0;
  order.merchandiseSubtotal = goodsSum;
  if (pct > 0 && goodsSum > 0) {
    order.discountAmount = Math.round(((goodsSum * pct) / 100) * 100) / 100;
    order.totalSellingPrice = Math.max(
      0,
      Math.round((goodsSum - order.discountAmount) * 100) / 100
    );
  } else {
    order.discountPercent = 0;
    order.discountAmount = 0;
    order.totalSellingPrice = goodsSum;
  }
}

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

    if (!EDITABLE.includes(order.internalStatus)) {
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

    recalcMerchandiseTotals(order);

    order.verificationLog.push({
      outcome: 'customer_requested_changes',
      note: `Exchange ${previousSku} → ${newVariant.sku}: ${exchangeNote}`,
      actorUserId,
    });

    await order.save({ session });
    return order;
  });
}

/**
 * Remove a line item before shipment (customer drops a product).
 * Keeps at least one item on the order.
 */
export async function removeOrderItem(orderId, actorUserId, { itemId, note }) {
  const removeNote = typeof note === 'string' ? note.trim() : '';
  if (!removeNote) {
    const err = new Error('A note is required when removing an item');
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

    if (!EDITABLE.includes(order.internalStatus)) {
      const err = new Error('Remove item only allowed before shipment');
      err.statusCode = 400;
      throw err;
    }

    if ((order.items || []).length <= 1) {
      const err = new Error('Cannot remove the last item — cancel the order instead');
      err.statusCode = 400;
      throw err;
    }

    const item = order.items.id(itemId);
    if (!item) {
      const err = new Error('Order item not found');
      err.statusCode = 404;
      throw err;
    }

    const removedSku = item.sku;
    const removedQty = item.quantity;

    const variant = await Variant.findById(item.variantId).session(session);
    const onHold = Number(variant?.onHoldStock) || 0;
    const releaseQty = Math.min(removedQty, onHold);
    if (releaseQty > 0) {
      await applyLedgerEntries(
        [
          {
            variantId: item.variantId,
            orderId: order._id,
            ledgerType: 'on_hold_release',
            quantityDelta: -releaseQty,
            actorUserId,
          },
        ],
        session
      );
    }

    item.deleteOne();
    recalcMerchandiseTotals(order);

    order.verificationLog.push({
      outcome: 'customer_requested_changes',
      note: `Removed item ${removedSku} ×${removedQty}: ${removeNote}`,
      actorUserId,
    });

    await order.save({ session });
    return order;
  });
}

export default { processExchange, removeOrderItem };
