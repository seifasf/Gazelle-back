import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, assertTransition, isTerminalStatus } from './orderStateMachine.js';

describe('orderStateMachine pending_refund', () => {
  it('allows transition from returning_to_origin and returned_awaiting_receipt to pending_refund', () => {
    assert.equal(canTransition('returning_to_origin', 'pending_refund'), true);
    assert.equal(canTransition('returned_awaiting_receipt', 'pending_refund'), true);
    assert.equal(canTransition('back_from_local_shipping', 'pending_refund'), true);
  });

  it('allows transition from pending_refund to returned_to_stock when paid', () => {
    assert.equal(canTransition('pending_refund', 'returned_to_stock'), true);
    assert.equal(canTransition('pending_refund', 'cancelled'), true);
  });

  it('pending_refund is not a terminal status, but returned_to_stock is', () => {
    assert.equal(isTerminalStatus('pending_refund'), false);
    assert.equal(isTerminalStatus('returned_to_stock'), true);
  });

  it('disallows invalid transitions from pending_refund', () => {
    assert.equal(canTransition('pending_refund', 'verified_ready_for_shipping'), false);
    assert.equal(canTransition('pending_refund', 'in_transit'), false);
  });
});
