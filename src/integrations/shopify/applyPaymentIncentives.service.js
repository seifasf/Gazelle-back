import logger from '../../utils/logger.js';
import { shopifyGraphQL, shopifyRest } from './client.js';
import { mapShopifyPaymentMethod } from './orderMoney.js';
import {
  COD_FEE_EGP,
  COD_FEE_SKU,
  COD_FEE_TITLE,
  INCENTIVE_ATTR,
  incentivesNeedShopifyEdit,
  isOnlineFiveDiscount,
  orderHasCodFee,
  planPaymentIncentives,
} from '../../utils/shopifyPaymentIncentives.js';

function orderGid(payload) {
  return payload.admin_graphql_api_id || `gid://shopify/Order/${payload.id}`;
}

function firstError(userErrors = []) {
  return userErrors.map((e) => e.message).filter(Boolean).join('; ');
}

async function restOrder(id) {
  const data = await shopifyRest(`/orders/${id}.json`);
  return data.order;
}

async function beginEdit(orderId) {
  const data = await shopifyGraphQL(
    `mutation Begin($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder { id }
        userErrors { field message }
      }
    }`,
    { id: orderId }
  );
  const err = firstError(data.orderEditBegin.userErrors);
  if (err) throw new Error(err);
  return data.orderEditBegin.calculatedOrder.id;
}

async function commitEdit(calculatedOrderId) {
  const data = await shopifyGraphQL(
    `mutation Commit($id: ID!) {
      orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Gazelle: online 5% / COD EGP 25") {
        order { id }
        userErrors { field message }
      }
    }`,
    { id: calculatedOrderId }
  );
  const err = firstError(data.orderEditCommit.userErrors);
  if (err) throw new Error(err);
}

async function calculatedLines(calculatedOrderId) {
  const data = await shopifyGraphQL(
    `query Lines($id: ID!) {
      calculatedOrder(id: $id) {
        id
        lineItems(first: 50) {
          nodes {
            id
            quantity
            title
            variant { sku }
            calculatedDiscountAllocations {
              discountApplication { id description }
            }
          }
        }
        discountApplications(first: 20) {
          nodes { id description }
        }
      }
    }`,
    { id: calculatedOrderId }
  );
  return data.calculatedOrder;
}

function isFeeLine(node) {
  const sku = String(node?.variant?.sku || '').toUpperCase();
  const title = String(node?.title || '');
  if (sku === COD_FEE_SKU) return true;
  if (title.includes(COD_FEE_TITLE)) return true;
  return /cod fee|cash on delivery fee|releasit|رسوم الدفع عند الاستلام/i.test(title);
}

async function addFee(calculatedOrderId) {
  const data = await shopifyGraphQL(
    `mutation AddFee($id: ID!, $title: String!, $qty: Int!, $price: MoneyInput!) {
      orderEditAddCustomItem(id: $id, title: $title, quantity: $qty, originalUnitPrice: $price, taxable: false, requireShipping: false) {
        userErrors { field message }
      }
    }`,
    {
      id: calculatedOrderId,
      title: COD_FEE_TITLE,
      qty: 1,
      price: { amount: String(COD_FEE_EGP), currencyCode: 'EGP' },
    }
  );
  const err = firstError(data.orderEditAddCustomItem?.userErrors);
  if (err) throw new Error(err);
}

async function addFeeDecimal(calculatedOrderId) {
  const data = await shopifyGraphQL(
    `mutation AddFeeDec($id: ID!, $title: String!) {
      orderEditAddCustomItem(id: $id, title: $title, quantity: 1, originalUnitPrice: 25.0, taxable: false) {
        userErrors { field message }
      }
    }`,
    { id: calculatedOrderId, title: COD_FEE_TITLE }
  );
  const err = firstError(data.orderEditAddCustomItem?.userErrors);
  if (err) throw new Error(err);
}

async function setQty(calculatedOrderId, lineItemId, quantity) {
  const data = await shopifyGraphQL(
    `mutation SetQty($id: ID!, $lineItemId: ID!, $quantity: Int!) {
      orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
        userErrors { field message }
      }
    }`,
    { id: calculatedOrderId, lineItemId, quantity }
  );
  const err = firstError(data.orderEditSetQuantity?.userErrors);
  if (err) throw new Error(err);
}

