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

*This document represents the merged and refined design from collaborative review of multiple design proposals.*
