import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import pg from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import { ORDER_STATUSES, canTransition, allowedTransitions } from './domain/order-state.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const publicDir = path.join(rootDir, 'public');
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(rootDir, 'uploads'));
const PORT = Number(process.env.PORT || 3000);
const BOT_SIMULATOR_URL = (process.env.BOT_SIMULATOR_URL || 'http://localhost:8788').replace(/\/$/, '');
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 5000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 20000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const GLOBAL_CONTROL_LOCK = 73451001;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://oxide:oxide_dev@localhost:55432/oxide_monitor',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(publicDir, { etag: true, maxAge: '1h' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try { await fs.mkdir(uploadDir, { recursive: true }); cb(null, uploadDir); }
      catch (err) { cb(err); }
    },
    filename: (_req, file, cb) => cb(null, `package-${Date.now()}-${crypto.randomUUID()}.zip`)
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const valid = path.extname(file.originalname).toLowerCase() === '.zip';
    cb(valid ? null : new Error('Only .zip packages are accepted'), valid);
  }
});

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isoNow = () => new Date().toISOString();

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be closed */ }
    throw error;
  } finally {
    client.release();
  }
}

async function writeAudit(db, { actor = 'system', action, targetType, targetId = null, metadata = {} }) {
  await db.query(
    `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actor, action, targetType, targetId, JSON.stringify(metadata ?? {})]
  );
}

async function getKillSwitch(db = pool) {
  const { rows } = await db.query(
    `SELECT metadata, created_at FROM audit_logs
     WHERE action = 'kill_switch.updated'
     ORDER BY id DESC LIMIT 1`
  );
  const latest = rows[0];
  return {
    enabled: latest?.metadata?.enabled === true,
    reason: latest?.metadata?.reason ?? null,
    updatedAt: latest?.created_at ?? null
  };
}

let httpServer;
let wss;
let heartbeatTimer;
let heartbeatBusy = false;

function broadcastRefresh(reason = 'data_changed') {
  if (!wss) return;
  const message = JSON.stringify({ type: 'refresh', reason, at: isoNow() });
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

async function simulatorFetch(resource, options = {}) {
  let response;
  try {
    response = await fetch(`${BOT_SIMULATOR_URL}${resource}`, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
      signal: AbortSignal.timeout(3500)
    });
  } catch (error) {
    throw new HttpError(502, 'simulator_unavailable', `Bot simulator request failed: ${error.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(response.status === 404 ? 404 : 502, data.error || 'simulator_error', 'Bot simulator rejected the request', data);
  }
  return data;
}

async function getBotRows(db = pool) {
  const { rows } = await db.query(
    `SELECT b.*,
       c.id AS latest_command_id, c.command AS latest_command, c.status AS latest_command_status,
       c.completed_at AS latest_command_completed_at
     FROM oxide_bot_agents b
     LEFT JOIN LATERAL (
       SELECT id, command, status, completed_at FROM oxide_bot_commands
       WHERE bot_id = b.id ORDER BY id DESC LIMIT 1
     ) c ON true
     ORDER BY b.id`
  );
  return rows;
}

async function getOverview() {
  const [botStats, orderStats, killSwitch, recentActivity] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE status = 'online')::int AS online_count,
      COUNT(*) FILTER (WHERE status = 'offline')::int AS offline_count,
      COUNT(*) FILTER (WHERE status = 'error')::int AS error_count
      FROM oxide_bot_agents`),
    pool.query(`SELECT
      COUNT(*)::int AS total_orders,
      COUNT(*) FILTER (WHERE status = 'PENDING_PAYMENT')::int AS pending_payment,
      COUNT(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'DELAYED')::int AS delayed,
      COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
      FROM orders`),
    getKillSwitch(),
    pool.query(`SELECT id, actor, action, target_type, target_id, metadata, created_at
      FROM audit_logs ORDER BY id DESC LIMIT 8`)
  ]);
  const b = botStats.rows[0];
  return {
    generatedAt: isoNow(),
    bots: {
      total: Number(b.total_count),
      online: Number(b.online_count),
      offline: Number(b.offline_count),
      error: Number(b.error_count),
      active: killSwitch.enabled ? 0 : Number(b.online_count),
      standby: killSwitch.enabled ? Number(b.online_count) : 0
    },
    orders: orderStats.rows[0],
    killSwitch,
    recentActivity: recentActivity.rows
  };
}

async function markTimedOutBots() {
  const staleResult = await pool.query(
    `UPDATE oxide_bot_agents
     SET status = 'offline', cpu_percent = 0, memory_percent = 0, uptime_seconds = 0, updated_at = now()
     WHERE status IN ('online','starting')
       AND (last_heartbeat IS NULL OR last_heartbeat < now() - ($1::int * interval '1 millisecond'))
     RETURNING id`,
    [HEARTBEAT_TIMEOUT_MS]
  );

  for (const { id: botId } of staleResult.rows) {
    await withTransaction(async (client) => {
      const affected = await client.query(
        `SELECT o.id, o.status
         FROM orders o
         JOIN LATERAL (
           SELECT payload FROM order_events
           WHERE order_id = o.id AND event_type = 'order.dispatched'
           ORDER BY id DESC LIMIT 1
         ) d ON true
         WHERE o.status IN ('QUEUED','IN_PROGRESS') AND d.payload->>'botId' = $1
         FOR UPDATE OF o`, [botId]
      );
      for (const order of affected.rows) {
        await client.query(`UPDATE orders SET status='DELAYED', updated_at=now() WHERE id=$1`, [order.id]);
        await client.query(
          `INSERT INTO order_events (order_id,event_type,payload) VALUES ($1,'order.delayed',$2::jsonb)`,
          [order.id, JSON.stringify({ reason: 'heartbeat_timeout', botId, previousStatus: order.status })]
        );
      }
      await writeAudit(client, {
        actor: 'heartbeat-monitor', action: 'bot.heartbeat_timeout', targetType: 'bot', targetId: botId,
        metadata: { delayedOrders: affected.rows.map((row) => row.id), timeoutMs: HEARTBEAT_TIMEOUT_MS }
      });
    });
  }
  if (staleResult.rows.length) broadcastRefresh('heartbeat_timeout');
}

async function syncBotsFromSimulator() {
  if (heartbeatBusy) return;
  heartbeatBusy = true;
  try {
    const bots = await simulatorFetch('/bots');
    if (!Array.isArray(bots)) throw new Error('Simulator /bots response must be an array');
    for (const bot of bots) {
      await pool.query(
        `INSERT INTO oxide_bot_agents
           (id,name,device_name,status,cpu_percent,memory_percent,uptime_seconds,last_heartbeat,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $4='online' THEN now() ELSE NULL END,now())
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, device_name=EXCLUDED.device_name, status=EXCLUDED.status,
           cpu_percent=EXCLUDED.cpu_percent, memory_percent=EXCLUDED.memory_percent,
           uptime_seconds=EXCLUDED.uptime_seconds,
           last_heartbeat=CASE WHEN EXCLUDED.status='online' THEN now() ELSE oxide_bot_agents.last_heartbeat END,
           updated_at=now()`,
        [bot.id, bot.name, bot.deviceName, bot.status, bot.cpuPercent ?? 0, bot.memoryPercent ?? 0, bot.uptimeSeconds ?? 0]
      );
    }
    await markTimedOutBots();
    broadcastRefresh('heartbeat');
  } catch (error) {
    console.error(`[heartbeat] ${error.message}`);
    await markTimedOutBots().catch((timeoutError) => console.error(`[timeout-check] ${timeoutError.message}`));
  } finally {
    heartbeatBusy = false;
  }
}

async function executeBotCommand(botId, command, requestedBy = 'dashboard', idempotencyKey = null) {
  const allowedCommands = ['start', 'stop', 'restart', 'status'];
  if (!allowedCommands.includes(command)) throw new HttpError(400, 'invalid_command', 'command must be start, stop, restart or status');
  let commandRow;
  let idempotentReplay = false;
  let blockedError = null;

  // Admission is serialized with the global control toggle, then the network call happens
  // outside the transaction so one slow simulator node cannot block the entire fleet.
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_CONTROL_LOCK]);
    if (idempotencyKey) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`command:${botId}:${idempotencyKey}`]);
      const existing = await client.query(
        `SELECT * FROM oxide_bot_commands WHERE bot_id=$1 AND result->>'idempotencyKey'=$2 ORDER BY id DESC LIMIT 1`,
        [botId, idempotencyKey]
      );
      if (existing.rows[0]) {
        commandRow = existing.rows[0];
        idempotentReplay = true;
        return;
      }
    }
    if (['start', 'restart'].includes(command)) {
      const kill = await getKillSwitch(client);
      if (kill.enabled) throw new HttpError(423, 'kill_switch_enabled', 'Global kill-switch is enabled; start/restart is blocked');
    }
    const bot = await client.query('SELECT id FROM oxide_bot_agents WHERE id=$1', [botId]);
    if (!bot.rows[0]) throw new HttpError(404, 'bot_not_found', `Bot ${botId} was not found`);
    const initialResult = idempotencyKey ? { idempotencyKey } : {};
    const inserted = await client.query(
      `INSERT INTO oxide_bot_commands (bot_id, command, requested_by, status, result)
       VALUES ($1,$2,$3,'queued',$4::jsonb) RETURNING *`,
      [botId, command, requestedBy, JSON.stringify(initialResult)]
    );
    commandRow = inserted.rows[0];
    await writeAudit(client, {
      actor: requestedBy, action: `bot.command.${command}.queued`, targetType: 'bot', targetId: botId,
      metadata: { commandId: commandRow.id, idempotencyKey }
    });
  });

  if (idempotentReplay) return { ...commandRow, idempotentReplay: true };

  // Check the kill-switch again at the execution boundary. If an operator enabled it
  // after admission but before execution, the command is failed without reaching the bot.
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_CONTROL_LOCK]);
    const current = await client.query('SELECT * FROM oxide_bot_commands WHERE id=$1 FOR UPDATE', [commandRow.id]);
    if (!current.rows[0] || current.rows[0].status !== 'queued') {
      commandRow = current.rows[0] || commandRow;
      return;
    }
    if (['start', 'restart'].includes(command)) {
      const kill = await getKillSwitch(client);
      if (kill.enabled) {
        const failed = await client.query(
          `UPDATE oxide_bot_commands SET status='failed', result=$2::jsonb, completed_at=now() WHERE id=$1 RETURNING *`,
          [commandRow.id, JSON.stringify({ error: 'kill_switch_enabled', message: 'Blocked before simulator execution', ...(idempotencyKey ? { idempotencyKey } : {}) })]
        );
        commandRow = failed.rows[0];
        blockedError = new HttpError(423, 'kill_switch_enabled', 'Global kill-switch was enabled before command execution');
        await writeAudit(client, {
          actor: requestedBy, action: `bot.command.${command}.blocked`, targetType: 'bot', targetId: botId,
          metadata: { commandId: commandRow.id, reason: 'kill_switch_enabled' }
        });
        return;
      }
    }
    const running = await client.query(`UPDATE oxide_bot_commands SET status='running' WHERE id=$1 RETURNING *`, [commandRow.id]);
    commandRow = running.rows[0];
  });

  if (blockedError) throw blockedError;
  if (commandRow.status !== 'running') return commandRow;

  try {
    const result = await simulatorFetch(`/bots/${encodeURIComponent(botId)}/commands`, {
      method: 'POST', body: JSON.stringify({ command })
    });
    commandRow = await withTransaction(async (client) => {
      const completed = await client.query(
        `UPDATE oxide_bot_commands SET status='success', result=$2::jsonb, completed_at=now() WHERE id=$1 RETURNING *`,
        [commandRow.id, JSON.stringify({ ...result, ...(idempotencyKey ? { idempotencyKey } : {}) })]
      );
      await writeAudit(client, {
        actor: requestedBy, action: `bot.command.${command}`, targetType: 'bot', targetId: botId,
        metadata: { commandId: commandRow.id, status: 'success', idempotencyKey }
      });
      return completed.rows[0];
    });
  } catch (error) {
    commandRow = await withTransaction(async (client) => {
      const failed = await client.query(
        `UPDATE oxide_bot_commands SET status='failed', result=$2::jsonb, completed_at=now() WHERE id=$1 RETURNING *`,
        [commandRow.id, JSON.stringify({ error: error.code || 'command_failed', message: error.message, ...(idempotencyKey ? { idempotencyKey } : {}) })]
      );
      await writeAudit(client, {
        actor: requestedBy, action: `bot.command.${command}.failed`, targetType: 'bot', targetId: botId,
        metadata: { commandId: commandRow.id, error: error.code || 'command_failed' }
      });
      return failed.rows[0];
    });
    throw error;
  }

  await syncBotsFromSimulator().catch(() => {});
  broadcastRefresh('bot_command');
  return commandRow;
}

function parseTargetBotIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return [...new Set(parsed.map((item) => String(item).trim()).filter(Boolean))]; } catch { /* Fall back to comma-separated values. */ }
    }
    return [...new Set(trimmed.split(',').map((item) => item.trim()).filter(Boolean))];
  }
  return [];
}

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, service: 'oxide-monitor', timestamp: isoNow() });
}));

app.get('/api/overview', asyncRoute(async (_req, res) => res.json(await getOverview())));

app.get('/api/control', asyncRoute(async (_req, res) => res.json({ killSwitch: await getKillSwitch() })));

app.post('/api/control/kill-switch', asyncRoute(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'invalid_payload', 'enabled must be a boolean');
  const actor = String(req.body.actor || 'dashboard').slice(0, 120);
  const reason = req.body.reason == null ? null : String(req.body.reason).slice(0, 500);
  const state = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_CONTROL_LOCK]);
    await writeAudit(client, {
      actor, action: 'kill_switch.updated', targetType: 'system',
      metadata: { enabled: req.body.enabled, reason, source: 'dashboard' }
    });
    return getKillSwitch(client);
  });
  broadcastRefresh('kill_switch');
  res.json({ ok: true, killSwitch: state });
}));

app.get('/api/bots', asyncRoute(async (_req, res) => {
  const bots = await getBotRows();
  res.json({ data: bots, total: bots.length, killSwitch: await getKillSwitch() });
}));

app.get('/api/bots/:id', asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM oxide_bot_agents WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'bot_not_found', 'Bot was not found');
  res.json({ data: rows[0] });
}));

app.get('/api/bots/:id/metrics', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id,b.name,b.device_name,b.status,b.cpu_percent,b.memory_percent,b.uptime_seconds,
      b.last_heartbeat,b.updated_at,
      (SELECT COUNT(*)::int FROM order_events e WHERE e.event_type='order.dispatched' AND e.payload->>'botId'=b.id) AS dispatched_total,
      (SELECT COUNT(*)::int FROM orders o JOIN LATERAL (SELECT payload FROM order_events e WHERE e.order_id=o.id AND e.event_type='order.dispatched' ORDER BY e.id DESC LIMIT 1) d ON true WHERE d.payload->>'botId'=b.id AND o.status='IN_PROGRESS') AS active_orders
     FROM oxide_bot_agents b WHERE b.id=$1`, [req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'bot_not_found', 'Bot was not found');
  res.json({ data: rows[0], sampledAt: isoNow() });
}));

