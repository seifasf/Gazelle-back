import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReturnKind } from './returnKind.js';

describe('classifyReturnKind', () => {
  it('tags exchanges even when OMS never marked delivered', () => {
    assert.equal(classifyReturnKind({ isExchangeOrder: true, deliveredAt: null }), 'exchange');
  });

  it('tags refund pickups and post-delivery returns', () => {
    assert.equal(classifyReturnKind({ isReturnOrder: true }), 'refund');
    assert.equal(classifyReturnKind({ deliveredAt: new Date() }), 'refund');
  });

  it('tags never-delivered packages as refused', () => {
    assert.equal(classifyReturnKind({ isReturnOrder: false, isExchangeOrder: false }), 'refused');
  });
});
