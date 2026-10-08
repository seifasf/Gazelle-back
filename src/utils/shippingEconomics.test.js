import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeShippingEconomics,
  computeShippingEconomicsFromOrders,
  findFailedRtoOrdersForRange,
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

describe('findFailedRtoOrdersForRange', () => {
  const at = (iso) => new Date(iso);
  const orders = [
    // Failed in September, returned to stock (edited) in October.
    { _id: 'sep-fail', internalStatus: 'returned_to_stock', updatedAt: at('2026-10-05T10:00:00Z') },
    // Failed in October.
    { _id: 'oct-fail', internalStatus: 'returning_to_origin', updatedAt: at('2026-10-03T10:00:00Z') },
    // Failed in October, later delivered on retry: counted as delivered, not failed.
    { _id: 'oct-retry', internalStatus: 'delivered', updatedAt: at('2026-10-04T10:00:00Z') },
    // Legacy order with no status history: falls back to updatedAt.
    { _id: 'legacy', internalStatus: 'returned_to_stock', updatedAt: at('2026-10-02T10:00:00Z') },
  ];
  const history = [
    { orderId: 'sep-fail', toStatus: 'failed_delivery', createdAt: at('2026-09-20T10:00:00Z') },
    { orderId: 'sep-fail', toStatus: 'returned_to_stock', createdAt: at('2026-10-05T10:00:00Z') },
    { orderId: 'oct-fail', toStatus: 'returning_to_origin', createdAt: at('2026-10-02T10:00:00Z') },
    { orderId: 'oct-retry', toStatus: 'failed_delivery', createdAt: at('2026-10-01T10:00:00Z') },
  ];

  const inRange = (v, r) => (!r.$gte || v >= r.$gte) && (!r.$lte || v <= r.$lte);
  const Order = {
    find(filter) {
      const rows = orders.filter(
        (o) =>
          (!filter.internalStatus || filter.internalStatus.$in.includes(o.internalStatus)) &&
          (!filter.updatedAt || inRange(o.updatedAt, filter.updatedAt)) &&
          (!filter._id || filter._id.$in.includes(o._id))
      );
      return { select: async () => rows };
    },
  };
  const OrderStatusHistory = {
    async aggregate(pipeline) {
      const upTo = pipeline[0].$match.createdAt.$lte;
      const window = pipeline[2].$match.firstFailedAt;
      const first = new Map();
      for (const h of history) {
        if (!pipeline[0].$match.toStatus.$in.includes(h.toStatus) || h.createdAt > upTo) continue;
        const prev = first.get(h.orderId);
        if (!prev || h.createdAt < prev) first.set(h.orderId, h.createdAt);
      }
      return [...first]
        .filter(([, d]) => inRange(d, window))
        .map(([id, d]) => ({ _id: id, firstFailedAt: d }));
    },
    async distinct(_field, filter) {
      return [...new Set(history
        .filter((h) => filter.orderId.$in.includes(h.orderId) && filter.toStatus.$in.includes(h.toStatus))
        .map((h) => h.orderId))];
    },
  };

  it('dates failures by first failed status, not by last edit', async () => {
    const rows = await findFailedRtoOrdersForRange({
      Order,
      OrderStatusHistory,
      fromBound: at('2026-09-30T21:00:00Z'),
      rangeTo: at('2026-10-31T21:59:59.999Z'),
    });
    assert.deepEqual(rows.map((o) => o._id).sort(), ['legacy', 'oct-fail']);
  });

  it('keeps an old failure in the month it failed', async () => {
    const rows = await findFailedRtoOrdersForRange({
      Order,
      OrderStatusHistory,
      fromBound: at('2026-08-31T21:00:00Z'),
      rangeTo: at('2026-09-30T20:59:59.999Z'),
    });
    assert.deepEqual(rows.map((o) => o._id), ['sep-fail']);
  });
});

describe('shippingLossAppliesToRange', () => {
  it(`applies from ${SHIPPING_LOSS_START_YMD}`, () => {
    assert.equal(shippingLossAppliesToRange({ from: '2026-09-01', to: '2026-09-30' }), true);
    assert.equal(shippingLossAppliesToRange({ from: '2026-08-01', to: '2026-08-31' }), false);
    assert.equal(shippingLossAppliesToRange({ from: '2026-08-15', to: '2026-09-15' }), true);
  });
});
