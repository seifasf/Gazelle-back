import Variant from '../models/Variant.js';
import InventoryLedger from '../models/InventoryLedger.js';
import DiscrepancyAlert from '../models/DiscrepancyAlert.js';

export async function checkVariantInvariant(variantId) {
  const variant = await Variant.findById(variantId);
  if (!variant) return null;

  const ledger = await InventoryLedger.find({ variantId }).sort({ createdAt: 1 });
  let computedOnHold = 0;
  let computedReal = 0;
  let computedOnline = 0;

  for (const entry of ledger) {
    switch (entry.ledgerType) {
      case 'on_hold_reserve':
        computedOnHold += entry.quantityDelta;
        break;
      case 'on_hold_release':
        computedOnHold += entry.quantityDelta;
        break;
      case 'real_stock_decrement':
      case 'real_stock_increment_manual':
      case 'real_stock_increment_return':
        computedReal += entry.quantityDelta;
        break;
      case 'online_stock_increment_api':
        computedOnline += entry.quantityDelta;
        break;
      default:
        break;
    }
  }

  const issues = [];
  if (variant.onHoldStock !== computedOnHold) {
    issues.push({ field: 'onHoldStock', expected: computedOnHold, actual: variant.onHoldStock });
  }
  if (variant.realStock !== computedReal) {
    issues.push({ field: 'realStock', expected: computedReal, actual: variant.realStock });
  }

  return { variant, issues, ledgerCount: ledger.length };
}

export async function createDiscrepancyAlert({ type, variantId, orderId, expected, actual, message }) {
  return DiscrepancyAlert.create({ type, variantId, orderId, expected, actual, message });
}

export async function listUnresolvedAlerts({ limit = 50, skip = 0 } = {}) {
  const filter = { resolvedAt: { $exists: false } };
  const [alerts, total] = await Promise.all([
    DiscrepancyAlert.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('variantId', 'sku title')
      .populate('orderId', 'shopifyOrderId'),
    DiscrepancyAlert.countDocuments(filter),
  ]);
  return { alerts, total };
}

export async function resolveAlert(alertId, userId) {
  return DiscrepancyAlert.findByIdAndUpdate(
    alertId,
    { resolvedAt: new Date(), resolvedByUserId: userId },
    { new: true }
  );
}

export async function reportOnlineStockDrift(variantId, shopifyOnlineStock) {
  const variant = await Variant.findById(variantId);
  if (!variant) return null;

  if (variant.onlineStock !== shopifyOnlineStock) {
    return createDiscrepancyAlert({
      type: 'online_stock_drift',
      variantId,
      expected: variant.onlineStock,
      actual: shopifyOnlineStock,
      message: `Shopify online_stock drift for SKU ${variant.sku}`,
    });
  }
  return null;
}

export default {
  checkVariantInvariant,
  createDiscrepancyAlert,
  listUnresolvedAlerts,
  resolveAlert,
  reportOnlineStockDrift,
};
