import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBostaFeeBreakdown,
  parseBostaFeeBreakdownFromDelivery,
} from './pricing.service.js';

describe('parseBostaFeeBreakdown', () => {
  it('parses calculator-style fee fields', () => {
    const parsed = parseBostaFeeBreakdown({
      data: {
        shippingFees: 74,
        openPackageFees: 5,
        nextDayTransferFees: 18.8,
        vat: 14.95,
        insuranceFees: 8.95,
        total: 121.7,
      },
    });

    assert.equal(parsed.shippingFee, 74);
    assert.equal(parsed.openPackageFee, 5);
    assert.equal(parsed.nextDayTransferFee, 18.8);
    assert.equal(parsed.vat, 14.95);
    assert.equal(parsed.insuranceFee, 8.95);
    assert.equal(parsed.total, 121.7);
    assert.equal(parsed.source, 'calculator');
  });

  it('parses labeled fee line arrays', () => {
    const parsed = parseBostaFeeBreakdown({
      fees: [
        { name: 'Shipping Fees', amount: 74 },
        { name: 'Open package Fees', amount: 5 },
        { name: 'Next Day Transfer Fees', amount: 18.8 },
        { name: 'VAT 14%', amount: 14.95 },
        { name: 'Insurance Fees', amount: 8.95 },
        { name: 'Total Bosta Fees', amount: 121.7 },
      ],
    });

    assert.equal(parsed.total, 121.7);
    assert.equal(parsed.shippingFee, 74);
    assert.equal(parsed.insuranceFee, 8.95);
  });

  it('extracts fees from delivery wallet/pricing objects', () => {
    const parsed = parseBostaFeeBreakdownFromDelivery({
      trackingNumber: '794',
      wallet: {
        pricing: {
          shippingFee: 74,
          openPackageFee: 5,
          nextDayTransferFee: 18.8,
          vat: 14.95,
          insuranceFee: 8.95,
          total: 121.7,
        },
      },
    });

    assert.equal(parsed.total, 121.7);
    assert.equal(parsed.source, 'delivery');
  });

  it('returns null when no fee data is present', () => {
    assert.equal(parseBostaFeeBreakdown({}), null);
    assert.equal(parseBostaFeeBreakdown(null), null);
  });
});