app.get('/api/bots/:id/logs', asyncRoute(async (req, res) => {
  const botId = req.params.id;
  const bot = await pool.query('SELECT id FROM oxide_bot_agents WHERE id=$1', [botId]);
  if (!bot.rows[0]) throw new HttpError(404, 'bot_not_found', 'Bot was not found');
  const [commands, events] = await Promise.all([
    pool.query('SELECT * FROM oxide_bot_commands WHERE bot_id=$1 ORDER BY id DESC LIMIT 50', [botId]),
    pool.query(`SELECT * FROM audit_logs WHERE target_type='bot' AND target_id=$1 ORDER BY id DESC LIMIT 50`, [botId])
  ]);
  res.json({ commands: commands.rows, events: events.rows });
}));

app.post('/api/bots/:id/commands', asyncRoute(async (req, res) => {
  if (!isObject(req.body)) throw new HttpError(400, 'invalid_payload', 'A JSON object is required');
  const command = String(req.body.command || '');
  const requestedBy = String(req.body.requestedBy || 'dashboard').slice(0, 120);
  const rawKey = req.get('Idempotency-Key') || req.body.idempotencyKey || null;
  const idempotencyKey = rawKey == null ? null : String(rawKey).slice(0, 200);
  const result = await executeBotCommand(req.params.id, command, requestedBy, idempotencyKey);
  res.status(result.idempotentReplay ? 200 : 202).json({ ok: result.status !== 'failed', idempotentReplay: Boolean(result.idempotentReplay), command: result });
}));

