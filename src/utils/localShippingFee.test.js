import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_SHIPPING_FEE } from '../constants/index.js';
import { parseStaffShippingFee, resolveLocalShippingFee } from './localShippingFee.js';

test('parseStaffShippingFee keeps typed amounts and rejects blanks', () => {
  assert.equal(parseStaffShippingFee(150), 150);
  assert.equal(parseStaffShippingFee('87.456'), 87.46);
  assert.equal(parseStaffShippingFee(0), 0);
  assert.equal(parseStaffShippingFee(null), null);
  assert.equal(parseStaffShippingFee(undefined), null);
  assert.equal(parseStaffShippingFee('  '), null);
  assert.equal(parseStaffShippingFee('x'), null);
  assert.equal(parseStaffShippingFee(-1), null);
});

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
