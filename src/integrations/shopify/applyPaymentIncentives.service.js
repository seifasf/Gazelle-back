import { orderHasCodFee } from '../../utils/shopifyPaymentIncentives.js';

/** Do not edit Shopify checkout (no COD EGP 25 line, no ONLINE5). */
export async function applyShopifyPaymentIncentives(payload) {
  return payload;
}

export { orderHasCodFee };
