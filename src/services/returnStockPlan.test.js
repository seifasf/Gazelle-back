import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmReturnStockEffect,
  exchangeConfirmActions,
  CONFIRMABLE_RETURN_STATUSES,
} from './returnStockPlan.js';

describe('confirmReturnStockEffect', () => {
  it('refused / never-sold RTO (like #44277) releases hold, does not +real', () => {
    const effect = confirmReturnStockEffect(
      { isReturnOrder: false, isExchangeOrder: false, deliveredAt: null },
      { outboundRestock: false, outboundHold: true }
    );
    assert.equal(effect.warehouse, 'release_hold');
    assert.equal(effect.reason, 'never_sold');
  });

  it('sold then returned (+real) when the order had a stock decrement', () => {
    const effect = confirmReturnStockEffect(
      { isReturnOrder: false, isExchangeOrder: false, deliveredAt: new Date() },
      { outboundRestock: true, outboundHold: false }
    );
    assert.equal(effect.warehouse, 'plus_real');
    assert.equal(effect.reason, 'sold_rto');
  });

  it('refund CRP pickup always +real', () => {
    const effect = confirmReturnStockEffect(
      { isReturnOrder: true, isExchangeOrder: false },
      { outboundRestock: false, outboundHold: false, hasCollectLines: true }
    );
    assert.equal(effect.warehouse, 'plus_real');
    assert.equal(effect.reason, 'refund_pickup');
  });

  it('delivered exchange collect restocks real stock', () => {
    const effect = confirmReturnStockEffect(
      { isExchangeOrder: true, deliveredAt: new Date() },
      { collectRestock: false, hasCollectLines: true }
    );
    assert.equal(effect.warehouse, 'plus_real');
    assert.equal(effect.reason, 'exchange_collect');
  });

  it('undelivered exchange (M-1013) +real collect and releases outbound hold', () => {
    const effect = confirmReturnStockEffect(
      { isExchangeOrder: true, deliveredAt: null },
      { collectRestock: false, outboundHold: true, hasCollectLines: true }
    );
    assert.equal(effect.warehouse, 'plus_real_and_release_hold');
    assert.equal(effect.reason, 'exchange_rto_collect');
    const actions = exchangeConfirmActions(
      { isExchangeOrder: true, deliveredAt: null },
      { outboundRestockLen: 0, hasCollectLines: true }
    );
    assert.equal(actions.applyCollectPlusReal, true);
    assert.equal(actions.applyOutboundHold, true);
    assert.equal(actions.applyOutboundRestock, false);
  });

  it('only Back at Bosta / Returning statuses are confirmable', () => {
    assert.deepEqual(CONFIRMABLE_RETURN_STATUSES, [
      'returned_awaiting_receipt',
      'returning_to_origin',
      'back_from_local_shipping',
    ]);
  });
});
