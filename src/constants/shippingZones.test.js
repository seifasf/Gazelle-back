import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBostaCourierFee, DEFAULT_BOSTA_COURIER_FEE } from './shippingZones.js';

describe('Bosta courier fee (what Bosta takes, not customer shipping)', () => {
  it('Cairo is 50 EGP', () => {
    assert.equal(resolveBostaCourierFee('Cairo'), 50);
    assert.equal(resolveBostaCourierFee({ shippingMethod: 'bosta', shippingAddress: { city: 'Giza' } }), 50);
  });

  it('pickup and local shipping are 0', () => {
    assert.equal(resolveBostaCourierFee({ shippingMethod: 'pickup', shippingAddress: { city: 'Cairo' } }), 0);
    assert.equal(resolveBostaCourierFee({ shippingMethod: 'local_shipping', shippingAddress: { city: 'Cairo' } }), 0);
  });

  it('unknown city falls back to Cairo default', () => {
    assert.equal(resolveBostaCourierFee('Unknownville'), DEFAULT_BOSTA_COURIER_FEE);
  });
});
