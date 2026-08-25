import * as orderService from '../services/order.service.js';
import * as exchangeService from '../services/exchange.service.js';

const STOCK_MANAGER_ORDER_STATUSES = new Set([
  'verified_ready_for_shipping',
  'awaiting_bosta_pickup',
  'out_of_stock',
  'picked_up_by_bosta',
  'local_shipping',
  'back_from_local_shipping',
  'in_transit',
  'returning_to_origin',
  'returned_awaiting_receipt',
  'returned_to_stock',
]);

function clampStatusFilterForRole(role, status) {
  if (role !== 'stock_manager') return status;

  if (!status) {
    return [...STOCK_MANAGER_ORDER_STATUSES].join(',');
  }

  const allowed = String(status)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => STOCK_MANAGER_ORDER_STATUSES.has(s));

  return allowed.length ? allowed.join(',') : [...STOCK_MANAGER_ORDER_STATUSES].join(',');
}

export async function listOrders(req, res, next) {
  try {
    const {
      status,
      limit,
      skip,
      search,
      orderSource,
      shippingMethod,
      isExchangeOrder,
      isReturnOrder,
      returnKind,
      placedFrom,
      placedTo,
      delayed,
    } = req.query;
    const statusFilter = clampStatusFilterForRole(req.user.role, status);

    const result = await orderService.listOrders({
      status: statusFilter,
      search,
      orderSource,
      shippingMethod,
      isExchangeOrder,
      isReturnOrder,
      returnKind,
      placedFrom,
      placedTo,
      delayed,
      limit: Number(limit) || 50,
      skip: Number(skip) || 0,
      sort: delayed === '1' || delayed === 'true' ? { delayedUntil: 1 } : undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getStateCounts(req, res, next) {
  try {
    const counts = await orderService.getOrderStateCounts();
    res.json({ data: counts });
  } catch (err) {
    next(err);
  }
}

export async function createManualOrder(req, res, next) {
  try {
    const order = await orderService.createManualOrder({
      ...req.body,
      actorUserId: req.user._id,
    });
    res.status(201).json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function findExchangeOrder(req, res, next) {
  try {
    const order = await orderService.findOrderForExchange(req.query.q || req.query.search);
    const city = order?.shippingAddress?.city;
    const suggested = await orderService.suggestShippingFeeByCity(city, 0);
    res.json({
      data: order,
      suggestedShippingFee: suggested,
    });
  } catch (err) {
    next(err);
  }
}

export async function suggestShippingFee(req, res, next) {
  try {
    const goodsTotal = Number(req.query.goodsTotal ?? req.query.subtotal ?? 0);
    const fee = await orderService.suggestShippingFeeByCity(
      req.query.city,
      Number.isFinite(goodsTotal) ? goodsTotal : 0
    );
    res.json({
      data: {
        city: String(req.query.city || '').trim() || null,
        shippingFee: fee,
        goodsTotal: Number.isFinite(goodsTotal) ? goodsTotal : 0,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function getOrder(req, res, next) {
  try {
    const order = await orderService.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function verifyOrder(req, res, next) {
  try {
    const order = await orderService.verifyOrder(req.params.id, req.user._id, req.body);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function bulkVerifyOrders(req, res, next) {
  try {
    const { orderIds, outcome, note, shippingMethod } = req.body || {};
    const results = await orderService.bulkVerifyOrders(orderIds, req.user._id, {
      outcome,
      note,
      shippingMethod,
    });
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
}

export async function cancelOrder(req, res, next) {
  try {
    const order = await orderService.cancelOrder(req.params.id, req.user._id, req.body);
    const warning = order?.shopifyCancelWarning;
    if (warning) {
      const data = order.toObject ? order.toObject() : { ...order };
      delete data.shopifyCancelWarning;
      return res.json({
        data,
        warning: `Order cancelled in Gazelle, but Shopify cancel failed: ${warning}`,
      });
    }
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function confirmReturn(req, res, next) {
  try {
    const order = await orderService.confirmReturnedToStock(
      req.params.id,
      req.user._id,
      req.body.note
    );
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function getStatusHistory(req, res, next) {
  try {
    const history = await orderService.getOrderStatusHistory(req.params.id);
    res.json({ data: history });
  } catch (err) {
    next(err);
  }
}

export async function claimOrder(req, res, next) {
  try {
    const role = req.user.role;
    const order = await orderService.claimOrder(req.params.id, req.user._id, role);
    if (!order) return res.status(409).json({ error: 'Order already claimed or not found' });
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function exchangeItem(req, res, next) {
  try {
    const order = await exchangeService.processExchange(req.params.id, req.user._id, req.body);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function removeItem(req, res, next) {
  try {
    const order = await exchangeService.removeOrderItem(req.params.id, req.user._id, req.body);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function addItem(req, res, next) {
  try {
    const order = await exchangeService.addOrderItem(req.params.id, req.user._id, req.body);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function updateShippingAddress(req, res, next) {
  try {
    const Order = (await import('../models/Order.js')).default;
    const {
      SHIPPING_METHODS,
      LOCAL_SHIPPING_FEE,
      DEFAULT_BOSTA_SHIPPING_FEE,
    } = await import('../constants/index.js');
    const order = await Order.findById(req.params.id).populate('customerId');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (
      !['pending_verification', 'no_response', 'verified_ready_for_shipping', 'out_of_stock', 'awaiting_bosta_pickup'].includes(
        order.internalStatus
      )
    ) {
      return res.status(400).json({ error: 'Cannot edit address at this stage' });
    }

    const {
      shippingMethod,
      line1,
      line2,
      city,
      zone,
      phone,
      fullName,
    } = req.body || {};

    const prevMethod = order.shippingMethod || 'bosta';
    if (shippingMethod != null && shippingMethod !== '') {
      if (!SHIPPING_METHODS.includes(shippingMethod)) {
        return res.status(400).json({ error: 'Invalid shipping method' });
      }
      if (order.isExchangeOrder && shippingMethod === 'pickup') {
        return res.status(400).json({ error: 'Exchange orders cannot use pickup' });
      }
      if (order.isReturnOrder && shippingMethod !== 'bosta') {
        return res.status(400).json({ error: 'Return pickups must use Bosta' });
      }
      order.shippingMethod = shippingMethod;
      if (shippingMethod === 'local_shipping') {
        order.shippingFee = LOCAL_SHIPPING_FEE;
      } else if (shippingMethod === 'pickup') {
        order.shippingFee = 0;
      } else if (shippingMethod === 'bosta' && prevMethod !== 'bosta') {
        const goods = Number(order.totalSellingPrice) || 0;
        const suggested = await orderService.suggestShippingFeeByCity(
          city || order.shippingAddress?.city,
          goods
        );
        order.shippingFee = suggested ?? DEFAULT_BOSTA_SHIPPING_FEE;
      }
    }

    const prev = order.shippingAddress?.toObject?.() || order.shippingAddress || {};
    const nextAddress = { ...prev };
    if (line1 !== undefined) nextAddress.line1 = line1;
    if (line2 !== undefined) nextAddress.line2 = line2;
    if (city !== undefined) nextAddress.city = city;
    if (zone !== undefined) nextAddress.zone = zone;
    if (phone !== undefined) nextAddress.phone = phone;
    if (fullName !== undefined) nextAddress.fullName = fullName;
    order.shippingAddress = nextAddress;

    const addressChanged =
      String(nextAddress.line1 || '') !== String(prev.line1 || '')
      || String(nextAddress.line2 || '') !== String(prev.line2 || '')
      || String(nextAddress.city || '') !== String(prev.city || '')
      || String(nextAddress.zone || '') !== String(prev.zone || '')
      || String(nextAddress.phone || '') !== String(prev.phone || '')
      || String(nextAddress.fullName || '') !== String(prev.fullName || '');

    // Always recalculate Shopify zone fee for Bosta when destination is known.
    if (order.shippingMethod === 'bosta' && !order.isReturnOrder) {
      const destCity = String(nextAddress.city || '').trim();
      if (destCity) {
        const goods = Number(order.totalSellingPrice) || 0;
        const suggested = await orderService.suggestShippingFeeByCity(destCity, goods);
        if (suggested != null) order.shippingFee = suggested;
      }
    }

    // Address fix after a failed Bosta create — clear so stock can retry scan & ship.
    if (order.bostaShipmentStatus === 'failed' && !order.bostaDeliveryId) {
      order.bostaShipmentStatus = 'none';
      order.bostaShipmentError = null;
    }

    if (addressChanged) {
      order.verificationLog = order.verificationLog || [];
      order.verificationLog.push({
        outcome: 'confirmed',
        note: `Address updated → ${[nextAddress.line1, nextAddress.zone, nextAddress.city].filter(Boolean).join(' · ')} · shipping EGP ${order.shippingFee ?? 0}`,
        actorUserId: req.user?._id,
      });
    }

    await order.save();

    let shopifyPickupWarning = null;
    if (order.shippingMethod === 'pickup') {
      try {
        const { zeroShopifyShippingForPickup } = await import(
          '../integrations/shopify/zeroPickupShipping.service.js'
        );
        await zeroShopifyShippingForPickup(order);
      } catch (err) {
        shopifyPickupWarning = `Pickup saved in Gazelle (shipping EGP 0), but Shopify shipping was not cleared: ${err.message}`;
      }
    }

    let bostaSync = null;
    if (
      addressChanged
      && order.shippingMethod === 'bosta'
      && order.bostaDeliveryId
    ) {
      try {
        const { updateDeliveryAddressAndCod } = await import('../integrations/bosta/shipments.service.js');
        bostaSync = await updateDeliveryAddressAndCod(
          order.bostaDeliveryId,
          order,
          order.customerId
        );
      } catch (err) {
        // OMS address/fee already saved — surface Bosta failure so OM can retry / call support.
        return res.json({
          data: order,
          warning: `Address saved in Gazelle, but Bosta AWB was not updated: ${err.message}. Reprint/check AWB or contact Bosta if the parcel is already moving.`,
        });
      }
    }

    res.json({
      data: order,
      ...(bostaSync ? { bostaUpdated: true } : {}),
      ...(shopifyPickupWarning ? { warning: shopifyPickupWarning } : {}),
    });
  } catch (err) {
    next(err);
  }
}

export async function transitionStatus(req, res, next) {
  try {
    const toStatus = req.body.toStatus;
    const role = req.user.role;

    // Stock: Out of stock ↔ Ready, plus Awaiting Bosta → Ready / OOS / Pending.
    if (role === 'stock_manager') {
      const Order = (await import('../models/Order.js')).default;
      const current = await Order.findById(req.params.id).select('internalStatus');
      const fromStatus = current?.internalStatus;
      const allowed =
        toStatus === 'verified_ready_for_shipping'
        || toStatus === 'out_of_stock'
        || (
          fromStatus === 'awaiting_bosta_pickup'
          && ['verified_ready_for_shipping', 'out_of_stock', 'pending_verification'].includes(toStatus)
        );
      if (!allowed) {
        return res.status(403).json({
          error: 'Stock managers can move Ready ↔ Out of stock, or pull Awaiting Bosta pickup back to Ready / Out of stock / Pending',
        });
      }
    }

    const order = await orderService.transitionOrderStatus(req.params.id, toStatus, {
      source: 'user_action',
      actorUserId: req.user._id,
      note: req.body.note,
    });
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function delayOrder(req, res, next) {
  try {
    const order = await orderService.delayOrder(req.params.id, req.user._id, req.body);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function applyDiscount(req, res, next) {
  try {
    const order = await orderService.applyOrderDiscount(req.params.id, req.user._id, req.body);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function partialLocalDelivery(req, res, next) {
  try {
    const order = await orderService.partialLocalDelivery(req.params.id, req.user._id, req.body);
    const summary = order?._partialSummary || null;
    const data = typeof order?.toObject === 'function' ? order.toObject() : order;
    if (summary) data.partialSummary = summary;
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function returnLocalShippingToStock(req, res, next) {
  try {
    const order = await orderService.returnLocalShippingToStock(
      req.params.id,
      req.user._id,
      req.body || {}
    );
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export default {
  listOrders,
  getStateCounts,
  createManualOrder,
  findExchangeOrder,
  suggestShippingFee,
  getOrder,
  verifyOrder,
  bulkVerifyOrders,
  cancelOrder,
  confirmReturn,
  getStatusHistory,
  claimOrder,
  exchangeItem,
  removeItem,
  addItem,
  updateShippingAddress,
  transitionStatus,
  delayOrder,
  applyDiscount,
  partialLocalDelivery,
  returnLocalShippingToStock,
};
