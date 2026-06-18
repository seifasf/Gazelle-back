import * as fulfillmentService from '../services/fulfillment.service.js';

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

export default { getPickList, pickAndPack, getAwb };