app.get('/api/orders', asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '50', 10) || 50));
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  if (status && !ORDER_STATUSES.includes(status)) throw new HttpError(400, 'invalid_status', `status must be one of ${ORDER_STATUSES.join(', ')}`);
  const { rows } = await pool.query(
    `SELECT o.*,
      (SELECT e.payload->>'botId' FROM order_events e WHERE e.order_id=o.id AND e.event_type='order.dispatched' ORDER BY e.id DESC LIMIT 1) AS assigned_bot_id,
      (SELECT e.created_at FROM order_events e WHERE e.order_id=o.id ORDER BY e.id DESC LIMIT 1) AS last_event_at
     FROM orders o WHERE ($1::text IS NULL OR o.status=$1)
     ORDER BY o.created_at DESC LIMIT $2`, [status, limit]
  );
  res.json({ data: rows, total: rows.length, allowedStatuses: ORDER_STATUSES });
}));

app.post('/api/orders', asyncRoute(async (req, res) => {
  const { externalOrderId, amount = 0, currency = 'THB' } = req.body || {};
  if (typeof externalOrderId !== 'string' || !externalOrderId.trim() || externalOrderId.length > 200) {
    throw new HttpError(400, 'invalid_external_order_id', 'externalOrderId must be a non-empty string of at most 200 characters');
  }
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 0) throw new HttpError(400, 'invalid_amount', 'amount must be a non-negative number');
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) throw new HttpError(400, 'invalid_currency', 'currency must be a 3-letter currency code');
  const order = await withTransaction(async (client) => {
    // Serialize intake with the kill-switch so no new order can be accepted after it is enabled.
    await client.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_CONTROL_LOCK]);
    const existing = await client.query('SELECT * FROM orders WHERE external_order_id=$1 FOR UPDATE', [externalOrderId.trim()]);
    if (existing.rows[0]) return { data: existing.rows[0], created: false };
    const kill = await getKillSwitch(client);
    if (kill.enabled) throw new HttpError(423, 'kill_switch_enabled', 'Global kill-switch rejects new orders');
    const inserted = await client.query(
      `INSERT INTO orders (external_order_id,status,amount,currency)
       VALUES ($1,'PENDING_PAYMENT',$2,$3) ON CONFLICT (external_order_id) DO NOTHING RETURNING *`,
      [externalOrderId.trim(), parsedAmount.toFixed(2), currency.toUpperCase()]
    );
    if (inserted.rows[0]) {
      await client.query(`INSERT INTO order_events (order_id,event_type,payload) VALUES ($1,'order.created',$2::jsonb)`,
        [inserted.rows[0].id, JSON.stringify({ source: 'api', actor: req.body.actor || 'api-client' })]);
      await writeAudit(client, { actor: String(req.body.actor || 'api-client'), action: 'order.created', targetType: 'order', targetId: String(inserted.rows[0].id), metadata: { externalOrderId: externalOrderId.trim() } });
      return { data: inserted.rows[0], created: true };
    }
    // The unique constraint is the final guard if another process writes outside this API lock.
    const reread = await client.query('SELECT * FROM orders WHERE external_order_id=$1', [externalOrderId.trim()]);
    return { data: reread.rows[0], created: false };
  });
  if (order.created) broadcastRefresh('order_created');
  res.status(order.created ? 201 : 200).json({ ...order, idempotentReplay: !order.created });
}));

