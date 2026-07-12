import * as fulfillmentService from '../services/fulfillment.service.js';
import * as warehouseReviewService from '../services/warehouseReview.service.js';
import { sendExcel } from '../utils/excelExport.js';
import Order from '../models/Order.js';

export async function getWarehouseReview(req, res, next) {
  try {
    const data = await warehouseReviewService.getWarehouseBacklog({
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function exportWarehouseReview(req, res, next) {
  try {
    const { buffer, filename } = await warehouseReviewService.exportWarehouseBacklogExcel({
      from: req.query.from,
      to: req.query.to,
    });
    sendExcel(res, { buffer, filename });
  } catch (err) {
    next(err);
  }
}

export async function getPickList(req, res, next) {
  try {
    const orders = await fulfillmentService.getPickList();
    res.json({ data: orders });
  } catch (err) {
    next(err);
  }
}

export async function pickAndPack(req, res, next) {
  try {
    const result = await fulfillmentService.pickAndPackOrder(req.params.id, req.user._id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getAwb(req, res, next) {
  try {
    const awb = await fulfillmentService.getAwbForOrder(req.params.id);
    res.json({ data: awb });
  } catch (err) {
    next(err);
  }
}

export async function getShipmentStatus(req, res, next) {
  try {
    const status = await fulfillmentService.getShipmentStatus(req.params.id);
    res.json({ data: status });
  } catch (err) {
    next(err);
  }
}

export async function checkStock(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    const warnings = await fulfillmentService.checkStockAvailability(order);
    res.json({ data: { warnings } });
  } catch (err) {
    next(err);
  }
}

export async function getOrderSheet(req, res, next) {
  try {
    const sheet = await fulfillmentService.buildOrderSheet(req.params.id);
    res.json({ data: sheet });
  } catch (err) {
    next(err);
  }
}

export default {
  getWarehouseReview,
  exportWarehouseReview,
  getPickList,
  pickAndPack,
  getAwb,
  getShipmentStatus,
  checkStock,
  getOrderSheet,
};
