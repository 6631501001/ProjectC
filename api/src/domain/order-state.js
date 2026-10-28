export const ORDER_STATUSES = Object.freeze([
  'PENDING_PAYMENT', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED', 'FAILED', 'CANCELLED'
]);

const transitions = Object.freeze({
  PENDING_PAYMENT: ['QUEUED', 'FAILED', 'CANCELLED'],
  QUEUED: ['IN_PROGRESS', 'DELAYED', 'FAILED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'DELAYED', 'FAILED'],
  DELAYED: ['QUEUED', 'IN_PROGRESS', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: []
});

export function canTransition(from, to) {
  return Boolean(transitions[from]?.includes(to));
}

export function allowedTransitions(from) {
  return [...(transitions[from] ?? [])];
}
