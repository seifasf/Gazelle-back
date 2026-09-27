import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isB1g1Tag, lineOfferInfo, orderHasOfferItems } from './offerOrder.js';

describe('isB1g1Tag', () => {
  it('matches every Buy 1 Get 1 tag spelling used in Shopify', () => {
    assert.equal(isB1g1Tag('buy1get1'), true);
    assert.equal(isB1g1Tag('buy 1 get 1'), true);
    assert.equal(isB1g1Tag('b1g1-men'), true);
    assert.equal(isB1g1Tag('Buy-1-Get-1'), true);
  });

  it('ignores unrelated tags', () => {
    assert.equal(isB1g1Tag('Women'), false);
    assert.equal(isB1g1Tag('UPSELL'), false);
    assert.equal(isB1g1Tag(''), false);
  });
});

describe('lineOfferInfo', () => {
  it('flags B1G1-tagged products even without a compare-at price', () => {
    const info = lineOfferInfo({ sellingPrice: 1200 }, ['Men', 'b1g1-men'], 1200);
    assert.deepEqual(info, { isOnOffer: true, offerType: 'b1g1' });
  });

  it('flags lines sold below compare-at price', () => {
    const info = lineOfferInfo({ sellingPrice: 490, compareAtPrice: 890 }, ['Women'], 490);
    assert.deepEqual(info, { isOnOffer: true, offerType: 'sale', unitCompareAtPrice: 890 });
  });

  it('prefers b1g1 when both apply', () => {
    const info = lineOfferInfo({ sellingPrice: 490, compareAtPrice: 890 }, ['buy1get1'], 490);
    assert.equal(info.offerType, 'b1g1');
  });

  it('does not flag full-price lines', () => {
    const info = lineOfferInfo({ sellingPrice: 890, compareAtPrice: 890 }, ['Women'], 890);
    assert.deepEqual(info, { isOnOffer: false, unitCompareAtPrice: 890 });
    assert.equal(lineOfferInfo({ sellingPrice: 890 }, [], 890).isOnOffer, false);
  });

  it('uses catalog price when the charged unit is 0 (creator gift)', () => {
    assert.equal(lineOfferInfo({ sellingPrice: 490, compareAtPrice: 890 }, [], 0).offerType, 'sale');
    assert.equal(lineOfferInfo({ sellingPrice: 890, compareAtPrice: 890 }, [], 0).isOnOffer, false);
  });
});

describe('orderHasOfferItems', () => {
  it('is true when any line is on offer', () => {
    assert.equal(orderHasOfferItems([{ isOnOffer: false }, { isOnOffer: true }]), true);
    assert.equal(orderHasOfferItems([{ isOnOffer: false }]), false);
    assert.equal(orderHasOfferItems([]), false);
  });
});
