import Settings from '../../models/Settings.js';

export async function getShopifyWritePolicy() {
  const settings = await Settings.findOne({ key: 'global' });
  return settings?.shopifyWritePolicy || 'oms_only';
}

export async function assertShopifyInventoryWriteAllowed() {
  const policy = await getShopifyWritePolicy();
  if (policy !== 'oms_only' && policy !== 'full') {
    const err = new Error('Shopify write policy blocks inventory updates');
    err.statusCode = 403;
    throw err;
  }
}

export default { getShopifyWritePolicy, assertShopifyInventoryWriteAllowed };
