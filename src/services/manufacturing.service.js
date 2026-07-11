import ExcelJS from 'exceljs';
import Factory from '../models/Factory.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import Product from '../models/Product.js';
import Variant from '../models/Variant.js';
import { OPEN_PO_STATUSES, FACTORY_AVG_LEAD_TIME_MIN_SAMPLES } from '../constants/index.js';
import { stockIntake } from './order.service.js';

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function factoryLeadTimeStats() {
  const rows = await PurchaseOrder.aggregate([
    { $match: { status: 'received', receivedAt: { $ne: null } } },
    {
      $project: {
        factoryId: 1,
        startAt: { $ifNull: ['$sentAt', '$createdAt'] },
        receivedAt: 1,
      },
    },
    {
      $project: {
        factoryId: 1,
        leadDays: {
          $divide: [{ $subtract: ['$receivedAt', '$startAt'] }, 1000 * 60 * 60 * 24],
        },
      },
    },
    {
      $group: {
        _id: '$factoryId',
        avgLeadTimeDays: { $avg: '$leadDays' },
        completedPoCount: { $sum: 1 },
      },
    },
  ]);

  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        completedPoCount: row.completedPoCount,
        avgLeadTimeDays:
          row.completedPoCount >= FACTORY_AVG_LEAD_TIME_MIN_SAMPLES
            ? Math.round(row.avgLeadTimeDays * 10) / 10
            : null,
      },
    ])
  );
}

function attachFactoryStats(factory, statsMap) {
  const stats = statsMap.get(String(factory._id)) || { completedPoCount: 0, avgLeadTimeDays: null };
  return {
    ...factory,
    completedPoCount: stats.completedPoCount,
    avgLeadTimeDays: stats.avgLeadTimeDays,
  };
}

async function nextPoNumber() {
  const prefix = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const latest = await PurchaseOrder.findOne({ poNumber: new RegExp(`^${prefix}`) })
    .sort({ poNumber: -1 })
    .select('poNumber')
    .lean();
  const seq = latest ? parseInt(latest.poNumber.split('-').pop(), 10) + 1 : 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

function computeTotalCost(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
}

export async function listFactories({ activeOnly = true } = {}) {
  const filter = activeOnly ? { isActive: true } : {};
  const [factories, statsMap] = await Promise.all([
    Factory.find(filter).sort({ name: 1 }).lean(),
    factoryLeadTimeStats(),
  ]);
  return factories.map((f) => attachFactoryStats(f, statsMap));
}

export async function createFactory(data) {
  return Factory.create(data);
}

export async function updateFactory(id, data) {
  return Factory.findByIdAndUpdate(id, data, { new: true, runValidators: true });
}

export async function deleteFactory(id) {
  const openPos = await PurchaseOrder.countDocuments({
    factoryId: id,
    status: { $in: OPEN_PO_STATUSES },
  });
  if (openPos > 0) {
    const err = new Error('Cannot delete factory with open purchase orders');
    err.statusCode = 400;
    throw err;
  }
  return Factory.findByIdAndDelete(id);
}

/** Active products for factory ordering — includes factory + size variants. */
export async function listOrderableProducts({ q, factoryId, includeUnlinked = true, limit = 40 } = {}) {
  const filter = { status: 'active' };
  if (factoryId && includeUnlinked) {
    filter.$or = [
      { defaultFactoryId: factoryId },
      { defaultFactoryId: null },
      { defaultFactoryId: { $exists: false } },
    ];
  } else if (factoryId) {
    filter.defaultFactoryId = factoryId;
  }
  if (q && String(q).trim()) {
    const term = String(q).trim();
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const skuProductIds = await Variant.find({ sku: { $regex: escaped, $options: 'i' } })
      .distinct('productId');
    const textOr = [
      { title: { $regex: escaped, $options: 'i' } },
      { handle: { $regex: escaped, $options: 'i' } },
      { _id: { $in: skuProductIds } },
    ];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: textOr }];
      delete filter.$or;
    } else {
      filter.$or = textOr;
    }
  }

  const products = await Product.find(filter)
    .populate('defaultFactoryId', 'name leadTimeDays currency isActive')
    .sort({ title: 1 })
    .limit(Math.min(Number(limit) || 40, 100))
    .lean();

  const productIds = products.map((p) => p._id);
  const variants = productIds.length
    ? await Variant.find({ productId: { $in: productIds } })
        .select('sku title color size cogs sellingPrice realStock onlineStock onHoldStock productId')
        .sort({ color: 1, size: 1 })
        .lean()
    : [];

  const byProduct = new Map();
  for (const v of variants) {
    const key = String(v.productId);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(v);
  }

  return products.map((p) => {
    const factory = p.defaultFactoryId && typeof p.defaultFactoryId === 'object'
      ? p.defaultFactoryId
      : null;
    const productVariants = byProduct.get(String(p._id)) || [];
    return {
      _id: p._id,
      title: p.title,
      imageUrl: p.imageUrl,
      status: p.status,
      factoryId: factory?._id || p.defaultFactoryId || null,
      factoryName: factory?.name || null,
      factoryLeadTimeDays: factory?.leadTimeDays ?? null,
      variants: productVariants.map((v) => ({
        _id: v._id,
        sku: v.sku,
        title: v.title,
        color: v.color,
        size: v.size,
        cogs: v.cogs || 0,
        sellingPrice: v.sellingPrice || 0,
        realStock: v.realStock || 0,
      })),
    };
  });
}

