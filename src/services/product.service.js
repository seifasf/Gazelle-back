import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import CogsBatch from '../models/CogsBatch.js';
import InventoryLedger from '../models/InventoryLedger.js';
import DiscrepancyAlert from '../models/DiscrepancyAlert.js';

export async function listVariants({ search, lowStockOnly, limit = 50, skip = 0, activeOnly = true }) {
  const filter = {};
  let productIdsFromTitle = null;

  if (search) {
    const regex = { $regex: search, $options: 'i' };
    productIdsFromTitle = await Product.find({ title: regex }).distinct('_id');
    filter.$or = [
      { sku: regex },
      { title: regex },
      { color: regex },
      ...(productIdsFromTitle.length ? [{ productId: { $in: productIdsFromTitle } }] : []),
    ];
  }

  if (activeOnly) {
    const activeProductIds = await Product.find({ status: 'active' }).distinct('_id');
    if (filter.productId?.$in) {
      const allow = new Set(activeProductIds.map(String));
      filter.productId.$in = filter.productId.$in.filter((id) => allow.has(String(id)));
    } else if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { productId: { $in: activeProductIds } }];
      delete filter.$or;
    } else {
      filter.productId = { $in: activeProductIds };
    }
  }

  if (lowStockOnly) {
    filter.$expr = { $lte: ['$realStock', '$lowStockThreshold'] };
  }

  const [variants, total] = await Promise.all([
    Variant.find(filter)
      .populate('productId', 'title status imageUrl vendor productType handle')
      .sort({ realStock: 1, sku: 1 })
      .skip(skip)
      .limit(limit),
    Variant.countDocuments(filter),
  ]);

  return { variants, total };
}

export async function getVariantById(variantId) {
  const variant = await Variant.findById(variantId).populate('productId');
  if (!variant) {
    const err = new Error('Variant not found');
    err.statusCode = 404;
    throw err;
  }
  return variant;
}

export async function updateVariantCogs(variantId, cogs, userId) {
  const variant = await Variant.findByIdAndUpdate(variantId, { cogs }, { new: true });
  if (!variant) {
    const err = new Error('Variant not found');
    err.statusCode = 404;
    throw err;
  }
  return variant;
}

export async function addCogsBatch({ variantId, batchLabel, cogs, quantity, userId }) {
  const batch = await CogsBatch.create({
    variantId,
    batchLabel,
    cogs,
    quantity,
    createdBy: userId,
  });
  await Variant.findByIdAndUpdate(variantId, { cogs });
  return batch;
}

