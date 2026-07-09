import PaymobReceived from '../../models/PaymobReceived.js';
import logger from '../../utils/logger.js';

function parseFiniteNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractExternalId(payload) {
  return (
    payload?.id ||
    payload?.transaction?.id ||
    payload?.payment_id ||
    payload?.payment_request_id ||
    null
  );
}

function isPaid(payload) {
  const raw =
    payload?.success != null
      ? payload.success
      : payload?.status ||
        payload?.transaction_status ||
        payload?.payment_status ||
        payload?.transaction?.status ||
        null;

  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === 'string') {
    const s = raw.toLowerCase();
    if (s.includes('success') || s === 'paid') return true;
    if (s.includes('fail') || s.includes('declin')) return false;
  }
  return false;
}

function extractAmountEgp(payload) {
  const cents =
    payload?.amount_cents ??
    payload?.amountCents ??
    payload?.data?.amount_cents ??
    payload?.transaction?.amount_cents;

  const amountCents = parseFiniteNumber(cents);
  if (amountCents != null) return amountCents / 100;

  return parseFiniteNumber(payload?.amount ?? payload?.transaction?.amount);
}

function extractReceivedAt(payload) {
  const raw =
    payload?.created_at ||
    payload?.createdAt ||
    payload?.transaction?.created_at ||
    payload?.transaction?.createdAt;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Record a successful Paymob payment — no order linking, no Paymob API calls. */
export async function recordPaymobPayment(payload) {
  if (!isPaid(payload)) {
    return { recorded: false, reason: 'not_paid' };
  }

  const externalId = extractExternalId(payload);
  if (!externalId) {
    logger.warn({ payloadKeys: Object.keys(payload || {}) }, 'Paymob webhook missing transaction id');
    return { recorded: false, reason: 'no_id' };
  }

  const amountEgp = extractAmountEgp(payload);
  if (amountEgp == null || amountEgp <= 0) {
    logger.warn({ externalId }, 'Paymob webhook missing amount');
    return { recorded: false, reason: 'no_amount' };
  }

  try {
    await PaymobReceived.create({
      externalId: String(externalId),
      amountEgp,
      receivedAt: extractReceivedAt(payload),
    });
    return { recorded: true, externalId, amountEgp };
  } catch (error) {
    if (error?.code === 11000) {
      return { recorded: false, reason: 'duplicate', externalId };
    }
    throw error;
  }
}

export default { recordPaymobPayment };
