# Technical Requirements Document (TRD)
# Time-Off Microservice

**Author:** Muhammad Usman  
**Version:** 1.0  
**Date:** April 2026  
**Status:** Approved for Implementation

---

## 1. Problem Statement

ReadyOn acts as the primary interface for employees to request time off, while an external HCM system (e.g., Workday, SAP SuccessFactors) remains the **source of truth** for leave balances.

### Core Challenge: The Dual-Write Problem

When an employee has 10 days of leave and requests 2 days on ReadyOn, we must:
1. Confirm the HCM agrees the balance exists
2. Handle cases where HCM updates balances independently (work anniversaries, yearly refresh)
3. Prevent overbooking under concurrent submissions
4. Remain available even when HCM is temporarily unreachable

### Key Constraints

| Constraint | Detail |
|---|---|
| HCM is Source of Truth | Local data is a cached, optimised view |
| Multiple HCM writers | Anniversary jobs, policy engines, and ReadyOn all write to HCM |
| HCM provides real-time API | Per-employee, per-location balance fetch |
| HCM provides batch endpoint | Full corpus of all balances |
| HCM may push webhooks | Balance change events (bonus, refresh) |
| HCM error handling | HCM _should_ return errors for invalid submissions but this is **not guaranteed** |

---

## 2. Goals & Non-Goals

