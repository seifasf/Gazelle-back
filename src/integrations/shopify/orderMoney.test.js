import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyShopifyMoneyFields } from './orderMoney.js';

describe('applyShopifyMoneyFields', () => {
  it('keeps warehouse pickup shipping at 0 even if Shopify still has a rate', () => {
    const order = { shippingMethod: 'pickup', shippingFee: 0 };
    applyShopifyMoneyFields(order, {
      total_shipping_price_set: { shop_money: { amount: '95.00' } },
      financial_status: 'pending',
      payment_gateway_names: ['cash on delivery'],
    });
    assert.equal(order.shippingFee, 0);
  });

  it('copies Shopify shipping for Bosta orders', () => {
    const order = { shippingMethod: 'bosta', shippingFee: 0 };
    applyShopifyMoneyFields(order, {
      total_shipping_price_set: { shop_money: { amount: '95.00' } },
      financial_status: 'pending',
      payment_gateway_names: ['cash on delivery'],
    });
    assert.equal(order.shippingFee, 95);
  });
});
