import { config } from '../../config/index.js';
import { flextockRequest } from './client.js';
import { buildReturnOrderPayload } from './payloads.js';

export async function createFlextockReturnOrder(order, customer, { outboundOrderCode, returnSkus } = {}) {
  const outbound = String(outboundOrderCode || order?.flextockOutboundOrderCode || '').trim();
  if (!outbound) {
    const err = new Error(
      'Flextock return needs the original outbound order code. Send the sale via Flextock first.'
    );
    err.statusCode = 400;
    throw err;
  }
  const skus = returnSkus || (order?.bostaReturnItems || order?.items || []).map((i) => ({
    sku_code: i.sku,
    quantity: i.quantity,
    is_damaged: false,
  }));
  const payload = buildReturnOrderPayload(order, customer, {
    outboundOrderCode: outbound,
    returnSkus: skus,
  });
  return flextockRequest('/external-integration/create-return-order/', {
    method: 'POST',
    body: payload,
  });
}

/**
 * Exchange API is documented as not live. Off unless FLEXTOCK_EXCHANGE_ENABLED=true.
 */
export async function createFlextockExchangeOrder(payload) {
  if (!config.FLEXTOCK_EXCHANGE_ENABLED) {
    const err = new Error('Flextock exchange API is not live yet (PDF: Create Exchange Order — Not Live)');
    err.statusCode = 501;
    throw err;
  }
  return flextockRequest('/external-integration/create-exchange-order/', {
    method: 'POST',
    body: payload,
  });
}

export default { createFlextockReturnOrder, createFlextockExchangeOrder };
