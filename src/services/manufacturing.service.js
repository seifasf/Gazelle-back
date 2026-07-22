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

/** Write A,B,C… from a 0-based cells array (ExcelJS contiguous assignment). */
function writeRow(sheet, rowNumber, cells) {
  const row = sheet.getRow(rowNumber);
  row.values = cells;
  return row;
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function sizeSortKey(size) {
  const n = parseFloat(String(size ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : String(size ?? '');
}

function productDisplayTitle(item) {
  const fromProduct = item.variantId?.productId?.title;
  if (fromProduct) return String(fromProduct).trim();
  // Variant titles are often "41 / Brown" — strip size prefix for a cleaner group name.
  const raw = String(item.title || item.variantId?.title || item.sku || 'Product').trim();
  return raw.replace(/^\d+\s*\/\s*/i, '') || raw;
}

function itemColor(item) {
  return item.color || item.variantId?.color || '—';
}

function itemSize(item) {
  return item.size || item.variantId?.size || '—';
}

function itemSku(item) {
  return item.sku || item.variantId?.sku || '—';
}

/**
 * One block per product + color (factory style), with all sizes underneath.
 * Grand total is always the sum of every PO line — grouping never drops lines.
 */
function groupPoItemsByProduct(items = []) {
  const groups = new Map();
  for (const item of items) {
    const productId = item.variantId?.productId?._id || item.variantId?.productId;
    const color = itemColor(item);
    const key = productId ? `${productId}::${color}` : `title:${productDisplayTitle(item)}::${color}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: productDisplayTitle(item),
        color,
        imageUrl:
          item.variantId?.imageUrl ||
          item.variantId?.productId?.imageUrl ||
          item.imageUrl ||
          null,
        lines: [],
        qty: 0,
        total: 0,
      });
    }
    const g = groups.get(key);
    g.lines.push(item);
    const qty = Number(item.quantity) || 0;
    const lineTotal = money(qty * (Number(item.unitCost) || 0));
    g.qty += qty;
    g.total = money(g.total + lineTotal);
  }
  for (const g of groups.values()) {
    g.lines.sort((a, b) => {
      const sa = sizeSortKey(itemSize(a));
      const sb = sizeSortKey(itemSize(b));
      if (typeof sa === 'number' && typeof sb === 'number') return sa - sb;
      return String(sa).localeCompare(String(sb), undefined, { numeric: true });
    });
  }
  return [...groups.values()];
}

async function optimizeImageBuffer(buf) {
  try {
    const sharp = (await import('sharp')).default;
    // PNG + cell-anchored embeds survive WhatsApp → Excel open better than floating JPEGs.
    const out = await sharp(buf)
      .rotate()
      .resize(140, 140, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();
    return { base64: out.toString('base64'), extension: 'png' };
  } catch {
    if (buf.length > 350_000) return null;
    return { base64: buf.toString('base64'), extension: 'png' };
  }
}

/**
 * Embed image over a cell range (Place over cells). More portable than fractional
 * floating anchors — WhatsApp / Sheets / older Excel often drop those.
 */
function embedSheetImage(sheet, workbook, img, { col, row, colSpan = 1, rowSpan = 1 }) {
  if (!img?.base64) return false;
  try {
    const imageId = workbook.addImage({
      base64: img.base64,
      extension: img.extension === 'jpeg' || img.extension === 'jpg' ? 'jpeg' : 'png',
    });
    const startCol = col; // 0-based
    const startRow = row; // 0-based
    sheet.addImage(imageId, {
      tl: { col: startCol, row: startRow },
      br: { col: startCol + colSpan, row: startRow + rowSpan },
      editAs: 'oneCell',
    });
    return true;
  } catch {
    return false;
  }
}

async function fetchImageAsBase64(url, cache = new Map()) {
  if (!url || typeof url !== 'string') return null;
  if (cache.has(url)) return cache.get(url);
  const pending = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) return null;
      const buf = Buffer.from(await response.arrayBuffer());
      return optimizeImageBuffer(buf);
    } catch (err) {
      logger.warn({ err: err.message, url }, 'PO excel image fetch failed');
      return null;
    }
  })();
  cache.set(url, pending);
  return pending;
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
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
    views: [{ state: 'normal', showGridLines: true }],
  });

  sheet.columns = [
    { width: 14 }, // A — size
    { width: 24 }, // B — sku
    { width: 14 }, // C — color
    { width: 10 }, // D — qty
    { width: 14 }, // E — unit cost
    { width: 16 }, // F — line total
  ];

  const factoryName = po.factoryId?.name || '—';
  const factoryContact = [po.factoryId?.contactName, po.factoryId?.phone, po.factoryId?.email]
    .filter(Boolean)
    .join(' · ');
  const currency = po.factoryId?.currency || po.items?.[0]?.currency || 'EGP';
  const issued = po.createdAt
    ? new Date(po.createdAt).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const items = po.items || [];
  // Authoritative totals from every line (same math as the old flat export).
  let grandQty = 0;
  let grandTotal = 0;
  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    grandQty += qty;
    grandTotal = money(grandTotal + qty * (Number(item.unitCost) || 0));
  }

  const groups = groupPoItemsByProduct(items);

  // Prefetch + compress unique product images in parallel (keeps the xlsx small/fast).
  const imageCache = new Map();
  await Promise.all(groups.map((g) => fetchImageAsBase64(g.imageUrl, imageCache)));

  sheet.getRow(1).height = 88;
  try {
    const logoB64 = logoBase64Raw();
    if (logoB64) {
      embedSheetImage(sheet, workbook, { base64: logoB64, extension: 'png' }, {
        col: 0,
        row: 0,
        colSpan: 1,
        rowSpan: 1,
      });
    }
  } catch {
    // logo optional
  }

  sheet.mergeCells('B1', 'F1');
  sheet.getCell('B1').value = 'GAZELLE — Factory production order';
  sheet.getCell('B1').font = { bold: true, size: 18, color: { argb: 'FF111111' } };
  sheet.getCell('B1').alignment = { vertical: 'middle' };

  writeRow(sheet, 3, ['Order #', po.poNumber, '', 'Date', issued]);
  writeRow(sheet, 4, ['Factory', factoryName]);
  sheet.mergeCells('B4', 'F4');
  writeRow(sheet, 5, ['Contact', factoryContact || '—']);
  sheet.mergeCells('B5', 'F5');
  let metaRow = 5;
  if (po.notes) {
    metaRow = 6;
    writeRow(sheet, 6, ['Notes', po.notes]);
    sheet.mergeCells('B6', 'F6');
  }
  for (const r of [3, 4, 5, 6]) {
    if (sheet.getCell(r, 1).value) {
      sheet.getCell(r, 1).font = { bold: true, color: { argb: 'FF555555' } };
    }
  }

  let rowIdx = metaRow + 2;
  const fillYellow = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF5C518' },
  };
  const fillMuted = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEEEEE' },
  };
  const fillTotal = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFF6D1' },
  };

  for (const group of groups) {
    const title =
      group.color && group.color !== '—'
        ? `${group.title} — ${group.color}`
        : group.title;

    sheet.mergeCells(rowIdx, 1, rowIdx, 6);
    sheet.getCell(rowIdx, 1).value = title;
    sheet.getCell(rowIdx, 1).font = { bold: true, size: 14, color: { argb: 'FF111111' } };
    sheet.getCell(rowIdx, 1).fill = fillYellow;
    sheet.getRow(rowIdx).height = 26;
    rowIdx += 1;

    // Small product image (cell-anchored), then full-width size table underneath.
    const imgRow = rowIdx;
    sheet.getRow(imgRow).height = 72;
    sheet.mergeCells(imgRow, 1, imgRow, 2);
    const img = await fetchImageAsBase64(group.imageUrl, imageCache);
    if (img) {
      const ok = embedSheetImage(sheet, workbook, img, {
        col: 0,
        row: imgRow - 1,
        colSpan: 1,
        rowSpan: 1,
      });
      if (!ok) sheet.getCell(imgRow, 1).value = '(image)';
    } else {
      sheet.getCell(imgRow, 1).value = '(no image)';
      sheet.getCell(imgRow, 1).font = { italic: true, color: { argb: 'FF999999' } };
    }
    rowIdx += 1;

    const tableStart = rowIdx;
    writeRow(sheet, tableStart, ['Size', 'SKU', 'Color', 'Qty', 'Unit cost', 'Line total']);
    sheet.getRow(tableStart).height = 22;
    for (let c = 1; c <= 6; c += 1) {
      sheet.getCell(tableStart, c).font = { bold: true, size: 12 };
      sheet.getCell(tableStart, c).fill = fillMuted;
      sheet.getCell(tableStart, c).alignment = { vertical: 'middle' };
    }

    let lineRow = tableStart + 1;
    for (const item of group.lines) {
      const qty = Number(item.quantity) || 0;
      const unitCost = money(item.unitCost);
      const lineTotal = money(qty * unitCost);
      writeRow(sheet, lineRow, [
        itemSize(item),
        itemSku(item),
        itemColor(item),
        qty,
        unitCost,
        lineTotal,
      ]);
      sheet.getRow(lineRow).height = 20;
      sheet.getCell(lineRow, 5).numFmt = '#,##0.00';
      sheet.getCell(lineRow, 6).numFmt = '#,##0.00';
      for (let c = 1; c <= 6; c += 1) {
        sheet.getCell(lineRow, c).font = { size: 12 };
        sheet.getCell(lineRow, c).alignment = { vertical: 'middle' };
      }
      const sizeNum = parseFloat(String(itemSize(item)).replace(',', '.'));
      if (Number.isFinite(sizeNum)) sheet.getCell(lineRow, 1).value = sizeNum;
      lineRow += 1;
    }

    writeRow(sheet, lineRow, ['', 'Product total', '', group.qty, '', group.total]);
    sheet.getRow(lineRow).height = 22;
    sheet.getCell(lineRow, 2).font = { bold: true, size: 12 };
    sheet.getCell(lineRow, 4).font = { bold: true, size: 12 };
    sheet.getCell(lineRow, 6).font = { bold: true, size: 12 };
    sheet.getCell(lineRow, 6).numFmt = '#,##0.00';
    for (const c of [2, 4, 6]) sheet.getCell(lineRow, c).fill = fillTotal;

    rowIdx = lineRow + 2;
  }

  // Summary table — one row per product/color + grand total matching line math.
  sheet.mergeCells(rowIdx, 1, rowIdx, 6);
  sheet.getCell(rowIdx, 1).value = 'SUMMARY';
  sheet.getCell(rowIdx, 1).font = { bold: true, size: 14 };
  sheet.getCell(rowIdx, 1).fill = fillYellow;
  rowIdx += 1;

  writeRow(sheet, rowIdx, ['Product', 'Color', 'SKUs', 'Units', 'Total', '']);
  sheet.getRow(rowIdx).height = 22;
  for (let c = 1; c <= 5; c += 1) {
    sheet.getCell(rowIdx, c).font = { bold: true, size: 12 };
    sheet.getCell(rowIdx, c).fill = fillMuted;
  }
  rowIdx += 1;

  for (const group of groups) {
    writeRow(sheet, rowIdx, [
      group.title,
      group.color,
      group.lines.length,
      group.qty,
      group.total,
    ]);
    sheet.getRow(rowIdx).height = 20;
    sheet.getCell(rowIdx, 5).numFmt = '#,##0.00';
    for (let c = 1; c <= 5; c += 1) sheet.getCell(rowIdx, c).font = { size: 12 };
    rowIdx += 1;
  }

  writeRow(sheet, rowIdx, ['GRAND TOTAL', '', items.length, grandQty, grandTotal]);
  sheet.getRow(rowIdx).height = 24;
  for (let c = 1; c <= 5; c += 1) {
    sheet.getCell(rowIdx, c).font = { bold: true, size: 13 };
    sheet.getCell(rowIdx, c).fill = fillYellow;
  }
  sheet.getCell(rowIdx, 5).numFmt = '#,##0.00';
  rowIdx += 1;

  writeRow(sheet, rowIdx, ['Currency', currency]);
  if (po.totalCost != null && money(po.totalCost) !== grandTotal) {
    rowIdx += 1;
    writeRow(sheet, rowIdx, [
      'Note',
      `OMS stored total ${money(po.totalCost)} — Excel uses line sum ${grandTotal}`,
    ]);
  }

  rowIdx += 2;
  sheet.getCell(rowIdx, 1).value = 'Prepared by Gazelle OMS for factory production';
  sheet.getCell(rowIdx, 1).font = { italic: true, size: 9, color: { argb: 'FF999999' } };

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