app.get('/api/orders/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM orders WHERE id::text=$1 OR external_order_id=$1 ORDER BY id LIMIT 1', [req.params.id]);
  const order = result.rows[0];
  if (!order) throw new HttpError(404, 'order_not_found', 'Order was not found');
  const events = await pool.query('SELECT * FROM order_events WHERE order_id=$1 ORDER BY id ASC', [order.id]);
  res.json({ data: order, timeline: events.rows, allowedTransitions: allowedTransitions(order.status) });
}));

app.post('/api/orders/:id/transition', asyncRoute(async (req, res) => {
  const targetStatus = String(req.body?.status || '').toUpperCase();
  if (!ORDER_STATUSES.includes(targetStatus)) throw new HttpError(400, 'invalid_status', `status must be one of ${ORDER_STATUSES.join(', ')}`);
  const actor = String(req.body?.actor || 'dashboard').slice(0, 120);
  const updated = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_CONTROL_LOCK]);
    if (['QUEUED', 'IN_PROGRESS'].includes(targetStatus)) {
      const kill = await getKillSwitch(client);
      if (kill.enabled) throw new HttpError(423, 'kill_switch_enabled', 'Global kill-switch prevents new order processing');
    }
    const found = await client.query('SELECT * FROM orders WHERE id::text=$1 OR external_order_id=$1 ORDER BY id LIMIT 1 FOR UPDATE', [req.params.id]);
    const order = found.rows[0];
    if (!order) throw new HttpError(404, 'order_not_found', 'Order was not found');
    if (order.status === targetStatus) return { order, unchanged: true };
    if (!canTransition(order.status, targetStatus)) {
      throw new HttpError(409, 'invalid_transition', `Cannot transition ${order.status} to ${targetStatus}`, { allowed: allowedTransitions(order.status) });
    }
    const { rows } = await client.query('UPDATE orders SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [order.id, targetStatus]);
    await client.query(`INSERT INTO order_events (order_id,event_type,payload) VALUES ($1,$2,$3::jsonb)`,
      [order.id, `order.${targetStatus.toLowerCase()}`, JSON.stringify({ from: order.status, to: targetStatus, actor })]);
    await writeAudit(client, { actor, action: 'order.transition', targetType: 'order', targetId: String(order.id), metadata: { from: order.status, to: targetStatus } });
    return { order: rows[0], unchanged: false };
  });
  if (!updated.unchanged) broadcastRefresh('order_transition');
  res.json({ ok: true, ...updated });
}));

