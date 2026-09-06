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

  it('parses live Bosta delivery wallet.cashCycle structure', () => {
    const parsed = parseBostaFeeBreakdownFromDelivery({
      trackingNumber: '2861458104',
      wallet: {
        cashCycle: {
          bosta_fees: '121.70',
          shipping_fees: '74.00',
          opening_package_fees: '5.00',
          expedite_fees: '18.80',
          vat: '14.95',
          insurance_fees: '8.95',
        },
      },
    });

    assert.ok(parsed, 'should parse cashCycle');
    assert.equal(parsed.total, 121.7);
    assert.equal(parsed.shippingFee, 74);
    assert.equal(parsed.openPackageFee, 5);
    assert.equal(parsed.nextDayTransferFee, 18.8);
    assert.equal(parsed.vat, 14.95);
    assert.equal(parsed.insuranceFee, 8.95);
    assert.equal(parsed.source, 'delivery');
  });

  it('parses live Bosta calculator response with nested amount objects', () => {
    const parsed = parseBostaFeeBreakdown({
      shippingFee: 64,
      openingPackageFee: { amount: 5 },
      expediteFee: { amount: 17.9 },
      insuranceFee: { amount: 8.95 },
      priceBeforeVat: 95.85,
      priceAfterVat: 109.27,
      vat: 0.14,
    });

    assert.ok(parsed, 'should parse calculator data');
    assert.equal(parsed.shippingFee, 64);
    assert.equal(parsed.openPackageFee, 5);
    assert.equal(parsed.nextDayTransferFee, 17.9);
    assert.equal(parsed.insuranceFee, 8.95);
    assert.equal(parsed.vat, 13.42); // 109.27 - 95.85
    assert.equal(parsed.total, 109.27);
  });

  it('returns null when no fee data is present', () => {
    assert.equal(parseBostaFeeBreakdown({}), null);
    assert.equal(parseBostaFeeBreakdown(null), null);
  });
});
