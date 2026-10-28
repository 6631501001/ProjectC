# Oxide Monitor — Centralized Bot Monitoring & Order Tracking

A local-first candidate implementation of a centralized control plane for the supplied Oxide bot simulator. It includes a responsive dashboard, REST API, WebSocket refresh notifications, PostgreSQL persistence, order state machine, heartbeat monitoring, command history, audit trail, and a simulated ZIP rollout workflow.

> **Safe by design for this exercise:** this project connects only to the supplied local simulator. It does not contain or connect to production Oxide bots, credentials, or services.

## Features

- **Fleet overview:** online/offline/error counts, active/standby state, in-progress and attention-needed orders.
- **Three simulator nodes:** status cards, heartbeat age, CPU/memory metrics, uptime, latest command, and per-bot start/stop/restart/status controls.
- **Global kill-switch:** persists in `audit_logs`; rejects newly created orders, prevents dispatch/new processing, and blocks start/restart commands while enabled. The toggle and work-starting operations are serialized with a PostgreSQL advisory lock to close the obvious race window.
- **Order tracking:** validated lifecycle `PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED`; `DELAYED`, `FAILED`, and `CANCELLED` failure/exit paths; each transition is persisted in `order_events`.
- **Idempotency:** `external_order_id` is unique, so repeating order creation returns the existing order. Bot commands accept `Idempotency-Key`; duplicate keys for the same bot do not re-send the simulator command.
- **Heartbeat timeout:** the poller samples the simulator every 5 seconds (configurable). Nodes with stale heartbeats are marked offline; orders currently assigned to a timed-out node are moved to `DELAYED` and audited.
- **Deployment staging:** accepts a ZIP (max 25 MB), validates the ZIP signature, stores it in the uploads volume, records the requested target set and audit events, then restarts selected bots as a simulated rollout.
- **Real-time UI refresh:** WebSocket notifications with 10-second HTTP polling as a fallback.
- **Operational traceability:** command rows, order timeline events, and operator/system audit events.

## Architecture

```text
Browser Dashboard
  ├─ REST /api/* ───────────────────┐
  └─ WebSocket /ws (refresh events)  │
                                    ▼
                          Express Control Plane
                           ├─ PostgreSQL (state)
                           ├─ Heartbeat poller ── GET /bots ──► Local Simulator
                           └─ Bot commands ───── POST /bots/:id/commands ─►
```

**Stack:** Node.js 22+, Express, `pg`, `ws`, Multer, Helmet, PostgreSQL 16, and a static vanilla-JS dashboard. The backend uses the supplied tables (`oxide_bot_agents`, `oxide_bot_commands`, `orders`, `order_events`, `audit_logs`). The provided `db/schema.sql` is the initial schema and includes the full order-state check constraint required by the brief; no separate migration runner is needed.

## Quick start (Docker — recommended)

Requirements: Docker Desktop / Docker Engine with the Compose plugin.

```bash
git clone <your-repository-url>
cd oxide-monitor-candidate-pack
docker compose up --build -d
```

Open:

- Dashboard: http://localhost:3000
- REST API docs summary: http://localhost:3000/api/docs
- Health check: http://localhost:3000/health
- Simulator health: http://localhost:8788/health
- PostgreSQL: `localhost:55432` (`oxide` / `oxide_dev`, database `oxide_monitor`)

Watch logs:

```bash
docker compose logs -f api simulator postgres
```

Stop the stack:

```bash
docker compose down
```

The SQL scripts under `db/` are applied automatically **only when PostgreSQL initializes an empty data volume**. For a disposable candidate database that was initialized with an older schema, reset it with `docker compose down -v` then `docker compose up --build -d`. **Warning:** `down -v` deletes this Compose project's PostgreSQL and upload volumes; do not run it if you need their data.

## Run without Docker

Requirements: Node.js 22+, PostgreSQL 16+, and a separate terminal for the supplied simulator.

1. Create a database and apply the schema/seed:

   ```bash
   createdb -U <your-postgres-user> oxide_monitor
   psql -U <your-postgres-user> -d oxide_monitor -f db/schema.sql
   psql -U <your-postgres-user> -d oxide_monitor -f db/seed.sql
   ```

   Then update `DATABASE_URL` in `.env` to match your local host, port, username, and password.

2. Install and configure:

   ```bash
   cp .env.example .env
   npm install
   ```

3. Run the simulator in one terminal:

   ```bash
   cd simulator
   PORT=8788 node server.js
   ```

4. Run the API + dashboard from the repository root in another terminal:

   ```bash
   npm start
   ```

## Configuration

Copy `.env.example` to `.env` and adjust values as needed.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API and dashboard HTTP port |
| `DATABASE_URL` | local candidate database | PostgreSQL connection string |
| `BOT_SIMULATOR_URL` | `http://localhost:8788` | Supplied simulator base URL |
| `HEARTBEAT_INTERVAL_MS` | `5000` | Simulator polling interval |
| `HEARTBEAT_TIMEOUT_MS` | `20000` | Maximum age before a node is stale |
| `UPLOAD_DIR` | `./uploads` | Directory to stage ZIP uploads |
| `MAX_UPLOAD_MB` | `25` | Maximum deployment package size |

## API reference

