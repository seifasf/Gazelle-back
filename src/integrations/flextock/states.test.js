import test from 'node:test';
import assert from 'node:assert/strict';
import { mapFlextockStatusToInternal, FLEXTOCK_INTERNAL } from './states.js';

test('maps common Flextock statuses onto OMS courier states', () => {
  assert.equal(mapFlextockStatusToInternal('processing'), FLEXTOCK_INTERNAL.awaiting);
  assert.equal(mapFlextockStatusToInternal('Ready for pickup'), FLEXTOCK_INTERNAL.awaiting);
  assert.equal(mapFlextockStatusToInternal('shipped'), FLEXTOCK_INTERNAL.picked);
  assert.equal(mapFlextockStatusToInternal('out_for_delivery'), FLEXTOCK_INTERNAL.transit);
  assert.equal(mapFlextockStatusToInternal('delivered'), FLEXTOCK_INTERNAL.delivered);
  assert.equal(mapFlextockStatusToInternal('canceled'), FLEXTOCK_INTERNAL.returned);
  assert.equal(mapFlextockStatusToInternal('delivery_failed'), FLEXTOCK_INTERNAL.failed);
  assert.equal(mapFlextockStatusToInternal('RTO'), FLEXTOCK_INTERNAL.returning);
});

test('unknown Flextock statuses stay unmapped (kept as raw on the order)', () => {
  assert.equal(mapFlextockStatusToInternal('totally_new_status'), null);
});
