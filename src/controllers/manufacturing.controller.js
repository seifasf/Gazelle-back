import * as manufacturingService from '../services/manufacturing.service.js';

export async function listFactories(req, res, next) {
  try {
    const factories = await manufacturingService.listFactories({
      activeOnly: req.query.activeOnly !== 'false',
    });
    res.json({ data: factories });
  } catch (err) {
    next(err);
  }
}

export async function createFactory(req, res, next) {
  try {
    const factory = await manufacturingService.createFactory(req.body);
    res.status(201).json({ data: factory });
  } catch (err) {
    next(err);
  }
}

export async function updateFactory(req, res, next) {
  try {
    const factory = await manufacturingService.updateFactory(req.params.id, req.body);
    res.json({ data: factory });
  } catch (err) {
    next(err);
  }
}

export async function deleteFactory(req, res, next) {
  try {
    await manufacturingService.deleteFactory(req.params.id);
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}

export async function listOrderableProducts(req, res, next) {
  try {
    const products = await manufacturingService.listOrderableProducts({
      q: req.query.q,
      factoryId: req.query.factoryId,
      includeUnlinked: req.query.includeUnlinked !== 'false',
      limit: Number(req.query.limit) || 40,
    });
    res.json({ data: products });
  } catch (err) {
    next(err);
  }
}

export async function assignProductFactory(req, res, next) {
  try {
    const product = await manufacturingService.assignProductFactory(
      req.params.productId,
      req.body.factoryId
    );
    res.json({ data: product });
  } catch (err) {
    next(err);
  }
}

export async function listPurchaseOrders(req, res, next) {
  try {
    const limit = Number(req.query.limit) || 50;
    const skip = Number(req.query.skip) || 0;
    const result = await manufacturingService.listPurchaseOrders({
      status: req.query.status,
      factoryId: req.query.factoryId,
      limit,
      skip,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPurchaseOrder(req, res, next) {
  try {
    const po = await manufacturingService.getPurchaseOrder(req.params.id);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    res.json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function createPurchaseOrder(req, res, next) {
  try {
    const po = await manufacturingService.createPurchaseOrder({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function updatePurchaseOrder(req, res, next) {
  try {
    const po = await manufacturingService.updatePurchaseOrder(req.params.id, req.body);
    res.json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function receivePurchaseOrder(req, res, next) {
  try {
    const po = await manufacturingService.receivePurchaseOrder(req.params.id, req.user._id);
    res.json({ data: po });
  } catch (err) {
    next(err);
  }
}

export async function exportPurchaseOrder(req, res, next) {
  try {
    const { buffer, filename } = await manufacturingService.exportPurchaseOrderExcel(req.params.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
}

export default {
  listFactories,
  createFactory,
  updateFactory,
  deleteFactory,
  listOrderableProducts,
  assignProductFactory,
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  receivePurchaseOrder,
  exportPurchaseOrder,
};
