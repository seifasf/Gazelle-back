import { recordPaymobPayment } from './payments.service.js';

/** Paymob sends the transaction under `obj` on processed callbacks. */
export function unwrapPaymobPayload(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.obj && typeof body.obj === 'object') return body.obj;
  if (body.transaction && typeof body.transaction === 'object') return body.transaction;
  return body;
}

/** Record the payment for a stored receipt. Throws so the caller can ask Paymob to retry. */
export async function processPaymobReceipt(receipt) {
  try {
    const result = await recordPaymobPayment(unwrapPaymobPayload(receipt.payload));
    receipt.processedAt = new Date();
    receipt.error = result?.reason && result.reason !== 'duplicate' ? result.reason : undefined;
    await receipt.save();
    return result;
  } catch (error) {
    receipt.error = error?.message || String(error);
    await receipt.save();
    throw error;
  }
}
