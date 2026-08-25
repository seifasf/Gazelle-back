import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { omsCodCollectAmount, omsCodFeeEgp } from './omsCod.js';

describe('OMS COD fee (system only, not Shopify)', () => {
  it('adds EGP 25 on COD collect', () => {
    const order = { paymentMethod: 'cod', totalSellingPrice: 995, shippingFee: 95 };
    assert.equal(omsCodFeeEgp(order), 25);
    assert.equal(omsCodCollectAmount(order), 1115);
  });

  it('does not add the fee on prepaid or return or exchange', () => {
    assert.equal(omsCodFeeEgp({ paymentMethod: 'online', totalSellingPrice: 995 }), 0);
    assert.equal(omsCodFeeEgp({ paymentMethod: 'cod', isReturnOrder: true, totalSellingPrice: 995 }), 0);
    assert.equal(
      omsCodCollectAmount({
        paymentMethod: 'cod',
        isExchangeOrder: true,
        totalSellingPrice: 100,
        shippingFee: 95,
        exchangeCreditAmount: 0,
      }),
      195
    );
  });
});
