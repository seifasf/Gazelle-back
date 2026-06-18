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
    .populate('productId', 'title status')
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
  updateVariantCogs,
  addCogsBatch,
  getVariantLedger,
  listProducts,
};
