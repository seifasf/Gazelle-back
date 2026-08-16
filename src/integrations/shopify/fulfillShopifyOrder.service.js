import { shopifyGraphQL } from './client.js';
import { isManualOrderRef } from '../../utils/orderRefs.js';
import logger from '../../utils/logger.js';

const ORDER_FULFILLMENT_ORDERS = `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      displayFulfillmentStatus
      fulfillmentOrders(first: 10) {
        nodes {
          id
          status
          lineItems(first: 50) {
            nodes {
              id
              remainingQuantity
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_V2 = `
  mutation FulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function shopifyOrderGid(order) {
  const raw = String(order?.shopifyOrderId || '').trim();
  if (!raw || isManualOrderRef(raw)) return null;
  if (raw.startsWith('gid://shopify/Order/')) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/Order/${raw}`;
  return null;
}

/**
 * Mark a Shopify order fulfilled when OMS verifies with the customer.
 * This is Shopify queue cleanup only — it must NEVER drive OMS delivery status.
 * Manual / M-xxxx orders are skipped — stock-only sync applies there.
 */
export async function markShopifyOrderFulfilled(order) {
  const orderGid = shopifyOrderGid(order);
  if (!orderGid || order?.orderSource === 'manual') {
    return { skipped: true, reason: 'manual_or_not_shopify' };
  }

  const data = await shopifyGraphQL(ORDER_FULFILLMENT_ORDERS, { id: orderGid });
  const shopifyOrder = data?.order;
  if (!shopifyOrder) {
    const err = new Error('Shopify order not found for fulfillment');
    err.statusCode = 404;
    throw err;
  }

  if (shopifyOrder.displayFulfillmentStatus === 'FULFILLED') {
    return { skipped: true, reason: 'already_fulfilled', orderGid };
  }

  const lineItemsByFulfillmentOrder = [];
  for (const fo of shopifyOrder.fulfillmentOrders?.nodes || []) {
    if (!['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(fo.status)) continue;
    const fulfillmentOrderLineItems = (fo.lineItems?.nodes || [])
      .filter((li) => (li.remainingQuantity || 0) > 0)
      .map((li) => ({ id: li.id, quantity: li.remainingQuantity }));
    if (!fulfillmentOrderLineItems.length) continue;
    lineItemsByFulfillmentOrder.push({
      fulfillmentOrderId: fo.id,
      fulfillmentOrderLineItems,
    });
  }

  if (!lineItemsByFulfillmentOrder.length) {
    return { skipped: true, reason: 'no_open_fulfillment_lines', orderGid };
  }

  const result = await shopifyGraphQL(FULFILLMENT_CREATE_V2, {
    fulfillment: {
      lineItemsByFulfillmentOrder,
      notifyCustomer: false,
    },
  });

  const userErrors = result?.fulfillmentCreateV2?.userErrors || [];
  if (userErrors.length) {
    const msg = userErrors.map((e) => e.message).join('; ');
    if (/already fulfilled|nothing to fulfill/i.test(msg)) {
      return { skipped: true, reason: 'already_fulfilled', orderGid, message: msg };
    }
    const err = new Error(msg);
    err.statusCode = 400;
    throw err;
  }

  const fulfillment = result?.fulfillmentCreateV2?.fulfillment;
  logger.info(
    { orderGid, fulfillmentId: fulfillment?.id, status: fulfillment?.status },
    'Shopify order marked fulfilled after OMS verification'
  );
  return { fulfilled: true, orderGid, fulfillmentId: fulfillment?.id, status: fulfillment?.status };
}

export default { markShopifyOrderFulfilled };
