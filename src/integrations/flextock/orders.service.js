import { flextockRequest } from './client.js';
import { buildCancelOrderPayload, buildCreateOrderPayload, flextockMerchantOrderCode } from './payloads.js';
import { ensureFlextockProductsForOrder } from './products.service.js';
import logger from '../../utils/logger.js';

export async function getFlextockOrderStatus(orderCode) {
  const code = String(orderCode || '').trim();
  if (!code) return null;
  return flextockRequest('/external-integration/order-status/', {
    method: 'POST',
    body: { order_code: code },
  });
}

export async function getFlextockOrderStatuses(orderCodes) {
  const codes = (orderCodes || []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 100);
  if (!codes.length) return [];
  const data = await flextockRequest('/external-integration/order-status/', {
    method: 'POST',
    body: { order_code_array: codes },
  });
  return data;
}

export async function getFlextockOrderDetails(orderCode) {
  return flextockRequest('/external-integration/order-details', {
    method: 'GET',
    query: { order_code: String(orderCode || '').trim() },
  });
}

export async function cancelFlextockOrder(orderCode, orderType = 'outbound') {
  return flextockRequest('/external-integration/cancel-order/', {
    method: 'POST',
    body: buildCancelOrderPayload(orderCode, orderType),
  });
}

function applyStatusToOrder(order, statusPayload) {
  const row = Array.isArray(statusPayload) ? statusPayload[0] : statusPayload;
  if (!row || typeof row !== 'object') return order;
  if (row.order_status != null) order.flextockOrderStatus = String(row.order_status);
  if (row.tracking_number != null) order.flextockTrackingNumber = String(row.tracking_number);
  if (row.tracking_url != null) order.flextockTrackingUrl = String(row.tracking_url);
  if (row.courier_name != null) order.flextockCourierName = String(row.courier_name);
  order.flextockSyncedAt = new Date();
  return order;
}

export async function createFlextockOrder(order, customer) {
  if (order?.isRepairOrder) {
    const err = new Error('Flextock needs product SKUs — use Bosta or local shipping for repairs');
    err.statusCode = 400;
    throw err;
  }
  if (!order?.shippingAddress?.line1 || !String(order.shippingAddress?.city || '').trim()) {
    const err = new Error(
      'Order is missing street or city. Open the order, fix the shipping address, then retry Flextock.'
    );
    err.statusCode = 400;
    throw err;
  }

  const { variantsById } = await ensureFlextockProductsForOrder(order);
  const payload = buildCreateOrderPayload(order, customer, variantsById);
  if (!payload.line_items.length) {
    const err = new Error('Flextock order needs at least one SKU');
    err.statusCode = 400;
    throw err;
  }
  if (!payload.customer_address.first_name && !payload.customer_address.last_name) {
    const err = new Error('Flextock needs a customer first or last name');
    err.statusCode = 400;
    throw err;
  }

  const code = payload.order_code;
  try {
    await flextockRequest('/external-integration/create-order/', {
      method: 'POST',
      body: payload,
    });
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    const already = msg.includes('already exists') || err.statusCode === 400 && msg.includes('already');
    if (!already) throw err;
    logger.info({ orderCode: code, orderId: String(order._id) }, 'Flextock order already exists — using live status');
  }

  let status = null;
  try {
    status = await getFlextockOrderStatus(code);
  } catch (err) {
    logger.warn({ err: err.message, orderCode: code }, 'Flextock order created but status lookup failed');
  }

  applyStatusToOrder(order, status);
  order.flextockOrderCode = code;
  order.flextockOrderType = 'outbound';
  order.flextockShipmentStatus = 'created';
  order.flextockShipmentError = null;
  return {
    orderCode: code,
    trackingNumber: order.flextockTrackingNumber || null,
    trackingUrl: order.flextockTrackingUrl || null,
    orderStatus: order.flextockOrderStatus || null,
    created: true,
    status,
  };
}

export { flextockMerchantOrderCode };
export default {
  createFlextockOrder,
  getFlextockOrderStatus,
  getFlextockOrderStatuses,
  getFlextockOrderDetails,
  cancelFlextockOrder,
};
