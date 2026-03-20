# ReadyOn Time-Off Microservice

A NestJS microservice that manages time-off request lifecycles and maintains a local shadow of HCM leave balances for ReadyOn's AI-powered frontline workforce platform.

---

## Overview

ReadyOn connects hourly and flex workers with employers who need on-demand shift coverage. Time off in this context means **blocking availability windows** — when a worker is unavailable, the scheduling engine must know immediately to stop offering them shifts. A stale balance isn't just a data quality issue; it causes real operational failures.

This service solves a two-system sync problem between ReadyOn and an external HCM (Workday, SAP SuccessFactors, etc.):

- Workers need **instant feedback** — no waiting for synchronous HCM round-trips
- Balances must **never be over-committed** across concurrent requests
- The service must stay **functional during HCM outages** without losing request state
- **Out-of-band HCM balance changes** (year-end resets, payroll adjustments) must reconcile quickly

---

## Architecture

```
┌─────────────────────────────────────────────┐
│             NestJS Application              │
│                                             │
│  BalanceModule   RequestModule   SyncModule  │
│      │               │              │       │
│  LeaveBalance   TimeOffRequest   SyncLog    │
│                                             │
│              TypeORM / SQLite               │
│              (WAL mode enabled)             │
└─────────────────────────────────────────────┘
              │
              ▼
     HcmService (HTTP)
              │
              ▼
      HCM System (Workday /
      SAP SuccessFactors)
```

**Key design decisions:**

- **Optimistic deduction** — balance is deducted locally before HCM confirmation, preventing over-commitment without blocking the worker
- **Optimistic locking** (`@VersionColumn`) with retry loop — handles concurrent submissions without `SELECT FOR UPDATE` (unsupported in SQLite)
- **`PENDING_HCM_CONFIRMATION`** — requests survive HCM outages; a background retry job re-submits with exponential backoff (1m → 5m → 15m → 30m → 60m)
- **Idempotency** — `Idempotency-Key` header deduplicates retried client submissions
- **Batch sync** — HCM pushes a corpus of balances; stale records are skipped; PENDING requests with insufficient balance are auto-cancelled
- **WAL mode** — SQLite Write-Ahead Log allows concurrent reads during writes

---

## API

Full interactive documentation available at `http://localhost:3000/api-docs` (Swagger UI) when the service is running.

### Balances

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/balances/:employeeId/:locationId` | Get current leave balance |

### Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/requests` | Submit a time-off request |
| `GET` | `/requests/:id` | Get request by ID |
| `PATCH` | `/requests/:id/approve` | Approve a PENDING request |
| `PATCH` | `/requests/:id/reject` | Reject a PENDING request |
| `PATCH` | `/requests/:id/cancel` | Cancel a PENDING request |

### Sync

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sync/batch` | HCM-initiated batch balance sync |
| `POST` | `/sync/refresh/:employeeId/:locationId` | Pull current balance from HCM for one employee |

### Request Status Lifecycle

```
                    ┌─────────┐
          ┌─────────│ PENDING │─────────┐
          │         └─────────┘         │
       approve                       cancel / reject
          │                             │
          ▼                             ▼
      APPROVED                   CANCELLED / REJECTED

  On submit:
    HCM approves    ──────────────────► APPROVED
    HCM rejects     ──────────────────► REJECTED
    HCM unavailable ────────────────► PENDING_HCM_CONFIRMATION
                                            │
                                      background retry
                                            │
                                APPROVED / REJECTED / CANCELLED
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
git clone https://github.com/burghporter314/readyon-time-off-service.git
cd readyon-time-off-service
npm install
cd mock-hcm && npm install && cd ..
```

### Run (development)

```bash
# Start the mock HCM server (required unless pointing at a real HCM)
node mock-hcm/server.js

# In a separate terminal, start the service with hot reload
npm run start:dev
```

### Run (production)

```bash
npm run build
npm run start:prod
```

The service starts on `http://localhost:3000`.
Swagger UI: `http://localhost:3000/api-docs`

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HCM_BASE_URL` | `http://localhost:3001` | Base URL of the HCM service |
| `DATABASE_PATH` | `:memory:` | SQLite file path (use a real path in production) |

Create a `.env` file in the project root to override defaults:

```env
HCM_BASE_URL=http://your-hcm-host/api
DATABASE_PATH=./data/time-off.db
```

---

## Testing

```bash
# Unit tests
npm run test:unit

# Integration tests (real SQLite in-memory)
npm run test:integration

# E2E tests (full app + mock HCM)
npm run test:e2e

# All tests
npm run test:all

# Unit + integration with coverage report
npm run test:coverage
```

### Coverage

| Metric | Result | Threshold |
|--------|--------|-----------|
| Statements | 97.48% | 85% |
| Branches | 86.71% | 80% |
| Functions | 96.15% | 85% |
| Lines | 98.47% | 85% |

| Suite | Tests |
|-------|-------|
| Unit | 54 |
| Integration | 22 |
| E2E | 21 |
| **Total** | **97** |

After running `npm run test:coverage`, open the HTML report:

```
coverage/lcov-report/index.html
```

---

## Mock HCM Server

A lightweight Express server that simulates the HCM API for local development and testing.

```bash
node mock-hcm/server.js
# Runs on http://localhost:3001
```

**Seed data:** `emp001/loc001` → 15 days, `emp002/loc001` → 10 days, `emp099/loc099` → 12 days

**Admin endpoints (test/dev only):**

```bash
# Reset seed data and clear failure simulation
curl -X POST http://localhost:3001/hcm/admin/reset

# Simulate HCM outage (rate: 0.0–1.0)
curl -X POST http://localhost:3001/hcm/admin/set-failure-rate \
  -H "Content-Type: application/json" \
  -d '{"rate": 1.0}'
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `HCM_MOCK_PORT` | `3001` | Port to listen on |
| `MOCK_FAILURE_RATE` | `0` | Initial failure rate (0.0–1.0) |

---

## Project Structure

```
src/
├── balance/          # LeaveBalance entity, BalanceService, BalanceController
├── request/          # TimeOffRequest entity, RequestService, RequestController
├── sync/             # SyncLog entity, SyncService, SyncController
├── hcm/              # HcmService (HTTP client to HCM)
├── common/
│   ├── dto/          # Shared DTOs
│   ├── exceptions/   # InsufficientBalanceException (HTTP 422)
│   └── utils/        # round4(), parseHcmBalance()
└── main.ts

test/
├── unit/             # Mocked unit tests
├── integration/      # Real SQLite in-memory tests
└── e2e/              # Full app tests via supertest

mock-hcm/
└── server.js         # Standalone Express mock HCM server

docs/
├── TRD.md            # Technical Requirements Document v2.1
└── COVERAGE.md       # Coverage report summary
```

---

## CI

GitHub Actions runs on every push and pull request:

1. Install dependencies (`npm ci`)
2. Build (`npm run build`)
3. Test with coverage (`npm run test:coverage`) — fails if any threshold is missed

See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## Known Limitations

- **Single-instance only** — SQLite is not shareable across processes. Horizontal scaling requires migrating to PostgreSQL.
- **No authentication** — all endpoints are open. Add JWT middleware before production deployment.
- **In-process retry queue** — `PENDING_HCM_CONFIRMATION` retries run in-memory via `setTimeout`. Heavy load may delay retries. Use Bull/BullMQ in production.
- **No data archival** — records accumulate indefinitely. Add a retention job for production.

See `docs/TRD.md` Section 2.3 for the full limitations register.

---

## License

Private — ReadyOn.ai
