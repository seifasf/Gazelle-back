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

function totalUnits(order) {
  return (order.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
}

function assertEditable(order) {
  if (!EDITABLE.includes(order.internalStatus)) {
    const err = new Error('Item edits only allowed before shipment');
    err.statusCode = 400;
    throw err;
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

    assertEditable(order);

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
 * Remove units from a line before shipment.
 * - quantity omitted or >= line qty → remove the whole line (if other units remain on the order)
 * - quantity < line qty → reduce quantity (supports 1 line with 2× same product)
 * Never leaves the order with 0 units — cancel instead.
 */
export async function removeOrderItem(orderId, actorUserId, { itemId, note, quantity } = {}) {
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

    assertEditable(order);

    const item = order.items.id(itemId);
    if (!item) {
      const err = new Error('Order item not found');
      err.statusCode = 404;
      throw err;
    }

    const lineQty = Number(item.quantity) || 0;
    const requested =
      quantity == null || quantity === ''
        ? lineQty
        : Math.floor(Number(quantity));

    if (!Number.isFinite(requested) || requested < 1) {
      const err = new Error('quantity must be at least 1');
      err.statusCode = 400;
      throw err;
    }

    const removeQty = Math.min(requested, lineQty);
    const unitsAfter = totalUnits(order) - removeQty;
    if (unitsAfter < 1) {
      const err = new Error('Cannot remove the last unit — cancel the order instead');
      err.statusCode = 400;
      throw err;
    }

    const removedSku = item.sku;
    const variant = await Variant.findById(item.variantId).session(session);
    const onHold = Number(variant?.onHoldStock) || 0;
    const releaseQty = Math.min(removeQty, onHold);
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

    if (removeQty >= lineQty) {
      item.deleteOne();
    } else {
      item.quantity = lineQty - removeQty;
    }

    recalcMerchandiseTotals(order);

    order.verificationLog.push({
      outcome: 'customer_requested_changes',
      note: `Removed ${removedSku} ×${removeQty}: ${removeNote}`,
      actorUserId,
    });

    await order.save({ session });
    return order;
  });
}

/**
 * Add a variant (or increase qty of an existing line) before shipment.
 */
export async function addOrderItem(orderId, actorUserId, { variantId, quantity = 1, note } = {}) {
  const addNote = typeof note === 'string' ? note.trim() : '';
  if (!addNote) {
    const err = new Error('A note is required when adding an item');
    err.statusCode = 400;
    throw err;
  }

  const qty = Math.floor(Number(quantity) || 0);
  if (!Number.isFinite(qty) || qty < 1) {
    const err = new Error('quantity must be at least 1');
    err.statusCode = 400;
    throw err;
  }

  if (!variantId) {
    const err = new Error('variantId is required');
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

    assertEditable(order);

    const variant = await Variant.findById(variantId).session(session);
    if (!variant) {
      const err = new Error('Variant not found');
      err.statusCode = 404;
      throw err;
    }

    const available = (Number(variant.realStock) || 0) - (Number(variant.onHoldStock) || 0);
    if (available < qty) {
      const err = new Error(`Insufficient stock for ${variant.sku} (available ${Math.max(0, available)})`);
      err.statusCode = 409;
      throw err;
    }

    await applyLedgerEntries(
      [
        {
          variantId: variant._id,
          orderId: order._id,
          ledgerType: 'on_hold_reserve',
          quantityDelta: qty,
          actorUserId,
        },
      ],
      session
    );

    const existing = (order.items || []).find(
      (i) => String(i.variantId) === String(variant._id)
    );
    if (existing) {
      existing.quantity = (Number(existing.quantity) || 0) + qty;
      if (existing.unitSellingPrice == null) existing.unitSellingPrice = variant.sellingPrice;
      if (existing.unitCogs == null) existing.unitCogs = variant.cogs;
    } else {
      order.items.push({
        variantId: variant._id,
        sku: variant.sku,
        quantity: qty,
        unitSellingPrice: variant.sellingPrice,
        unitCogs: variant.cogs,
      });
    }

    recalcMerchandiseTotals(order);

    order.verificationLog.push({
      outcome: 'customer_requested_changes',
      note: `Added ${variant.sku} ×${qty}: ${addNote}`,
      actorUserId,
    });

    await order.save({ session });
    return order;
  });
}

export default { processExchange, removeOrderItem, addOrderItem };
