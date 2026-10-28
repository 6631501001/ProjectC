import test from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_STATUSES, canTransition, allowedTransitions } from '../src/domain/order-state.js';

test('order state machine exposes the required lifecycle statuses', () => {
  assert.deepEqual(ORDER_STATUSES, [
    'PENDING_PAYMENT', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED', 'FAILED', 'CANCELLED'
  ]);
});

test('happy path is PENDING_PAYMENT -> QUEUED -> IN_PROGRESS -> COMPLETED', () => {
  assert.equal(canTransition('PENDING_PAYMENT', 'QUEUED'), true);
  assert.equal(canTransition('QUEUED', 'IN_PROGRESS'), true);
  assert.equal(canTransition('IN_PROGRESS', 'COMPLETED'), true);
  assert.equal(canTransition('PENDING_PAYMENT', 'COMPLETED'), false);
  assert.equal(canTransition('COMPLETED', 'IN_PROGRESS'), false);
});

test('delayed orders can be retried but terminal states cannot be reopened', () => {
  assert.equal(canTransition('QUEUED', 'DELAYED'), true);
  assert.equal(canTransition('IN_PROGRESS', 'DELAYED'), true);
  assert.equal(canTransition('DELAYED', 'QUEUED'), true);
  assert.equal(canTransition('DELAYED', 'IN_PROGRESS'), true);
  assert.equal(canTransition('FAILED', 'QUEUED'), false);
  assert.equal(canTransition('CANCELLED', 'IN_PROGRESS'), false);
});

test('allowed transitions are defensive copies and terminal states are empty', () => {
  const transitions = allowedTransitions('PENDING_PAYMENT');
  transitions.push('COMPLETED');
  assert.deepEqual(allowedTransitions('PENDING_PAYMENT'), ['QUEUED', 'FAILED', 'CANCELLED']);
  assert.deepEqual(allowedTransitions('COMPLETED'), []);
  assert.deepEqual(allowedTransitions('unknown'), []);
});
