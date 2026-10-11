/** Bosta caps ALLOW_TO_OPEN_THE_PACKAGE photos at 10 per delivery. */
export const BOSTA_DELIVERY_IMAGES_MAX = 10;

function variantFor(item, variantsById) {
  const v = item?.variantId;
  if (v && typeof v === 'object' && (v.imageUrl || v.productImageUrl)) return v;
  return variantsById.get(String(v?._id || v)) || (v && typeof v === 'object' ? v : {});
}

function imageUrlFor(item, variantsById) {
  const variant = variantFor(item, variantsById);
  const product = variant.productId && typeof variant.productId === 'object' ? variant.productId : {};
  const url = variant.imageUrl || variant.productImageUrl || product.imageUrl || item?.imageUrl || '';
  return /^https?:\/\//i.test(String(url).trim()) ? String(url).trim() : '';
}

/** Product photo URLs for the shoes on this delivery (outbound, then any items collected back). */
export function deliveryImageUrls(order, variantsById = new Map()) {
  const lines = [...(order?.items || []), ...(order?.bostaReturnItems || [])];
  const urls = [];
  for (const item of lines) {
    const url = imageUrlFor(item, variantsById);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= BOSTA_DELIVERY_IMAGES_MAX) break;
  }
  return urls;
}

/**
 * Bosta requires ALLOW_TO_OPEN_THE_PACKAGE photos whenever the customer may open the package.
 * With no product photo (e.g. repaired shoes) the delivery goes out closed instead of failing.
 */
export function bostaOpenPackageFields(order, variantsById = new Map()) {
  const images = deliveryImageUrls(order, variantsById);
  if (!images.length) return { allowToOpenPackage: false };
  return {
    allowToOpenPackage: true,
    deliveryImages: [{ type: 'ALLOW_TO_OPEN_THE_PACKAGE', images }],
  };
}
