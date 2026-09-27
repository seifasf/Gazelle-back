import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import { lineOfferInfo, orderHasOfferItems } from '../utils/offerOrder.js';

/**
 * Sets isOnOffer / offerType / unitCompareAtPrice on each order line (mutates `items`)
 * and returns whether the order is an offer order.
 */
export async function annotateOfferItems(items, session = null) {
  const lines = (items || []).filter((i) => i?.variantId);
  if (!lines.length) return false;

  const variantIds = [...new Set(lines.map((i) => String(i.variantId?._id || i.variantId)))];
  const variants = await Variant.find({ _id: { $in: variantIds } })
    .select('productId sellingPrice compareAtPrice')
    .session(session)
    .lean();
  const productIds = [...new Set(variants.map((v) => String(v.productId)).filter(Boolean))];
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } }).select('tags').session(session).lean()
    : [];
  const tagsByProduct = new Map(products.map((p) => [String(p._id), p.tags || []]));
  const variantById = new Map(variants.map((v) => [String(v._id), v]));

  for (const line of lines) {
    const variant = variantById.get(String(line.variantId?._id || line.variantId));
    if (!variant) continue;
    const info = lineOfferInfo(variant, tagsByProduct.get(String(variant.productId)), line.unitSellingPrice);
    line.isOnOffer = info.isOnOffer;
    line.offerType = info.offerType;
    line.unitCompareAtPrice = info.unitCompareAtPrice;
  }
  return orderHasOfferItems(items);
}

/**
 * Flag lines that were just added/swapped, then re-derive order.isOfferOrder from all
 * line snapshots (untouched lines keep their original flags). Mutates `order`.
 */
export async function refreshOrderOfferFlag(order, changedLines, session = null) {
  if (order.isExchangeOrder || order.isReturnOrder) return order;
  await annotateOfferItems(changedLines, session);
  order.isOfferOrder = orderHasOfferItems(order.items);
  return order;
}
