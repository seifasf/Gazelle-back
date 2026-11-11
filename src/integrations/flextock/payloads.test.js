import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flextockMerchantOrderCode,
  splitCustomerName,
  normalizeFlextockPhone,
  flextockLineItems,
  flextockPaymentData,
  flextockPaymentTimestamp,
  flextockProductFromVariant,
  buildCreateOrderPayload,
  buildCancelOrderPayload,
  buildReturnOrderPayload,
  validateCreateOrderPayload,
} from './payloads.js';
import { mapFlextockStatusToInternal, FLEXTOCK_INTERNAL } from './states.js';
import { cleanFlextockSecret } from './client.js';

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

test('normalizes Egypt phones to local 01… form', () => {
  assert.equal(normalizeFlextockPhone('+201144885880'), '01144885880');
  assert.equal(normalizeFlextockPhone('201144885880'), '01144885880');
  assert.equal(normalizeFlextockPhone('01144885880'), '01144885880');
});

test('cleans Render-pasted secrets with quotes/spaces', () => {
  assert.equal(cleanFlextockSecret('  "abc"  '), 'abc');
  assert.equal(cleanFlextockSecret("'xyz'"), 'xyz');
});

test('line items merge duplicate SKUs and keep promotional price', () => {
  const lines = flextockLineItems({
    items: [
      { sku: 'GZ-1', quantity: 2, unitSellingPrice: 80, unitCompareAtPrice: 100, variantId: 'v1' },
      { sku: 'GZ-1', quantity: 1, unitSellingPrice: 80, variantId: 'v1' },
      { sku: 'GZ-2', quantity: 1, unitSellingPrice: 200, variantId: 'v2' },
    ],
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].quantity, 3);
  assert.equal(lines[0].sku_promotional_price, 80);
  assert.equal(lines[0].sku_price, 100);
  assert.equal(lines[1].sku_promotional_price, null);
});

test('create-product payload uses merchant_promotional_price when on promo', () => {
  const product = flextockProductFromVariant(
    { sku: 'GZ-1', title: 'Flat' },
    { price: 80, compareAtPrice: 100 }
  );
  assert.equal(product.sku_code, 'GZ-1');
  assert.equal(product.price, 100);
  assert.equal(product.merchant_promotional_price, 80);
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
  assert.match(prepaid[0].payment_timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \+0200$/);
});

test('payment timestamp matches Flextock PDF format', () => {
  const stamp = flextockPaymentTimestamp(new Date('2024-12-03T11:46:14.000Z'));
  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \+0200$/);
});

test('create-order payload matches PDF contract fields', () => {
  const payload = buildCreateOrderPayload(
    {
      shopifyOrderName: '#45349',
      placedAt: new Date('2026-11-09T10:00:00Z'),
      shippingFee: 95,
      totalSellingPrice: 1000,
      paymentMethod: 'cod',
      shippingAddress: {
        fullName: 'Mona Ali',
        phone: '+201000000000',
        city: 'Cairo',
        zone: 'Heliopolis',
        line1: '24 Street',
      },
      items: [{ sku: 'GZ-1', quantity: 1, unitSellingPrice: 1000 }],
    },
    { fullName: 'Mona Ali', phone: '+201000000000' },
    new Map(),
    { flextockIntegrationSource: 'gazelle', flextockVendorName: 'gazelle' }
  );
  assert.equal(payload.order_code, '45349');
  assert.equal(payload.customer_address.country, 'Egypt');
  assert.equal(payload.customer_address.city, 'Cairo');
  assert.equal(payload.customer_address.area, 'Heliopolis');
  assert.equal(payload.customer_address.phone_number, '01000000000');
  assert.equal(payload.customer_address.secondary_phone_number, '01000000000');
  assert.equal(payload.requires_self_delivery, false);
  assert.equal(payload.shipment_data, undefined);
  assert.equal(payload.integration_source, 'gazelle');
  assert.equal(payload.vendor_name, 'gazelle');
  assert.equal(payload.line_items[0].sku_code, 'GZ-1');
  assert.equal(payload.line_items[0].sku_promotional_price, null);
  assert.equal(payload.payment_data[0].payment_type, 'cash_on_delivery');
  assert.equal(payload.extra_fees[0].name, 'COD Fees');
  assert.deepEqual(validateCreateOrderPayload(payload), []);
});

test('validateCreateOrderPayload catches PDF validation rules', () => {
  const errors = validateCreateOrderPayload({
    order_code: '',
    line_items: [],
    customer_address: { city: '', area: '', address_line1: '', phone_number: '' },
    requires_self_delivery: false,
  });
  assert.ok(errors.some((e) => /order_code/i.test(e)));
  assert.ok(errors.some((e) => /Line items/i.test(e)));
});

test('cancel payload uses outbound/exchange/return types', () => {
  assert.deepEqual(buildCancelOrderPayload('45349', 'outbound'), {
    order_code: '45349',
    order_type: 'outbound',
  });
  assert.equal(buildCancelOrderPayload('45349', 'RETURN').order_type, 'return');
});

test('return payload requires cash_returned and outbound code', () => {
  const payload = buildReturnOrderPayload(
    {
      placedAt: new Date('2026-11-09T10:00:00Z'),
      refundAmount: 50,
      shippingAddress: {
        fullName: 'Mona Ali',
        phone: '01000000000',
        city: 'Cairo',
        zone: 'Heliopolis',
        line1: '24 Street',
      },
    },
    { fullName: 'Mona Ali' },
    {
      outboundOrderCode: 'FTT-OT-80191WCQ7M',
      returnSkus: [{ sku_code: 'GZ-1', quantity: 1, is_damaged: false }],
    }
  );
  assert.equal(payload.outbound_order_code, 'FTT-OT-80191WCQ7M');
  assert.equal(payload.cash_returned, 50);
  assert.equal(payload.return_skus[0].sku_code, 'GZ-1');
  assert.equal(payload.requires_self_delivery, false);
});

test('maps Flextock statuses onto OMS courier states', () => {
  assert.equal(mapFlextockStatusToInternal('canceled'), FLEXTOCK_INTERNAL.returned);
  assert.equal(mapFlextockStatusToInternal('in transit'), FLEXTOCK_INTERNAL.transit);
  assert.equal(mapFlextockStatusToInternal('Delivered'), FLEXTOCK_INTERNAL.delivered);
  assert.equal(mapFlextockStatusToInternal('something-new'), null);
});
