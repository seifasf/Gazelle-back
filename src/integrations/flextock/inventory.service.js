import { config } from '../../config/index.js';
import { flextockRequest } from './client.js';
import logger from '../../utils/logger.js';

/**
 * Poll Flextock sellable qty. Does not write Gazelle warehouse unless FLEXTOCK_SYNC_INVENTORY=true.
 * Rate limit: 10 requests / minute / IP.
 */
export async function fetchFlextockInventoryLevels({ skus = null, limit = 100 } = {}) {
  return flextockRequest('/external-integration/inventory-levels/', {
    method: 'POST',
    body: {
      skus: Array.isArray(skus) && skus.length ? skus : null,
      limit,
    },
  });
}

export async function syncFlextockInventoryLevels(opts = {}) {
  if (!config.FLEXTOCK_SYNC_INVENTORY) {
    logger.info('Flextock inventory sync skipped (FLEXTOCK_SYNC_INVENTORY is off)');
    return { skipped: true, reason: 'disabled' };
  }
  const data = await fetchFlextockInventoryLevels(opts);
  return { skipped: false, data };
}

export default { fetchFlextockInventoryLevels, syncFlextockInventoryLevels };
