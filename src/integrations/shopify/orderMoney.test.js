import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyShopifyMoneyFields,
  isShopifyOrderPickup,
  mapShopifyShippingFee,
} from './orderMoney.js';

describe('isShopifyOrderPickup', () => {
  it('detects pickup via carrier_identifier', () => {
    assert.equal(
      isShopifyOrderPickup({
        shipping_lines: [{ carrier_identifier: '650f1a14fa979ec5c74d063e968411d4' }],
      }),
      true
    );
  });

  it('detects pickup via shipping line title (English)', () => {
    assert.equal(
      isShopifyOrderPickup({
        shipping_lines: [{ title: 'Store Pickup' }],
      }),
      true
    );
    assert.equal(
      isShopifyOrderPickup({
        shipping_lines: [{ title: 'Local Pickup' }],
      }),
      true
    );
    assert.equal(
      isShopifyOrderPickup({
        shipping_lines: [{ title: 'Pick up in store' }],
      }),
      true
    );
  });

  it('detects pickup via shipping line title (Arabic)', () => {
    assert.equal(
      isShopifyOrderPickup({
        shipping_lines: [{ title: 'استلام من الفرع' }],
      }),
      true
    );
  });

  it('detects pickup via pickup_in_store flag', () => {
    assert.equal(isShopifyOrderPickup({ pickup_in_store: true }), true);
  });

  it('detects pickup via tags', () => {
    assert.equal(isShopifyOrderPickup({ tags: 'store pickup, vip' }), true);
  });

  it('detects pickup via fulfillmentOrders deliveryMethod', () => {
    assert.equal(
      isShopifyOrderPickup({}, [{ deliveryMethod: { methodType: 'PICK_UP' } }]),
      true
    );
    assert.equal(
      isShopifyOrderPickup({}, [{ deliveryMethod: { methodType: 'PICKUP_POINT' } }]),
      true
    );
  });

  it('returns false for normal delivery shipping lines', () => {
    assert.equal(
      isShopifyOrderPickup({
        shipping_lines: [{ title: 'Standard', price: '95.00' }],
      }),
      false
    );
  });
});

describe('mapShopifyShippingFee', () => {
  it('forces 0 EGP when order was placed as pickup even if shipping rate exists', () => {
    const fee = mapShopifyShippingFee({
      shipping_lines: [{ title: 'Store Pickup', price: '95.00' }],
      total_shipping_price_set: { shop_money: { amount: '95.00' } },
    });
    assert.equal(fee, 0);
  });

  it('returns rate for regular shipping', () => {
    const fee = mapShopifyShippingFee({
      shipping_lines: [{ title: 'Standard', price: '95.00' }],
      total_shipping_price_set: { shop_money: { amount: '95.00' } },
    });
    assert.equal(fee, 95);
  });
});

describe('applyShopifyMoneyFields', () => {
  it('keeps warehouse pickup shipping at 0 even if Shopify still has a rate', () => {
    const order = { shippingMethod: 'pickup', shippingFee: 0 };
    applyShopifyMoneyFields(order, {
      total_shipping_price_set: { shop_money: { amount: '95.00' } },
      financial_status: 'pending',
      payment_gateway_names: ['cash on delivery'],
    });
    assert.equal(order.shippingFee, 0);
    assert.equal(order.shippingMethod, 'pickup');
  });

  it('automatically sets shippingMethod to pickup and fee to 0 when Shopify payload is pickup', () => {
    const order = { shippingMethod: 'bosta', shippingFee: 95 };
    applyShopifyMoneyFields(order, {
      shipping_lines: [{ title: 'Store Pickup', price: '95.00' }],
      total_shipping_price_set: { shop_money: { amount: '95.00' } },
      financial_status: 'pending',
      payment_gateway_names: ['cash on delivery'],
    });
    assert.equal(order.shippingMethod, 'pickup');
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
