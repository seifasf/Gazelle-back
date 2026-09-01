import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichOrderMoneyFields,
  omsCodCollectAmount,
  omsCodFeeEgp,
} from './omsCod.js';
import { shopifyMerchandiseTotal } from './shopifyPaymentIncentives.js';

describe('OMS COD fee (system only, not Shopify)', () => {
  it('adds EGP 25 on COD collect', () => {
    const order = { paymentMethod: 'cod', totalSellingPrice: 995, shippingFee: 95 };
    assert.equal(omsCodFeeEgp(order), 25);
    assert.equal(omsCodCollectAmount(order), 1115);
  });

  it('Shopify COD ingest: goods from Shopify, EGP 25 added in OMS only', () => {
    const shippingFee = 95;
    const shopifyPayload = {
      financial_status: 'pending',
      payment_gateway_names: ['Cash on Delivery (COD)'],
      total_price: '1490.00',
      line_items: [{ sku: 'GMC-2-1007', title: 'Boot', price: '1395' }],
      total_shipping_price_set: { shop_money: { amount: '95.00' } },
    };
    const goods = shopifyMerchandiseTotal(shopifyPayload, shippingFee);
    assert.equal(goods, 1395);
    const order = enrichOrderMoneyFields({
      orderSource: 'shopify',
      paymentMethod: 'cod',
      totalSellingPrice: goods,
      shippingFee,
    });
    assert.equal(order.codFeeEgp, 25);
    assert.equal(order.codCollectAmount, 1515);
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

  it('creator gift with zero total and zero shipping collects nothing', () => {
    const order = {
      paymentMethod: 'cod',
      isCreatorOrder: true,
      totalSellingPrice: 0,
      shippingFee: 0,
    };
    assert.equal(omsCodFeeEgp(order), 0);
    assert.equal(omsCodCollectAmount(order), 0);
  });
});
