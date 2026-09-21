import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCollectFromPriorOrder,
  healCollectToPriorOrder,
  skuFamily,
} from './assertCollectFromPriorOrder.js';

const prior = {
  shopifyOrderName: '#44787',
  items: [
    { variantId: 'vid-44-brown', sku: 'GBMBR-404-44', quantity: 1, unitSellingPrice: 1790, color: 'Brown', size: '44' },
    { variantId: 'vid-44-black', sku: 'GBMB-405-44', quantity: 1, unitSellingPrice: 1790, color: 'Black', size: '44' },
  ],
};

describe('assertCollectFromPriorOrder', () => {
  it('accepts collect lines that match the prior order', () => {
    assert.equal(
      assertCollectFromPriorOrder(
        [
          { variantId: 'vid-44-brown', sku: 'GBMBR-404-44', quantity: 1 },
          { variantId: 'vid-44-black', sku: 'GBMB-405-44', quantity: 1 },
        ],
        prior
      ),
      true
    );
  });

  it('rejects collect size that was never on the original order', () => {
    assert.throws(
      () =>
        assertCollectFromPriorOrder(
          [
            { variantId: 'vid-44-brown', sku: 'GBMBR-404-44', quantity: 1 },
            { variantId: 'vid-43-black', sku: 'GBMB-405-43', quantity: 1 },
          ],
          prior
        ),
      /GBMB-405-43.*not on original order/
    );
  });

  it('rejects over-collect quantity', () => {
    assert.throws(
      () =>
        assertCollectFromPriorOrder(
          [{ variantId: 'vid-44-black', sku: 'GBMB-405-44', quantity: 2 }],
          prior
        ),
      /exceeds/
    );
  });
});

describe('healCollectToPriorOrder', () => {
  it('maps wrong deliver size back to prior size in the same family', () => {
    const { items, changed, fixes } = healCollectToPriorOrder(
      [
        { variantId: 'vid-44-brown', sku: 'GBMBR-404-44', quantity: 1 },
        { variantId: 'vid-43-black', sku: 'GBMB-405-43', quantity: 1 },
      ],
      prior
    );
    assert.equal(changed, true);
    assert.deepEqual(fixes, [{ from: 'GBMB-405-43', to: 'GBMB-405-44' }]);
    assert.equal(items[1].sku, 'GBMB-405-44');
    assert.equal(String(items[1].variantId), 'vid-44-black');
    assertCollectFromPriorOrder(items, prior);
  });

  it('skuFamily strips trailing size', () => {
    assert.equal(skuFamily('GBMB-405-44'), 'GBMB-405');
    assert.equal(skuFamily('GBMBR-404-43'), 'GBMBR-404');
  });
});
