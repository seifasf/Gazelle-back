import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, isTerminalStatus } from './orderStateMachine.js';

describe('orderStateMachine pending_refund', () => {
  it('allows transition from returning_to_origin and returned_awaiting_receipt to pending_refund', () => {
    assert.equal(canTransition('returning_to_origin', 'pending_refund'), true);
    assert.equal(canTransition('returned_awaiting_receipt', 'pending_refund'), true);
    assert.equal(canTransition('back_from_local_shipping', 'pending_refund'), true);
  });

  it('allows delivered local exchange/refund to move to back_from_local_shipping', () => {
    assert.equal(canTransition('delivered', 'back_from_local_shipping'), true);
  });

  it('allows local_shipping to pull back to Ready to ship', () => {
    assert.equal(canTransition('local_shipping', 'verified_ready_for_shipping'), true);
  });

  it('allows pickup exchange/refund to move to back_from_pickup', () => {
    assert.equal(canTransition('delivered', 'back_from_pickup'), true);
    assert.equal(canTransition('verified_ready_for_shipping', 'back_from_pickup'), true);
    assert.equal(canTransition('back_from_pickup', 'pending_refund'), true);
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

describe('orderStateMachine repaired_shoe', () => {
  it('ships a repaired shoe by Bosta, local courier, or customer pickup', () => {
    assert.equal(canTransition('repaired_shoe', 'awaiting_bosta_pickup'), true);
    assert.equal(canTransition('repaired_shoe', 'local_shipping'), true);
    assert.equal(canTransition('repaired_shoe', 'delivered'), true);
    assert.equal(canTransition('repaired_shoe', 'cancelled'), true);
  });

  it('never enters stock lanes', () => {
    assert.equal(canTransition('repaired_shoe', 'out_of_stock'), false);
    assert.equal(canTransition('repaired_shoe', 'verified_ready_for_shipping'), false);
  });

  it('can be pulled back from courier lanes to Repaired shoe', () => {
    assert.equal(canTransition('awaiting_bosta_pickup', 'repaired_shoe'), true);
    assert.equal(canTransition('local_shipping', 'repaired_shoe'), true);
  });
});