app.post('/api/orders/:id/dispatch', asyncRoute(async (req, res) => {
  const actor = String(req.body?.actor || 'dispatcher').slice(0, 120);
  const result = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_CONTROL_LOCK]);
    const kill = await getKillSwitch(client);
    if (kill.enabled) throw new HttpError(423, 'kill_switch_enabled', 'Global kill-switch prevents order dispatch');
    const found = await client.query('SELECT * FROM orders WHERE id::text=$1 OR external_order_id=$1 ORDER BY id LIMIT 1 FOR UPDATE', [req.params.id]);
    const order = found.rows[0];
    if (!order) throw new HttpError(404, 'order_not_found', 'Order was not found');
    if (!['PENDING_PAYMENT', 'QUEUED', 'DELAYED'].includes(order.status)) {
      throw new HttpError(409, 'order_not_dispatchable', `Order in ${order.status} cannot be dispatched`, { allowed: allowedTransitions(order.status) });
    }
    const eligible = await client.query(
      `SELECT b.id FROM oxide_bot_agents b
       WHERE b.status='online' AND b.last_heartbeat > now() - ($1::int * interval '1 millisecond')
       ORDER BY (SELECT COUNT(*) FROM orders o
          JOIN LATERAL (SELECT payload FROM order_events e WHERE e.order_id=o.id AND e.event_type='order.dispatched' ORDER BY e.id DESC LIMIT 1) d ON true
          WHERE o.status='IN_PROGRESS' AND d.payload->>'botId'=b.id), b.id
       LIMIT 1`, [HEARTBEAT_TIMEOUT_MS]
    );
    if (!eligible.rows[0]) throw new HttpError(503, 'no_healthy_bots', 'No healthy online bot is available to receive this order');
    const botId = eligible.rows[0].id;
    if (order.status !== 'QUEUED') {
      await client.query(`UPDATE orders SET status='QUEUED',updated_at=now() WHERE id=$1`, [order.id]);
      await client.query(`INSERT INTO order_events (order_id,event_type,payload) VALUES ($1,'order.queued',$2::jsonb)`,
        [order.id, JSON.stringify({ from: order.status, to: 'QUEUED', actor })]);
    }
    const { rows } = await client.query(`UPDATE orders SET status='IN_PROGRESS',updated_at=now() WHERE id=$1 RETURNING *`, [order.id]);
    await client.query(`INSERT INTO order_events (order_id,event_type,payload) VALUES ($1,'order.dispatched',$2::jsonb)`,
      [order.id, JSON.stringify({ botId, from: 'QUEUED', to: 'IN_PROGRESS', actor, dispatchMode: 'simulated' })]);
    await client.query(`INSERT INTO order_events (order_id,event_type,payload) VALUES ($1,'order.in_progress',$2::jsonb)`,
      [order.id, JSON.stringify({ botId, actor })]);
    await writeAudit(client, { actor, action: 'order.dispatched', targetType: 'order', targetId: String(order.id), metadata: { botId, simulated: true } });
    return { order: rows[0], botId, dispatchMode: 'simulated' };
  });
  broadcastRefresh('order_dispatched');
  res.status(202).json({ ok: true, ...result });
}));