export async function assignProductFactory(productId, factoryId) {
  const factory = await Factory.findById(factoryId);
  if (!factory || !factory.isActive) {
    const err = new Error('Factory not found or inactive');
    err.statusCode = 400;
    throw err;
  }
  const product = await Product.findByIdAndUpdate(
    productId,
    { defaultFactoryId: factoryId },
    { new: true }
  ).populate('defaultFactoryId', 'name leadTimeDays currency');
  if (!product) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    throw err;
  }
  return product;
}

async function linkProductsToFactory(variantIds, factoryId) {
  if (!variantIds?.length || !factoryId) return 0;
  const productIds = await Variant.find({ _id: { $in: variantIds } }).distinct('productId');
  if (!productIds.length) return 0;
  const result = await Product.updateMany(
    {
      _id: { $in: productIds },
      $or: [{ defaultFactoryId: null }, { defaultFactoryId: { $exists: false } }],
    },
    { $set: { defaultFactoryId: factoryId } }
  );
  return result.modifiedCount || 0;
}

export async function listPurchaseOrders({ status, factoryId, limit = 50, skip = 0 } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (factoryId) filter.factoryId = factoryId;

  const [orders, total] = await Promise.all([
    PurchaseOrder.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('factoryId', 'name country city leadTimeDays currency contactEmail')
      .populate('createdBy', 'name email'),
    PurchaseOrder.countDocuments(filter),
  ]);
  return { orders, total };
}

export async function getPurchaseOrder(id) {
  return PurchaseOrder.findById(id)
    .populate('factoryId')
    .populate('createdBy', 'name email')
    .populate('items.variantId', 'sku title color size imageUrl realStock');
}

async function enrichItems(items) {
  const enriched = [];
  for (const item of items) {
    const variant = await Variant.findById(item.variantId);
    if (!variant) {
      const err = new Error(`Variant not found: ${item.variantId}`);
      err.statusCode = 400;
      throw err;
    }
    enriched.push({
      variantId: variant._id,
      sku: variant.sku,
      title: variant.title,
      color: variant.color,
      size: variant.size,
      quantity: item.quantity,
      unitCost: item.unitCost,
      currency: item.currency || 'EGP',
    });
  }
  return enriched;
}

export async function createPurchaseOrder({
  factoryId,
  items,
  expectedDeliveryDate,
  notes,
  createdBy,
  linkFactory = true,
}) {
  let resolvedFactoryId = factoryId;

  // If factory omitted, resolve from products linked to the line items.
  if (!resolvedFactoryId && items?.length) {
    const variantIds = items.map((i) => i.variantId);
    const variants = await Variant.find({ _id: { $in: variantIds } })
      .select('productId')
      .lean();
    const productIds = [...new Set(variants.map((v) => String(v.productId)))];
    const products = await Product.find({ _id: { $in: productIds } })
      .select('defaultFactoryId title')
      .lean();
    const linked = products
      .map((p) => p.defaultFactoryId && String(p.defaultFactoryId))
      .filter(Boolean);
    const unique = [...new Set(linked)];
    if (unique.length === 1) {
      resolvedFactoryId = unique[0];
    } else if (unique.length === 0) {
      const err = new Error('Pick a factory — these products are not linked to one yet');
      err.statusCode = 400;
      throw err;
    } else {
      const err = new Error('Line items belong to different factories — split into separate orders');
      err.statusCode = 400;
      throw err;
    }
  }

  const factory = await Factory.findById(resolvedFactoryId);
  if (!factory || !factory.isActive) {
    const err = new Error('Factory not found or inactive');
    err.statusCode = 400;
    throw err;
  }
  const enrichedItems = await enrichItems(items);
  const poNumber = await nextPoNumber();
  const expected =
    expectedDeliveryDate ||
    (factory.leadTimeDays != null ? addDays(new Date(), factory.leadTimeDays) : undefined);

  const po = await PurchaseOrder.create({
    poNumber,
    factoryId: factory._id,
    items: enrichedItems,
    totalCost: computeTotalCost(enrichedItems),
    expectedDeliveryDate: expected,
    notes,
    createdBy,
    status: 'draft',
  });

  // Connect products ↔ factory when still unassigned.
  if (linkFactory !== false) {
    await linkProductsToFactory(
      enrichedItems.map((i) => i.variantId),
      factory._id
    );
  }

  return getPurchaseOrder(po._id);
}