All API responses are JSON. See the runnable examples in [`oxide-monitor.http`](./oxide-monitor.http), or use `GET /api/docs` for the endpoint list.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Liveness and database connectivity check |
| `GET` | `/api/overview` | Counts, kill-switch state, recent activity |
| `GET` | `/api/control` | Global kill-switch state |
| `POST` | `/api/control/kill-switch` | `{ "enabled": true, "reason": "...", "actor": "..." }` |
| `GET` | `/api/bots` | List fleet nodes and latest command |
| `GET` | `/api/bots/:id` | One bot record |
| `GET` | `/api/bots/:id/metrics` | Resource metrics and order counters |
| `GET` | `/api/bots/:id/logs` | Command history and audit events |
| `POST` | `/api/bots/:id/commands` | `{ "command": "restart", "requestedBy": "..." }`; optional `Idempotency-Key` header |
| `GET` | `/api/orders?status=IN_PROGRESS&limit=50` | List and filter recent orders |
| `POST` | `/api/orders` | Create order: `{ "externalOrderId": "OX-100", "amount": 99, "currency": "THB" }` |
| `GET` | `/api/orders/:id` | Order details and ordered timeline; accepts DB ID or external order ID |
| `POST` | `/api/orders/:id/transition` | `{ "status": "QUEUED", "actor": "..." }` |
| `POST` | `/api/orders/:id/dispatch` | Atomically queue + assign to the least-loaded healthy simulator bot |
| `GET` | `/api/activity?limit=30` | Most recent audit events |
| `POST` | `/api/deployments` | Multipart: `package` (ZIP), `targetBotIds` (comma-separated or JSON array) |
| WebSocket | `/ws` | Sends `{ "type": "refresh" }` after state changes |

### Example requests

```bash
# Create an order (safe to repeat with the same externalOrderId)
curl -X POST http://localhost:3000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"externalOrderId":"OX-1001","amount":299,"currency":"THB"}'

# Dispatch it to a healthy bot
curl -X POST http://localhost:3000/api/orders/OX-1001/dispatch \
  -H 'Content-Type: application/json' -d '{"actor":"operator"}'

# Enable global kill-switch
curl -X POST http://localhost:3000/api/control/kill-switch \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"reason":"manual pause","actor":"operator"}'

# Restart a bot; duplicate calls with the same key are idempotent
curl -X POST http://localhost:3000/api/bots/bot-01/commands \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: restart-bot-01-demo' \
  -d '{"command":"restart","requestedBy":"operator"}'
```

## Order state machine and failure handling

```text
PENDING_PAYMENT ──► QUEUED ──► IN_PROGRESS ──► COMPLETED
       │               │             │
       ├──► FAILED     ├──► DELAYED ◄─┘
       └──► CANCELLED  │       │
                       ├──► FAILED
                       └──► CANCELLED

DELAYED ──► QUEUED or IN_PROGRESS (retry after operator/system recovery)
```

Transitions are checked by the domain state machine and again under a row lock (`SELECT ... FOR UPDATE`) before the order is written, so concurrent requests cannot both advance the same prior state. A terminal state (`COMPLETED`, `FAILED`, `CANCELLED`) cannot be reopened. The API returns `409 invalid_transition` and an `allowed` list when a transition is invalid. New work is refused with `423 kill_switch_enabled` while the global switch is active. A dispatch returns `503 no_healthy_bots` if no bot has a fresh heartbeat.

The unique `orders.external_order_id` constraint is the source of truth for order-creation idempotency. Bot-command idempotency uses a caller-provided key scoped to a bot, stored in the existing `result` JSONB column, and a PostgreSQL advisory lock to serialize duplicate keys.

## ZIP rollout limitation

The supplied simulator only supports `start`, `stop`, `restart`, and `status`. The deployment flow validates/stages a ZIP, logs selected targets, and exercises the restart-control path. It **does not extract or install the uploaded code into simulated bot machines**. This is deliberate and visible in the API/UI rather than implying a real production deployment. A real deployment adapter would need an authenticated agent command for package download, checksum/signature verification, atomic swap, health check, and rollback.

## Tests

```bash
npm test
# With the Docker stack running, add API-level concurrency/idempotency/kill-switch checks:
TEST_BASE_URL=http://localhost:3000 npm test
# Fast health + endpoint smoke checks:
npm run test:smoke
```

The unit tests cover the allowed order lifecycle and terminal-state rules. The optional API integration test checks concurrent duplicate order creation, duplicate command keys, invalid state jumps, and kill-switch enforcement. The smoke script checks the live health, overview, bot list, orders, and API docs endpoints. Additional manual cases in `oxide-monitor.http` cover bot commands and timeline inspection.

## Continuous integration

The GitHub Actions workflow under `.github/workflows/test.yml` uses Node.js 24, installs the pinned direct dependencies, runs the state-machine unit tests, and runs API integration checks in skip mode unless `TEST_BASE_URL` is supplied.

## Operational and security notes

- This repository is a local candidate/demo build. Do not expose it to the public internet as-is; write endpoints do not include production authentication or role-based authorization.
- Use environment variables for connection configuration. `.env` and staged ZIP files are excluded from Git.
- The SQL seed uses only synthetic test orders and bot metrics.
- The dashboard renders HTML from API data with escaping for text fields; production deployments should additionally add authenticated sessions/RBAC, CSRF controls where applicable, package scanning/signature checks, rate limiting, and restricted network access.
