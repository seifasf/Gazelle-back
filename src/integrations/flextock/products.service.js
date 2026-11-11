import { flextockRequest } from './client.js';
import { buildCreateProductsPayload, flextockProductFromVariant } from './payloads.js';
import Variant from '../../models/Variant.js';
import Product from '../../models/Product.js';
import logger from '../../utils/logger.js';

const CREATE_BATCH = 100;

export async function createFlextockProducts(products) {
  const list = (products || []).filter((p) => p?.sku_code);
  if (!list.length) return { created: 0, existing: 0, responses: [] };
  const responses = [];
  let created = 0;
  let existing = 0;
  for (let i = 0; i < list.length; i += CREATE_BATCH) {
    const chunk = list.slice(i, i + CREATE_BATCH);
    const data = await flextockRequest('/external-integration/create-products/', {
      method: 'POST',
      body: buildCreateProductsPayload(chunk),
    });
    const rows = Array.isArray(data?.response) ? data.response : [];
    for (const row of rows) {
      const msg = String(row?.message || '').toLowerCase();
      if (msg.includes('already exists')) existing += 1;
      else created += 1;
      responses.push(row);
    }
  }
  return { created, existing, responses };
}

export async function listFlextockProducts() {
  return flextockRequest('/external-integration/list-products/', {
    method: 'POST',
    body: { request: 'product listing' },
  });
}

export async function updateFlextockProduct(body) {
  return flextockRequest('/external-integration/update-product/', {
    method: 'PATCH',
    body,
  });
}

export async function productsForOrder(order) {
  const ids = [...new Set((order?.items || []).map((i) => String(i.variantId?._id || i.variantId || '')).filter(Boolean))];
  const variants = ids.length
    ? await Variant.find({ _id: { $in: ids } }).select('sku title color size imageUrl productId')
    : [];
  const productIds = [...new Set(variants.map((v) => String(v.productId || '')).filter(Boolean))];
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } }).select('title imageUrl')
    : [];
  const productsById = new Map(products.map((p) => [String(p._id), p]));
  const byId = new Map();
  const payload = [];
  for (const variant of variants) {
    const product = productsById.get(String(variant.productId));
    const line = (order.items || []).find((i) => String(i.variantId?._id || i.variantId) === String(variant._id));
    const item = flextockProductFromVariant(variant, {
      price: line?.unitSellingPrice,
      compareAtPrice: line?.unitCompareAtPrice,
      name: product?.title ? `${product.title}${variant.size ? ` ${variant.size}` : ''}` : variant.title,
      imageUrl: variant.imageUrl || product?.imageUrl,
    });
    byId.set(String(variant._id), { ...variant.toObject?.() || variant, productImageUrl: item.sku_image_url });
    if (item.sku_code) payload.push(item);
  }
  for (const item of order?.items || []) {
    const sku = String(item.sku || '').trim();
    if (sku && !payload.some((p) => p.sku_code === sku)) {
      payload.push(flextockProductFromVariant({ sku, title: sku }, { price: item.unitSellingPrice }));
    }
  }
  return { products: payload, variantsById: byId };
}

export async function ensureFlextockProductsForOrder(order) {
  const { products, variantsById } = await productsForOrder(order);
  if (!products.length) {
    const err = new Error('Flextock needs SKUs on the order. Repair orders cannot go via Flextock.');
    err.statusCode = 400;
    throw err;
  }
  const result = await createFlextockProducts(products);
  logger.info(
    { orderId: String(order._id), created: result.created, existing: result.existing, skus: products.map((p) => p.sku_code) },
    'Flextock products ensured'
  );
  return { ...result, products, variantsById };
}

export default {
  createFlextockProducts,
  listFlextockProducts,
  updateFlextockProduct,
  ensureFlextockProductsForOrder,
  productsForOrder,
};
