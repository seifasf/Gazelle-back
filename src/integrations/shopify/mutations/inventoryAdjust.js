import { shopifyGraphQL } from '../client.js';

const ADJUST_INVENTORY = `
  mutation AdjustOnlineStock($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes { name delta }
      }
    }
  }
`;

/**
 * Push relative online_stock adjustment to Shopify.
 * @param {object} params
 * @param {string} params.inventoryItemId - Shopify inventory item GID
 * @param {string} params.locationId - Shopify location GID
 * @param {number} params.delta - signed quantity change
 * @param {string} params.idempotencyKey - deterministic key from ledger _id
 */
export async function inventoryAdjustQuantities({
  inventoryItemId,
  locationId,
  delta,
  idempotencyKey,
  reason = 'correction',
}) {
  const input = {
    reason,
    name: 'available',
    changes: [
      {
        inventoryItemId,
        locationId,
        delta,
      },
    ],
  };

  return shopifyGraphQL(ADJUST_INVENTORY, {
    input,
    // graphql-request passes idempotency via custom header if supported by API version
  });
}

export default { inventoryAdjustQuantities };
