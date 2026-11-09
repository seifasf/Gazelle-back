import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flextockMerchantOrderCode,
  splitCustomerName,
  flextockLineItems,
  flextockPaymentData,
  flextockCustomerAddress,
  buildCreateOrderPayload,
  buildCancelOrderPayload,
} from './payloads.js';
import { mapFlextockStatusToInternal, FLEXTOCK_INTERNAL } from './states.js';

test('merchant order code strips Shopify #', () => {
  assert.equal(flextockMerchantOrderCode({ shopifyOrderName: '#45349' }), '45349');
  assert.equal(flextockMerchantOrderCode({ shopifyOrderId: 'M-1305' }), 'M-1305');
});

test('splits customer name for Flextock first/last', () => {
  assert.deepEqual(splitCustomerName('Muhammad Ashraf'), {
    first_name: 'Muhammad',
    last_name: 'Ashraf',
  });
  assert.equal(splitCustomerName('Mona').last_name, 'Mona');
});

test('line items skip duplicate SKUs and keep promotional price', () => {
  const lines = flextockLineItems({
    items: [
      { sku: 'GZ-1', quantity: 2, unitSellingPrice: 80, unitCompareAtPrice: 100, variantId: 'v1' },
      { sku: 'GZ-1', quantity: 1, unitSellingPrice: 80, variantId: 'v1' },
      { sku: 'GZ-2', quantity: 1, unitSellingPrice: 200, variantId: 'v2' },
    ],
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].sku_promotional_price, 80);
  assert.equal(lines[0].sku_price, 100);
  assert.equal(lines[1].sku_promotional_price, null);
});

test('COD payment uses cash_on_delivery; prepaid uses reference', () => {
  const cod = flextockPaymentData({
    paymentMethod: 'cod',
    totalSellingPrice: 500,
    shippingFee: 95,
    isReturnOrder: false,
  });
  assert.equal(cod[0].payment_type, 'cash_on_delivery');
  assert.equal(cod[0].value, 500 + 95 + 25);

  const prepaid = flextockPaymentData({
    paymentMethod: 'online',
    onlinePaymentStatus: 'paid',
    onlinePaymentAmount: 210,
    onlinePaymentProvider: 'paymob',
    onlinePaymentReference: 'XYZ',
    shopifyOrderName: '#1',
  });
  assert.equal(prepaid[0].payment_type, 'prepaid');
  assert.equal(prepaid[0].payment_reference, 'XYZ');
});

test('create-order payload uses Egypt city/area and merchant order code', () => {
  const payload = buildCreateOrderPayload(
    {
      shopifyOrderName: '#45349',
      placedAt: new Date('2026-11-09T10:00:00Z'),
      shippingFee: 95,
      totalSellingPrice: 1000,
      paymentMethod: 'cod',
      shippingAddress: {
        fullName: 'Mona Ali',
        phone: '01000000000',
        city: 'Cairo',
        zone: 'Heliopolis',
        line1: '24 Street',
      },
      items: [{ sku: 'GZ-1', quantity: 1, unitSellingPrice: 1000 }],
    },
    { fullName: 'Mona Ali', phone: '01000000000' }
  );
  assert.equal(payload.order_code, '45349');
  assert.equal(payload.customer_address.country, 'Egypt');
  assert.equal(payload.customer_address.city, 'Cairo');
  assert.equal(payload.customer_address.area, 'Heliopolis');
  assert.equal(payload.requires_self_delivery, false);
  assert.equal(payload.line_items[0].sku_code, 'GZ-1');
  assert.equal(payload.payment_data[0].payment_type, 'cash_on_delivery');
});

test('cancel payload uses outbound/exchange/return types', () => {
  assert.deepEqual(buildCancelOrderPayload('45349', 'outbound'), {
    order_code: '45349',
    order_type: 'outbound',
  });
});

test('maps Flextock statuses onto OMS courier states', () => {
  assert.equal(mapFlextockStatusToInternal('canceled'), FLEXTOCK_INTERNAL.returned);
  assert.equal(mapFlextockStatusToInternal('in transit'), FLEXTOCK_INTERNAL.transit);
  assert.equal(mapFlextockStatusToInternal('Delivered'), FLEXTOCK_INTERNAL.delivered);
  assert.equal(mapFlextockStatusToInternal('something-new'), null);
});