export async function updatePurchaseOrder(id, { status, expectedDeliveryDate, notes, items }) {
  const po = await PurchaseOrder.findById(id);
  if (!po) {
    const err = new Error('Purchase order not found');
    err.statusCode = 404;
    throw err;
  }
  if (po.status === 'received' || po.status === 'cancelled') {
    const err = new Error('Cannot edit a closed purchase order');
    err.statusCode = 400;
    throw err;
  }

  if (items) {
    po.items = await enrichItems(items);
    po.totalCost = computeTotalCost(po.items);
  }
  if (expectedDeliveryDate !== undefined) po.expectedDeliveryDate = expectedDeliveryDate;
  if (notes !== undefined) po.notes = notes;
  if (status) {
    po.status = status;
    if (status === 'sent' && !po.sentAt) po.sentAt = new Date();
  }
  await po.save();
  return getPurchaseOrder(id);
}

export async function receivePurchaseOrder(id, actorUserId) {
  const po = await PurchaseOrder.findById(id);
  if (!po) {
    const err = new Error('Purchase order not found');
    err.statusCode = 404;
    throw err;
  }
  if (po.status === 'received') {
    const err = new Error('Purchase order already received');
    err.statusCode = 400;
    throw err;
  }
  if (po.status === 'cancelled') {
    const err = new Error('Cannot receive a cancelled purchase order');
    err.statusCode = 400;
    throw err;
  }

  if (!po.sentAt) po.sentAt = po.createdAt;

  for (const item of po.items) {
    await stockIntake({
      variantId: item.variantId,
      quantity: item.quantity,
      reasonCode: 'factory_receive',
      note: `PO ${po.poNumber}`,
      actorUserId,
      syncToShopify: false,
    });
  }

  po.status = 'received';
  po.receivedAt = new Date();
  await po.save();
  return getPurchaseOrder(id);
}

export async function exportPurchaseOrderExcel(id) {
  const po = await getPurchaseOrder(id);
  if (!po) {
    const err = new Error('Purchase order not found');
    err.statusCode = 404;
    throw err;
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Purchase Order');

  sheet.columns = [
    { header: 'PO Number', key: 'poNumber', width: 18 },
    { header: 'Factory', key: 'factory', width: 24 },
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Product', key: 'title', width: 30 },
    { header: 'Color', key: 'color', width: 14 },
    { header: 'Size', key: 'size', width: 10 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Unit Cost', key: 'unitCost', width: 12 },
    { header: 'Line Total', key: 'lineTotal', width: 12 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Expected Delivery', key: 'expectedDelivery', width: 18 },
  ];

  const factoryName = po.factoryId?.name || '';
  const expected = po.expectedDeliveryDate
    ? new Date(po.expectedDeliveryDate).toISOString().slice(0, 10)
    : '';

  for (const item of po.items) {
    sheet.addRow({
      poNumber: po.poNumber,
      factory: factoryName,
      sku: item.sku,
      title: item.title,
      color: item.color || '',
      size: item.size || '',
      quantity: item.quantity,
      unitCost: item.unitCost,
      lineTotal: item.quantity * item.unitCost,
      currency: item.currency || po.factoryId?.currency || 'EGP',
      expectedDelivery: expected,
    });
  }

  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, filename: `${po.poNumber}.xlsx` };
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
  exportPurchaseOrderExcel,
};
