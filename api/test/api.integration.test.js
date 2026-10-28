import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = process.env.TEST_BASE_URL;
const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

test('API integration: concurrent idempotency, state transitions, and kill-switch guard', {
  skip: !baseUrl ? 'Set TEST_BASE_URL to a running candidate API to run integration checks' : false,
  timeout: 30000
}, async () => {
  const suffix = randomUUID();
  const externalOrderId = `INTEGRATION-${suffix}`;
  const idemKey = `integration-command-${suffix}`;

  // Ensure the candidate is in a known state before this disposable test.
  await request('/api/control/kill-switch', { method: 'POST', body: JSON.stringify({ enabled: false, actor: 'integration-test' }) });

  const creates = await Promise.all(Array.from({ length: 6 }, () => request('/api/orders', {
    method: 'POST', body: JSON.stringify({ externalOrderId, amount: 123.45, currency: 'THB', actor: 'integration-test' })
  })));
  assert.ok(creates.every((result) => [200, 201].includes(result.status)), JSON.stringify(creates.map((r) => r.body)));
  assert.equal(new Set(creates.map((result) => String(result.body.data?.id))).size, 1, 'all concurrent duplicates must resolve to one order row');
  assert.equal(creates.filter((result) => result.status === 201).length, 1, 'exactly one concurrent caller should create the order');

  const botCommands = await Promise.all(Array.from({ length: 4 }, () => request('/api/bots/bot-01/commands', {
    method: 'POST', headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify({ command: 'status', requestedBy: 'integration-test' })
  })));
  assert.ok(botCommands.every((result) => [200, 202].includes(result.status)), JSON.stringify(botCommands.map((r) => r.body)));
  assert.equal(new Set(botCommands.map((result) => String(result.body.command?.id))).size, 1, 'duplicate command keys must reuse the same command row');

  const orderId = creates[0].body.data.id;
  const illegalJump = await request(`/api/orders/${orderId}/transition`, {
    method: 'POST', body: JSON.stringify({ status: 'COMPLETED', actor: 'integration-test' })
  });
  assert.equal(illegalJump.status, 409, 'pending payment must not jump directly to completed');

  const queued = await request(`/api/orders/${orderId}/transition`, {
    method: 'POST', body: JSON.stringify({ status: 'QUEUED', actor: 'integration-test' })
  });
  assert.equal(queued.status, 200);

  await request('/api/control/kill-switch', { method: 'POST', body: JSON.stringify({ enabled: true, reason: 'integration check', actor: 'integration-test' }) });
  try {
    const rejectedOrder = await request('/api/orders', {
      method: 'POST', body: JSON.stringify({ externalOrderId: `BLOCKED-${suffix}`, amount: 1, currency: 'THB', actor: 'integration-test' })
    });
    assert.equal(rejectedOrder.status, 423, 'kill-switch must reject newly created orders');

    const rejectedStart = await request('/api/bots/bot-01/commands', {
      method: 'POST', body: JSON.stringify({ command: 'restart', requestedBy: 'integration-test' })
    });
    assert.equal(rejectedStart.status, 423, 'kill-switch must block start/restart commands');

    const rejectedDispatch = await request(`/api/orders/${orderId}/dispatch`, {
      method: 'POST', body: JSON.stringify({ actor: 'integration-test' })
    });
    assert.equal(rejectedDispatch.status, 423, 'kill-switch must block order dispatch');
  } finally {
    await request('/api/control/kill-switch', { method: 'POST', body: JSON.stringify({ enabled: false, actor: 'integration-test-cleanup' }) });
  }
});