app.get('/api/activity', asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '30', 10) || 30));
  const { rows } = await pool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1', [limit]);
  res.json({ data: rows });
}));

app.post('/api/deployments', upload.single('package'), asyncRoute(async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'package_required', 'Upload a .zip file in multipart field "package"');
  const prefix = await fs.readFile(file.path).then((data) => data.subarray(0, 4));
  const zipMagic = prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b && (
    (prefix[2] === 0x03 && prefix[3] === 0x04) ||
    (prefix[2] === 0x05 && prefix[3] === 0x06) ||
    (prefix[2] === 0x07 && prefix[3] === 0x08)
  );
  if (!zipMagic) {
    await fs.unlink(file.path).catch(() => {});
    throw new HttpError(400, 'invalid_zip', 'Uploaded package is not a ZIP archive');
  }
  const targetBotIds = parseTargetBotIds(req.body?.targetBotIds);
  let targets = targetBotIds;
  if (!targets.length) {
    const { rows } = await pool.query('SELECT id FROM oxide_bot_agents ORDER BY id');
    targets = rows.map((row) => row.id);
  }
  const botResult = await pool.query('SELECT id FROM oxide_bot_agents WHERE id = ANY($1::text[])', [targets]);
  const validTargets = botResult.rows.map((row) => row.id);
  const invalidTargets = targets.filter((id) => !validTargets.includes(id));
  if (!validTargets.length || invalidTargets.length) {
    await fs.unlink(file.path).catch(() => {});
    throw new HttpError(400, 'invalid_targets', 'Every targetBotIds value must refer to an existing bot', { invalidTargets });
  }
  const kill = await getKillSwitch();
  if (kill.enabled) {
    await fs.unlink(file.path).catch(() => {});
    throw new HttpError(423, 'kill_switch_enabled', 'Global kill-switch prevents deployment rollout');
  }
  const deploymentId = crypto.randomUUID();
  await withTransaction(async (client) => {
    await writeAudit(client, {
      actor: String(req.body?.actor || 'dashboard'), action: 'deployment.requested', targetType: 'deployment', targetId: deploymentId,
      metadata: {
        originalFilename: path.basename(file.originalname), storedFilename: path.basename(file.path),
        sizeBytes: file.size, targetBotIds: validTargets, status: 'simulated_rollout',
        limitation: 'Simulator supports lifecycle commands only; package installation is not performed.'
      }
    });
  });
  const rollout = await Promise.all(validTargets.map(async (botId) => {
    try {
      const command = await executeBotCommand(botId, 'restart', 'deployment-service', `deployment:${deploymentId}:${botId}`);
      return { botId, status: command.status, commandId: command.id };
    } catch (error) {
      return { botId, status: 'failed', error: error.code || error.message };
    }
  }));
  const status = rollout.every((item) => item.status === 'success') ? 'simulated_rollout_complete'
    : rollout.some((item) => item.status === 'success') ? 'partial_failure' : 'failed';
  await withTransaction(async (client) => {
    await writeAudit(client, {
      actor: 'deployment-service', action: 'deployment.completed', targetType: 'deployment', targetId: deploymentId,
      metadata: { status, rollout, packageName: path.basename(file.originalname), simulated: true }
    });
  });
  broadcastRefresh('deployment');
  res.status(status === 'failed' ? 502 : 202).json({
    ok: status !== 'failed', deploymentId, status, packageName: path.basename(file.originalname),
    sizeBytes: file.size, rollout, simulated: true,
    note: 'This candidate simulator can restart bots but cannot install code packages. The ZIP is staged and the rollout is recorded; no production bot is modified.'
  });
}));

