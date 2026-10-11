import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_SHIPPING_FEE } from '../constants/index.js';
import { resolveLocalShippingFee } from './localShippingFee.js';

test('uses the fee staff typed', () => {
  assert.equal(resolveLocalShippingFee(70), 70);
  assert.equal(resolveLocalShippingFee('120.5'), 120.5);
  assert.equal(resolveLocalShippingFee(0), 0);
});

test('falls back to the default when blank or invalid', () => {
  assert.equal(resolveLocalShippingFee(undefined), LOCAL_SHIPPING_FEE);
  assert.equal(resolveLocalShippingFee(''), LOCAL_SHIPPING_FEE);
  assert.equal(resolveLocalShippingFee('abc'), LOCAL_SHIPPING_FEE);
  assert.equal(resolveLocalShippingFee(-5), LOCAL_SHIPPING_FEE);
});
