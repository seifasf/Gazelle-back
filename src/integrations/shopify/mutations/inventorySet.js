import { shopifyGraphQL } from '../client.js';

const SET_INVENTORY = `
  mutation SetWarehouseStock($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors { field message code }
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes { name delta }
      }
    }
  }
`;

/**
 * Set absolute Shopify "available" quantities for inventory items at a location.
 * Batches are caller-controlled; keep quantities.length modest (≤50) for rate limits.
 *
 * Uses ignoreCompareQuantity for API 2025.x (OMS is source of truth for this push).
 */
export async function inventorySetQuantities({
  locationId,
  quantities,
  reason = 'correction',
  referenceDocumentUri = 'gid://gazelle/WarehouseStockPush',
}) {
  if (!locationId) throw new Error('Shopify locationId is required');
  if (!Array.isArray(quantities) || !quantities.length) {
    return { inventorySetQuantities: { userErrors: [], inventoryAdjustmentGroup: null } };
  }

  const input = {
    name: 'available',
    reason,
    ignoreCompareQuantity: true,
    referenceDocumentUri,
    quantities: quantities.map((q) => ({
      inventoryItemId: q.inventoryItemId,
      locationId,
      quantity: Math.max(0, Math.round(Number(q.quantity) || 0)),
    })),
  };

  return shopifyGraphQL(SET_INVENTORY, { input });
}

export default { inventorySetQuantities };
