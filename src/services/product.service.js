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

  return variant;
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
    const escapedSearch = escapeRegex(search);
    const regex = { $regex: escapedSearch, $options: 'i' };
    searchProductIds = await Variant.distinct('productId', {
      $or: [
        { sku: regex },
        { barcode: regex },
        { title: regex },
        { color: regex },
        { size: regex },
      ],
    });
    productFilter.$or = [
      { title: regex },
      { vendor: regex },
      { productType: regex },
      { handle: regex },
      { tags: regex },
    ];
    if (searchProductIds.length) {
      productFilter.$or.push({ _id: { $in: searchProductIds } });
    }
  }

  const hasVariantFilters = Object.keys(variantMatch).length > 0;
  let variantProductIds = null;
  if (hasVariantFilters) {
    variantProductIds = await Variant.distinct('productId', variantMatch);
    productFilter._id = { $in: variantProductIds };
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

export default {
  listVariants,
  getVariantById,
  findVariantBySku,
  updateVariantCogs,
  addCogsBatch,
  getVariantLedger,
  listProducts,
  listCatalog,
  getCatalogFilterOptions,
  getStockQueueCounts,
};
