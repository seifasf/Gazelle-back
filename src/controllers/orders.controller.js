import * as orderService from '../services/order.service.js';
import * as exchangeService from '../services/exchange.service.js';

export async function listOrders(req, res, next) {
  try {
    const { status, limit, skip, search, orderSource, shippingMethod } = req.query;
    let statusFilter = status;

    if (!statusFilter && req.user.role === 'stock_manager') {
      statusFilter = 'verified_ready_for_shipping,picked_up_by_bosta,in_transit,returning_to_origin';
    }

    const result = await orderService.listOrders({
      status: statusFilter,
      search,
      orderSource,
      shippingMethod,
      limit: Number(limit) || 50,
      skip: Number(skip) || 0,
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

export async function cancelOrder(req, res, next) {
  try {
    const order = await orderService.cancelOrder(req.params.id, req.user._id, req.body);
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

export async function updateShippingAddress(req, res, next) {
  try {
    const Order = (await import('../models/Order.js')).default;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['pending_verification', 'verified_ready_for_shipping'].includes(order.internalStatus)) {
      return res.status(400).json({ error: 'Cannot edit address at this stage' });
    }
    order.shippingAddress = { ...order.shippingAddress.toObject?.() || order.shippingAddress, ...req.body };
    await order.save();
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export async function transitionStatus(req, res, next) {
  try {
    const order = await orderService.transitionOrderStatus(req.params.id, req.body.toStatus, {
      source: 'user_action',
      actorUserId: req.user._id,
      note: req.body.note,
    });
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

export default {
  listOrders,
  getStateCounts,
  createManualOrder,
  getOrder,
  verifyOrder,
  cancelOrder,
  confirmReturn,
  getStatusHistory,
  claimOrder,
  exchangeItem,
  updateShippingAddress,
  transitionStatus,
};
