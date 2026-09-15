import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeShippingEconomics,
  shippingLossAppliesToRange,
  SHIPPING_LOSS_START_YMD,
} from './shippingEconomics.js';

describe('computeShippingEconomics', () => {
  it('Left after Bosta: loss when Bosta fees exceed customer shipping', () => {
    // 10 orders x 50 ship collected = 500; Bosta 600; left = -100 loss
    const r = computeShippingEconomics({
      customerShipping: 500,
      bostaFees: 600,
      orderCount: 10,
    });
    assert.equal(r.leftAfterBosta, -100);
    assert.equal(r.egp25Total, 0);
    assert.equal(r.shippingResult, -100);
    assert.equal(r.shippingLoss, 100);
    assert.equal(r.shippingGain, 0);
  });

  it('positive result when customer shipping covers Bosta (no EGP 25)', () => {
    const r = computeShippingEconomics({
      customerShipping: 1000,
      bostaFees: 500,
      orderCount: 10,
    });
    assert.equal(r.leftAfterBosta, 500);
    assert.equal(r.shippingResult, 500);
    assert.equal(r.shippingLoss, 0);
    assert.equal(r.shippingGain, 500);
    assert.equal(r.egp25Total, 0);
  });
});

describe('shippingLossAppliesToRange', () => {
  it(`applies from ${SHIPPING_LOSS_START_YMD}`, () => {
    assert.equal(shippingLossAppliesToRange({ from: '2026-09-01', to: '2026-09-30' }), true);
    assert.equal(shippingLossAppliesToRange({ from: '2026-08-01', to: '2026-08-31' }), false);
    assert.equal(shippingLossAppliesToRange({ from: '2026-08-15', to: '2026-09-15' }), true);
  });
});
