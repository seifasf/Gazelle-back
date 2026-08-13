import { randomUUID } from 'crypto';
import { shopifyGraphQL } from '../client.js';

const SET_INVENTORY = `
  mutation SetWarehouseStock($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
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
 * API 2026-04+: requires @idempotent + changeFromQuantity (null = opt out of CAS).
 * OMS is source of truth for this push.
 */
export async function inventorySetQuantities({
  locationId,
  quantities,
  reason = 'correction',
  referenceDocumentUri = 'gid://gazelle/WarehouseStockPush',
  idempotencyKey = null,
}) {
  if (!locationId) throw new Error('Shopify locationId is required');
  if (!Array.isArray(quantities) || !quantities.length) {
    return { inventorySetQuantities: { userErrors: [], inventoryAdjustmentGroup: null } };
  }

  const input = {
    name: 'available',
    reason,
    referenceDocumentUri,
    quantities: quantities.map((q) => ({
      inventoryItemId: q.inventoryItemId,
      locationId,
      quantity: Math.max(0, Math.round(Number(q.quantity) || 0)),
      // null = intentionally skip compare-and-swap (OMS overwrites Shopify available)
      changeFromQuantity: q.changeFromQuantity === undefined ? null : q.changeFromQuantity,
    })),
  };

  return shopifyGraphQL(SET_INVENTORY, {
    input,
    idempotencyKey: idempotencyKey || randomUUID(),
  });
}

export default { inventorySetQuantities };
