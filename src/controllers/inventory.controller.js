import * as productService from '../services/product.service.js';
import * as orderService from '../services/order.service.js';
import * as barcodeService from '../services/barcode.service.js';
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

export async function stockIntake(req, res, next) {
  try {
    const { variantId, quantity, reasonCode, note } = req.body;
    const result = await orderService.stockIntake({
      variantId,
      quantity,
      reasonCode,
      note,
      actorUserId: req.user._id,
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

export async function lookupVariantFamilyBySku(req, res, next) {
  try {
    const family = await productService.findVariantFamilyBySku(req.query.sku);
    if (!family) return res.status(404).json({ error: 'Variant not found' });
    res.json({ data: family });
  } catch (err) {
    next(err);
  }
}

export async function stockIntakeBatch(req, res, next) {
  try {
    const { items, reasonCode, note } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const results = [];
    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!item.variantId || !(quantity > 0)) continue;
      const result = await orderService.stockIntake({
        variantId: item.variantId,
        quantity,
        reasonCode,
        note,
        actorUserId: req.user._id,
      });
      results.push({
        variantId: item.variantId,
        quantity,
        ...result,
      });
    }

    if (!results.length) {
      return res.status(400).json({ error: 'Enter at least one size quantity greater than 0' });
    }

    res.json({ data: { results, count: results.length } });
  } catch (err) {
    next(err);
  }
}

/** Set absolute warehouse realStock for many variants (no Shopify write). */
export async function stockSetBatch(req, res, next) {
  try {
    const { items, reasonCode } = req.body || {};
    const data = await orderService.setRealStockBatch({
      items,
      reasonCode: reasonCode || 'stock_count',
      actorUserId: req.user._id,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function importRealStockExcel(req, res, next) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Excel file required (field: file)' });
    }
    const { importRealStockFromExcelBuffer } = await import('../services/stockImport.service.js');
    const report = await importRealStockFromExcelBuffer(req.file.buffer, {
      actorUserId: req.user._id,
      apply: req.body?.apply !== 'false' && req.body?.apply !== false,
    });
    res.json({ data: report });
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

export async function getQueueCounts(req, res, next) {
  try {
    const data = await productService.getStockQueueCounts();
    res.json({ data });
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

export async function exportCatalogStock(req, res, next) {
  try {
    const { sendExcel } = await import('../utils/excelExport.js');
    const { buffer, filename } = await productService.exportCatalogStockExcel({
      productIds: req.body?.productIds || [],
    });
    sendExcel(res, { buffer, filename });
  } catch (err) {
    next(err);
  }
}

export async function getVariantBarcodePng(req, res, next) {
  try {
    const { png, value } = await barcodeService.getVariantBarcodePng(req.params.id);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="barcode-${value}.png"`);
    res.send(png);
  } catch (err) {
    next(err);
  }
}

export async function getVariantBarcodeLabels(req, res, next) {
  try {
    const html = await barcodeService.buildBarcodeLabelHtml(req.params.id, req.query.copies);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    next(err);
  }
}

export default {
  listVariants,
  getVariant,
  adjustStock,
  stockIntake,
  stockIntakeBatch,
  stockSetBatch,
  importRealStockExcel,
  lookupVariantBySku,
  lookupVariantFamilyBySku,
  getLedger,
  listDiscrepancies,
  getQueueCounts,
  listCatalog,
  catalogFilters,
  exportCatalogStock,
  getVariantBarcodePng,
  getVariantBarcodeLabels,
};
