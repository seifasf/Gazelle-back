/**
 * What “Confirm — in stock” does to warehouse quantity.
 * Ledger flags come from outstanding decrement/hold on the same order.
 */
export function confirmReturnStockEffect(order, ledger = {}) {
  const collectRestock = Boolean(ledger.collectRestock);
  const outboundRestock = Boolean(ledger.outboundRestock);
  const outboundHold = Boolean(ledger.outboundHold);
  const hasCollectLines = Boolean(ledger.hasCollectLines);

  if (order?.isExchangeOrder && order?.skipCollectRestock) {
    if (order.deliveredAt) return { warehouse: 'no_change', reason: 'skip_collect' };
    return { warehouse: 'release_hold', reason: 'skip_collect_undelivered' };
  }
  if (order?.isReturnOrder) {
    return { warehouse: 'plus_real', reason: 'refund_pickup' };
  }
  if (order?.isExchangeOrder) {
    if (order.deliveredAt) {
      return { warehouse: 'plus_real', reason: 'exchange_collect' };
    }
    return {
      warehouse: 'plus_real_and_release_hold',
      reason: 'exchange_rto_collect',
    };
  }
  if (outboundRestock) {
    return { warehouse: 'plus_real', reason: 'sold_rto' };
  }
  if (outboundHold) {
    return { warehouse: 'release_hold', reason: 'never_sold' };
  }
  if (collectRestock || hasCollectLines) {
    return { warehouse: 'plus_real', reason: 'collect' };
  }
  return { warehouse: 'no_change', reason: 'already_aligned' };
}

/** Which ledger sets to apply when confirming an exchange into warehouse stock. */
export function exchangeConfirmActions(order, { outboundRestockLen = 0, hasCollectLines = false } = {}) {
  const delivered = Boolean(order?.deliveredAt);
  if (order?.skipCollectRestock) {
    return {
      applyCollectPlusReal: false,
      applyOutboundRestock: false,
      applyOutboundHold: !delivered,
    };
  }
  if (delivered) {
    return {
      applyCollectPlusReal: hasCollectLines,
      applyOutboundRestock: false,
      applyOutboundHold: false,
    };
  }
  return {
    applyCollectPlusReal: hasCollectLines,
    applyOutboundRestock: outboundRestockLen > 0,
    applyOutboundHold: outboundRestockLen === 0,
  };
}

export const CONFIRMABLE_RETURN_STATUSES = ['returned_awaiting_receipt', 'returning_to_origin'];
