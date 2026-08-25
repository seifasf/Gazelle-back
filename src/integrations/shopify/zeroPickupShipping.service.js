import logger from '../../utils/logger.js';
import { shopifyGraphQL, shopifyRest } from './client.js';
import { isManualOrderRef } from '../../utils/orderRefs.js';

function firstError(userErrors = []) {
  return (userErrors || []).map((e) => e.message).filter(Boolean).join('; ');
}

function orderGid(order) {
  const id = order?.shopifyOrderId;
  if (!id) return null;
  if (String(id).startsWith('gid://')) return String(id);
  return `gid://shopify/Order/${id}`;
}

/**
 * Set Shopify shipping to EGP 0 for warehouse pickup so checkout shipping is not left on the order.
 */
export async function zeroShopifyShippingForPickup(order) {
  if (!order || order.shippingMethod !== 'pickup') return { skipped: true };
  if (order.orderSource === 'manual' || isManualOrderRef(order.shopifyOrderId)) {
    return { skipped: true, reason: 'manual' };
  }
  const gid = orderGid(order);
  const restId = String(order.shopifyOrderId || '').replace(/^gid:\/\/shopify\/Order\//, '');
  if (!gid || !restId) return { skipped: true, reason: 'no-shopify-id' };

  try {
    const begin = await shopifyGraphQL(
      `mutation Begin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { id: gid }
    );
    const beginErr = firstError(begin.orderEditBegin?.userErrors);
    if (beginErr) throw new Error(beginErr);
    const calcId = begin.orderEditBegin?.calculatedOrder?.id;
    if (!calcId) throw new Error('orderEditBegin returned no calculated order');

    const calc = await shopifyGraphQL(
      `query Lines($id: ID!) {
        calculatedOrder(id: $id) {
          id
          shippingLines {
            id
            title
          }
        }
      }`,
      { id: calcId }
    );
    const linesRaw = calc.calculatedOrder?.shippingLines;
    const lines = Array.isArray(linesRaw) ? linesRaw : linesRaw?.nodes || [];
    const pickupLine = {
      title: 'Warehouse pickup',
      price: { amount: '0.00', currencyCode: 'EGP' },
    };

    if (lines.length) {
      for (const line of lines) {
        const upd = await shopifyGraphQL(
          `mutation Upd($id: ID!, $shippingLineId: ID!, $shippingLine: OrderEditAppliedShippingLineInput!) {
            orderEditUpdateShippingLine(id: $id, shippingLineId: $shippingLineId, shippingLine: $shippingLine) {
              userErrors { field message }
            }
          }`,
          { id: calcId, shippingLineId: line.id, shippingLine: pickupLine }
        );
        const err = firstError(upd.orderEditUpdateShippingLine?.userErrors);
        if (err) throw new Error(err);
      }
    } else {
      const add = await shopifyGraphQL(
        `mutation Add($id: ID!, $shippingLine: OrderEditAppliedShippingLineInput!) {
          orderEditAddShippingLine(id: $id, shippingLine: $shippingLine) {
            userErrors { field message }
          }
        }`,
        { id: calcId, shippingLine: pickupLine }
      );
      const err = firstError(add.orderEditAddShippingLine?.userErrors);
      if (err) throw new Error(err);
    }

    const commit = await shopifyGraphQL(
      `mutation Commit($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Gazelle: warehouse pickup  shipping EGP 0") {
          userErrors { field message }
        }
      }`,
      { id: calcId }
    );
    const commitErr = firstError(commit.orderEditCommit?.userErrors);
    if (commitErr) throw new Error(commitErr);

    logger.info({ shopifyOrderId: restId }, 'Shopify shipping set to 0 for warehouse pickup');
    return { ok: true };
  } catch (err) {
    logger.warn(
      { err: err.message, shopifyOrderId: restId },
      'GraphQL pickup shipping zero failed  trying REST'
    );
    try {
      const data = await shopifyRest(`/orders/${restId}.json`);
      const existing = data?.order?.shipping_lines || [];
      await shopifyRest(`/orders/${restId}.json`, {
        method: 'PUT',
        body: {
          order: {
            id: Number(restId) || restId,
            shipping_lines: existing.length
              ? existing.map((l) => ({
                  id: l.id,
                  price: '0.00',
                  title: 'Warehouse pickup',
                }))
              : [{ price: '0.00', title: 'Warehouse pickup' }],
          },
        },
      });
      return { ok: true, via: 'rest' };
    } catch (restErr) {
      logger.error(
        { err: restErr.message, shopifyOrderId: restId },
        'Could not zero Shopify shipping for pickup'
      );
      const wrapped = new Error(restErr.message || err.message);
      wrapped.statusCode = 502;
      throw wrapped;
    }
  }
}

export default { zeroShopifyShippingForPickup };
