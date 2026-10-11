import test from 'node:test';
import assert from 'node:assert/strict';
import { bostaOpenPackageFields, deliveryImageUrls, BOSTA_DELIVERY_IMAGES_MAX } from './deliveryImages.js';

const img = (n) => `https://cdn.shopify.com/s/files/shoe-${n}.jpg`;

test('sends product photos from variants with ALLOW_TO_OPEN_THE_PACKAGE', () => {
  const variantsById = new Map([['v1', { imageUrl: img(1) }], ['v2', { imageUrl: img(2) }]]);
  const order = { items: [{ variantId: 'v1', quantity: 2 }, { variantId: 'v2', quantity: 1 }] };
  assert.deepEqual(bostaOpenPackageFields(order, variantsById), {
    allowToOpenPackage: true,
    deliveryImages: [{ type: 'ALLOW_TO_OPEN_THE_PACKAGE', images: [img(1), img(2)] }],
  });
});

test('uses populated variants, product image fallback, and collected exchange items', () => {
  const order = {
    items: [{ variantId: { _id: 'a', imageUrl: img(1) } }],
    bostaReturnItems: [{ variantId: 'b' }],
  };
  const variantsById = new Map([['b', { productImageUrl: img(2) }]]);
  assert.deepEqual(deliveryImageUrls(order, variantsById), [img(1), img(2)]);
});

test('dedupes, ignores non-URLs, and caps at 10', () => {
  const items = Array.from({ length: 14 }, (_, i) => ({ variantId: { imageUrl: img(i) } }));
  items.push({ variantId: { imageUrl: img(0) } }, { variantId: { imageUrl: 'not-a-url' } });
  const urls = deliveryImageUrls({ items });
  assert.equal(urls.length, BOSTA_DELIVERY_IMAGES_MAX);
  assert.equal(new Set(urls).size, urls.length);
});

test('no product photo (repaired shoe) ships closed instead of failing', () => {
  assert.deepEqual(bostaOpenPackageFields({ isRepairOrder: true, items: [] }), { allowToOpenPackage: false });
});
