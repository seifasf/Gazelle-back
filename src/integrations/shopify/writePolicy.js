import Settings from '../../models/Settings.js';

/**
 * Shopify inventory is brand-owned. OMS only writes inventory when policy is
 * explicitly set to `full` (legacy escape hatch). Default / oms_only = no writes.
 */
export async function getShopifyWritePolicy() {
  const settings = await Settings.findOne({ key: 'global' });
  return settings?.shopifyWritePolicy || 'oms_only';
}

export async function assertShopifyInventoryWriteAllowed() {
  const policy = await getShopifyWritePolicy();
  if (policy !== 'full') {
    const err = new Error('Shopify inventory writes are disabled — brand owners manage Shopify stock');
    err.statusCode = 403;
    throw err;
  }
}

export default { getShopifyWritePolicy, assertShopifyInventoryWriteAllowed };
