import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInboundInventory,
  pushRecordUpdate,
  SHOPIFY_INVENTORY_ECHO_MS,
  SHOPIFY_PUSH_HISTORY_MAX,
} from './inventoryEcho.js';

const now = Date.parse('2026-10-08T12:00:00.000Z');
const ago = (ms) => new Date(now - ms);

test('out-of-order echo of an older push is still an echo', () => {
  const pushHistory = [
    { qty: 5, at: ago(20_000) },
    { qty: 4, at: ago(10_000) },
  ];
  assert.equal(
    classifyInboundInventory({ targetAvail: 5, lastPushAt: ago(10_000), pushHistory, now }),
    'echo'
  );
});

test('webhook not newer than the last push is stale', () => {
  assert.equal(
    classifyInboundInventory({
      targetAvail: 7,
      lastPushAt: ago(10_000),
      pushHistory: [],
      eventAt: ago(15_000).toISOString(),
      now,
    }),
    'stale'
  );
});

test('admin edit after the last push is applied', () => {
  assert.equal(
    classifyInboundInventory({
      targetAvail: 7,
      lastPushAt: ago(60_000),
      pushHistory: [{ qty: 4, at: ago(60_000) }],
      eventAt: ago(5_000).toISOString(),
      now,
    }),
    null
  );
});

test('pushed value outside the echo window is not an echo', () => {
  assert.equal(
    classifyInboundInventory({
      targetAvail: 4,
      pushHistory: [{ qty: 4, at: ago(SHOPIFY_INVENTORY_ECHO_MS + 1) }],
      now,
    }),
    null
  );
});

test('missing timestamps fall back to the history check only', () => {
  assert.equal(classifyInboundInventory({ targetAvail: 3, pushHistory: undefined, now }), null);
});

test('pushRecordUpdate caps the history', () => {
  const at = new Date(now);
  const update = pushRecordUpdate(6, at);
  assert.equal(update.$set.lastShopifyPushAt, at);
  assert.deepEqual(update.$push.shopifyPushHistory.$each, [{ qty: 6, at }]);
  assert.equal(update.$push.shopifyPushHistory.$slice, -SHOPIFY_PUSH_HISTORY_MAX);
});