export async function getVariantLedger(variantId, { limit = 100, skip = 0 }) {
  const [entries, total] = await Promise.all([
    InventoryLedger.find({ variantId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    InventoryLedger.countDocuments({ variantId }),
  ]);
  return { entries, total };
}

function displayOptions(variant) {
  if (variant.color || variant.size) {
    return { color: variant.color, size: variant.size };
  }
  const parts = (variant.title || '').split('/').map((s) => s.trim());
  if (parts.length >= 2) {
    return { color: parts[0], size: parts[1] };
  }
  return { color: variant.color, size: variant.size };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function findVariantBySku(sku) {
  const raw = String(sku || '').trim();
  if (!raw) return null;

  const escaped = escapeRegex(raw);
  const exact = new RegExp(`^${escaped}$`, 'i');

  let variant = await Variant.findOne({ sku: exact })
    .populate('productId', 'title imageUrl vendor productType shopifyProductId defaultFactoryId');

  if (!variant) {
    variant = await Variant.findOne({ barcode: exact })
      .populate('productId', 'title imageUrl vendor productType shopifyProductId defaultFactoryId');
  }

  // Prefix match: typing "GMK-20" finds "GMK-20-38", "GMK-20-39", …
  if (!variant) {
    const prefixHits = await Variant.find({
      $or: [
        { sku: new RegExp(`^${escaped}([-_/]|$)`, 'i') },
        { barcode: new RegExp(`^${escaped}([-_/]|$)`, 'i') },
      ],
    })
      .limit(1)
      .populate('productId', 'title imageUrl vendor productType shopifyProductId defaultFactoryId');
    variant = prefixHits[0] || null;
  }

  return variant;
}

function sortSizes(a, b) {
  const sa = String(a?.size ?? '');
  const sb = String(b?.size ?? '');
  const na = Number(sa);
  const nb = Number(sb);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === sa && String(nb) === sb) {
    return na - nb;
  }
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Resolve a SKU/barcode to the product family (all sizes), optionally same color.
 * Used by stock intake so staff enter one SKU and fill qty per size.
 */
export async function findVariantFamilyBySku(sku) {
  const matched = await findVariantBySku(sku);
  if (!matched) return null;

  const product = matched.productId;
  const productId = product?._id || matched.productId;

  let variants = await Variant.find({ productId })
    .select(
      'sku barcode title color size imageUrl realStock onHoldStock sellingPrice productId shopifyVariantId'
    )
    .lean();

  // Prefer same colorway when the product has multiple colors.
  if (matched.color) {
    const sameColor = variants.filter((v) => v.color === matched.color);
    if (sameColor.length > 0) variants = sameColor;
  }

  variants.sort(sortSizes);

  return {
    matched: {
      _id: matched._id,
      sku: matched.sku,
      barcode: matched.barcode,
      title: matched.title,
      color: matched.color,
      size: matched.size,
      imageUrl: matched.imageUrl,
      realStock: matched.realStock,
      onHoldStock: matched.onHoldStock,
    },
    product:
      product && typeof product === 'object'
        ? {
            _id: product._id,
            title: product.title,
            imageUrl: product.imageUrl,
            vendor: product.vendor,
            productType: product.productType,
          }
        : null,
    variants,
  };
}

export async function listCatalog({
  search,
  productType,
  vendor,
  color,
  size,
  stockStatus,
  lowRealStock,
  status = 'active',
  limit = 24,
  skip = 0,
}) {
  if (search === 'undefined' || search === 'null') search = undefined;
  if (search) search = search.trim();
  if (color === 'undefined' || color === 'null') color = undefined;
  if (size === 'undefined' || size === 'null') size = undefined;
  if (stockStatus === 'undefined' || stockStatus === 'null') stockStatus = undefined;
  if (lowRealStock === true || lowRealStock === 'true') {
    stockStatus = stockStatus || 'low';
  }

  const productFilter = {};
  if (status && status !== 'all') productFilter.status = status;
  if (productType) productFilter.productType = { $regex: `^${escapeRegex(productType)}$`, $options: 'i' };
  if (vendor) productFilter.vendor = { $regex: `^${escapeRegex(vendor)}$`, $options: 'i' };

  const variantMatch = {};
  if (color) variantMatch.color = { $regex: `^${escapeRegex(color)}$`, $options: 'i' };
  if (size) variantMatch.size = { $regex: `^${escapeRegex(size)}$`, $options: 'i' };
  if (stockStatus === 'in_stock') variantMatch.realStock = { $gt: 0 };
  if (stockStatus === 'out_of_stock') variantMatch.realStock = { $lte: 0 };
  if (stockStatus === 'on_hold') variantMatch.onHoldStock = { $gt: 0 };
  if (stockStatus === 'low') {
    variantMatch.$expr = { $lte: ['$realStock', '$lowStockThreshold'] };
  }

  let searchProductIds = [];
  if (search) {
    /**
     * Accurate catalog search:
     * - SKU-like queries → match SKU / barcode (prefix + contains), not loose color/size words
     * - Name queries → every significant word (2+ chars) must appear in product title
     * - Ignore 1-letter noise that previously matched half the catalog
     */
    const term = String(search).trim();
    const tokens = term
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const looksLikeSku =
      /[-_/]/.test(term) ||
      /^[A-Za-z]{1,8}\d/.test(term) ||
      (/^[A-Za-z0-9-_/]+$/.test(term) && /\d/.test(term) && !/\s/.test(term));

    if (looksLikeSku || (tokens.length === 1 && /^[A-Za-z0-9-_/]+$/.test(tokens[0]) && /\d/.test(tokens[0]))) {
      const skuTerm = tokens[0] || term;
      // Prefix + exact only — no mid-string contains (avoids partial “fast” hits).
      const exact = { $regex: `^${escapeRegex(skuTerm)}$`, $options: 'i' };
      const prefix = { $regex: `^${escapeRegex(skuTerm)}`, $options: 'i' };
      searchProductIds = await Variant.distinct('productId', {
        $or: [
          { sku: exact },
          { barcode: exact },
          { sku: prefix },
          { barcode: prefix },
        ],
      });
      productFilter._id = { $in: searchProductIds };
    } else if (tokens.length) {
      // Name: require all words in product title (order-independent).
      const titleAnd = {
        $and: tokens.map((t) => ({ title: { $regex: escapeRegex(t), $options: 'i' } })),
      };
      // Also allow exact-ish phrase match on title / handle.
      const phrase = { $regex: escapeRegex(term), $options: 'i' };
      productFilter.$or = [
        titleAnd,
        { title: phrase },
        { handle: phrase },
      ];

      // If the full phrase also hits a SKU, include those products too.
      searchProductIds = await Variant.distinct('productId', {
        $or: [{ sku: phrase }, { barcode: phrase }],
      });
      if (searchProductIds.length) {
        productFilter.$or.push({ _id: { $in: searchProductIds } });
      }
    } else {
      // Term too short (e.g. one letter) — do not broaden the catalog.
      productFilter._id = { $in: [] };
    }
  }

  const hasVariantFilters = Object.keys(variantMatch).length > 0;
  let variantProductIds = null;
  if (hasVariantFilters) {
    variantProductIds = await Variant.distinct('productId', variantMatch);
    if (productFilter._id?.$in) {
      const allow = new Set(variantProductIds.map(String));
      productFilter._id = {
        $in: productFilter._id.$in.filter((id) => allow.has(String(id))),
      };
    } else {
      productFilter._id = { $in: variantProductIds };
    }
  }

  const [totalProducts, products] = await Promise.all([
    Product.countDocuments(productFilter),
    Product.find(productFilter).sort({ title: 1 }).skip(skip).limit(limit).lean(),
  ]);

  const productIds = products.map((p) => p._id);
  const allMatchingProductIds = hasVariantFilters
    ? variantProductIds
    : await Product.find(productFilter).distinct('_id');

  const [variants, totalVariants] = await Promise.all([
    productIds.length
      ? Variant.find({ productId: { $in: productIds } })
          .sort({ color: 1, size: 1 })
          .lean()
      : Promise.resolve([]),
    allMatchingProductIds.length
      ? Variant.countDocuments({ productId: { $in: allMatchingProductIds } })
      : Promise.resolve(0),
  ]);

  const variantsByProduct = new Map();
  for (const variant of variants) {
    const key = variant.productId.toString();
    if (!variantsByProduct.has(key)) variantsByProduct.set(key, []);
    variantsByProduct.get(key).push(variant);
  }

  const catalog = products.map((product) => {
    let productVariants = variantsByProduct.get(product._id.toString()) || [];
    if (hasVariantFilters) {
      productVariants = productVariants.filter((variant) => {
        if (color && !(variant.color || '').toLowerCase().includes(String(color).toLowerCase())) return false;
        if (size && String(variant.size || '').toLowerCase() !== String(size).toLowerCase()) return false;
        if (stockStatus === 'in_stock' && !(variant.realStock > 0)) return false;
        if (stockStatus === 'out_of_stock' && variant.realStock > 0) return false;
        if (stockStatus === 'on_hold' && !(variant.onHoldStock > 0)) return false;
        if (stockStatus === 'low' && !(variant.realStock <= variant.lowStockThreshold)) return false;
        return true;
      });
    }

    let imageUrl = product.imageUrl;
    const mappedVariants = productVariants.map((variant) => {
      if (!imageUrl && variant.imageUrl) imageUrl = variant.imageUrl;
      const opts = displayOptions(variant);
      return {
        _id: variant._id,
        sku: variant.sku,
        barcode: variant.barcode,
        title: variant.title,
        color: opts.color,
        size: opts.size,
        imageUrl: variant.imageUrl || imageUrl,
        compareAtPrice: variant.compareAtPrice,
        sellingPrice: variant.sellingPrice,
        onHoldStock: variant.onHoldStock,
        realStock: variant.realStock,
        onlineStock: variant.onlineStock,
        shopifyAvailable: variant.shopifyAvailable,
        shopifyVariantId: variant.shopifyVariantId,
        lastSyncedAt: variant.lastSyncedAt,
      };
    });

    return {
      _id: product._id,
      title: product.title,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      imageUrl,
      tags: product.tags,
      status: product.status,
      shopifyProductId: product.shopifyProductId,
      lastSyncedAt: product.lastSyncedAt,
      variantCount: mappedVariants.length,
      totalRealStock: mappedVariants.reduce((s, v) => s + (v.realStock || 0), 0),
      totalOnHold: mappedVariants.reduce((s, v) => s + (v.onHoldStock || 0), 0),
      variants: mappedVariants,
    };
  });

  return { catalog, totalProducts, totalVariants, page: Math.floor(skip / limit) + 1, pageSize: limit };
}

export async function getCatalogFilterOptions({ status = 'active' } = {}) {
  const productFilter = status && status !== 'all' ? { status } : {};
  const productIds = await Product.find(productFilter).distinct('_id');

  const [vendors, productTypes, colors, sizes] = await Promise.all([
    Product.distinct('vendor', { ...productFilter, vendor: { $nin: [null, ''] } }),
    Product.distinct('productType', { ...productFilter, productType: { $nin: [null, ''] } }),
    productIds.length
      ? Variant.distinct('color', { productId: { $in: productIds }, color: { $nin: [null, ''] } })
      : Promise.resolve([]),
    productIds.length
      ? Variant.distinct('size', { productId: { $in: productIds }, size: { $nin: [null, ''] } })
      : Promise.resolve([]),
  ]);

  const sortAlpha = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

  return {
    vendors: vendors.filter(Boolean).sort(sortAlpha),
    productTypes: productTypes.filter(Boolean).sort(sortAlpha),
    colors: colors.filter(Boolean).sort(sortAlpha),
    sizes: sizes.filter(Boolean).sort(sortAlpha),
  };
}

export async function listProducts({ limit = 50, skip = 0 }) {
  const filter = { status: 'active' };
  const [products, total] = await Promise.all([
    Product.find(filter).sort({ title: 1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);
  return { products, total };
}

export async function getStockQueueCounts() {
  const activeProductIds = await Product.find({ status: 'active' }).distinct('_id');
  const variantFilter = {
    productId: { $in: activeProductIds },
    $expr: { $lte: ['$realStock', '$lowStockThreshold'] },
  };

  const [lowStock, discrepancies] = await Promise.all([
    Variant.countDocuments(variantFilter),
    DiscrepancyAlert.countDocuments({ resolvedAt: { $exists: false } }),
  ]);

  return { lowStock, discrepancies };
}

export async function exportCatalogStockExcel({ productIds = [] } = {}) {
  const ExcelJS = (await import('exceljs')).default;
  const { workbookBuffer, styleHeaderRow } = await import('../utils/excelExport.js');

  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  if (!ids.length) {
    const err = new Error('Select at least one product to export');
    err.statusCode = 400;
    throw err;
  }

  const products = await Product.find({ _id: { $in: ids } }).sort({ title: 1 }).lean();
  const variants = await Variant.find({ productId: { $in: products.map((p) => p._id) } })
    .sort({ color: 1, size: 1 })
    .lean();

  const byProduct = new Map();
  for (const v of variants) {
    const key = String(v.productId);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(v);
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock');
  sheet.columns = [
    { header: 'Product', key: 'product', width: 36 },
    { header: 'SKU', key: 'sku', width: 22 },
    { header: 'Color', key: 'color', width: 14 },
    { header: 'Size', key: 'size', width: 10 },
    { header: 'Warehouse', key: 'realStock', width: 12 },
    { header: 'On hold', key: 'onHoldStock', width: 10 },
    { header: 'Shopify mirror', key: 'onlineStock', width: 14 },
    { header: 'Low threshold', key: 'lowStockThreshold', width: 14 },
  ];
  styleHeaderRow(sheet);

  for (const product of products) {
    const list = byProduct.get(String(product._id)) || [];
    for (const v of list) {
      sheet.addRow({
        product: product.title,
        sku: v.sku,
        color: v.color || '',
        size: v.size ?? '',
        realStock: v.realStock ?? 0,
        onHoldStock: v.onHoldStock ?? 0,
        onlineStock: v.onlineStock ?? 0,
        lowStockThreshold: v.lowStockThreshold ?? '',
      });
    }
  }

  const buffer = await workbookBuffer(workbook);
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `gazelle-stock-selected-${stamp}.xlsx` };
}

/**
 * Full warehouse count sheet (الجرد) — same content shape as مراقبه pivot:
 * Row Labels | اضافة | خصم | الاجمالى (+ Shopify mirror + SKU).
 * No fancy colors — plain header + data.
 */
export async function exportInventoryCountExcel() {
  const ExcelJS = (await import('exceljs')).default;
  const { workbookBuffer, styleHeaderRow } = await import('../utils/excelExport.js');

  const products = await Product.find({ status: 'active' })
    .sort({ title: 1 })
    .select('_id title')
    .lean();
  const productIds = products.map((p) => p._id);
  const variants = await Variant.find({ productId: { $in: productIds } })
    .sort({ productId: 1, color: 1, size: 1 })
    .select('sku color size realStock onlineStock productId')
    .lean();

  const titleById = new Map(products.map((p) => [String(p._id), p.title || '']));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('الجرد');
  sheet.columns = [
    { header: 'Row Labels', key: 'label', width: 48 },
    { header: 'اضافة', key: 'add', width: 10 },
    { header: 'خصم', key: 'deduct', width: 10 },
    { header: 'الاجمالى', key: 'total', width: 12 },
    { header: 'Shopify', key: 'shopify', width: 12 },
    { header: 'SKU', key: 'sku', width: 22 },
  ];
  styleHeaderRow(sheet);

  for (const v of variants) {
    const title = titleById.get(String(v.productId)) || v.sku || '';
    const size = v.size != null && String(v.size).trim() !== '' ? String(v.size).trim() : '';
    const color = v.color != null && String(v.color).trim() !== '' ? String(v.color).trim() : '';
    let label = title;
    if (size && color) label = `${title} - ${size}, ${color}`;
    else if (size) label = `${title} - ${size}`;
    else if (color) label = `${title} - ${color}`;

    const total = v.realStock ?? 0;
    sheet.addRow({
      label,
      add: '',
      deduct: '',
      total,
      shopify: v.onlineStock ?? 0,
      sku: v.sku || '',
    });
  }

  const buffer = await workbookBuffer(workbook);
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `gazelle-jard-${stamp}.xlsx` };
}

export default {
  listVariants,
  getVariantById,
  findVariantBySku,
  findVariantFamilyBySku,
  updateVariantCogs,
  addCogsBatch,
  getVariantLedger,
  listProducts,
  listCatalog,
  getCatalogFilterOptions,
  getStockQueueCounts,
  exportCatalogStockExcel,
  exportInventoryCountExcel,
};