async function removeDiscount(calculatedOrderId, discountApplicationId) {
  const data = await shopifyGraphQL(
    `mutation RemoveDisc($id: ID!, $discountApplicationId: ID!) {
      orderEditRemoveDiscount(id: $id, discountApplicationId: $discountApplicationId) {
        userErrors { field message }
      }
    }`,
    { id: calculatedOrderId, discountApplicationId }
  );
  const err = firstError(data.orderEditRemoveDiscount?.userErrors);
  if (err) throw new Error(err);
}

async function addFivePercent(calculatedOrderId, lineItemId) {
  const data = await shopifyGraphQL(
    `mutation AddPct($id: ID!, $lineItemId: ID!) {
      orderEditAddLineItemDiscount(
        id: $id
        lineItemId: $lineItemId
        discount: { percentValue: 5.0, description: "ONLINE5" }
      ) {
        userErrors { field message }
      }
    }`,
    { id: calculatedOrderId, lineItemId }
  );
  const err = firstError(data.orderEditAddLineItemDiscount?.userErrors);
  if (err) throw new Error(err);
}

async function stampAttribute(orderId, value) {
  await shopifyGraphQL(
    `mutation Stamp($input: OrderInput!) {
      orderUpdate(input: $input) {
        userErrors { field message }
      }
    }`,
    {
      input: {
        id: orderId,
        customAttributes: [{ key: INCENTIVE_ATTR, value }],
      },
    }
  ).catch((err) => {
    logger.warn({ err: err.message }, 'Could not stamp gazelle_pay order attribute');
  });
}

function alreadyStamped(payload) {
  const attrs = payload.note_attributes || payload.customAttributes || [];
  return attrs.some((a) => {
    const key = a.name || a.key;
    return key === INCENTIVE_ATTR && a.value;
  });
}

/**
 * COD → add EGP 25 (skip if Releasit already added it) and strip ONLINE5.
 * Online → 5% off merchandise and drop a leftover COD fee.
 */
export async function applyShopifyPaymentIncentives(payload) {
  if (!payload?.id || payload.cancelled_at) return payload;
  if (alreadyStamped(payload)) return payload;

  const paymentMethod = mapShopifyPaymentMethod(payload);
  const plan = planPaymentIncentives(payload, paymentMethod);
  if (!incentivesNeedShopifyEdit(plan)) {
    await stampAttribute(orderGid(payload), paymentMethod);
    return payload;
  }

  const gid = orderGid(payload);
  logger.info({ shopifyOrderId: payload.id, paymentMethod, plan }, 'Applying Shopify payment incentives');

  try {
    const calcId = await beginEdit(gid);
    const calc = await calculatedLines(calcId);

    if (plan.addCodFee && !calc.lineItems.nodes.some(isFeeLine)) {
      try {
        await addFee(calcId);
      } catch (err) {
        logger.warn({ err: err.message }, 'orderEditAddCustomItem retried with Decimal price');
        await addFeeDecimal(calcId);
      }
    }

    if (plan.removeCodFee) {
      for (const node of calc.lineItems.nodes.filter(isFeeLine)) {
        await setQty(calcId, node.id, 0);
      }
    }

    if (plan.removeOnlineDiscount) {
      const ids = new Set();
      for (const app of calc.discountApplications?.nodes || []) {
        if (app.id && isOnlineFiveDiscount(app)) ids.add(app.id);
      }
      for (const line of calc.lineItems.nodes) {
        for (const alloc of line.calculatedDiscountAllocations || []) {
          const app = alloc.discountApplication;
          if (app?.id && isOnlineFiveDiscount(app)) ids.add(app.id);
        }
      }
      for (const discountApplicationId of ids) {
        await removeDiscount(calcId, discountApplicationId);
      }
    }

    if (plan.addOnlineDiscount) {
      for (const node of calc.lineItems.nodes) {
        if (isFeeLine(node) || !node.quantity) continue;
        await addFivePercent(calcId, node.id);
      }
    }

    await commitEdit(calcId);
    await stampAttribute(gid, paymentMethod);
    const fresh = await restOrder(payload.id);
    return fresh || payload;
  } catch (err) {
    logger.error(
      { err: err.message, shopifyOrderId: payload.id, paymentMethod },
      'Shopify payment incentive edit failed — ingesting original totals'
    );
    return payload;
  }
}

export { orderHasCodFee };
