# Time-Off Microservice

A production-quality microservice for managing employee time-off requests with HCM balance synchronisation.

Built with **NestJS + TypeORM + SQLite** following a **reservation-based balance system** and **three-layer HCM sync strategy**.

📄 **[Read the full Technical Requirements Document](./docs/TRD.md)**

---

## Architecture Overview

```
Employee UI → Time-Off Microservice (NestJS) → HCM System (Workday/SAP)
                       ↕
               SQLite (Local Cache)
               - Balances (with reservedDays)
               - TimeOffRequests
               - SyncLogs (audit trail)
```

**Key design decisions:**
- **Reservation system**: Days reserved on submission, confirmed/released on HCM response — prevents overbooking under concurrency
- **Defensive local check**: Validates balance locally *before* calling HCM
- **Optimistic locking**: `version` column on Balance entity — concurrent writers retry automatically
- **HCM always wins**: Batch sync overwrites local data; conflicts flagged as `NEEDS_REVALIDATION`
- **Idempotent API**: Client-supplied `idempotencyKey` ensures safe retries

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm 9+

### 1. Install dependencies

```bash
# Main service
npm install

# Mock HCM server
cd mock-hcm && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — defaults work for local development
```

### 3. Start the Mock HCM Server (Terminal 1)

```bash
npm run mock-hcm
# Listening on http://localhost:4000
# Seeded with 6 initial employee balances
```

### 4. Start the Microservice (Terminal 2)

```bash
npm run start:dev
# API running on  http://localhost:3000/api/v1
# Swagger docs at http://localhost:3000/api/docs
```

---

## Running Tests

```bash
# Unit tests (fast, no DB or network)
npm test

# Unit + integration tests with coverage report
npm run test:cov

# E2E tests (starts mock HCM + in-memory SQLite)
npm run test:e2e

# All tests together
npm run test:all
```

Expected coverage: **≥ 80% lines**

---

## API Reference

Interactive Swagger UI: **http://localhost:3000/api/docs**

### Authentication

Get a token (dev convenience endpoint):
```bash
curl -X POST http://localhost:3000/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"employeeId": "<uuid-from-seed>"}'
```

Use the returned `accessToken` as `Authorization: Bearer <token>`.

---

### Key Flows

#### Submit a Time-Off Request
```bash
curl -X POST http://localhost:3000/api/v1/time-off-requests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "EMPLOYEE_ID",
    "locationId": "loc-nyc",
    "leaveTypeId": "VACATION",
    "startDate": "2026-07-01",
    "endDate": "2026-07-05",
    "days": 5,
    "idempotencyKey": "my-unique-request-key-001"
  }'
```

#### Check Balance
```bash
curl http://localhost:3000/api/v1/balances/EMPLOYEE_ID/loc-nyc/VACATION \
  -H "Authorization: Bearer $TOKEN"
# Response includes: totalDays, usedDays, reservedDays, availableDays
```

#### Force Real-Time HCM Refresh
```bash
curl -X POST http://localhost:3000/api/v1/balances/sync/realtime/EMPLOYEE_ID/loc-nyc/VACATION \
  -H "Authorization: Bearer $TOKEN"
```

#### Batch Sync (System/Manager)
```bash
curl -X POST http://localhost:3000/api/v1/balances/sync/batch \
  -H "Authorization: Bearer $MANAGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "balances": [
      { "employeeId": "EMPLOYEE_ID", "locationId": "loc-nyc", "leaveTypeId": "VACATION",
        "totalDays": 20, "usedDays": 5 }
    ],
    "source": "workday"
  }'
```

#### Simulate Anniversary Bonus (via Mock HCM)
```bash
curl -X POST http://localhost:4000/hcm/admin/anniversary-bonus \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "emp-001",
    "locationId": "loc-nyc",
    "leaveTypeId": "VACATION",
    "bonusDays": 5
  }'
# Mock HCM fires a webhook to ReadyOn automatically
```

---

## Project Structure

```
├── docs/
│   └── TRD.md                     # Technical Requirements Document
├── src/
│   ├── main.ts                    # Bootstrap (Swagger, global pipes)
│   ├── app.module.ts              # Root module
│   ├── config/                    # Typed config factories
│   ├── modules/
│   │   ├── auth/                  # JWT + role guards
│   │   ├── balances/              # Balance CRUD + HCM sync
│   │   ├── time-off-requests/     # Request lifecycle
│   │   ├── hcm-sync/              # Scheduled reconciliation
│   │   ├── webhooks/              # Inbound HCM push events
│   │   └── health/                # Liveness + readiness probes
│   ├── common/
│   │   ├── filters/               # Global HTTP exception filter
│   │   ├── interceptors/          # Logging + response transform
│   │   └── decorators/            # @Roles, @CurrentUser
│   └── database/
│       ├── entities/              # TypeORM entities
│       └── seed.ts                # Dev seed data
├── mock-hcm/
│   └── src/index.ts               # Express mock HCM server
├── test/
│   ├── unit/                      # Unit tests (Jest + mocks)
│   ├── integration/               # DB integration tests
│   └── e2e/                       # E2E against live app + mock HCM
├── .env.example
└── data/                          # SQLite database files
```

---

## Balance Formula

```
availableDays = totalDays - usedDays - reservedDays
```

| Field | Meaning |
|---|---|
| `totalDays` | Entitlement from HCM (source of truth) |
| `usedDays` | Confirmed consumed (APPROVED requests) |
| `reservedDays` | Held for PENDING requests — prevents overbooking |
| `availableDays` | What the employee can actually book |

---

## Status State Machine

```
PENDING → APPROVED       (HCM accepts)
PENDING → REJECTED       (HCM rejects OR local balance insufficient)
PENDING → CANCELLED      (employee cancels)
PENDING → NEEDS_REVALIDATION  (batch sync reveals conflict)
NEEDS_REVALIDATION → REJECTED (manager resolves)
```

---

## Mock HCM Admin Endpoints

| Endpoint | Description |
|---|---|
| `GET /hcm/admin/state` | View full internal balance state |
| `POST /hcm/admin/reset` | Reset to initial seed data |
| `POST /hcm/admin/set-balance` | Directly set a balance (for tests) |
| `POST /hcm/admin/anniversary-bonus` | Simulate a bonus (fires webhook) |
