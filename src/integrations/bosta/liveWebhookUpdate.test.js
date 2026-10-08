import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bostaLookupKey, pickLiveBostaUpdate } from './liveWebhookUpdate.js';

const ORDER_ID = '65a1b2c3d4e5f60718293a4b';

test('bostaLookupKey prefers the linked tracking number over the webhook hint', () => {
  const order = { _id: ORDER_ID, bostaTrackingNumber: 'T-REAL', bostaDeliveryId: 'D-REAL' };
  assert.deepEqual(bostaLookupKey(order, { deliveryId: 'D-FAKE', payload: { trackingNumber: 'T-FAKE' } }), {
    key: 'T-REAL',
    linked: true,
  });
});

test('bostaLookupKey falls back to the hint when the order has no Bosta link', () => {
  const order = { _id: ORDER_ID };
  assert.deepEqual(bostaLookupKey(order, { deliveryId: 'D1', payload: { trackingNumber: 'T1' } }), {
    key: 'T1',
    linked: false,
  });
  assert.deepEqual(bostaLookupKey(order, { deliveryId: 'D1', payload: {} }), { key: 'D1', linked: false });
  assert.deepEqual(bostaLookupKey(order, {}), { key: null, linked: false });
});

test('pickLiveBostaUpdate applies the live state, not the webhook state', () => {
  const order = { _id: ORDER_ID, bostaDeliveryId: 'D-REAL' };
  const update = pickLiveBostaUpdate({
    order,
    delivery: { data: { _id: 'D-REAL', state: { code: 21, value: 'Picked up' } } },
    linked: true,
    hintedDeliveryId: 'D-REAL',
  });
  assert.deepEqual(update, {
    deliveryId: 'D-REAL',
    state: { code: 21, value: 'Picked up' },
    payload: { _id: 'D-REAL', state: { code: 21, value: 'Picked up' } },
  });
});

test('pickLiveBostaUpdate ignores an unlinked delivery that belongs to another order', () => {
  const order = { _id: ORDER_ID };
  const delivery = { _id: 'D9', state: 45, businessReference: 'someone-else' };
  assert.equal(pickLiveBostaUpdate({ order, delivery, linked: false, hintedDeliveryId: 'D9' }), null);
});

test('pickLiveBostaUpdate accepts an unlinked delivery whose businessReference is the order id', () => {
  const order = { _id: ORDER_ID };
  const delivery = { _id: 'D9', state: 45, businessReference: ` ${ORDER_ID} ` };
  const update = pickLiveBostaUpdate({ order, delivery, linked: false, hintedDeliveryId: 'D-HINT' });
  assert.equal(update.deliveryId, 'D9');
  assert.equal(update.state, 45);
});

test('pickLiveBostaUpdate returns null when Bosta has no state', () => {
  const order = { _id: ORDER_ID, bostaDeliveryId: 'D1' };
  assert.equal(pickLiveBostaUpdate({ order, delivery: { data: {} }, linked: true }), null);
  assert.equal(pickLiveBostaUpdate({ order, delivery: null, linked: true }), null);
});
