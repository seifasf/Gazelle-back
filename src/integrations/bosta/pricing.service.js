import { bostaRequest } from './client.js';
import {
  bostaCodAmountForOrder,
  bostaDeliveryTypeForOrder,
} from './shipments.service.js';

function roundEgp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function readAmount(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const parts = String(key).split('.');
    let cur = source;
    for (const part of parts) {
      cur = cur?.[part];
    }
    const n = Number(cur);
    if (Number.isFinite(n) && n >= 0) return roundEgp(n);
  }
  return null;
}

function parseFeeLines(lines) {
  const out = {
    shippingFee: 0,
    openPackageFee: 0,
    nextDayTransferFee: 0,
    vat: 0,
    insuranceFee: 0,
    total: 0,
  };
  if (!Array.isArray(lines)) return null;

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const label = String(line.name || line.label || line.title || line.key || '').toLowerCase();
    const amount = readAmount(line, ['amount', 'value', 'fee', 'price', 'total']);
    if (amount == null) continue;

    if (/shipping/.test(label) && !/customer/.test(label)) out.shippingFee = amount;
    else if (/open.?package/.test(label)) out.openPackageFee = amount;
    else if (/next.?day|transfer/.test(label)) out.nextDayTransferFee = amount;
    else if (/vat|tax/.test(label)) out.vat = amount;
    else if (/insurance/.test(label)) out.insuranceFee = amount;
    else if (/total/.test(label)) out.total = amount;
  }

  if (!out.total) {
    out.total = roundEgp(
      out.shippingFee + out.openPackageFee + out.nextDayTransferFee + out.vat + out.insuranceFee
    );
  }
  return out.total > 0 ? out : null;
}

/**
 * Normalize Bosta pricing / wallet payloads into Gazelle fee breakdown.
 * Accepts calculator responses, delivery.wallet, or nested fee objects.
 */
export function parseBostaFeeBreakdown(raw, source = 'calculator') {
  if (raw == null) return null;

  const root = raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
  if (Array.isArray(root)) {
    const fromLines = parseFeeLines(root);
    if (fromLines) {
      return { ...fromLines, source, fetchedAt: new Date() };
    }
    return null;
  }

  for (const lines of [root.fees, root.breakdown, root.feeBreakdown, root.items, root.details]) {
    const fromLines = parseFeeLines(lines);
    if (fromLines) {
      return { ...fromLines, source, fetchedAt: new Date() };
    }
  }

  const shippingFee =
    readAmount(root, [
      'shippingFees',
      'shippingFee',
      'shipping_fees',
      'shipping',
      'deliveryFee',
      'deliveryFees',
    ]) ?? 0;
  const openPackageFee =
    readAmount(root, [
      'openPackageFees',
      'openPackageFee',
      'open_package_fees',
      'openPackage',
      'allowToOpenPackageFee',
    ]) ?? 0;
  const nextDayTransferFee =
    readAmount(root, [
      'nextDayTransferFees',
      'nextDayTransferFee',
      'next_day_transfer_fees',
      'nextDayFees',
      'transferFees',
    ]) ?? 0;
  const vat =
    readAmount(root, ['vat', 'vatFees', 'vatFee', 'vatAmount', 'tax', 'taxes']) ?? 0;
  const insuranceFee =
    readAmount(root, ['insuranceFees', 'insuranceFee', 'insurance', 'insuranceAmount']) ?? 0;

  let total =
    readAmount(root, [
      'total',
      'totalFees',
      'totalBostaFees',
      'totalPrice',
      'price',
      'bostaFees',
      'bosta_fees',
      'amount',
    ]) ?? 0;

  if (!total) {
    total = roundEgp(shippingFee + openPackageFee + nextDayTransferFee + vat + insuranceFee);
  }

  if (!(total > 0)) return null;

  return {
    shippingFee,
    openPackageFee,
    nextDayTransferFee,
    vat,
    insuranceFee,
    total,
    source,
    fetchedAt: new Date(),
  };
}

export function parseBostaFeeBreakdownFromDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object') return null;

  const candidates = [
    delivery.pricing,
    delivery.pricingDetails,
    delivery.shipmentFees,
    delivery.fees,
    delivery.wallet?.pricing,
    delivery.wallet?.fees,
    delivery.wallet?.feeBreakdown,
    delivery.wallet?.shipmentFees,
    delivery.wallet,
    delivery,
  ];

  for (const candidate of candidates) {
    const parsed = parseBostaFeeBreakdown(candidate, 'delivery');
    if (parsed?.total > 0) return parsed;
  }
  return null;
}

export function buildCalculatorParamsForOrder(order) {
  if (!order || order.shippingMethod !== 'bosta') return null;

  const dropOffCity = String(order.shippingAddress?.city || '').trim();
  if (!dropOffCity) return null;

  return {
    pickupCity: process.env.BOSTA_PICKUP_CITY || 'Cairo',
    dropOffCity,
    cod: bostaCodAmountForOrder(order),
    size: 'MEDIUM',
    allowToOpenPackage: true,
    type: bostaDeliveryTypeForOrder(order),
    goodsValue: Math.max(0, Number(order.totalSellingPrice) || 0),
  };
}

export async function calculateShipmentFees(params) {
  const query = {
    pickupCity: params.pickupCity || 'Cairo',
    dropOffCity: params.dropOffCity,
    cod: params.cod ?? 0,
    size: params.size || 'MEDIUM',
    allowToOpenPackage: params.allowToOpenPackage !== false,
    type: params.type ?? 10,
  };
  if (params.goodsValue > 0) query.goodsValue = params.goodsValue;

  const response = await bostaRequest('/pricing/shipment/calculator', {
    method: 'GET',
    query,
    quiet: true,
  });
  return parseBostaFeeBreakdown(response, 'calculator');
}

export default {
  parseBostaFeeBreakdown,
  parseBostaFeeBreakdownFromDelivery,
  buildCalculatorParamsForOrder,
  calculateShipmentFees,
};
