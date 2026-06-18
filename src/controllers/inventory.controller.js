import * as productService from '../services/product.service.js';
import * as orderService from '../services/order.service.js';

export async function listVariants(req, res, next) {
  try {
    const result = await productService.listVariants({
      search: req.query.search,
      lowStockOnly: req.query.lowStock === 'true',
      limit: Number(req.query.limit) || 50,
      skip: Number(req.query.skip) || 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getVariant(req, res, next) {
  try {
    const variant = await productService.getVariantById(req.params.id);
    res.json({ data: variant });
  } catch (err) {
    next(err);
  }
}

export async function adjustStock(req, res, next) {
  try {
    const { quantityDelta, reasonCode } = req.body;
    const result = await orderService.manualStockAdjustment({
      variantId: req.params.id,
      quantityDelta,
      reasonCode,
      actorUserId: req.user._id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getLedger(req, res, next) {
  try {
    const result = await productService.getVariantLedger(req.params.id, req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function listDiscrepancies(req, res, next) {
  try {
    const discrepancyService = await import('../services/discrepancy.service.js');
    const result = await discrepancyService.listUnresolvedAlerts(req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export default { listVariants, getVariant, adjustStock, getLedger, listDiscrepancies };
