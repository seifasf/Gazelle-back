import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasCompleteShopifyAddress,
  mapShopifyShippingAddress,
  shopifyCustomerPhone,
  SHOPIFY_ADDRESS_PLACEHOLDER,
  assertContactReadyToConfirm,
  applyKnownCustomerContact,
} from './shopifyShippingAddress.js';

describe('mapShopifyShippingAddress', () => {
  it('keeps a complete Shopify address', () => {
    const mapped = mapShopifyShippingAddress({
      shipping_address: {
        first_name: 'A',
        last_name: 'B',
        address1: '12 Nile',
        city: 'Cairo',
        province: 'Cairo',
        phone: '0100',
      },
    });
    assert.equal(mapped.line1, '12 Nile');
    assert.equal(mapped.city, 'Cairo');
    assert.equal(mapped.fullName, 'A B');
  });

  it('falls back to province when street and city are stripped', () => {
    const mapped = mapShopifyShippingAddress({
      shipping_address: { province: 'Kafr el-Sheikh', country: 'Egypt' },
      customer: { id: 99 },
    });
    assert.equal(mapped.line1, SHOPIFY_ADDRESS_PLACEHOLDER);
    assert.equal(mapped.city, 'Kafr el-Sheikh');
    assert.equal(hasCompleteShopifyAddress({ shipping_address: { province: 'Cairo' } }), false);
  });
});

describe('shopifyCustomerPhone', () => {
  it('uses a unique placeholder when Shopify withholds the phone', () => {
    assert.equal(
      shopifyCustomerPhone({ customer: { id: 9523816333538 } }, {}),
      'shopify-cust-9523816333538'
    );
  });
});

describe('applyKnownCustomerContact', () => {
  it('fills Unknown from an existing OMS customer', () => {
    const next = applyKnownCustomerContact(
      { fullName: 'Unknown', phone: 'shopify-cust-1', line1: 'x', city: 'Cairo' },
      { fullName: 'Rasha Radi', phone: '01002590056' }
    );
    assert.equal(next.fullName, 'Rasha Radi');
    assert.equal(next.phone, '01002590056');
  });
});

describe('assertContactReadyToConfirm', () => {
  it('blocks Unknown name and shopify-cust phones', () => {
    assert.throws(
      () =>
        assertContactReadyToConfirm({
          shippingAddress: {
            fullName: 'Unknown',
            phone: 'shopify-cust-1',
            line1: '12 Nile',
            city: 'Cairo',
          },
        }),
      /name/
    );
  });
});
