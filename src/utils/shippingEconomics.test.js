import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeShippingEconomics,
  computeShippingEconomicsFromOrders,
  resolveRealBostaFee,
  shippingLossAppliesToRange,
  SHIPPING_LOSS_START_YMD,
} from './shippingEconomics.js';

describe('computeShippingEconomics', () => {
  it('shipping loss when Bosta fees exceed collected shipping', () => {
    const r = computeShippingEconomics({
      customerShipping: 500,
      bostaFees: 600,
      orderCount: 10,
    });
    assert.equal(r.leftAfterBosta, -100);
    assert.equal(r.shippingLoss, 100);
    assert.equal(r.shippingGain, 0);
  });

  it('gain when collected shipping covers Bosta', () => {
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

describe('resolveRealBostaFee', () => {
  it('prefers invoice breakdown total (real / hidden fees)', () => {
    assert.equal(
      resolveRealBostaFee({
        bostaFeeBreakdown: { total: 121.7 },
        bostaCourierFee: 50,
      }),
      121.7
    );
  });
});

describe('computeShippingEconomicsFromOrders', () => {
  it('failed/RTO: customer shipping not collected, Bosta fee is full loss', () => {
    const r = computeShippingEconomicsFromOrders({
      deliveredOrders: [
        {
          shippingMethod: 'bosta',
          shippingFee: 95,
          bostaFeeBreakdown: { total: 50, source: 'delivery' },
        },
      ],
      failedRtoOrders: [
        {
          shippingMethod: 'bosta',
          shippingFee: 95,
          internalStatus: 'failed_delivery',
          bostaFeeBreakdown: { total: 80, source: 'delivery' },
        },
        {
          shippingMethod: 'bosta',
          shippingFee: 100,
          internalStatus: 'returned_to_stock',
          bostaFeeBreakdown: { total: 90, source: 'calculator' },
        },
      ],
      bostaApiOnly: true,
    });
    assert.equal(r.customerShipping, 95);
    assert.equal(r.bostaFees, 50 + 80 + 90);
    assert.equal(r.failedRto.bostaFees, 170);
    assert.equal(r.shippingLoss, 125);
  });

  it('ignores zone/estimate fees when bostaApiOnly', () => {
    const r = computeShippingEconomicsFromOrders({
      deliveredOrders: [
        {
          shippingMethod: 'bosta',
          shippingFee: 95,
          bostaFeeBreakdown: { total: 50, source: 'zone' },
        },
      ],
      failedRtoOrders: [],
      bostaApiOnly: true,
    });
    assert.equal(r.bostaFees, 0);
    assert.equal(r.delivered.withLiveFee, 0);
  });
});

describe('shippingLossAppliesToRange', () => {
  it(`applies from ${SHIPPING_LOSS_START_YMD}`, () => {
    assert.equal(shippingLossAppliesToRange({ from: '2026-09-01', to: '2026-09-30' }), true);
    assert.equal(shippingLossAppliesToRange({ from: '2026-08-01', to: '2026-08-31' }), false);
    assert.equal(shippingLossAppliesToRange({ from: '2026-08-15', to: '2026-09-15' }), true);
  });
});
