import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

// ─────────────────────────────────────────────────────────────
// In-memory store — simulates HCM database
// ─────────────────────────────────────────────────────────────

interface HcmBalance {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  totalDays: number;
  usedDays: number;
}

interface HcmRequest {
  refId: string;
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  days: number;
  startDate: string;
  endDate: string;
  status: 'APPROVED' | 'REJECTED';
  createdAt: string;
}

// Seeded initial balances
const initialBalances: HcmBalance[] = [
  { employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'VACATION', totalDays: 15, usedDays: 3 },
  { employeeId: 'emp-001', locationId: 'loc-nyc', leaveTypeId: 'SICK', totalDays: 10, usedDays: 1 },
  { employeeId: 'emp-002', locationId: 'loc-sf', leaveTypeId: 'VACATION', totalDays: 20, usedDays: 5 },
  { employeeId: 'emp-002', locationId: 'loc-sf', leaveTypeId: 'SICK', totalDays: 10, usedDays: 0 },
  { employeeId: 'emp-003', locationId: 'loc-nyc', leaveTypeId: 'VACATION', totalDays: 5, usedDays: 4 },
  { employeeId: 'emp-003', locationId: 'loc-nyc', leaveTypeId: 'PERSONAL', totalDays: 3, usedDays: 0 },
];

// Deep clone for reset
const balances: Map<string, HcmBalance> = new Map(
  initialBalances.map((b) => [balanceKey(b.employeeId, b.locationId, b.leaveTypeId), { ...b }]),
);

const requests: Map<string, HcmRequest> = new Map();
const processedIdempotencyKeys: Map<string, HcmRequest> = new Map();

