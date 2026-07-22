import ExcelJS from 'exceljs';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Factory from '../models/Factory.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import Product from '../models/Product.js';
import Variant from '../models/Variant.js';
import { OPEN_PO_STATUSES, FACTORY_AVG_LEAD_TIME_MIN_SAMPLES } from '../constants/index.js';
import { stockIntake } from './order.service.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Black mark on transparent — visible on white Excel sheets (white logo is invisible). */
const LOGO_PATH = resolve(__dirname, '../assets/gazelle-logo-black.png');
const LOGO_FALLBACK_PATH = resolve(__dirname, '../assets/gazelle-logo.png');

function logoBase64Raw() {
  for (const path of [LOGO_PATH, LOGO_FALLBACK_PATH]) {
    try {
      return readFileSync(path).toString('base64');
    } catch {
      // try next
    }
  }
  return null;
}

function sizeSortKey(size) {
  const n = parseFloat(String(size ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : String(size ?? '');
}

function productDisplayTitle(item) {
  return (
    item.variantId?.productId?.title ||
    item.title ||
    item.variantId?.title ||
    item.sku ||
    'Product'
  );
}

function groupPoItemsByProduct(items = []) {
  const groups = new Map();
  for (const item of items) {
    const productId = item.variantId?.productId?._id || item.variantId?.productId;
    const key = productId ? String(productId) : `title:${productDisplayTitle(item)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: productDisplayTitle(item),
        imageUrl:
          item.variantId?.productId?.imageUrl ||
          item.variantId?.imageUrl ||
          item.imageUrl ||
          null,
        lines: [],
      });
    }
    groups.get(key).lines.push(item);
  }
  for (const g of groups.values()) {
    g.lines.sort((a, b) => {
      const sa = sizeSortKey(a.size || a.variantId?.size);
      const sb = sizeSortKey(b.size || b.variantId?.size);
      if (typeof sa === 'number' && typeof sb === 'number') return sa - sb;
      return String(sa).localeCompare(String(sb), undefined, { numeric: true });
    });
  }
  return [...groups.values()];
}

async function fetchImageAsBase64(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    const ctype = response.headers.get('content-type') || '';
    const extension = ctype.includes('jpeg') || ctype.includes('jpg') ? 'jpeg' : 'png';
    return { base64: buf.toString('base64'), extension };
  } catch (err) {
    logger.warn({ err: err.message, url }, 'PO excel image fetch failed');
    return null;
  }
}

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
    .populate({
      path: 'items.variantId',
      select: 'sku title color size imageUrl realStock productId',
      populate: { path: 'productId', select: 'title imageUrl' },
    });
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
  workbook.creator = 'Gazelle OMS';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Factory order', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.columns = [
    { key: 'size', width: 12 },
    { key: 'sku', width: 22 },
    { key: 'color', width: 14 },
    { key: 'qty', width: 10 },
    { key: 'cost', width: 12 },
    { key: 'total', width: 14 },
  ];

  const factoryName = po.factoryId?.name || '—';
  const factoryContact = [po.factoryId?.contactName, po.factoryId?.phone, po.factoryId?.email]
    .filter(Boolean)
    .join(' · ');
  const currency = po.factoryId?.currency || po.items?.[0]?.currency || 'EGP';
  const issued = po.createdAt
    ? new Date(po.createdAt).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // Header — black logo (visible on white) + simple order meta (no Status / Expected).
  sheet.getRow(1).height = 56;
  try {
    const logoB64 = logoBase64Raw();
    if (logoB64) {
      const logoId = workbook.addImage({ base64: logoB64, extension: 'png' });
      sheet.addImage(logoId, {
        tl: { col: 0, row: 0 },
        ext: { width: 72, height: 72 },
        editAs: 'oneCell',
      });
    }
  } catch {
    // logo optional
  }

  sheet.mergeCells('B1', 'F1');
  sheet.getCell('B1').value = 'GAZELLE — Factory production order';
  sheet.getCell('B1').font = { bold: true, size: 16, color: { argb: 'FF111111' } };
  sheet.getCell('B1').alignment = { vertical: 'middle' };

  sheet.getRow(3).values = ['Order #', po.poNumber, '', 'Date', issued];
  sheet.getRow(4).values = ['Factory', factoryName];
  sheet.mergeCells('B4', 'F4');
  sheet.getRow(5).values = ['Contact', factoryContact || '—'];
  sheet.mergeCells('B5', 'F5');
  let metaRow = 5;
  if (po.notes) {
    metaRow = 6;
    sheet.getRow(6).values = ['Notes', po.notes];
    sheet.mergeCells('B6', 'F6');
  }
  for (const r of [3, 4, 5, 6]) {
    if (sheet.getCell(`A${r}`).value) {
      sheet.getCell(`A${r}`).font = { bold: true, color: { argb: 'FF555555' } };
    }
  }

  const groups = groupPoItemsByProduct(po.items || []);
  let rowIdx = metaRow + 2;
  let grandQty = 0;
  let grandTotal = 0;

  for (const group of groups) {
    // Product title
    sheet.mergeCells(`A${rowIdx}`, `F${rowIdx}`);
    sheet.getCell(`A${rowIdx}`).value = group.title;
    sheet.getCell(`A${rowIdx}`).font = { bold: true, size: 14, color: { argb: 'FF111111' } };
    sheet.getCell(`A${rowIdx}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF5C518' },
    };
    sheet.getRow(rowIdx).height = 24;
    rowIdx += 1;

    // Big product image
    const imgStartRow = rowIdx;
    sheet.getRow(rowIdx).height = 18;
    sheet.mergeCells(`A${rowIdx}`, `F${rowIdx + 7}`);
    for (let i = 0; i < 8; i += 1) {
      sheet.getRow(rowIdx + i).height = 18;
    }
    const img = await fetchImageAsBase64(group.imageUrl);
    if (img) {
      try {
        const imageId = workbook.addImage({
          base64: img.base64,
          extension: img.extension,
        });
        sheet.addImage(imageId, {
          tl: { col: 0.15, row: imgStartRow - 1 + 0.1 },
          ext: { width: 160, height: 160 },
          editAs: 'oneCell',
        });
      } catch {
        sheet.getCell(`A${imgStartRow}`).value = '(image unavailable)';
        sheet.getCell(`A${imgStartRow}`).font = { italic: true, color: { argb: 'FF999999' } };
      }
    } else {
      sheet.getCell(`A${imgStartRow}`).value = '(no product image)';
      sheet.getCell(`A${imgStartRow}`).font = { italic: true, color: { argb: 'FF999999' } };
    }
    rowIdx += 8;

    // Size / SKU table
    const headerRow = rowIdx;
    sheet.getRow(headerRow).values = ['Size', 'SKU', 'Color', 'Qty', 'Unit cost', 'Line total'];
    sheet.getRow(headerRow).font = { bold: true, color: { argb: 'FF111111' } };
    sheet.getRow(headerRow).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEEEEEE' },
    };
    rowIdx += 1;

    let productQty = 0;
    let productTotal = 0;
    for (const item of group.lines) {
      const qty = Number(item.quantity) || 0;
      const unitCost = Number(item.unitCost) || 0;
      const lineTotal = qty * unitCost;
      productQty += qty;
      productTotal += lineTotal;
      grandQty += qty;
      grandTotal += lineTotal;

      sheet.getRow(rowIdx).values = [
        item.size || item.variantId?.size || '—',
        item.sku || item.variantId?.sku || '—',
        item.color || item.variantId?.color || '—',
        qty,
        unitCost,
        lineTotal,
      ];
      sheet.getCell(`E${rowIdx}`).numFmt = '#,##0.00';
      sheet.getCell(`F${rowIdx}`).numFmt = '#,##0.00';
      rowIdx += 1;
    }

    sheet.getRow(rowIdx).values = [
      '',
      '',
      'Product total',
      productQty,
      '',
      productTotal,
    ];
    sheet.getCell(`C${rowIdx}`).font = { bold: true };
    sheet.getCell(`D${rowIdx}`).font = { bold: true };
    sheet.getCell(`F${rowIdx}`).font = { bold: true };
    sheet.getCell(`F${rowIdx}`).numFmt = '#,##0.00';
    sheet.getCell(`C${rowIdx}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF6D1' },
    };
    sheet.getCell(`D${rowIdx}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF6D1' },
    };
    sheet.getCell(`F${rowIdx}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF6D1' },
    };
    rowIdx += 2;
  }

  sheet.getCell(`A${rowIdx}`).value = 'ORDER TOTAL';
  sheet.getCell(`A${rowIdx}`).font = { bold: true, size: 12 };
  sheet.mergeCells(`A${rowIdx}`, `B${rowIdx}`);
  rowIdx += 1;
  sheet.getRow(rowIdx).values = ['Products', groups.length, '', 'Units', grandQty];
  rowIdx += 1;
  sheet.getRow(rowIdx).values = ['Currency', currency, '', 'Grand total', grandTotal];
  sheet.getCell(`E${rowIdx}`).numFmt = '#,##0.00';
  sheet.getCell(`D${rowIdx}`).font = { bold: true };
  sheet.getCell(`E${rowIdx}`).font = { bold: true, size: 13 };
  sheet.getCell(`D${rowIdx}`).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF5C518' },
  };
  sheet.getCell(`E${rowIdx}`).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF5C518' },
  };

  rowIdx += 2;
  sheet.getCell(`A${rowIdx}`).value = 'Prepared by Gazelle OMS for factory production';
  sheet.getCell(`A${rowIdx}`).font = { italic: true, size: 9, color: { argb: 'FF999999' } };
  sheet.mergeCells(`A${rowIdx}`, `F${rowIdx}`);

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, filename: `${po.poNumber}-factory-order.xlsx` };
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
