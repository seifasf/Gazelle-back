import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeShippingEconomics,
  shippingLossAppliesToRange,
  SHIPPING_LOSS_START_YMD,
} from './shippingEconomics.js';

describe('computeShippingEconomics', () => {
  it('shipping loss is Bosta fees minus customer shipping only (no COD 25)', () => {
    const r = computeShippingEconomics({
      customerShipping: 500,
      bostaFees: 600,
      orderCount: 10,
    });
    assert.equal(r.leftAfterBosta, -100);
    assert.equal(r.shippingResult, -100);
    assert.equal(r.shippingLoss, 100);
    assert.equal(r.shippingGain, 0);
    assert.equal(r.egp25Total, undefined);
  });

  it('gain when customer shipping covers Bosta', () => {
    const r = computeShippingEconomics({
      customerShipping: 1000,
      bostaFees: 500,
      orderCount: 10,
    });
    assert.equal(r.leftAfterBosta, 500);
    assert.equal(r.shippingLoss, 0);
    assert.equal(r.shippingGain, 500);
  });
});

describe('shippingLossAppliesToRange', () => {
  it(`applies from ${SHIPPING_LOSS_START_YMD}`, () => {
    assert.equal(shippingLossAppliesToRange({ from: '2026-09-01', to: '2026-09-30' }), true);
    assert.equal(shippingLossAppliesToRange({ from: '2026-08-01', to: '2026-08-31' }), false);
    assert.equal(shippingLossAppliesToRange({ from: '2026-08-15', to: '2026-09-15' }), true);
  });
});