function balanceKey(employeeId: string, locationId: string, leaveTypeId: string): string {
  return `${employeeId}::${locationId}::${leaveTypeId}`;
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

/**
 * GET /hcm/balances/:employeeId/:locationId
 * Real-time balance fetch (query param: leaveTypeId)
 */
app.get('/hcm/balances/:employeeId/:locationId', (req: Request, res: Response) => {
  const { employeeId, locationId } = req.params;
  const { leaveTypeId } = req.query as { leaveTypeId?: string };

  if (leaveTypeId) {
    const balance = balances.get(balanceKey(employeeId, locationId, leaveTypeId));
    if (!balance) {
      return res.status(404).json({ error: 'Balance not found', employeeId, locationId, leaveTypeId });
    }
    return res.json(balance);
  }

  // Return all balances for employee+location
  const result = Array.from(balances.values()).filter(
    (b) => b.employeeId === employeeId && b.locationId === locationId,
  );
  return res.json({ balances: result });
});

/**
 * POST /hcm/time-off
 * File a time-off request against HCM. Validates balance and deducts.
 */
app.post('/hcm/time-off', (req: Request, res: Response) => {
  const { employeeId, locationId, leaveTypeId, days, startDate, endDate, refId } = req.body as {
    employeeId: string;
    locationId: string;
    leaveTypeId: string;
    days: number;
    startDate: string;
    endDate: string;
    refId: string;
  };

  const idempotencyKey = req.headers['x-idempotency-key'] as string;

  // Idempotency — return same result for same key
  if (idempotencyKey && processedIdempotencyKeys.has(idempotencyKey)) {
    const cached = processedIdempotencyKeys.get(idempotencyKey)!;
    return res.json({ refId: cached.refId, status: cached.status });
  }

  const balance = balances.get(balanceKey(employeeId, locationId, leaveTypeId));

  // Validation
  if (!balance) {
    return res.status(400).json({
      error: 'INVALID_COMBINATION',
      message: `No balance found for employee=${employeeId} location=${locationId} leaveType=${leaveTypeId}`,
    });
  }

  const available = balance.totalDays - balance.usedDays;
  if (available < days) {
    return res.status(400).json({
      error: 'INSUFFICIENT_BALANCE',
      message: `Insufficient balance: ${available} days available, ${days} requested`,
      available,
      requested: days,
    });
  }

  if (days <= 0) {
    return res.status(400).json({ error: 'INVALID_DAYS', message: 'Days must be positive' });
  }

  // Approve and deduct
  balance.usedDays = parseFloat((balance.usedDays + days).toFixed(4));

  const hcmRequest: HcmRequest = {
    refId: refId ?? uuidv4(),
    employeeId,
    locationId,
    leaveTypeId,
    days,
    startDate,
    endDate,
    status: 'APPROVED',
    createdAt: new Date().toISOString(),
  };

  requests.set(hcmRequest.refId, hcmRequest);
  if (idempotencyKey) processedIdempotencyKeys.set(idempotencyKey, hcmRequest);

  console.log(
    `[HCM] Approved: emp=${employeeId} loc=${locationId} type=${leaveTypeId} days=${days} ` +
    `(remaining: ${balance.totalDays - balance.usedDays})`,
  );

  return res.json({ refId: hcmRequest.refId, status: 'APPROVED' });
});

/**
 * POST /hcm/balances/batch
 * Returns full corpus of all balances (used by ReadyOn for batch sync)
 */
app.post('/hcm/balances/batch', (_req: Request, res: Response) => {
  const allBalances = Array.from(balances.values());
  console.log(`[HCM] Batch export: ${allBalances.length} records`);
  return res.json({ balances: allBalances, exportedAt: new Date().toISOString() });
});

/**
 * POST /hcm/admin/anniversary-bonus
 * Test helper: simulate work anniversary / year-start balance refresh.
 * Fires a webhook to ReadyOn after updating the internal balance.
 */
app.post('/hcm/admin/anniversary-bonus', async (req: Request, res: Response) => {
  const { employeeId, locationId, leaveTypeId, bonusDays, readyOnWebhookUrl } = req.body as {
    employeeId: string;
    locationId: string;
    leaveTypeId: string;
    bonusDays: number;
    readyOnWebhookUrl?: string;
  };

  const key = balanceKey(employeeId, locationId, leaveTypeId);
  let balance = balances.get(key);

  if (!balance) {
    balance = { employeeId, locationId, leaveTypeId, totalDays: bonusDays, usedDays: 0 };
    balances.set(key, balance);
  } else {
    balance.totalDays = parseFloat((balance.totalDays + bonusDays).toFixed(4));
  }

  console.log(
    `[HCM] Anniversary bonus: emp=${employeeId} +${bonusDays} days → total=${balance.totalDays}`,
  );

  // Fire webhook to ReadyOn
  const webhookUrl =
    readyOnWebhookUrl ?? process.env.READYON_WEBHOOK_URL ?? 'http://localhost:3000/api/v1/webhooks/hcm/balance-update';

  try {
    await axios.post(webhookUrl, {
      employeeId,
      locationId,
      leaveTypeId,
      totalDays: balance.totalDays,
      usedDays: balance.usedDays,
      reason: 'ANNIVERSARY_BONUS',
    });
    console.log(`[HCM] Webhook fired to ${webhookUrl}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HCM] Webhook delivery failed: ${msg}`);
  }

  return res.json({
    message: 'Anniversary bonus applied',
    balance,
    webhookFired: webhookUrl,
  });
});

/**
 * POST /hcm/admin/set-balance
 * Test helper: directly set a balance (for test setup)
 */
app.post('/hcm/admin/set-balance', (req: Request, res: Response) => {
  const { employeeId, locationId, leaveTypeId, totalDays, usedDays } = req.body as HcmBalance;
  const key = balanceKey(employeeId, locationId, leaveTypeId);
  balances.set(key, { employeeId, locationId, leaveTypeId, totalDays, usedDays });
  return res.json({ message: 'Balance set', balance: balances.get(key) });
});

/**
 * GET /hcm/admin/state
 * Test helper: inspect full internal state
 */
app.get('/hcm/admin/state', (_req: Request, res: Response) => {
  return res.json({
    balances: Object.fromEntries(balances),
    requests: Object.fromEntries(requests),
    idempotencyKeys: Array.from(processedIdempotencyKeys.keys()),
  });
});

/**
 * POST /hcm/admin/reset
 * Test helper: reset all state to initial seed data
 */
app.post('/hcm/admin/reset', (_req: Request, res: Response) => {
  balances.clear();
  requests.clear();
  processedIdempotencyKeys.clear();
  initialBalances.forEach((b) => {
    balances.set(balanceKey(b.employeeId, b.locationId, b.leaveTypeId), { ...b });
  });
  return res.json({ message: 'State reset to initial seed', count: balances.size });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[HCM] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal mock HCM error', message: err.message });
});

export { app };

// ─────────────────────────────────────────────────────────────
// Start server when run directly
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const port = parseInt(process.env.PORT ?? '4000', 10);
  app.listen(port, () => {
    console.log(`🎭 Mock HCM server running on http://localhost:${port}`);
    console.log(`📊 State inspector: http://localhost:${port}/hcm/admin/state`);
    console.log(`🔄 Seeded ${initialBalances.length} initial balances`);
  });
}
