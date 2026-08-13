import Settings from '../../models/Settings.js';

/**
 * Shopify inventory sync: OMS warehouse is source of truth when policy=`full`.
 * Sellable on Shopify = realStock − holds from Shopify (non-manual) orders.
 * Manual orders never change Shopify stock. Stock intake always forces `full`.
 * Default remains oms_only until explicitly enabled (or first stock intake).
 */
export async function getShopifyWritePolicy() {
  const settings = await Settings.findOne({ key: 'global' });
  return settings?.shopifyWritePolicy || 'oms_only';
}

export async function assertShopifyInventoryWriteAllowed() {
  const policy = await getShopifyWritePolicy();
  if (policy !== 'full') {
    const err = new Error('Shopify inventory writes are disabled — set shopifyWritePolicy=full to sync');
    err.statusCode = 403;
    throw err;
  }
}

export async function enableShopifyInventorySync() {
  await Settings.findOneAndUpdate(
    { key: 'global' },
    { $set: { shopifyWritePolicy: 'full' } },
    { upsert: true }
  );
  return 'full';
}

export default {
  getShopifyWritePolicy,
  assertShopifyInventoryWriteAllowed,
  enableShopifyInventorySync,
};