### ✅ Goals
- Full lifecycle management of time-off requests (submit → approve/reject → cancel)
- Balance integrity under concurrent submissions (no overbooking)
- Eventual consistency with HCM via three-layer sync strategy
- Instant user feedback (don't block employee UI on HCM latency)
- Resilience to HCM downtime and network failures
- Idempotent API — safe to retry without side effects
- Auditable — every sync and state transition logged

### ❌ Non-Goals
- Payroll integration or accrual policy calculation
- Multi-region distributed deployment
- Real-time HCM push (ReadyOn → HCM) is async by design
- Complex leave policy rules (carried forward, leave encashment)

---

## 3. Key Design Principles

1. **HCM always wins** — on any conflict, the HCM value overrides local state
2. **Defensive local validation** — check locally _before_ calling HCM to protect against HCM error-handling gaps
3. **Reserve, don't deduct** — hold days on submission; finalise on HCM confirmation
4. **Every operation is idempotent** — safe retries with client-supplied idempotency keys
5. **Design for eventual consistency** — not strong consistency; favour availability
6. **Fail gracefully** — HCM downtime keeps requests PENDING; reconciliation corrects later

---

## 4. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Client (ReadyOn UI)                       │
└───────────────────────────┬─────────────────────────────────┘
                            │ REST / JWT
┌───────────────────────────▼─────────────────────────────────┐
│              Time-Off Microservice (NestJS)                  │
│                                                             │
│  ┌──────────────┐  ┌───────────────────┐  ┌─────────────┐  │
│  │  Balances    │  │  TimeOffRequests  │  │  Webhooks   │  │
│  │  Module      │  │  Module           │  │  Module     │  │
│  └──────┬───────┘  └────────┬──────────┘  └──────┬──────┘  │
│         │                   │                     │         │
│  ┌──────▼───────────────────▼─────────────────────▼──────┐  │
│  │              SQLite (Local Cache)                      │  │
│  │  balances | time_off_requests | sync_logs             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           HCM Sync Module (Scheduled)                │  │
│  │      Reconciliation every 15 min via batch API       │  │
│  └────────────────────────┬─────────────────────────────┘  │
└───────────────────────────┼─────────────────────────────────┘
                            │ HTTP (REST)
┌───────────────────────────▼─────────────────────────────────┐
│                 HCM System (Workday / SAP)                   │
│   GET /balances  │  POST /time-off  │  POST /batch           │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Domain Model

### 5.1 Entities

#### Balance
The local cached view of an employee's leave entitlement.

```
Balance {
  employeeId    : string   // FK → Employee.id
  locationId    : string   // HCM location dimension
  leaveTypeId   : string   // HCM leave type dimension (VACATION, SICK, etc.)
  totalDays     : number   // Entitlement from HCM
  usedDays      : number   // Confirmed consumed days
  reservedDays  : number   // Held for PENDING requests (KEY FIELD)
  version       : number   // Optimistic lock counter
  lastSyncedAt  : Date     // Last successful HCM sync
}
```

**Critical formula:**
```
availableDays = totalDays - usedDays - reservedDays
```

#### TimeOffRequest
The full lifecycle of a leave request.

```
TimeOffRequest {
  id             : UUID
  employeeId     : string
  locationId     : string
  leaveTypeId    : string
  startDate      : date
  endDate        : date
  days           : number         // Business days requested
  status         : RequestStatus  // See state machine below
  idempotencyKey : string         // Client-supplied, unique
  hcmRefId       : string?        // Reference ID from HCM on approval
  rejectionReason: string?
  managerNotes   : string?
  reviewedBy     : string?
  reviewedAt     : Date?
}
```

#### Status State Machine

```
                ┌─────────────────────────────┐
                │          PENDING             │◄──── Initial state
                └──┬──────────────┬───────────┘
                   │              │
          HCM OK   │              │  HCM Error / Insufficient
                   ▼              ▼
              APPROVED        REJECTED
                   │
                   │  (Manager or Batch Sync detects conflict)
                   ▼
           NEEDS_REVALIDATION
                   │
          Manager  │  reject
                   ▼
               REJECTED

PENDING ──────────────────────────────► CANCELLED   (employee cancels)
```

**State machine rules:**
- Only `PENDING` requests can be cancelled by the employee
- Only `PENDING` and `NEEDS_REVALIDATION` requests can be manager-rejected
- `APPROVED` requests cannot be cancelled (requires a new reversal flow — future scope)
- `NEEDS_REVALIDATION` is set by batch sync when HCM balance drops below local reserved

---

## 6. Reservation-Based Balance System

### Why Reservation?

Without reservation, two concurrent requests for 8 days each against a 10-day balance could both pass local validation before either calls HCM — causing overbooking.

### How It Works

```
Step 1: Employee submits request for N days
  → Local check: if availableDays < N → reject immediately (ConflictException)
  → reservedDays += N  (atomic, with optimistic lock retry)
  → Request status = PENDING

Step 2: Async HCM call
  → HCM APPROVED:
      reservedDays -= N
      usedDays     += N
      status = APPROVED

  → HCM REJECTED / Error:
      reservedDays -= N   (released)
      status = REJECTED

Step 3: Cancel (while PENDING)
  → reservedDays -= N   (released)
  → status = CANCELLED
```

### Optimistic Locking

The `Balance` entity carries a `version` column. On every write, TypeORM increments it. Concurrent writers race on `WHERE version = X` — the loser retries up to 3 times with exponential backoff (50ms, 100ms, 150ms).

This approach is preferred over pessimistic locking because:
- SQLite has limited concurrent write support
- Optimistic locking scales better in read-heavy workloads
- Retries are fast (< 1ms typical round-trip on SQLite)

---

## 7. API Design

### Base URL
```
/api/v1
```

### Authentication
All endpoints (except webhooks and health) require `Authorization: Bearer <JWT>`.

JWT payload:
```json
{
  "sub": "employee-uuid",
  "email": "alice@company.com",
  "role": "employee | manager | system",
  "hcmEmployeeId": "emp-001",
  "locationId": "loc-nyc"
}
```

### Endpoints

#### Balances

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/balances/:employeeId/:locationId/:leaveTypeId` | Employee+ | Get balance (optional `?refresh=true` forces HCM pull) |
| GET | `/balances/:employeeId` | Employee+ | Get all balances for employee |
| POST | `/balances/sync/batch` | Manager/System | Ingest full HCM batch snapshot |
| POST | `/balances/sync/realtime/:employeeId/:locationId/:leaveTypeId` | Employee+ | Force real-time HCM pull |

#### Time-Off Requests

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/time-off-requests` | Employee | Submit new request |
| GET | `/time-off-requests` | Employee+ | List with filters (employeeId, status, locationId) |
| GET | `/time-off-requests/:id` | Employee+ | Get single request |
| PATCH | `/time-off-requests/:id/approve` | Manager | Approve PENDING request |
| PATCH | `/time-off-requests/:id/reject` | Manager | Reject PENDING request |
| DELETE | `/time-off-requests/:id` | Employee | Cancel own PENDING request |

#### Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/webhooks/hcm/balance-update` | HMAC Signature | HCM pushes balance changes |

#### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness probe |
| GET | `/health/ready` | Readiness probe (checks DB) |

### Request/Response Envelope
All successful responses are wrapped:
```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-04-25T10:00:00.000Z"
}
```

Errors follow:
```json
{
  "statusCode": 409,
  "timestamp": "2026-04-25T10:00:00.000Z",
  "path": "/api/v1/time-off-requests",
  "error": { "message": "Insufficient balance: 2 days available, 5 days requested" }
}
```

### Idempotency
Clients supply an `idempotencyKey` string in the request body. The server stores `(idempotencyKey → response)` — identical keys return the cached result without re-executing the operation. This makes retries safe for employees with flaky connections.

---

## 8. Three-Layer HCM Sync Strategy

### Layer 1: Real-Time (On-Demand)
- Triggered by `?refresh=true` on GET balance or explicit POST to `/sync/realtime`
- Used when an employee needs the latest balance before submitting a request
- Latency: HCM API response time (~100–500ms)

### Layer 2: Webhook Push (Primary async correction)
- HCM pushes balance changes to `POST /webhooks/hcm/balance-update`
- Triggered by: anniversary bonus, year-start refresh, manual admin adjustment
- Idempotent upsert on local balance
- HMAC-SHA256 signature verification prevents spoofing
- If webhook causes conflict (e.g., HCM reduces total below local reserved), affected PENDING requests are flagged `NEEDS_REVALIDATION`

### Layer 3: Batch Sync (Fallback / Eventual Consistency)
- Scheduled every 15 minutes via NestJS `@Cron`
- Fetches full balance corpus from HCM `POST /hcm/balances/batch`
- **HCM always wins** — overwrites `totalDays` and `usedDays` unconditionally
- Detects conflicts: `reservedDays > (new totalDays - new usedDays)`
- On conflict: marks affected PENDING requests as `NEEDS_REVALIDATION`, logs the discrepancy
- Guards against missed webhooks, network partitions, and HCM-side bulk operations

```
                 ┌──────────────────────────┐
                 │         HCM              │
                 └────┬──────────┬──────────┘
     Real-time pull   │          │  Webhook push
     (on-demand)      │          │  (event-driven)
                      │          │
          ┌───────────▼──────────▼────────┐
          │      Local Balance Cache       │
          │         (SQLite)               │
          └───────────▲────────────────────┘
                      │
          Batch pull every 15 min
          (scheduled reconciliation)
```

---

## 9. Conflict Resolution

### Rule: HCM Always Wins

When a batch sync or webhook delivers data that contradicts local state:

```
Scenario:
  Local:  totalDays=10, usedDays=2, reservedDays=8  (available=0)
  HCM:    totalDays=5,  usedDays=2                  (available=3)

Resolution:
  1. Update local: totalDays=5, usedDays=2
  2. Detect: reservedDays(8) > HCM_available(3) → CONFLICT
  3. Flag all PENDING requests for this (employee, location, leaveType) → NEEDS_REVALIDATION
  4. Log conflict to SyncLog with PARTIAL status
  5. Alert (future: send notification to manager)
```

### NEEDS_REVALIDATION
A request in this status means the HCM balance may no longer cover the originally reserved days. The manager must:
- **Reject** the request (balance released, employee notified)
- Or the employee re-submits after the conflict is resolved

---

## 10. Failure Scenarios & Mitigations

| Scenario | Detection | Mitigation |
|---|---|---|
| HCM API down | HTTP timeout / 5xx | Request stays PENDING; batch reconciliation retries |
| Network partition | axios timeout | Retry with exponential backoff (3x, 1s base) |
| HCM rejects late | 4xx on async call | Mark REJECTED, release reservation |
| Duplicate webhook | Same payload twice | Idempotent upsert — second write is a no-op |
| Race condition on submit | Optimistic lock conflict | Retry up to 3x, then surface ConflictException |
| HCM balance drops post-approval | Batch sync detects discrepancy | Flag NEEDS_REVALIDATION, log conflict |
| Partial batch failure | Some records fail | SyncLog records PARTIAL status, failed records retried next cycle |
| Invalid HCM dimensions | 400 from HCM | Propagate error with `INVALID_COMBINATION` code |

---

## 11. Alternatives Considered

### ❌ Strong Consistency (Two-Phase Commit)
- **Approach:** Lock HCM balance before reserving locally
- **Rejected because:** Tight coupling with HCM; any HCM latency blocks the employee UI; HCM APIs don't support distributed transactions

### ❌ Event Sourcing
- **Approach:** Store every balance change as an immutable event; derive state by replaying
- **Rejected because:** Significantly increases complexity; overkill for current scope; SQLite is not ideal as an event store

### ❌ Pessimistic Locking (SELECT FOR UPDATE)
- **Approach:** Lock the balance row on every write
- **Rejected because:** SQLite's limited concurrency makes this a bottleneck; doesn't scale to distributed deployments

### ❌ Saga Pattern (Choreography)
- **Approach:** Each step publishes events; services react and compensate on failure
- **Rejected because:** Requires a message broker (Kafka/RabbitMQ); increases operational complexity; not warranted for this service's scope

### ✅ Chosen: Reservation + Optimistic Locking + Eventual Consistency
- Simple to reason about
- No tight coupling with HCM
- Handles concurrent requests correctly
- Degrades gracefully on HCM unavailability

---

## 12. Security

### Authentication
- JWT Bearer tokens with configurable expiry (default: 24h)
- Role-based access control: `employee`, `manager`, `system`
- `system` role for HCM-to-ReadyOn batch ingestion

### Webhook Verification
- `X-HCM-Signature: sha256=<HMAC-SHA256(body, secret)>`
- Dev mode: verification skipped if secret is not configured (logs a warning)

### Rate Limiting
- 100 requests per 60 seconds per IP (via `@nestjs/throttler`)

### Input Validation
- All DTOs validated with `class-validator` and `class-transformer`
- Whitelist mode: unknown fields are stripped

---

## 13. Observability

### Logging
Every request logged with:
- `requestId` (auto-generated UUID, propagated via `x-request-id` header)
- `[METHOD] /path → statusCode (Xms)`
- HCM call start/end/error
- State transitions (PENDING → APPROVED, etc.)

### Audit Trail
`SyncLog` table records every sync operation:
- Type: `REALTIME | BATCH | WEBHOOK | RECONCILIATION`
- Status: `SUCCESS | PARTIAL | FAILURE`
- Records processed / conflicted
- Error message

### Health Endpoints
- `GET /api/v1/health` — liveness (always 200 if process is running)
- `GET /api/v1/health/ready` — readiness (checks DB connection)

---

## 14. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Request submission latency (P99) | < 200ms (local check only; HCM call is async) |
| Balance read latency (P99) | < 50ms (local cache) |
| HCM sync lag (webhook) | < 5 seconds end-to-end |
| HCM sync lag (batch) | ≤ 15 minutes |
| Test coverage | ≥ 80% line coverage enforced |
| Availability | Remains functional during HCM downtime (degraded mode) |

---

## 15. Test Strategy

### Philosophy
Given the agentic development approach, the value of the implementation lies in the **rigour of the test suite**. Tests are written to:
1. Guard against regressions from future development
2. Serve as living documentation of business rules
3. Validate correctness under adversarial conditions (concurrency, HCM failures)

### Test Layers

#### Unit Tests (`test/unit/`)
Testing services in complete isolation with Jest mocks.

| Test File | Key Scenarios |
|---|---|
| `balances.service.spec.ts` | availableDays formula, reservation, confirmation, release, optimistic lock retry, HCM sync success/failure, batch conflict detection |
| `time-off-requests.service.spec.ts` | Idempotency key hit, insufficient balance rejects before HCM, date validation, all state machine transitions, cancel guards |

#### E2E Tests (`test/e2e/`)
Full integration against a real NestJS app + in-memory SQLite + live mock HCM server.

| Scenario | What's Validated |
|---|---|
| Happy path | Submit → HCM approves → `usedDays` incremented, `reservedDays` released |
| Duplicate idempotency key | Second request returns identical response without re-executing |
| Insufficient balance (local) | 409 returned before HCM is called |
| Anniversary bonus webhook | Local balance updated, new `totalDays` visible immediately |
| Webhook idempotency | Same payload twice yields same final state |
| Batch sync — clean | Balances updated, 0 conflicts |
| Batch sync — conflict | `NEEDS_REVALIDATION` set on affected requests |
| Cancel PENDING | Reservation released, status CANCELLED |
| Cancel APPROVED | 400 — not allowed |
| Cross-employee cancel | 400 — employees can only cancel their own requests |
| Manager rejects | Reservation released, status REJECTED |
| Employee tries to approve | 403 — role guard enforced |
| No auth token | 401 |
| Invalid input (missing fields) | 400 with field-level errors |

### Mock HCM Server
A standalone Express server (`mock-hcm/`) simulates the HCM system:
- In-memory state seeded from fixtures
- Validates balance and deducts on time-off filings
- Supports anniversary bonus simulation that fires a webhook back to ReadyOn
- Admin endpoints for test setup (`/hcm/admin/set-balance`, `/hcm/admin/reset`, `/hcm/admin/state`)
- Idempotency key handling on filings

---

## 16. Future Improvements

| Improvement | Rationale |
|---|---|
| PostgreSQL | Production-grade concurrent writes; row-level locking |
| Kafka / Event streaming | Decouple HCM sync from scheduled polling; near-real-time consistency |
| Circuit breaker (opossum) | Fail fast when HCM is consistently unavailable |
| Distributed tracing (OpenTelemetry) | End-to-end request tracing across services |
| Multi-leave-type accrual policies | Support carry-forward, encashment, blackout periods |
| Manager notification on NEEDS_REVALIDATION | Email/Slack alert when conflicts are detected |
| Cancellation of APPROVED requests | Reversal flow — file a reversal with HCM |

---

## 17. Edge Cases

This section documents every significant edge case — which are **resolved in the current implementation** and which remain **open risks** for future work.

### 17.1 Resolved Edge Cases ✅

These are handled by the current implementation and covered by tests.

| Edge Case | How It's Resolved |
|---|---|
| **Two concurrent submissions against the same balance** | Optimistic locking (`@VersionColumn`) on the `Balance` entity. The second writer detects a version mismatch and retries up to 3× with exponential backoff (50ms → 100ms → 150ms). If all retries fail, a `ConflictException` is returned. |
| **Employee submits while batch sync is running** | Batch sync operates inside a database transaction. The submission sees a fully consistent balance snapshot — it cannot observe a partial sync. |
| **Duplicate idempotency key (same request sent twice)** | The service checks for an existing `TimeOffRequest` with the same `idempotencyKey` before executing. If found, the stored response is returned immediately — no side effects. |
| **Duplicate webhook (same HCM event delivered twice)** | Webhook handler performs an idempotent upsert (`INSERT OR REPLACE` semantics). The second identical payload overwrites the same values — the final state is identical. |
| **HCM API unavailable at submission time** | The request is saved as `PENDING` after the local reservation is made. The async HCM call fails silently. The batch reconciliation job (every 15 min) will retry. The employee is not blocked. |
| **HCM rejects the request after local reservation** | The async HCM callback receives a `REJECTED` status. `releaseReservation` is called, restoring `reservedDays`. The request status is set to `REJECTED`. |
| **Batch sync reveals HCM balance is lower than local reserved** | Conflict detected: `reservedDays > (HCM_totalDays - HCM_usedDays)`. Affected `PENDING` requests are flagged `NEEDS_REVALIDATION`. Conflict logged to `SyncLog`. Manager must explicitly resolve. |
| **Employee cancels a PENDING request** | `reservedDays -= days` is applied atomically before status is set to `CANCELLED`. Guard prevents cancellation of non-PENDING requests. |
| **Cross-employee cancellation attempt** | Guard checks `request.employeeId === requestingEmployeeId`. Returns `400 Bad Request` if mismatched. |
| **Employee tries to use a manager-only endpoint** | `@Roles('manager')` decorator on the controller method. `RolesGuard` returns `403 Forbidden`. |
| **Request with negative days** | DTO-level validation via `class-validator` (`@Min(0.5)`). Returns `400 Bad Request` before any logic runs. |
| **Start date is after end date** | Date range validation in service layer. Returns `400 Bad Request`. |
| **Fractional days (half-day requests)** | `days` field is typed as `real` (float) in SQLite. The formula `availableDays = totalDays - usedDays - reservedDays` supports `0.5` increments. |
| **Invalid HCM location/leave-type combination** | HCM returns a `400`. The service propagates this as a `BadRequestException` with a clear message to the employee. |
| **HCM network timeout** | `axios` is configured with a timeout (default: 10s). On timeout, the request stays `PENDING` and the sync log records a `FAILURE` entry. |

---

### 17.2 Known Open Edge Cases ⚠️

These are identified risks that are **not fully handled** in the current implementation and represent concrete future work.

| Edge Case | Risk | Recommended Fix |
|---|---|---|
| **Employee cancels exactly as HCM approves (race condition)** | Cancel releases the reservation. The concurrent HCM approval callback then tries to call `confirmReservation` on 0 reserved days. The `Math.max(0, ...)` guard prevents it from going negative, but the request status may be inconsistent (CANCELLED + APPROVED both attempted). | Use a distributed advisory lock or a database-level `SELECT FOR UPDATE` on the `TimeOffRequest` row during status transitions. Alternatively, introduce a terminal state check before any status update. |
| **PENDING request orphaned when HCM never responds** | If the HCM call fails silently (no response, no webhook), the request stays `PENDING` indefinitely and `reservedDays` is never released. | Add a recovery cron job: every 30 minutes, find all `PENDING` requests older than X minutes and re-trigger the HCM call. If HCM still does not respond after Y attempts, auto-cancel and release the reservation. |
| **Idempotency key scoped globally, not per employee** | Two different employees using the same `idempotencyKey` string will collide — the second employee receives the first employee's response. | Scope idempotency checks to `(employeeId + idempotencyKey)` composite key. Add a unique index on `(employeeId, idempotencyKey)`. |
| **Business days not validated locally** | `days` is caller-supplied. An employee could submit a request for `5 days` that spans a weekend with only 2 actual working days. ReadyOn trusts the client's `days` value. HCM may or may not validate this. | Integrate a working-days calculation library (e.g. `date-holidays`) and validate that `days` matches the number of business days between `startDate` and `endDate` for the employee's location. |
| **`availableDays` can go negative** | If HCM data is corrupted (e.g., `usedDays > totalDays`), `availableDays` becomes negative. No application-level guard exists. | Add a `CHECK (total_days >= used_days + reserved_days)` database constraint. At application level, throw a `DataIntegrityException` and alert ops if this is ever violated. |
| **Approved request cannot be cancelled** | Once `APPROVED`, an employee cannot cancel. Real HR systems require a reversal/cancellation-after-approval flow. | Implement a reversal request: a new `TimeOffRequest` of type `REVERSAL` that files a negative balance adjustment with HCM. On HCM approval, `usedDays -= N` is applied. |
| **No notification on NEEDS_REVALIDATION** | Managers are not alerted when batch sync flags requests as `NEEDS_REVALIDATION`. Without a notification, the conflict may sit unresolved for days. | Integrate an email/Slack notification on status transition to `NEEDS_REVALIDATION`. Expose a dashboard endpoint for managers to see all unresolved conflicts. |
| **Single `lastSyncedAt` timestamp per balance** | If real-time sync succeeds but the webhook-based sync fails silently, `lastSyncedAt` still shows a recent value. Staleness cannot be distinguished by sync type. | Add separate `lastRealtimeSyncedAt`, `lastWebhookSyncedAt`, `lastBatchSyncedAt` columns for fine-grained observability. |

---

## 18. Scalability

### 18.1 Current State (Stage 1 — Single Instance, SQLite)

The current implementation is intentionally designed for simplicity and correctness over raw scale. It is appropriate for small-to-medium organisations (< 500 employees, < 50 concurrent requests).

```
Employee UI
    │
    ▼
NestJS (1 instance)
    │
    ├── SQLite (local file DB)        ← Single writer, limited concurrency
    │
    └── HCM API (external)
```

**Bottlenecks at this stage:**
- SQLite allows only one writer at a time. Under burst load, requests queue behind the write lock.
- A single NestJS instance is not fault-tolerant. If the process crashes, all in-flight requests are lost.
- The 15-minute cron job runs inside the same process — it competes with request handlers for memory.

**Realistic capacity:** ~50–100 requests/second with sub-200ms P99.

---

### 18.2 Stage 2 — PostgreSQL + Horizontal Scaling

Replace SQLite with PostgreSQL and deploy multiple NestJS instances behind a load balancer. This is the primary production target.

```
Employee UI
    │
    ▼
Load Balancer (NGINX / AWS ALB)
    │
    ├── NestJS Instance 1 ─┐
    ├── NestJS Instance 2 ─┤── PostgreSQL (Primary + Read Replica)
    └── NestJS Instance N ─┘
                           │
                       HCM API
```

**What changes:**

| Component | Current (Stage 1) | Stage 2 |
|---|---|---|
| Database | SQLite (file-based) | PostgreSQL (server-based) |
| Concurrency model | Optimistic locking (SQLite constraints) | Optimistic locking OR `SELECT FOR UPDATE` on the balance row |
| NestJS instances | 1 | N (stateless — JWT means no session affinity needed) |
| Scheduled cron | Runs in every instance | Distribute using a leader-election lock (e.g. `pg_advisory_lock`) or move to a dedicated worker |
| Fault tolerance | None | Process manager (PM2), container orchestration (Kubernetes) |

**Code change required:** In `app.module.ts`, replace `better-sqlite3` TypeORM driver with `postgres`. The business logic, optimistic locking mechanism, and all service code are **driver-agnostic** — no rewrites needed.

**Realistic capacity:** Thousands of requests/second with proper connection pooling (PgBouncer).

---

### 18.3 Stage 3 — Event-Driven, Multi-Service

Decouple the HCM sync concern from the request-handling path entirely using an event streaming platform (Kafka or AWS SQS).

```
Employee UI
    │
    ▼
API Gateway
    │
    ▼
Time-Off Service (NestJS) ──── PostgreSQL
    │
    ├── Publishes: "time-off-request.submitted"
    │               "time-off-request.cancelled"
    │
    ▼
Kafka / AWS SQS
    │
    ├── HCM Sync Consumer ───── HCM API (Workday / SAP)
    │       ↓ publishes: "hcm.balance-updated"
    │
    └── Notification Consumer ── Email / Slack
```

**What this unlocks:**

| Capability | How |
|---|---|
| **Near-real-time HCM sync** | HCM publishes to Kafka on every balance change. ReadyOn subscribes and applies updates within seconds — eliminates the 15-minute polling lag entirely. |
| **Independent scaling of sync vs serving** | The HCM consumer can be scaled independently based on HCM event volume, without touching the request-serving tier. |
| **Built-in retry and dead-letter queue** | Kafka/SQS retries failed HCM calls automatically. Failed messages go to a DLQ for manual inspection — no lost updates. |
| **Decoupled notification pipeline** | A separate consumer handles `NEEDS_REVALIDATION` alerts — removing that responsibility from the core service. |
| **Multi-region readiness** | Kafka topics can be replicated across regions. Each region runs its own Time-Off Service consumer group. |

**Trade-offs:** Requires Kafka/SQS infrastructure, consumer service deployment, schema registry for event versioning, and operational expertise. Recommended when team size and request volume justify the overhead.

**Realistic capacity:** Millions of events/day with horizontal scaling of each tier independently.

---

### 18.4 Scalability at a Glance

| Dimension | Stage 1 (Today) | Stage 2 (PostgreSQL) | Stage 3 (Event-Driven) |
|---|---|---|---|
| **Throughput** | ~100 req/s | ~10,000 req/s | Horizontally unlimited |
| **Fault tolerance** | None | Container restart (K8s) | Full — each service independent |
| **HCM sync lag** | ≤ 15 min (batch) | ≤ 15 min (batch) | < 5 seconds (event-driven) |
| **Database** | SQLite | PostgreSQL | PostgreSQL + read replicas |
| **Deployment complexity** | Single binary | K8s Deployment | K8s + Kafka + consumers |
| **Recommended for** | Prototype / interview | Production (< 50k employees) | Large enterprise / multi-region |

---

## 19. Current vs Future Implementation

This section maps every key design decision to its current implementation and the recommended production-grade upgrade.

| Concern | Current Implementation | Future Implementation |
|---|---|---|
| **Database** | SQLite (`better-sqlite3`) — simple, zero-config, file-based | PostgreSQL — concurrent writes, row-level locking, JSONB, connection pooling |
| **Concurrency control** | Optimistic locking with 3× retry at application layer | `SELECT FOR UPDATE` on the balance row (PostgreSQL advisory locks for distributed locking) |
| **HCM sync** | 3-layer: real-time pull, webhook push, 15-min batch cron | HCM publishes events to Kafka; ReadyOn subscribes — eliminates polling entirely |
| **HCM error handling** | Async call with retry (3×, exponential backoff) | Circuit breaker (Opossum) — fail-fast after N consecutive failures; half-open probe to detect recovery |
| **Cron scheduling** | NestJS `@Cron` inside the application process | Dedicated worker process or scheduled Kubernetes CronJob — no competition with request handlers |
| **Idempotency** | Global `idempotencyKey` field on requests | Composite unique index on `(employeeId, idempotencyKey)` — prevent cross-employee collision |
| **PENDING recovery** | None — orphaned PENDING requests stay PENDING | Recovery cron: find PENDING requests older than 30 min, re-trigger HCM call or auto-cancel |
| **Business day validation** | Caller-supplied `days` field is trusted | Server-side validation using `date-holidays` library for the employee's location/country |
| **Approved request cancellation** | Not supported | Reversal request flow — file negative balance adjustment with HCM |
| **Notifications** | None | Event-driven notification consumer — email/Slack on `NEEDS_REVALIDATION`, rejection, and approval |
| **Observability** | Structured request logging + SyncLog audit table | OpenTelemetry distributed tracing, Prometheus metrics, Grafana dashboards |
| **Auth** | JWT Bearer (self-signed) | OAuth2 / OIDC integration with the corporate identity provider (Okta, Azure AD) |
| **Deployment** | `node dist/main` (single process) | Docker container → Kubernetes Deployment with liveness/readiness probes, auto-scaling HPA |
| **Multi-region** | Not supported | Active-active via Kafka replication; PostgreSQL global via CockroachDB or Aurora Global |
| **Secret management** | `.env` file | HashiCorp Vault or AWS Secrets Manager — secrets injected at runtime, rotated without redeployment |

---

*This document represents the merged and refined design from collaborative review of multiple design proposals.*
