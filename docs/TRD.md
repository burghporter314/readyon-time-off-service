# Technical Requirements Document
## ReadyOn Time-Off Microservice — v2.1

| Attribute | Value |
|---|---|
| Version | 2.1 |
| Status | Approved |
| Stack | NestJS · TypeORM · SQLite (PostgreSQL migration path) · REST |
| Standard | ISO/IEC/IEEE 29148:2018 |
| Last Updated | 2025 |

---

## Table of Contents

1. [Overview & Problem Statement](#1-overview--problem-statement)
2. [Document Context](#2-document-context)
   - 2.1 Assumptions & Dependencies
   - 2.2 Constraints
   - 2.3 Known Limitations
3. [Glossary](#3-glossary)
4. [Stakeholders & Use Cases](#4-stakeholders--use-cases)
5. [Domain Model](#5-domain-model)
6. [Functional Requirements](#6-functional-requirements)
7. [API Surface](#7-api-surface)
8. [Sync Strategy](#8-sync-strategy)
9. [Quality Attributes (IEEE 29148 Aligned)](#9-quality-attributes-ieee-29148-aligned)
10. [Key Challenges & Solutions](#10-key-challenges--solutions)
11. [Alternatives Considered](#11-alternatives-considered)
12. [Edge Cases & Risk Register](#12-edge-cases--risk-register)
13. [Use Case Specifications](#13-use-case-specifications)
14. [Test Scenarios](#14-test-scenarios)
15. [Acceptance Criteria](#15-acceptance-criteria)
16. [Out of Scope](#16-out-of-scope)
17. [IEEE 29148 Compliance Analysis](#17-ieee-29148-compliance-analysis)

---

## 1. Overview & Problem Statement

### 1.1 Business Context

ReadyOn is an AI-powered frontline workforce platform. Its core purpose is connecting hourly workers — in retail, hospitality, food service, manufacturing, and logistics — with employers who need flexible, on-demand shift coverage. Workers self-select shifts through a mobile app based on their availability. Employers use ReadyOn's AI scheduling engine to optimise coverage, backfill no-shows, and manage a contingent workforce at scale.

**Time off in this context is fundamentally different from traditional HR leave management.** A ReadyOn worker is not submitting a vacation request weeks in advance. They are blocking availability windows — telling the system "I am not available to pick up shifts during this period." The scheduling engine acts on this information immediately: it stops offering those shift slots to the worker, and backfill logic may be triggered to find coverage. A stale or incorrect balance does not just inconvenience a worker — it directly disrupts shift coverage for an employer's operation.

This means:
- **Balance accuracy is operationally critical in near-real-time**, not just eventually.
- **The PENDING_HCM_CONFIRMATION window is a genuine business risk** — in a high-throughput shift environment, a 2-hour unresolved status could span multiple shift slots being offered, filled, or missed incorrectly.
- **Workers may be flex-time** (part-time W2 workers choosing their own hours), so leave balances may accrue on short cycles and reset more frequently than for salaried employees.
- **Multiple workers at the same location compete for the same shift slots**, making the over-commitment problem more acute than in a traditional office setting.

### 1.2 Problem Statement

ReadyOn's time-off module must sync with the HCM system (typically Workday or SAP SuccessFactors), which is the authoritative source of truth for leave balances. The HCM is not exclusively controlled by ReadyOn: third-party processes (anniversary bonuses, year-end resets, payroll adjustments) can modify balances independently at any time.

This creates a two-system synchronisation problem with four competing constraints:
- Workers need **instant feedback** on availability blocking — they cannot wait for synchronous HCM round-trips while deciding whether to pick up a shift.
- Balances must **never be over-committed** — two workers cannot both consume the same available days at the same location.
- The system must remain **functional during HCM outages** without losing request state or disrupting the scheduling engine's view of worker availability.
- **Balance changes from outside ReadyOn must reconcile quickly** — a stale balance that keeps offering shifts to an unavailable worker is an operational failure, not just a data quality issue.

### 1.3 Scope

This document specifies the requirements for the **Time-Off Microservice**: a NestJS backend service that manages the lifecycle of time-off requests and maintains a local shadow of HCM leave balances. It covers functional behaviour, quality attributes, interface contracts, sync strategy, edge cases, and acceptance criteria.

Balances are scoped to the `(employeeId, locationId)` composite key. `locationId` is especially significant in ReadyOn's context — a flex worker may be eligible to pick up shifts at multiple employer locations, each with independent leave accrual.

---

## 2. Document Context

### 2.1 Assumptions & Dependencies

| ID | Assumption or Dependency |
|---|---|
| A-01 | The HCM exposes a real-time REST API supporting `GET /hcm/balances/:employeeId/:locationId` and `POST /hcm/requests`. |
| A-02 | The HCM exposes a batch push mechanism allowing it to POST a corpus of balance records to ReadyOn's `POST /sync/batch` endpoint. |
| A-03 | HCM API responses include an `availableDays` field that is numeric or coercible to a finite non-negative decimal. |
| A-04 | The HCM will return a `transactionId` on successful request submission. |
| A-05 | Clock synchronisation between the ReadyOn host and HCM host is within ±1 second. Batch `syncTimestamp` comparisons depend on this. |
| A-06 | `employeeId` and `locationId` are opaque string identifiers managed externally. ReadyOn does not validate their format beyond non-empty string. |
| A-07 | The deployment environment is single-instance (one Node process) for this version. Horizontal scaling requires migration to PostgreSQL (see Section 9.5). |
| A-08 | The HCM real-time API has a P95 response time ≤ 300ms under normal conditions. The 500ms target for `POST /requests` depends on this. |

### 2.2 Constraints

| ID | Constraint |
|---|---|
| C-01 | Technology stack is fixed: NestJS, TypeORM, SQLite (`better-sqlite3`). |
| C-02 | SQLite WAL mode must be enabled. `busy_timeout` must be set to at least 5000ms. |
| C-03 | All balance arithmetic must use fixed-point rounding to 4 decimal places before any database write. |
| C-04 | No authentication implementation in this version. Authentication is a pre-production requirement. |
| C-05 | SQLite does not support `SELECT ... FOR UPDATE`. Concurrency guarantees that rely on pessimistic locking must use optimistic locking with retry in this version, or be serialised at the application level. |
| C-06 | The HCM mock server must run as a separate Express process on port 3001, controllable via environment variables for test scenarios. |

### 2.3 Known Limitations

| ID | Limitation | Impact | Mitigation Path |
|---|---|---|---|
| L-01 | SQLite is a single-writer database. All write transactions are serialised at commit time. | Under high concurrent submission load, write throughput is bounded. | Migrate to PostgreSQL. |
| L-02 | No horizontal scaling in this version (SQLite is file-based, not shareable across processes). | Cannot run multiple instances of the service behind a load balancer. | Migrate to PostgreSQL with connection pooling. |
| L-03 | No authentication. All endpoints are open. | Not safe for production deployment as-is. | Add JWT middleware before production. |
| L-04 | Balance drift detection is reactive (batch sync) not proactive (real-time streaming). | A balance changed in HCM between batch syncs will not be reflected until the next batch or manual refresh. | Accept for this version; document the refresh endpoint as the manual mitigation. |
| L-05 | Retry logic for `PENDING_HCM_CONFIRMATION` runs in-process. If the process is under heavy load, retries may be delayed beyond `nextRetryAt`. | **Elevated risk in ReadyOn's shift context**: a worker stuck in PENDING_HCM_CONFIRMATION may be incorrectly offered or blocked from shift slots until the status resolves. The ~2 hour max retry window is too long when shift slots fill in minutes. | Use Bull/BullMQ in production; reduce max retry window to 30 minutes for shift-critical contexts. |
| L-06 | No soft-delete or archival strategy. All records accumulate indefinitely. | Database file size grows unboundedly over time. | Add a data retention/archival job for records older than configurable TTL. |

---

## 3. Glossary

| Term | Definition |
|---|---|
| **HCM** | Human Capital Management system (e.g. Workday, SAP SuccessFactors). The authoritative source of truth for employee leave balances. |
| **Shadow Balance** | ReadyOn's local copy of the HCM balance for a given `(employeeId, locationId)`. Not authoritative — the HCM owns the true value — but used for all local reads and pre-submission validation. |
| **Optimistic Deduction** | The act of reducing `availableDays` and increasing `pendingDays` locally upon request submission, before HCM confirmation is received. |
| **Reconciliation** | The process of adjusting the local shadow balance to align with the HCM's authoritative state, either through batch sync (HCM-initiated) or real-time refresh (ReadyOn-initiated). |
| **Batch Sync** | An HCM-initiated push of a complete corpus of balance records to ReadyOn's `POST /sync/batch` endpoint. Used for large-scale balance updates (year-end resets, anniversary bonuses). |
| **Eventual Consistency** | The property that the local shadow balance will eventually reflect the HCM's authoritative state, given sufficient time and sync events, even if they diverge temporarily. |
| **Idempotency Key** | A client-generated UUID included in the `Idempotency-Key` header of `POST /requests`. Allows the server to detect and deduplicate retried submissions. |
| **Pending Days** | Days that have been optimistically deducted from `availableDays` but not yet confirmed by the HCM or a manager. Held in the `pendingDays` field. |
| **Available Days** | Days the employee can currently request, after accounting for pending deductions. |
| **PENDING_HCM_CONFIRMATION** | A request status indicating the HCM was unreachable at submission time. The local deduction stands. A background retry job will attempt HCM submission. |
| **Auto-Cancel** | The automatic cancellation of a PENDING request triggered by a batch sync that reduces the balance below the request's `daysRequested`. Only applies to requests created before the batch's `syncTimestamp`. |
| **WAL Mode** | Write-Ahead Log mode for SQLite. Allows reads and writes to proceed concurrently (readers do not block the writer). Mandatory for this service. |
| **Composite Key** | The `(employeeId, locationId)` pair that uniquely identifies a balance record. A single employee can have different balances at different locations. |

---

## 4. Stakeholders & Use Cases

### 4.1 Stakeholder Map

| Stakeholder | Role | Primary Concern |
|---|---|---|
| **Flex Worker (Employee)** | Hourly/flex-time worker using the ReadyOn mobile app | Accurate balance display; instant confirmation when blocking availability; ability to cancel |
| **Employer / Site Manager** | Manages shift coverage at a location | Confidence that worker availability data is accurate; no scheduling gaps caused by stale balances |
| **Supervisor / Manager** | Approves time-off requests at a location | Data validity when approving; preventing over-approval that would leave shifts uncovered |
| **HR Administrator** | Configures HCM; triggers syncs | Balance accuracy after bulk HCM changes; bootstrap of new workers |
| **ReadyOn Scheduling Engine** | AI system that matches workers to open shifts | Real-time accuracy of availability data; stale balances mean workers are offered shifts they cannot take |
| **HCM System** | External system; pushes batch syncs | Reliable batch acceptance; idempotent processing |
| **Platform / ReadyOn Engineering** | Operates the service | Audit trail; observability; data integrity; no silent failures |

### 4.2 Use Case Summary

| ID | Use Case | Primary Actor |
|---|---|---|
| UC-01 | Worker blocks availability window (submits time-off request) | Flex Worker |
| UC-02 | Approve time-off request | Supervisor / Manager |
| UC-03 | Reject time-off request | Supervisor / Manager |
| UC-04 | Cancel time-off request | Flex Worker |
| UC-05 | View current leave balance | Flex Worker / Manager |
| UC-06 | HCM pushes batch balance sync | HCM System |
| UC-07 | Manually refresh a single balance from HCM | HR Administrator |
| UC-08 | Retry failed HCM submission on startup | Platform (system) |
| UC-09 | Submit duplicate request (idempotent retry) | Flex Worker (client retry) |
| UC-10 | Submit request when HCM is unavailable | Flex Worker |
| UC-11 | Scheduling engine queries availability for shift matching | ReadyOn Scheduling Engine |

Full specifications for each use case are in Section 13.

---

## 5. Domain Model

### 5.1 Entity Relationship

```
LeaveBalance (1) ──── (N) TimeOffRequest
     │
     └── keyed by (employeeId, locationId)

SyncLog ──── independent audit table, written on every sync event
```

### 5.2 LeaveBalance

Represents the local shadow of the HCM leave balance for a specific employee at a specific location.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK, NOT NULL | Auto-generated |
| `employeeId` | varchar(255) | NOT NULL | Opaque identifier |
| `locationId` | varchar(255) | NOT NULL | Opaque identifier |
| `availableDays` | decimal(10,4) | NOT NULL, >= 0 | Days available to request |
| `pendingDays` | decimal(10,4) | NOT NULL, >= 0 | Days held by PENDING requests |
| `lastHcmSyncAt` | timestamp | NULL allowed | Null until first sync |
| `version` | integer | NOT NULL, DEFAULT 0 | Optimistic lock version |
| `createdAt` | timestamp | NOT NULL | Auto-set on insert |
| `updatedAt` | timestamp | NOT NULL | Auto-set on update |

**Business invariants:**
- `availableDays >= 0` at all times
- `pendingDays >= 0` at all times
- `availableDays >= daysRequested` must hold before any deduction

**Unique constraint:** `(employeeId, locationId)`

**Precision rule:** All arithmetic on `availableDays` and `pendingDays` must round to 4 decimal places before writing: `Math.round(value * 10000) / 10000`. Incoming HCM values with more than 4 decimal places are truncated (floor, not round-up) to avoid granting more balance than the HCM intends.

---

### 5.3 TimeOffRequest

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK, NOT NULL | Auto-generated |
| `employeeId` | varchar(255) | NOT NULL | FK semantic only (no DB FK) |
| `locationId` | varchar(255) | NOT NULL | FK semantic only |
| `startDate` | date | NOT NULL | Must be <= endDate |
| `endDate` | date | NOT NULL | Must be >= startDate |
| `daysRequested` | decimal(10,4) | NOT NULL, > 0 | Must be <= availableDays at submission |
| `status` | varchar(50) | NOT NULL | Enum — see status table |
| `hcmTransactionId` | varchar(255) | NULL allowed | Set when HCM confirms |
| `idempotencyKey` | varchar(255) | NULL allowed, UNIQUE | From `Idempotency-Key` header |
| `retryCount` | integer | NOT NULL, DEFAULT 0 | HCM retry attempts |
| `nextRetryAt` | timestamp | NULL allowed | Next scheduled HCM retry |
| `createdAt` | timestamp | NOT NULL | |
| `updatedAt` | timestamp | NOT NULL | |

**Status state machine:**

| Status | Terminal? | Allowed transitions | Balance state |
|---|---|---|---|
| `PENDING` | No | → APPROVED, REJECTED, CANCELLED | availableDays reduced, pendingDays increased |
| `APPROVED` | Yes | — | pendingDays released; net deduction permanent |
| `REJECTED` | Yes | — | availableDays restored; pendingDays released |
| `CANCELLED` | Yes | — | availableDays restored; pendingDays released |
| `PENDING_HCM_CONFIRMATION` | No | → APPROVED, REJECTED | availableDays reduced, pendingDays increased |

Transitions not listed above are invalid and must return HTTP 409.

---

### 5.4 SyncLog

Immutable audit record. Never updated after creation.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK, NOT NULL | |
| `type` | varchar(20) | NOT NULL | `REAL_TIME` or `BATCH` |
| `triggeredBy` | varchar(255) | NOT NULL | Actor string |
| `status` | varchar(20) | NOT NULL | `SUCCESS`, `PARTIAL`, `ERROR` |
| `recordsAffected` | integer | NOT NULL, DEFAULT 0 | |
| `recordsSkipped` | integer | NOT NULL, DEFAULT 0 | |
| `errorDetails` | text | NULL allowed | |
| `createdAt` | timestamp | NOT NULL | |

---

## 6. Functional Requirements

Requirements are identified by ID (FR-XX) for traceability. Each requirement states a single verifiable behaviour.

### 6.1 Balance Management

| ID | Requirement | Verification Method |
|---|---|---|
| FR-01 | The system **shall** return the local shadow balance for a given `(employeeId, locationId)` when queried via `GET /balances/:employeeId/:locationId`. | Test: query a seeded balance; verify response fields match. |
| FR-02 | The system **shall** return HTTP 404 with error code `BALANCE_NOT_FOUND` when no local balance record exists for the queried `(employeeId, locationId)`. | Test: query unknown employee; verify 404 + error code. |
| FR-03 | The system **shall** ensure `availableDays` is never stored as a value less than 0. Any arithmetic that would produce a negative value **shall** be rejected before the write is committed. | Test: attempt deduction exceeding balance; verify DB value unchanged. |
| FR-04 | The system **shall** round all `availableDays` and `pendingDays` values to 4 decimal places before writing to the database. | Test: write value with 10 d.p.; verify stored value has exactly 4 d.p. |

### 6.2 Request Submission

| ID | Requirement | Verification Method |
|---|---|---|
| FR-05 | The system **shall** atomically deduct `daysRequested` from `availableDays` and add it to `pendingDays`, and create a `TimeOffRequest` record with status `PENDING`, within a single database transaction on submission. | Test: interrupt between deduction and HCM call; verify DB consistency. |
| FR-06 | The system **shall** reject a submission with HTTP 422 if `availableDays < daysRequested` at the time of submission, before contacting the HCM. | Test: submit with daysRequested > availableDays; verify 422, no HCM call made. |
| FR-07 | The system **shall** reject a submission with HTTP 400 if `startDate` is after `endDate`. | Test: submit with startDate = 2025-03-10, endDate = 2025-03-09; verify 400. |
| FR-08 | The system **shall** reject a submission with HTTP 400 if `daysRequested <= 0`. | Test: submit with daysRequested = 0; verify 400. |
| FR-09 | The system **shall** call the HCM API after the submission transaction commits, not within it. | Test: mock HCM to fail; verify request is saved in DB before HCM call. |
| FR-10 | When the HCM returns `approved: true`, the system **shall** update the request status to `APPROVED` and reduce `pendingDays` by `daysRequested`. | Test: HCM mock returns approved; verify status = APPROVED, pendingDays = 0. |
| FR-11 | When the HCM returns `approved: false`, the system **shall** update the request status to `REJECTED`, restore `availableDays` by `daysRequested`, and reduce `pendingDays` by `daysRequested`. | Test: HCM mock returns rejected; verify status = REJECTED, balance restored. |
| FR-12 | When the HCM is unreachable (timeout or 5xx), the system **shall** save the request with status `PENDING_HCM_CONFIRMATION` and return HTTP 201. It **shall not** roll back the local balance deduction. | Test: HCM mock returns 503; verify 201, status = PENDING_HCM_CONFIRMATION, balance deducted. |

### 6.3 Idempotency

| ID | Requirement | Verification Method |
|---|---|---|
| FR-13 | The system **shall** accept an optional `Idempotency-Key` header on `POST /requests`. If provided, the key **shall** be stored with the created request with a 24-hour TTL. | Test: submit with header; verify key stored on request record. |
| FR-14 | If a second `POST /requests` is received with the same `Idempotency-Key` within 24 hours, the system **shall** return the original response without creating a new request or modifying any balance. | Test: submit twice with same key; verify single request in DB, balance deducted once. |
| FR-15 | If two concurrent `POST /requests` arrive with the same `Idempotency-Key`, the system **shall** return HTTP 409 to the second. | Test: concurrent duplicate submissions; verify one 201, one 409. |

### 6.4 Request Lifecycle Transitions

| ID | Requirement | Verification Method |
|---|---|---|
| FR-16 | The system **shall** transition a `PENDING` request to `APPROVED` when `PATCH /requests/:id/approve` is called, and invoke `reconcile('CONFIRMED')`. | Test: approve PENDING request; verify status = APPROVED, pendingDays = 0. |
| FR-17 | The system **shall** transition a `PENDING` request to `REJECTED` when `PATCH /requests/:id/reject` is called, and invoke `reconcile('REJECTED')`. | Test: reject PENDING request; verify status = REJECTED, availableDays restored. |
| FR-18 | The system **shall** transition a `PENDING` request to `CANCELLED` when `PATCH /requests/:id/cancel` is called by the employee, and invoke `reconcile('REJECTED')`. | Test: cancel PENDING request; verify status = CANCELLED, availableDays restored. |
| FR-19 | The system **shall** return HTTP 409 for any transition attempt on a request that is not in a valid source status for that transition. | Test: approve already-APPROVED request; verify 409. |
| FR-20 | The system **shall** return HTTP 404 for any transition attempt on a request ID that does not exist. | Test: approve nonexistent ID; verify 404. |

### 6.5 Batch Sync

| ID | Requirement | Verification Method |
|---|---|---|
| FR-21 | The system **shall** process a batch sync payload within a single atomic database transaction. If any record in the payload fails validation, no records shall be written. | Test: batch with one invalid record; verify zero writes. |
| FR-22 | The system **shall** validate that all `availableDays` values in a batch payload are finite, non-negative numbers. Invalid values shall cause the entire batch to be rejected with HTTP 400. | Test: batch with availableDays = -1; verify 400. |
| FR-23 | The system **shall** skip (not reject) any batch record whose `syncTimestamp` is not newer than the stored `lastHcmSyncAt` for that `(employeeId, locationId)`. Skipped records shall be counted in the response's `skipped` field. | Test: send stale batch; verify skipped count = 1, balance unchanged. |
| FR-24 | After committing a batch sync, the system **shall** re-evaluate all `PENDING` requests for each affected `(employeeId, locationId)` where `createdAt <= syncTimestamp`, and cancel any whose `daysRequested` exceeds the updated `availableDays`. | Test: batch reduces balance below pending request; verify request auto-cancelled. |
| FR-25 | The system **shall not** auto-cancel any `PENDING` request whose `createdAt > syncTimestamp` from the batch. | Test: request created after syncTimestamp; verify NOT cancelled even if balance insufficient. |
| FR-26 | The system **shall** accept an empty `records: []` payload as valid, returning HTTP 200 with `{ updated: 0, autoCancelled: 0, skipped: 0 }`. | Test: empty batch; verify 200 and zeroed response. |

### 6.6 Real-Time Refresh

| ID | Requirement | Verification Method |
|---|---|---|
| FR-27 | The system **shall** pull the current balance from the HCM real-time API and upsert it locally when `POST /sync/refresh/:employeeId/:locationId` is called. | Test: call refresh; verify local balance matches HCM mock value. |
| FR-28 | The system **shall** create a new `LeaveBalance` record on the first `POST /sync/refresh` call for an unknown `(employeeId, locationId)` (upsert semantics). | Test: refresh for new employee; verify record created. |

### 6.7 HCM Retry (PENDING_HCM_CONFIRMATION)

| ID | Requirement | Verification Method |
|---|---|---|
| FR-29 | The system **shall** re-enqueue all `PENDING_HCM_CONFIRMATION` requests at service startup (`onModuleInit`), computing backoff delay from `updatedAt`. | Test: start service with PENDING_HCM_CONFIRMATION request in DB; verify retry scheduled. |
| FR-30 | The system **shall** transition a `PENDING_HCM_CONFIRMATION` request to `REJECTED` and restore the balance if `retryCount >= 5` at startup or after exhausting retries. | Test: request with retryCount = 5 in DB; verify immediate REJECTED + balance restored. |

### 6.8 Audit

| ID | Requirement | Verification Method |
|---|---|---|
| FR-31 | The system **shall** create a `SyncLog` record for every batch sync, real-time refresh, and HCM retry attempt, regardless of success or failure. | Test: trigger sync; verify SyncLog record created. |
| FR-32 | The system **shall** populate `SyncLog.errorDetails` with the HCM error message or exception when `status = ERROR`. | Test: HCM returns 503; verify SyncLog.errorDetails is non-null. |

---

## 7. API Surface

All endpoints return `application/json`. HTTP error responses use the shape `{ statusCode, message, error }`. Authentication is not implemented in this version (see Section 9.4).

### 7.1 Request/Response Contracts

#### `GET /balances/:employeeId/:locationId`

| | |
|---|---|
| **Success** | 200 `{ employeeId, locationId, availableDays, pendingDays, lastHcmSyncAt }` |
| **Not found** | 404 `{ statusCode: 404, error: "BALANCE_NOT_FOUND", message: "..." }` |
| **Traces to** | FR-01, FR-02 |

---

#### `POST /requests`

**Headers:** `Idempotency-Key: <uuid>` (optional, recommended)

**Body:**
```json
{
  "employeeId": "emp001",
  "locationId": "loc001",
  "startDate": "2025-06-01",
  "endDate": "2025-06-05",
  "daysRequested": 5
}
```

| Code | Condition | Traces to |
|---|---|---|
| 201 | Request created | FR-05, FR-10, FR-12 |
| 400 | Invalid body, startDate > endDate, daysRequested <= 0 | FR-07, FR-08 |
| 404 | No balance record for employee/location | FR-02 |
| 409 | Duplicate Idempotency-Key in flight | FR-15 |
| 422 | Insufficient balance | FR-06 |

**Response (201):**
```json
{
  "id": "uuid",
  "employeeId": "emp001",
  "locationId": "loc001",
  "startDate": "2025-06-01",
  "endDate": "2025-06-05",
  "daysRequested": 5,
  "status": "APPROVED",
  "hcmTransactionId": "hcm-txn-abc123",
  "createdAt": "...",
  "updatedAt": "..."
}
```

Status in the response will be `APPROVED` (HCM confirmed), `PENDING` (awaiting manager), or `PENDING_HCM_CONFIRMATION` (HCM unreachable).

---

#### `GET /requests/:id`

| Code | Condition |
|---|---|
| 200 | Request found |
| 404 | Request not found |

---

#### `PATCH /requests/:id/approve`
#### `PATCH /requests/:id/reject`
#### `PATCH /requests/:id/cancel`

| Code | Condition | Traces to |
|---|---|---|
| 200 | Transition succeeded | FR-16 / FR-17 / FR-18 |
| 404 | Request not found | FR-20 |
| 409 | Invalid source status for transition | FR-19 |

---

#### `POST /sync/batch`

**Body:**
```json
{
  "records": [
    {
      "employeeId": "emp001",
      "locationId": "loc001",
      "availableDays": 20,
      "syncTimestamp": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

| Code | Condition | Traces to |
|---|---|---|
| 200 | Batch processed | FR-21 |
| 400 | Malformed body, any `availableDays < 0` | FR-22 |

**Response (200):**
```json
{ "updated": 1, "autoCancelled": 0, "skipped": 0 }
```

---

#### `POST /sync/refresh/:employeeId/:locationId`

| Code | Condition | Traces to |
|---|---|---|
| 200 | Balance refreshed | FR-27, FR-28 |
| 503 | HCM unreachable | — |

### 7.2 HCM Interface Contract

This specifies what ReadyOn expects from the HCM API. The mock server must implement these exactly.

**`GET /hcm/balances/:employeeId/:locationId`**

Expected response on success (200):
```json
{ "employeeId": "string", "locationId": "string", "availableDays": number }
```

Expected response on not found (404):
```json
{ "error": "Employee/location not found" }
```

**`POST /hcm/requests`**

Request body sent by ReadyOn:
```json
{ "employeeId": "string", "locationId": "string", "daysRequested": number, "requestId": "uuid" }
```

Expected response on success (200):
```json
{ "transactionId": "string", "approved": true }
```

Expected response on insufficient balance (422):
```json
{ "error": "Insufficient balance", "availableDays": number }
```

Expected error responses: 404 (not found), 422 (insufficient balance), 503 (unavailable).

ReadyOn treats any 5xx or timeout as a `ServiceUnavailableException`. ReadyOn treats any 4xx other than 422 as a permanent rejection.

---

## 8. Sync Strategy

### 8.1 Two-Phase Balance Model

ReadyOn maintains a local shadow with two balance components:

- `availableDays` — days remaining that can be requested.
- `pendingDays` — days reserved by `PENDING` or `PENDING_HCM_CONFIRMATION` requests, not yet finalised.

**The invariant:** `availableDays + pendingDays` at any point in time should equal the last HCM-confirmed total, modulo in-flight requests the HCM hasn't been told about yet.

On submission, `daysRequested` moves from `availableDays` into `pendingDays` **within a single atomic transaction** that also creates the `TimeOffRequest` record. The HCM call fires **after** the transaction commits. This ordering is non-negotiable:

- If the process crashes before the HCM call, the request exists in PENDING status and the startup retry job re-attempts.
- If the HCM call fails, the request transitions to `PENDING_HCM_CONFIRMATION` — the local deduction is preserved.
- If the HCM call succeeds, the deduction is finalised and `pendingDays` is released.

### 8.2 Reconciliation Decision Tree

```
On receiving HCM response to a submission:
  approved: true  → status = APPROVED, pendingDays -= daysRequested
  approved: false → status = REJECTED, availableDays += daysRequested, pendingDays -= daysRequested
  5xx / timeout   → status = PENDING_HCM_CONFIRMATION, schedule retry

On batch sync for (employeeId, locationId):
  1. Validate syncTimestamp > lastHcmSyncAt → skip if stale
  2. SET availableDays = incoming value
  3. COMMIT
  4. For each PENDING request where createdAt <= syncTimestamp:
     a. If availableDays < daysRequested → CANCEL (oldest first), restore balance
  5. Write SyncLog

On startup:
  For each PENDING_HCM_CONFIRMATION request:
    If retryCount >= 5 → REJECT immediately, restore balance
    Else → re-enqueue with backoff from updatedAt
```

### 8.3 Clock Skew Consideration

`syncTimestamp` comparisons depend on clock alignment between ReadyOn and the HCM. Per assumption A-05, clocks are synchronised within ±1 second. This is acceptable for the use case (batch syncs typically reflect state from minutes or hours ago). If clock skew exceeds this assumption, `syncTimestamp` comparisons may produce incorrect results. This is a known limitation (see L-04).

### 8.4 Request Lifecycle Sequence

```
Employee            ReadyOn                   Database        HCM
   |                    |                        |              |
   |-- POST /requests ->|                        |              |
   |  [Idempotency-Key] |                        |              |
   |                    |-- check idempotency -->|              |
   |                    |-- validate balance --->|              |
   |                    |-- BEGIN txn ---------->|              |
   |                    |-- deductPending ------>|              |
   |                    |-- INSERT request ------->|            |
   |                    |-- INSERT idempotency --->|            |
   |                    |-- COMMIT ------------->|              |
   |                    |                        |              |
   |                    |-- POST /hcm/requests ----------------->|
   |                    |<--- { approved: true, transactionId } -|
   |                    |                        |              |
   |                    |-- UPDATE → APPROVED -->|              |
   |                    |-- reconcile ---------->|              |
   |<-- 201 APPROVED ---|                        |              |
   |                    |                        |              |
```

---

## 9. Quality Attributes (IEEE 29148 Aligned)

This section specifies non-functional requirements using measurable acceptance criteria. All NFRs are tagged with the IEEE 29148 quality category they address.

### 9.1 Performance

| ID | Requirement | Acceptance Criterion | Category |
|---|---|---|---|
| NFR-01 | `GET /balances/:employeeId/:locationId` response time | P95 < 50ms under normal load. Primary data source for ReadyOn's scheduling engine — latency directly impacts shift-matching throughput. | Performance |
| NFR-02 | `POST /requests` end-to-end response time (including HCM round-trip) | P95 < 500ms, assuming HCM P95 < 300ms (A-08) | Performance |
| NFR-03 | `PATCH /requests/:id/approve` response time | P95 < 100ms | Performance |
| NFR-04 | `POST /sync/batch` with up to 1,000 records | P95 < 2,000ms | Performance |
| NFR-05 | System must not return HTTP 500 under a burst of 10 concurrent `POST /requests` for the same employee | Zero 500 errors; correct balance outcome | Performance / Resilience |

### 9.2 Reliability & Availability

| ID | Requirement | Acceptance Criterion | Category |
|---|---|---|---|
| NFR-06 | Balance invariant (`availableDays >= 0`) must hold at all times | No test scenario or concurrent load pattern produces a negative balance | Reliability |
| NFR-07 | A `PENDING_HCM_CONFIRMATION` request must not remain unresolved across a process restart | Integration test: restart service with PENDING_HCM_CONFIRMATION in DB; verify retry re-enqueued within 5 seconds of startup | Reliability |
| NFR-08 | The system must return a well-formed error response (not a stack trace) for all expected error conditions | All 4xx responses include `{ statusCode, error, message }` | Reliability |
| NFR-09 | A batch sync with a partially invalid payload must leave the database in its pre-sync state | Integration test: mixed valid/invalid batch; verify zero records changed | Reliability / Atomicity |

### 9.3 Maintainability

| ID | Requirement | Acceptance Criterion | Category |
|---|---|---|---|
| NFR-10 | The database dialect can be switched from SQLite to PostgreSQL by changing the TypeORM driver configuration without modifying application logic | No TypeORM entity, service, or controller file references SQLite-specific types or pragmas (except the config module) | Maintainability / Portability |
| NFR-11 | All configuration values (HCM URL, port, retry limits, timeouts) are read from environment variables via `@nestjs/config`; no configuration is hardcoded | Zero hardcoded URLs, ports, or timeout values in source files other than `.env.example` | Maintainability |
| NFR-12 | Code coverage must meet the following thresholds: statements 85%, branches 80%, functions 85%, lines 85% | Jest `--coverage` output meets all four thresholds | Testability |

### 9.4 Security

| ID | Requirement | Acceptance Criterion | Category |
|---|---|---|---|
| NFR-13 | Authentication is required before production deployment. This version exposes all endpoints without authentication. **This is an accepted and documented risk.** | N/A for this version | Security |
| NFR-14 | The `SyncLog` table provides an immutable audit trail of all balance-changing operations | Every balance change (submission, approval, rejection, cancellation, sync) produces a corresponding `SyncLog` entry | Security / Auditability |
| NFR-15 | The system must validate and reject any incoming data that could produce a negative balance, regardless of HCM behaviour | Integration test: HCM mock returns `approved: false` for a balance we already deducted; verify balance is correctly restored, never negative | Data Integrity |
| NFR-16 | Input validation must reject requests with unexpected fields (`forbidNonWhitelisted: true`) and strip extra properties (`whitelist: true`) | E2E test: submit with extra field `isAdmin: true`; verify field is absent from stored record | Security / Input Validation |

### 9.5 Scalability

| ID | Requirement | Acceptance Criterion | Category |
|---|---|---|---|
| NFR-17 | SQLite WAL mode and `busy_timeout=5000ms` must be configured to handle concurrent reads during write operations | Integration test: 10 concurrent reads during a write do not fail | Scalability |
| NFR-18 | The service must document the horizontal scaling migration path | Section 9.5.1 below | Scalability |
| NFR-19 | A single SQLite instance must support at least 50 concurrent read connections without returning errors | Load test: 50 concurrent GET requests complete without error | Scalability |

#### 9.5.1 Horizontal Scaling Migration Path

The current SQLite deployment supports a **single-instance, single-process** architecture. The migration path to horizontal scaling is:

1. **Replace SQLite with PostgreSQL:** Change `better-sqlite3` driver to `pg` in TypeORM config. Remove SQLite-specific pragmas. No entity or service code changes required (NFR-10 ensures this).
2. **Replace optimistic lock retries with pessimistic row locks:** Use `findOne` with `lock: { mode: 'pessimistic_write' }` inside `deductPending`. This is more appropriate under high concurrent load when retries compound.
3. **Replace in-process retry scheduler with Bull/BullMQ:** The in-memory retry for `PENDING_HCM_CONFIRMATION` requests does not survive across multiple instances. BullMQ with a shared Redis store provides distributed, persistent job scheduling.
4. **Add connection pooling:** TypeORM PostgreSQL supports connection pooling natively. Configure `max: 10` connections per instance.
5. **Deploy behind a load balancer:** Because all state is in PostgreSQL (not the process), any instance can handle any request.

**Trigger for migration:** When SQLite write throughput becomes a measurable bottleneck (observed `SQLITE_BUSY` retries > 1% of requests), or when horizontal scaling is required.

### 9.6 Interoperability

| ID | Requirement | Acceptance Criterion | Category |
|---|---|---|---|
| NFR-20 | The service must handle HCM `availableDays` values delivered as either numeric or string types without error | Unit test: `HcmService.getBalance` with `"10.5"` (string) parses to `10.5` (number) | Interoperability |
| NFR-21 | The service must emit Swagger documentation at `/api-docs` describing all endpoints, request bodies, and response shapes | Navigate to `/api-docs` when service is running; all endpoints are documented | Interoperability |
| NFR-22 | Dates in API requests and responses must use ISO 8601 format (YYYY-MM-DD for dates, full RFC 3339 for timestamps) | Unit test: submit with date format `2025/06/01`; verify 400 | Interoperability |

### 9.7 Observability

| ID | Requirement | Acceptance Criterion | Category |
|---|---|---|---|
| NFR-23 | All unhandled exceptions must be logged with context: endpoint, employeeId, locationId (where available), error message, and stack trace | Integration test: trigger 500 error; verify log output includes all required fields | Observability |
| NFR-24 | `PENDING_HCM_CONFIRMATION` requests with `updatedAt` older than 1 hour must be detectable via a database query | Integration test: query DB for stale PENDING_HCM_CONFIRMATION; verify records appear | Observability |
| NFR-25 | The mock HCM server must log every request to stdout in the format `[HCM MOCK] METHOD /path — status` | Manual verification | Observability |

---

## 10. Key Challenges & Solutions

### 10.1 Race Conditions on Balance Deduction

**Problem:** Two concurrent submissions for the same employee could simultaneously read the same `availableDays` value and both pass the balance guard, leading to a combined deduction exceeding the available balance.

**Solution:** TypeORM `@Version()` column on `LeaveBalance`. The `deductPending` method uses a single `QueryRunner` transaction: `findOne` with `lock: { mode: 'optimistic', version }` + `save` in the same transaction. On `OptimisticLockVersionMismatchError`, retry up to 3 times. On exhaustion, return HTTP 409.

**Critical implementation note:** The balance check, deduction, and request creation must all happen within one transaction. The HCM call must happen after `commitTransaction()`. Splitting the balance check and deduction across separate transactions recreates the race condition (TypeORM issue #2848: `setLock("optimistic", version)` on `.update()` silently ignores the version).

**Future upgrade:** Under high concurrency on PostgreSQL, replace optimistic retries with `pessimistic_write` lock to eliminate retry overhead.

### 10.2 HCM Defensive Balance Guard

**Problem:** The HCM may not reliably return errors for invalid requests.

**Solution:** ReadyOn applies an independent balance guard before calling the HCM. A 422 is returned locally if `availableDays < daysRequested`. The HCM is a second-layer check, not the primary enforcement mechanism.

### 10.3 Balance Drift from External HCM Writes

**Problem:** Other systems (payroll, HR tooling) modify HCM balances without informing ReadyOn.

**Solution:** The batch sync endpoint (`POST /sync/batch`) is the authoritative reconciliation mechanism. After each batch, PENDING requests are re-evaluated. The `createdAt > syncTimestamp` exemption (Section 8.2) prevents punishing requests submitted after the HCM snapshot that was the source of the batch.

### 10.4 HCM Outage Resilience

**Problem:** HCM outages at submission time should not lose the request or leave the balance in an unknown state.

**Solution:** On `ServiceUnavailableException`, save request as `PENDING_HCM_CONFIRMATION` with `retryCount = 0`. Persist `nextRetryAt`. On `onModuleInit`, scan for all such requests and re-enqueue based on `updatedAt` + exponential backoff schedule. Retry schedule: 1 min, 5 min, 15 min, 30 min, 60 min (5 attempts). If `retryCount >= 5`, immediately transition to REJECTED and restore balance.

**ReadyOn scheduling impact:** The ~111-minute maximum retry window is acceptable for traditional HR contexts but is elevated risk for a shift-scheduling platform. During PENDING_HCM_CONFIRMATION, the local balance is correctly deducted — the scheduling engine will not offer conflicting shifts. The problem arises on retry exhaustion: the request is rejected, the balance is restored, and the availability window re-opens. By this point the scheduling engine may have already acted on the assumed unavailability (e.g. dispatched backfill notifications). This creates a coordination gap between the Time-Off Microservice and the scheduling engine that is **out of scope for this version** but should be addressed via a domain event (e.g. `TimeOffCancelled` event) when the service is integrated into ReadyOn's broader event architecture.

### 10.5 Idempotent Batch Processing

**Problem:** HCM may deliver the same batch payload multiple times (at-least-once delivery).

**Solution:** Per-record `syncTimestamp` comparison against stored `lastHcmSyncAt`. Stale records are silently skipped. The entire batch runs in one transaction, making partial re-delivery safe.

### 10.6 Decimal Precision Accumulation

**Problem:** SAP SuccessFactors uses fractional balances to 10 decimal places. IEEE 754 float arithmetic accumulates error over repeated deductions.

**Solution:** Store `availableDays` and `pendingDays` as `DECIMAL(10, 4)`. All arithmetic rounds to 4 d.p. before writing. Incoming HCM values are truncated (not rounded up) at 4 d.p.

### 10.7 Partial Batch Atomicity

**Problem:** A mid-batch failure (e.g. record 300 of 500 has invalid data) could leave the DB partially updated.

**Solution:** Validate all records before opening the transaction. Wrap all upserts in a single `QueryRunner` transaction. Any failure rolls back the entire batch.

---

## 11. Alternatives Considered

### 11.1 Event-Driven Sync (HCM Webhooks)

**What:** Subscribe to per-balance-change HCM events for near-real-time consistency.  
**Why not:** Workday and SAP do not provide balance-change webhooks at the required granularity. The batch endpoint is the practical integration surface. If a future HCM integration supports streaming, `SyncService` can consume events without changing reconciliation logic.

### 11.2 HCM as Only System of Record

**What:** All reads go directly to the HCM real-time API; no local shadow.  
**Why not:** Couples ReadyOn's availability to HCM uptime. Adds HCM round-trip latency to every page load. Cannot display balance while a request is in-flight. Rejected in favour of local shadow with eventual consistency.

### 11.3 Saga / Distributed Transaction Pattern

**What:** Model the submit-request flow as a formal saga with compensating transactions at each step.  
**Why deferred:** For a single microservice with one external system, a saga adds orchestration overhead without meaningful benefit. The `PENDING_HCM_CONFIRMATION` + retry mechanism covers the primary failure case. The hook points for a future saga are clear: if the service is decomposed (e.g. separate notification service, separate approval workflow), a saga orchestrator should be introduced at that boundary. The `SyncLog` table already provides the audit trail that a saga would rely on.

### 11.4 GraphQL Instead of REST

**What:** A GraphQL API allowing flexible query composition.  
**Why deferred:** The batch sync endpoint is called by customer IT teams configuring HCM integrations. They need a stable, well-known REST URL. REST is simpler and more widely understood for webhook-style endpoints. GraphQL can be layered on top later as a client convenience API without modifying the service core.

### 11.5 Pessimistic Locking as Default

**What:** Use `SELECT ... FOR UPDATE` on `LeaveBalance` during deduction, holding a row lock.  
**Why not chosen as default:** SQLite does not support `FOR UPDATE`. In the current deployment, optimistic locking + retry is equivalent in safety because SQLite serialises all writes anyway. Documented as the recommended upgrade for PostgreSQL migration (Section 9.5.1).

### 11.6 In-Memory Balance Cache

**What:** Cache `LeaveBalance` in application memory (e.g. Redis) to serve GET requests without DB reads.  
**Why not:** Adds infrastructure complexity (Redis dependency) and a cache invalidation problem. For this scale, SQLite reads (especially in WAL mode with many concurrent readers) are fast enough to meet the < 50ms P95 target without a cache. Cache invalidation after a batch sync would require careful coordination.

---

## 12. Edge Cases & Risk Register

| ID | Title | Risk | Status |
|---|---|---|---|
| EC-01 | Duplicate request submission | High | Mitigated (Idempotency-Key) |
| EC-02 | SQLite writer bottleneck | Medium | Mitigated (WAL + busy_timeout) |
| EC-03 | Optimistic lock across transaction boundary | High | Mitigated (single-txn deductPending) |
| EC-04 | PENDING_HCM_CONFIRMATION orphan on crash | High | Mitigated (persistent retry fields + onModuleInit scan) |
| EC-05 | Batch sync cancelling post-sync requests | Medium | Mitigated (createdAt > syncTimestamp exemption) |
| EC-06 | Decimal precision drift | Medium | Mitigated (DECIMAL(10,4) + rounding) |
| EC-07 | Partial batch sync inconsistency | Medium | Mitigated (single transaction + pre-validation) |
| EC-08 | First submission for unknown employee | Low–Medium | Mitigated (BALANCE_NOT_FOUND error code + auto-bootstrap option) |
| EC-09 | Concurrent approve and cancel race | Low | Mitigated (SQLite write serialisation; pessimistic lock on PostgreSQL) |
| EC-10 | HCM response field format variation | Low–Medium | Mitigated (Number() parsing + isFinite guard) |
| EC-11 | Clock skew affecting batch timestamp comparison | Low | Accepted (A-05 assumption; documented as L-04) |
| EC-12 | HCM rate limiting on refreshOne bursts | Low | Noted (no mitigation in this version) |

### EC-11 — Clock Skew

**Risk:** Low  
**Failure mode:** If the HCM's `syncTimestamp` is derived from a clock that drifts more than ±1 second from the ReadyOn host, the `createdAt > syncTimestamp` exemption in auto-cancel logic may classify requests incorrectly.  
**Mitigation:** Assumption A-05 constrains clock skew. Documented as known limitation L-04. No code mitigation in this version.

### EC-12 — HCM Rate Limiting

**Risk:** Low  
**Failure mode:** The `POST /sync/refresh` endpoint makes one HCM API call per invocation. If called rapidly (e.g. 1,000 employees being bootstrapped via script), the HCM may rate-limit the requests and return 429.  
**Mitigation:** Not addressed in this version. `HcmService` should be extended to handle 429 by respecting the `Retry-After` header if present. For bulk bootstrap, the `POST /sync/batch` endpoint (HCM-initiated) is the correct mechanism.

---

## 13. Use Case Specifications

### UC-01 — Submit Time-Off Request (Standard Path)

| Field | Value |
|---|---|
| **Actor** | Flex Worker |
| **Goal** | Block an availability window so the scheduling engine stops offering shifts during that period |
| **Preconditions** | `LeaveBalance` exists for (employeeId, locationId); `availableDays >= daysRequested`; HCM is reachable |
| **Postconditions** | `TimeOffRequest` created with status APPROVED; `availableDays` reduced by `daysRequested`; scheduling engine immediately reflects the worker as unavailable for the blocked window |

**Main Flow:**
1. Employee sends `POST /requests` with valid body and optional `Idempotency-Key`.
2. System validates body (fields, date ordering, `daysRequested > 0`).
3. System checks `availableDays >= daysRequested` against local shadow.
4. System opens a database transaction: deducts `daysRequested` from `availableDays`, adds to `pendingDays`, creates request with status PENDING, stores idempotency key.
5. System commits the transaction.
6. System calls `POST /hcm/requests`.
7. HCM returns `{ approved: true, transactionId }`.
8. System updates request to APPROVED, reduces `pendingDays` by `daysRequested`, stores `hcmTransactionId`.
9. System returns HTTP 201 with APPROVED request.

**Alternate Flows:**
- **3a:** `availableDays < daysRequested` → return HTTP 422. No DB changes.
- **6a:** HCM returns 503 or times out → save request as PENDING_HCM_CONFIRMATION; return HTTP 201.
- **6b:** HCM returns 422 (insufficient balance on HCM side) → save as REJECTED; restore balance; return HTTP 201 (or 422 — see Note).
- **1a:** Same `Idempotency-Key` as a previous successful request → return original 201 response; no new record.

> **Note on 6b:** Even though the local balance was sufficient, the HCM may disagree (drift). In this case the request is immediately REJECTED and the local balance is restored. The response should be HTTP 201 with `status: "REJECTED"` to communicate the outcome clearly.

---

### UC-02 — Manager Approves Request

| Field | Value |
|---|---|
| **Actor** | Manager |
| **Preconditions** | Request exists with status PENDING |
| **Postconditions** | Status = APPROVED; `pendingDays` reduced by `daysRequested` |

**Main Flow:**
1. Manager sends `PATCH /requests/:id/approve`.
2. System loads request; verifies status = PENDING.
3. System transitions status to APPROVED.
4. System calls `reconcile('CONFIRMED')`: reduces `pendingDays` by `daysRequested`.
5. System creates SyncLog entry.
6. Returns HTTP 200 with updated request.

**Alternate Flow:** Request status ≠ PENDING → HTTP 409. Balance unchanged.

---

### UC-03 — Manager Rejects Request

Identical to UC-02 except: status → REJECTED, `reconcile('REJECTED')` restores `availableDays` and reduces `pendingDays`.

---

### UC-04 — Employee Cancels Request

| Field | Value |
|---|---|
| **Actor** | Employee |
| **Preconditions** | Request exists with status PENDING |
| **Postconditions** | Status = CANCELLED; balance restored |

Same structure as UC-02 using `/cancel` endpoint. Request must be in PENDING status (not APPROVED — employees cannot cancel approved requests).

---

### UC-05 — View Current Leave Balance

| Field | Value |
|---|---|
| **Actor** | Employee or Manager |
| **Preconditions** | LeaveBalance record exists |
| **Postconditions** | No state change |

1. Send `GET /balances/:employeeId/:locationId`.
2. System returns local shadow balance (availableDays, pendingDays, lastHcmSyncAt).

**Note:** The returned `availableDays` reflects the net-of-pending value. If an employee has 10 days available and 3 days pending, `availableDays = 7` and `pendingDays = 3`.

---

### UC-06 — HCM Pushes Batch Balance Sync

| Field | Value |
|---|---|
| **Actor** | HCM System |
| **Preconditions** | HCM has a corpus of updated balances to push |
| **Postconditions** | Local shadows updated; stale PENDING requests auto-cancelled where applicable |

**Main Flow:**
1. HCM sends `POST /sync/batch` with N records.
2. System validates all records: all `availableDays >= 0`, all required fields present.
3. System opens a single database transaction.
4. For each record: compare `syncTimestamp` to `lastHcmSyncAt`. If stale, skip and count in `skipped`. If fresh, upsert.
5. Commit transaction.
6. For each updated `(employeeId, locationId)`: load all PENDING requests where `createdAt <= syncTimestamp`. Cancel oldest-first until `availableDays >= remaining pendingDays`.
7. Write SyncLog entry.
8. Return HTTP 200 `{ updated, autoCancelled, skipped }`.

**Alternate Flow:** Any record with `availableDays < 0` → reject entire batch with HTTP 400 before opening transaction.

---

### UC-07 — HR Admin Refreshes a Single Balance

1. Admin calls `POST /sync/refresh/emp001/loc001`.
2. System calls `GET /hcm/balances/emp001/loc001`.
3. HCM returns current balance.
4. System upserts local record, sets `lastHcmSyncAt`.
5. System writes SyncLog (type = REAL_TIME).
6. Returns HTTP 200 with updated balance.

---

### UC-08 — System Retry on Startup (PENDING_HCM_CONFIRMATION Recovery)

| Field | Value |
|---|---|
| **Actor** | Platform (system) |
| **Trigger** | Service starts / restarts |
| **Preconditions** | One or more requests in DB with status PENDING_HCM_CONFIRMATION |

1. `onModuleInit` runs in `SyncService` (or `RequestService`).
2. Query DB for all requests with status PENDING_HCM_CONFIRMATION.
3. For each: if `retryCount >= 5`, immediately transition to REJECTED and restore balance.
4. For each with `retryCount < 5`: compute `delay = backoffSchedule[retryCount] - elapsed(updatedAt)`. If `delay <= 0`, retry immediately. Else schedule retry after `delay`.
5. Write SyncLog for each immediate REJECTED transition.

---

### UC-09 — Idempotent Retry (Client Network Failure)

| Field | Value |
|---|---|
| **Actor** | Employee (client timeout/retry) |
| **Preconditions** | First POST /requests succeeded and created a request; client did not receive response due to network failure |

1. Client resends `POST /requests` with the same `Idempotency-Key`.
2. System finds the stored idempotency record.
3. System returns the original HTTP 201 response without creating a new request or modifying the balance.

---

### UC-10 — Submit Request When HCM Is Unavailable

| Field | Value |
|---|---|
| **Actor** | Flex Worker |
| **Preconditions** | LeaveBalance exists; HCM is down |

1. Worker sends `POST /requests`.
2. System validates body and checks local balance (passes).
3. System commits: deducts balance, creates request with PENDING status.
4. System calls HCM; receives 503 or timeout.
5. System updates request to PENDING_HCM_CONFIRMATION, sets `retryCount = 0`, `nextRetryAt = now + 1 minute`.
6. Returns HTTP 201 with status PENDING_HCM_CONFIRMATION.
7. Background job retries at `nextRetryAt`. If HCM is back, transitions to APPROVED or REJECTED. Otherwise increments retryCount and reschedules.

> **ReadyOn scheduling note:** While in PENDING_HCM_CONFIRMATION, the local balance is correctly deducted so the scheduling engine will not offer conflicting shifts. The risk is retry exhaustion: if all 5 retries fail, the request is REJECTED, the balance is restored, and the worker's availability window re-opens — potentially after backfill coverage has already been dispatched.

---

### UC-11 — Scheduling Engine Queries Worker Availability

| Field | Value |
|---|---|
| **Actor** | ReadyOn Scheduling Engine |
| **Goal** | Determine whether a worker has leave available before offering a shift slot |
| **Preconditions** | LeaveBalance record exists for the worker at the relevant location |
| **Postconditions** | No state change; read-only |

1. Scheduling engine calls `GET /balances/:employeeId/:locationId`.
2. System returns `{ availableDays, pendingDays, lastHcmSyncAt }`.
3. Scheduling engine uses `availableDays` to decide whether to offer this worker a shift that would consume leave.
4. If `lastHcmSyncAt` is older than a configurable staleness threshold (suggested: 4 hours), the scheduling engine should optionally trigger `POST /sync/refresh` before making the decision.

**Note:** This is the highest-frequency caller of `GET /balances` and is the primary driver of the P95 < 50ms performance requirement (NFR-01). It never mutates state.

---

## 14. Test Scenarios

All test scenarios below are structured as Given / When / Then for direct use by Claude Code in building the test suite.

### 14.1 Unit Tests

**T-U-01: Successful balance deduction**
- Given: LeaveBalance with availableDays = 10.0000, pendingDays = 0, version = 1
- When: `deductPending(employeeId, locationId, 3)` is called
- Then: availableDays = 7.0000, pendingDays = 3.0000, version = 2

**T-U-02: Insufficient balance rejection**
- Given: LeaveBalance with availableDays = 2.0000
- When: `deductPending(employeeId, locationId, 3)` is called
- Then: Throws `InsufficientBalanceException` (HTTP 422); no DB changes

**T-U-03: Optimistic lock retry — version conflict**
- Given: Repository mock configured to throw `OptimisticLockVersionMismatchError` on first two calls, succeed on third
- When: `deductPending` is called
- Then: Retries twice; succeeds on third attempt; no error thrown

**T-U-04: Optimistic lock retry — exhausted**
- Given: Repository mock throws `OptimisticLockVersionMismatchError` on all three attempts
- When: `deductPending` is called
- Then: Throws `ConflictException` (HTTP 409)

**T-U-05: Reconcile CONFIRMED**
- Given: LeaveBalance with availableDays = 7.0000, pendingDays = 3.0000
- When: `reconcile(employeeId, locationId, 3, 'CONFIRMED')` is called
- Then: availableDays = 7.0000, pendingDays = 0.0000 (net: deduction is final)

**T-U-06: Reconcile REJECTED**
- Given: LeaveBalance with availableDays = 7.0000, pendingDays = 3.0000
- When: `reconcile(employeeId, locationId, 3, 'REJECTED')` is called
- Then: availableDays = 10.0000, pendingDays = 0.0000 (balance restored)

**T-U-07: upsertFromHcm — new record**
- Given: No LeaveBalance exists for (emp001, loc001)
- When: `upsertFromHcm('emp001', 'loc001', 10, '2025-01-01T00:00:00Z')` is called
- Then: New record created with availableDays = 10.0000

**T-U-08: upsertFromHcm — newer timestamp updates**
- Given: LeaveBalance with lastHcmSyncAt = '2025-01-01T00:00:00Z', availableDays = 10
- When: `upsertFromHcm` called with availableDays = 15, syncTimestamp = '2025-01-02T00:00:00Z'
- Then: availableDays = 15.0000, lastHcmSyncAt updated

**T-U-09: upsertFromHcm — stale timestamp skipped**
- Given: LeaveBalance with lastHcmSyncAt = '2025-01-02T00:00:00Z', availableDays = 15
- When: `upsertFromHcm` called with availableDays = 10, syncTimestamp = '2025-01-01T00:00:00Z'
- Then: availableDays unchanged (still 15.0000)

**T-U-10: Decimal truncation**
- Given: Incoming HCM value of 7.3333333333
- When: stored via `upsertFromHcm`
- Then: stored as 7.3333 (truncated, not rounded up)

**T-U-11: Request submit — HCM approved**
- Given: HcmService mock returns `{ approved: true, transactionId: 'hcm-001' }`
- When: `submit(dto)` is called
- Then: Request status = APPROVED; hcmTransactionId = 'hcm-001'; balance reconciled

**T-U-12: Request submit — HCM rejected**
- Given: HcmService mock returns `{ approved: false }`
- When: `submit(dto)` is called
- Then: Request status = REJECTED; balance restored

**T-U-13: Request submit — HCM unavailable**
- Given: HcmService mock throws ServiceUnavailableException
- When: `submit(dto)` is called
- Then: Request status = PENDING_HCM_CONFIRMATION; balance NOT restored; retryCount = 0

**T-U-14: Cancel APPROVED request**
- Given: Request with status = APPROVED
- When: `cancel(id)` is called
- Then: Throws ConflictException (HTTP 409)

**T-U-15: Batch sync cancels eligible PENDING request**
- Given: PENDING request with createdAt = '2025-01-01T09:00:00Z', daysRequested = 5
- When: `batchSync` called with syncTimestamp = '2025-01-01T10:00:00Z', availableDays = 3
- Then: Request auto-cancelled; balance restored

**T-U-16: Batch sync exempts post-syncTimestamp request**
- Given: PENDING request with createdAt = '2025-01-01T11:00:00Z', daysRequested = 5
- When: `batchSync` called with syncTimestamp = '2025-01-01T10:00:00Z', availableDays = 3
- Then: Request NOT cancelled (createdAt > syncTimestamp)

**T-U-17: HcmService parses string balance**
- Given: HCM returns `availableDays: "10.5"` (string)
- When: `getBalance` parses the response
- Then: Returns numeric 10.5 without error

**T-U-18: HcmService rejects NaN balance**
- Given: HCM returns `availableDays: "invalid"` (non-numeric string)
- When: `getBalance` parses the response
- Then: Throws ServiceUnavailableException

---

### 14.2 Integration Tests

**T-I-01: Full PENDING → APPROVED lifecycle**
- Given: LeaveBalance seeded with availableDays = 10, HcmService mocked to return approved
- When: POST /requests for 3 days
- Then: availableDays = 7.0000, pendingDays = 0.0000, request status = APPROVED

**T-I-02: Full PENDING → REJECTED lifecycle**
- Given: LeaveBalance = 10, HcmService returns rejected
- When: POST /requests for 3 days
- Then: availableDays = 10.0000, pendingDays = 0.0000, request status = REJECTED

**T-I-03: Concurrent submissions — only valid ones succeed**
- Given: LeaveBalance = 10
- When: 3 concurrent POST /requests for 8 days each
- Then: Exactly one returns 201 (APPROVED or PENDING_HCM_CONFIRMATION); the other two return 422; balance never goes below 0

**T-I-04: Idempotent replay**
- Given: LeaveBalance = 10
- When: POST /requests with Idempotency-Key='key-001'; then again with same key
- Then: Second call returns same 201 body; DB has one request; balance deducted once

**T-I-05: Batch sync atomicity — invalid record**
- Given: LeaveBalance seeded for emp001/loc001 and emp002/loc001
- When: POST /sync/batch with valid record for emp001 and invalid (availableDays = -1) for emp002
- Then: HTTP 400; both balances unchanged

**T-I-06: Batch sync auto-cancel**
- Given: LeaveBalance = 5; PENDING request for 4 days created at T1
- When: POST /sync/batch at T2 > T1 with availableDays = 2
- Then: PENDING request cancelled; balance restored to 2; SyncLog entry with autoCancelled = 1

**T-I-07: Batch sync does not cancel post-timestamp request**
- Given: LeaveBalance = 5; PENDING request for 4 days created at T2
- When: POST /sync/batch with syncTimestamp = T1 < T2, availableDays = 2
- Then: PENDING request NOT cancelled; balance = 2 with 4 pendingDays (deficit state, accepted until next sync)

**T-I-08: PENDING_HCM_CONFIRMATION recovery on startup**
- Given: DB has a request with status PENDING_HCM_CONFIRMATION, retryCount = 0
- When: `onModuleInit` runs; HcmService returns approved on retry
- Then: Request transitions to APPROVED; balance reconciled

**T-I-09: retryCount exhaustion on startup**
- Given: DB has a request with status PENDING_HCM_CONFIRMATION, retryCount = 5
- When: `onModuleInit` runs
- Then: Request immediately transitions to REJECTED; balance restored; SyncLog entry created

**T-I-10: SyncLog written on batch failure**
- Given: HcmService configured to return 503
- When: POST /sync/refresh called
- Then: SyncLog entry created with status = ERROR, errorDetails non-null

**T-I-11: Manager approve + employee cancel concurrent race**
- Given: PENDING request
- When: PATCH /approve and PATCH /cancel fired simultaneously
- Then: One returns 200; one returns 409; balance is correct for whichever transition won

---

### 14.3 E2E Tests

**T-E-01: Happy path — GET balance**
- Start service + mock HCM; seed emp001/loc001 balance = 15
- GET /balances/emp001/loc001 → 200, availableDays = 15

**T-E-02: 404 for unknown balance**
- GET /balances/unknown/loc999 → 404

**T-E-03: Happy path — submit request**
- POST /requests body { emp001, loc001, 3 days } → 201 with request id
- GET /requests/:id → 200

**T-E-04: Invalid body — missing field**
- POST /requests without `locationId` → 400

**T-E-05: Invalid body — startDate after endDate**
- POST /requests with startDate = 2025-06-10, endDate = 2025-06-05 → 400

**T-E-06: 422 on insufficient balance**
- POST /requests with daysRequested > availableDays → 422

**T-E-07: Full approval workflow**
- POST /requests → GET (PENDING or APPROVED) → PATCH /approve → GET (APPROVED)

**T-E-08: Approve already-approved**
- Approve a request; PATCH /approve again → 409

**T-E-09: Cancel PENDING request, balance restored**
- POST /requests (3 days) → PATCH /cancel → GET /balances → verify availableDays = original

**T-E-10: Batch sync updates balance**
- POST /sync/batch with emp001/loc001 availableDays = 20, syncTimestamp = now → 200; GET /balances → availableDays = 20

**T-E-11: Batch with invalid record rejected**
- POST /sync/batch with one record having availableDays = -1 → 400

**T-E-12: refreshOne creates new balance**
- Mock HCM seeded with emp099/loc099 = 12; POST /sync/refresh/emp099/loc099 → 200; GET /balances/emp099/loc099 → availableDays = 12

**T-E-13: HCM outage → PENDING_HCM_CONFIRMATION**
- Set mock MOCK_FAILURE_RATE = 1 via admin endpoint
- POST /requests → 201, status = PENDING_HCM_CONFIRMATION
- Reset MOCK_FAILURE_RATE = 0

**T-E-14: Batch sync auto-cancels underfunded PENDING**
- Submit PENDING request for 8 days (availableDays = 10)
- POST /sync/batch with availableDays = 3 (syncTimestamp before request)
- GET /requests/:id → status = CANCELLED

**T-E-15: BALANCE_NOT_FOUND error code**
- POST /requests for unknown employee → 404; response.error = 'BALANCE_NOT_FOUND'

**T-E-16: Extra field stripped (input validation)**
- POST /requests with extra field `isAdmin: true` → 201 (if otherwise valid); stored request has no `isAdmin` field

**T-E-17: Swagger documentation accessible**
- GET /api-docs → 200 (HTML) or GET /api-docs-json → 200 (OpenAPI JSON)

**T-E-18: Scheduling engine availability query (simulated)**
- Given: emp001/loc001 balance seeded at 15 days; POST /requests for 3 days submitted and resolved
- When: GET /balances/emp001/loc001 (simulating a scheduling engine poll)
- Then: 200; availableDays = 12 (deduction reflected); lastHcmSyncAt present; response time < 50ms

---

## 15. Acceptance Criteria

These criteria define the minimum bar for the implementation to be considered complete. Each maps directly to functional requirements and test scenarios.

| # | Criterion | Verified By |
|---|---|---|
| AC-01 | All 10 happy-path E2E tests (T-E-01 through T-E-10) pass with zero failures | E2E test suite |
| AC-02 | The balance invariant (`availableDays >= 0`) is never violated under any test scenario, including 10 concurrent submissions | T-I-03, T-U-03, T-U-04 |
| AC-03 | A process restart with PENDING_HCM_CONFIRMATION requests in the DB results in all requests being retried or rejected within 5 seconds of startup | T-I-08, T-I-09 |
| AC-04 | A batch sync payload containing any invalid record produces zero DB writes and returns HTTP 400 | T-I-05, T-E-11 |
| AC-05 | A PENDING request created after a batch's `syncTimestamp` is not auto-cancelled when the batch reduces the balance | T-I-07, T-U-16 |
| AC-06 | Duplicate submissions with the same Idempotency-Key produce exactly one DB record and one balance deduction | T-I-04 |
| AC-07 | All invalid input combinations (missing fields, bad dates, non-positive daysRequested) return HTTP 400 with a descriptive message | T-E-04, T-E-05; FR-07, FR-08 |
| AC-08 | Code coverage meets thresholds: statements 85%, branches 80%, functions 85%, lines 85% | `npm run test:coverage` output |
| AC-09 | Swagger documentation is accessible at `/api-docs` and documents all endpoints | T-E-17 |
| AC-10 | SyncLog is written for every sync event, with `errorDetails` populated on failures | T-I-10, FR-31, FR-32 |

---

## 16. Out of Scope

The following are explicitly not part of this version and should not be implemented:

- **Authentication & authorisation** — JWT middleware, role-based access control, token validation. Required before production (NFR-13 documents the risk).
- **Multi-tenancy** — all data is treated as belonging to a single organisational tenant.
- **Leave type categorisation** — vacation, sick leave, personal days, parental leave are not differentiated. All requests use a single undifferentiated "time off" concept.
- **Calendar & holiday integration** — `daysRequested` is caller-provided. Business day calculation, public holidays, and working hour schedules are the client's responsibility.
- **Employee notifications** — no email, push, or in-app notifications on any state change.
- **Employee data ownership** — `employeeId` and `locationId` are opaque strings. ReadyOn stores no employee profile data.
- **Data archival / retention** — records accumulate indefinitely (L-06 documents the impact).
- **Rate limiting** — no per-client or per-employee rate limits on the API.
- **List / pagination endpoints** — no `GET /requests` or `GET /balances` list endpoints.
- **Frontend / UI** — this is a pure backend microservice.
- **Bulk request submission** — a single POST creates a single request.

---

## 17. IEEE 29148 Compliance Analysis

This section analyses the TRD against the nine individual requirement characteristics defined in ISO/IEC/IEEE 29148:2018.

### 17.1 Individual Requirement Characteristics

| Characteristic | Definition | Compliance in This TRD | Gap / Mitigation |
|---|---|---|---|
| **Necessary** (C1) | The requirement is essential; removing it would leave a deficiency | Functional requirements checked: all FR-XX entries represent observable, needed behaviour. Optional features (auto-bootstrap config) are marked optional, not required. | Some NFRs (e.g. NFR-25 mock server logging) could be considered non-essential. Retained as they support testability. |
| **Appropriate** (C2) | The requirement is appropriate to the level of abstraction; avoids over-specifying implementation | FR section specifies *what*, not *how*. Implementation choices (TypeORM, QueryRunner, @Version) are documented in Section 10 (solutions) not Section 6 (requirements). | Residual coupling: FR-05 references "single database transaction" which is slightly implementation-specific. Retained because the atomicity guarantee is the requirement. |
| **Unambiguous** (C3) | Interpretable in only one way; stated simply | FR-XX requirements use "shall" language with measurable outcomes. All previously ambiguous phrases ("graceful", "accurate", "eventual consistency") are either defined in the Glossary or replaced with measurable criteria. | Glossary (Section 3) resolves all domain-specific terms. |
| **Complete** (C4) | Sufficient without needing additional information | Each FR includes a verification method. Each NFR includes an acceptance criterion. Edge cases are formally registered with test coverage requirements. | Section 2.3 explicitly documents known limitations to prevent readers from inferring completeness where there isn't any. |
| **Singular** (C5) | States one capability / constraint | FR-XX entries revised to be single-sentence requirements. Previous compound bullets split. | Reviewed: no FR combines two requirements with "and" in a way that creates two distinct verifiable obligations. |
| **Feasible** (C6) | Achievable within system constraints | All requirements verified against the NestJS/SQLite/TypeORM stack. Performance targets (NFR-01 through NFR-04) grounded in assumption A-08 (HCM P95). Scaling limitations documented (L-01, L-02). | NFR-02 (500ms P95) is contingent on A-08. If the HCM exceeds 300ms P95, this target is infeasible. Documented dependency. |
| **Verifiable** (C7) | The requirement's realisation can be demonstrated | Every FR and NFR includes a verification method or acceptance criterion. The test scenarios in Section 14 provide Given/When/Then for each. | Coverage thresholds (NFR-12) provide the quantitative bar. |
| **Correct** (C8) | Accurately represents the stakeholder need | Requirements trace to stakeholders (Section 4.1) and use cases (Section 13). Domain model invariants trace to business rules. | Traceability is semantic (described in UC and FR). A formal traceability matrix is out of scope for this exercise. |
| **Conforming** (C9) | Conforms to an approved style | FR entries use active "shall" language per IEEE 29148 conventions. NFRs include measurable criteria. All requirements have IDs. | Consistent style applied across Section 6 and Section 9. |

### 17.2 Requirements Set Characteristics

| Characteristic | Status |
|---|---|
| **Complete (set)** | Section 16 explicitly enumerates out-of-scope items, bounding the requirement set. No TBD/TBR items remain in core requirements. |
| **Consistent** | No requirements conflict with each other. The optimistic lock and pessimistic lock alternatives (Sections 10.1, 11.5) are documented as choices, not conflicts. |
| **Bounded** | The domain model (Section 5) and out-of-scope section (Section 16) bound the system. |
| **Traceable** | FR-XX IDs are referenced in API contracts (Section 7) and test scenarios (Section 14). Use cases trace to requirements. |
| **Feasible (set)** | The full requirement set is achievable with NestJS + SQLite within the described constraints. Scaling limitations are documented. |

### 17.3 Gaps Identified and Resolved in This Version

| Gap (v1.1) | Category | Resolution in v2.0 |
|---|---|---|
| No requirement IDs | Traceability | FR-XX, NFR-XX identifiers added throughout |
| Vague NFRs ("graceful", "accurate") | Unambiguous / Verifiable | Replaced with measurable criteria |
| No use cases | Complete | Section 13 added (10 formal use cases) |
| No test scenarios | Verifiable | Section 14 added (17 unit, 11 integration, 17 E2E) |
| No acceptance criteria | Verifiable | Section 15 added (10 ACs) |
| No glossary | Unambiguous | Section 3 added (14 terms defined) |
| No constraints section | Complete / Bounded | Section 2.2 added |
| No assumptions section | Feasible | Section 2.1 added |
| No limitations section | Correct | Section 2.3 added |
| Scaling almost unaddressed | Complete | NFR-17 through NFR-19; Section 9.5.1 (migration path) |
| No security NFRs beyond auth stub | Complete | NFR-13 through NFR-16 added |
| No interoperability NFRs | Complete | NFR-20 through NFR-22 added |
| No observability NFRs | Complete | NFR-23 through NFR-25 added |
| Alternative 11.6 (cache) not considered | Complete | Added as Section 11.6 |
| HCM interface contract undefined | Complete | Section 7.2 added |
| Clock skew not addressed | Complete | EC-11 added; A-05 assumption documented |
| Rate limiting not addressed | Complete | EC-12 added; L-06 limitation documented |
| Data retention not addressed | Complete | L-06 documented; out of scope declared |
