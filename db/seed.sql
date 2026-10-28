INSERT INTO oxide_bot_agents (id, name, device_name, status, cpu_percent, memory_percent, uptime_seconds)
VALUES
  ('bot-01', 'Oxide Bot 01', 'oxide-worker-01', 'online', 18.4, 41.2, 86400),
  ('bot-02', 'Oxide Bot 02', 'oxide-worker-02', 'online', 7.1, 33.8, 4200),
  ('bot-03', 'Oxide Bot 03', 'oxide-worker-03', 'offline', 0, 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (external_order_id, status, amount, currency)
VALUES
  ('TEST-ORDER-001', 'IN_PROGRESS', 1250.00, 'THB'),
  ('TEST-ORDER-002', 'PENDING_PAYMENT', 499.00, 'THB')
ON CONFLICT (external_order_id) DO NOTHING;

INSERT INTO order_events (order_id, event_type, payload)
SELECT id, 'order.created', jsonb_build_object('source','seed') FROM orders o
WHERE external_order_id IN ('TEST-ORDER-001','TEST-ORDER-002')
AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id=o.id);
