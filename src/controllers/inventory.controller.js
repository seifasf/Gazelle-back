import * as productService from '../services/product.service.js';
import * as orderService from '../services/order.service.js';
import Settings from '../models/Settings.js';

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
    const { quantityDelta, reasonCode, syncToShopify } = req.body;
    const result = await orderService.manualStockAdjustment({
      variantId: req.params.id,
      quantityDelta,
      reasonCode,
      actorUserId: req.user._id,
      syncToShopify: syncToShopify === true,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function stockIntake(req, res, next) {
  try {
    const { variantId, quantity, reasonCode, note, syncToShopify } = req.body;
    const result = await orderService.stockIntake({
      variantId,
      quantity,
      reasonCode,
      note,
      actorUserId: req.user._id,
      syncToShopify: syncToShopify !== false,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function lookupVariantBySku(req, res, next) {
  try {
    const variant = await productService.findVariantBySku(req.query.sku);
    if (!variant) return res.status(404).json({ error: 'Variant not found' });
    res.json({ data: variant });
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

export async function listCatalog(req, res, next) {
  try {
    const limit = Number(req.query.limit) || 24;
    const page = Number(req.query.page) || 1;
    const skip = req.query.skip != null ? Number(req.query.skip) : (page - 1) * limit;

    const [result, settings] = await Promise.all([
      productService.listCatalog({
        search: req.query.search,
        productType: req.query.productType,
        vendor: req.query.vendor,
        color: req.query.color,
        size: req.query.size,
        stockStatus: req.query.stockStatus,
        lowRealStock: req.query.lowRealStock === 'true',
        status: req.query.status || 'active',
        limit,
        skip,
      }),
      Settings.findOne({ key: 'global' }).lean(),
    ]);
    res.json({
      ...result,
      shopifyCatalogMode: settings?.shopifyCatalogMode || 'none',
      shopifyConfigured: Boolean(settings?.shopifyAccessToken),
    });
  } catch (err) {
    next(err);
  }
}

export async function catalogFilters(req, res, next) {
  try {
    const data = await productService.getCatalogFilterOptions({
      status: req.query.status || 'active',
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export default {
  listVariants,
  getVariant,
  adjustStock,
  stockIntake,
  lookupVariantBySku,
  getLedger,
  listDiscrepancies,
  listCatalog,
  catalogFilters,
};