app.get('/api/docs', (_req, res) => res.json({
  service: 'Oxide Centralized Bot Monitoring & Order Tracking',
  websocket: '/ws',
  endpoints: [
    'GET /health', 'GET /api/overview', 'GET /api/control', 'POST /api/control/kill-switch',
    'GET /api/bots', 'GET /api/bots/:id', 'GET /api/bots/:id/metrics', 'GET /api/bots/:id/logs',
    'POST /api/bots/:id/commands', 'GET /api/orders', 'POST /api/orders', 'GET /api/orders/:id',
    'POST /api/orders/:id/transition', 'POST /api/orders/:id/dispatch', 'GET /api/activity', 'POST /api/deployments'
  ]
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/ws') return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'upload_too_large' : 'upload_error', message: err.message });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err?.message === 'Only .zip packages are accepted') return res.status(400).json({ error: 'invalid_package_type', message: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON' });
  console.error(`[request-error] ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred' });
});

export async function startServer() {
  await fs.mkdir(uploadDir, { recursive: true });
  await pool.query('SELECT 1');
  httpServer = http.createServer(app);
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected', at: isoNow() }));
    socket.on('error', (error) => console.error(`[websocket] ${error.message}`));
  });
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Oxide Monitor listening on http://localhost:${PORT}`);
    console.log(`Bot simulator: ${BOT_SIMULATOR_URL}`);
  });
  await syncBotsFromSimulator();
  heartbeatTimer = setInterval(syncBotsFromSimulator, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  return httpServer;
}

export async function stopServer() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (wss) wss.close();
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await pool.end();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error('Failed to start Oxide Monitor:', error);
    process.exitCode = 1;
  });
  const shutdown = async () => {
    await stopServer().catch((error) => console.error(error));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
