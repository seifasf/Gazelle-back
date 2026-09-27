/**
 * Offer orders: at least one line is a Buy 1 Get 1 product (Shopify tag) or sold
 * below its Shopify compare-at price.
 */

const B1G1_TAG_PREFIXES = ['buy1get1', 'b1g1'];

export function isB1g1Tag(tag) {
  const key = String(tag || '').toLowerCase().replace(/[\s_-]+/g, '');
  return B1G1_TAG_PREFIXES.some((p) => key.startsWith(p));
}

export function hasB1g1Tag(tags) {
  return Array.isArray(tags) && tags.some(isB1g1Tag);
}

/**
 * @param {{ compareAtPrice?: number, sellingPrice?: number }} variant
 * @param {string[]} [productTags]
 * @param {number} [unitPrice] price charged on the line (falls back to catalog price when 0/missing)
 * @returns {{ isOnOffer: boolean, offerType?: 'b1g1'|'sale', unitCompareAtPrice?: number }}
 */
export function lineOfferInfo(variant, productTags, unitPrice) {
  const compareAt = Number(variant?.compareAtPrice) || 0;
  const charged = Number(unitPrice) > 0 ? Number(unitPrice) : Number(variant?.sellingPrice) || 0;
  const onSale = compareAt > 0 && charged > 0 && compareAt - charged > 0.009;
  const offerType = hasB1g1Tag(productTags) ? 'b1g1' : onSale ? 'sale' : undefined;
  return {
    isOnOffer: Boolean(offerType),
    ...(offerType ? { offerType } : {}),
    ...(compareAt > 0 ? { unitCompareAtPrice: compareAt } : {}),
  };
}

export function orderHasOfferItems(items) {
  return (items || []).some((i) => i?.isOnOffer);
}
