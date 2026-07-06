import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import CogsBatch from '../models/CogsBatch.js';
import InventoryLedger from '../models/InventoryLedger.js';

export async function listVariants({ search, lowStockOnly, limit = 50, skip = 0 }) {
  const filter = {};
  if (search) {
    filter.$or = [
      { sku: { $regex: search, $options: 'i' } },
      { title: { $regex: search, $options: 'i' } },
    ];
  }

  let variants = await Variant.find(filter)
    .populate('productId', 'title status imageUrl vendor productType handle')
    .sort({ sku: 1 })
    .skip(skip)
    .limit(limit);

  if (lowStockOnly) {
    variants = variants.filter((v) => v.realStock <= v.lowStockThreshold);
  }

  const total = await Variant.countDocuments(filter);
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
  const escaped = escapeRegex(sku);
  const variant = await Variant.findOne({ sku: { $regex: new RegExp(`^${escaped}$`, 'i') } })
    .populate('productId', 'title imageUrl vendor productType shopifyProductId');
  return variant;
}

export async function listCatalog({
  search,
  productType,
  vendor,
  lowRealStock,
  status = 'active',
  limit = 24,
  skip = 0,
}) {
  if (search === 'undefined' || search === 'null') search = undefined;
  if (search) search = search.trim();

  const productFilter = {};
  // Stock view shows only live (active) Shopify products by default; pass
  // status='all' to include drafts/archived.
  if (status && status !== 'all') productFilter.status = status;
  if (productType) productFilter.productType = { $regex: productType, $options: 'i' };
  if (vendor) productFilter.vendor = { $regex: vendor, $options: 'i' };

  let variantProductIds = [];
  if (search) {
    const escapedSearch = escapeRegex(search);
    const regex = { $regex: escapedSearch, $options: 'i' };
    variantProductIds = await Variant.distinct('productId', {
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
    if (variantProductIds.length) {
      productFilter.$or.push({ _id: { $in: variantProductIds } });
    }
  }

  let productIdsFilter = null;
  if (lowRealStock) {
    const lowIds = await Variant.distinct('productId', {
      $expr: { $lte: ['$realStock', '$lowStockThreshold'] },
    });
    productIdsFilter = lowIds;
    productFilter._id = { $in: lowIds };
  }

  const [totalProducts, products] = await Promise.all([
    Product.countDocuments(productFilter),
    Product.find(productFilter).sort({ title: 1 }).skip(skip).limit(limit).lean(),
  ]);

  const productIds = products.map((p) => p._id);
  let totalVariantsPromise;
  if (productIdsFilter) {
    totalVariantsPromise = Variant.countDocuments({ productId: { $in: productIdsFilter } });
  } else if (search) {
    // The UI paginates by products, so keep search totals cheap: count variants
    // that directly matched the search plus variants on the current product page.
    const pageProductIds = productIds.map((id) => id.toString());
    const directProductIds = variantProductIds.map((id) => id.toString());
    const countedProductIds = [...new Set([...pageProductIds, ...directProductIds])];
    totalVariantsPromise = countedProductIds.length
      ? Variant.countDocuments({ productId: { $in: countedProductIds } })
      : Promise.resolve(0);
  } else {
    // Count only variants belonging to products that match the current filter
    // (active-only by default) so totals line up with what's shown.
    const filterProductIds = await Product.find(productFilter).distinct('_id');
    totalVariantsPromise = Variant.countDocuments({ productId: { $in: filterProductIds } });
  }

  const [variants, totalVariants] = await Promise.all([
    productIds.length
      ? Variant.find({ productId: { $in: productIds } })
          .sort({ color: 1, size: 1 })
          .lean()
      : Promise.resolve([]),
    totalVariantsPromise,
  ]);

  const variantsByProduct = new Map();
  for (const variant of variants) {
    const key = variant.productId.toString();
    if (!variantsByProduct.has(key)) variantsByProduct.set(key, []);
    variantsByProduct.get(key).push(variant);
  }

  const catalog = products.map((product) => {
    const productVariants = variantsByProduct.get(product._id.toString()) || [];
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

export async function listProducts({ limit = 50, skip = 0 }) {
  const [products, total] = await Promise.all([
    Product.find().sort({ title: 1 }).skip(skip).limit(limit),
    Product.countDocuments(),
  ]);
  return { products, total };
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
};
