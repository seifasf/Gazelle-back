import { shopifyGraphQL } from '../client.js';
import logger from '../../../utils/logger.js';

const ORDER_CANCEL = `
  mutation OrderCancel(
    $orderId: ID!
    $notifyCustomer: Boolean
    $refundMethod: OrderCancelRefundMethodInput!
    $restock: Boolean!
    $reason: OrderCancelReason!
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      notifyCustomer: $notifyCustomer
      refundMethod: $refundMethod
      restock: $restock
      reason: $reason
      staffNote: $staffNote
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

const REASON_MAP = {
  customer_changed_mind: 'CUSTOMER',
  duplicate_order: 'OTHER',
  out_of_stock: 'INVENTORY',
  fraud_suspected: 'FRAUD',
  other: 'OTHER',
};

function toShopifyOrderGid(shopifyOrderId) {
  const id = String(shopifyOrderId || '').trim();
  if (!id || id.startsWith('MAN-')) return null;
  if (id.startsWith('gid://')) return id;
  if (/^\d+$/.test(id)) return `gid://shopify/Order/${id}`;
  return null;
}

/**
 * Cancel a Shopify order from Gazelle.
 * Inventory restock is left to Gazelle (restock: false) so we don't double-adjust.
 */
export async function cancelShopifyOrder({
  shopifyOrderId,
  reason = 'customer_changed_mind',
  staffNote,
  notifyCustomer = false,
  refund = true,
}) {
  const orderId = toShopifyOrderGid(shopifyOrderId);
  if (!orderId) {
    return { skipped: true, reason: 'not_a_shopify_order' };
  }

  const data = await shopifyGraphQL(ORDER_CANCEL, {
    orderId,
    notifyCustomer,
    refundMethod: { originalPaymentMethodsRefund: Boolean(refund) },
    // OMS already releases hold + restores online stock via ledger sync.
    restock: false,
    reason: REASON_MAP[reason] || 'OTHER',
    staffNote: staffNote || undefined,
  });

  const result = data?.orderCancel;
  const errors = [...(result?.orderCancelUserErrors || [])];

  if (errors.length) {
    const message = errors.map((e) => e.message).join('; ');
    logger.error({ shopifyOrderId, errors }, 'Shopify orderCancel userErrors');
    const err = new Error(`Shopify cancel failed: ${message}`);
    err.statusCode = 502;
    err.shopifyErrors = errors;
    throw err;
  }

  return { skipped: false, job: result?.job || null };
}

export default { cancelShopifyOrder, toShopifyOrderGid };
