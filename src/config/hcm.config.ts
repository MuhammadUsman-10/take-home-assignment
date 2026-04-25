import { registerAs } from '@nestjs/config';

export const hcmConfig = registerAs('hcm', () => ({
  baseUrl: process.env.HCM_BASE_URL ?? 'http://localhost:4000',
  apiKey: process.env.HCM_API_KEY ?? 'hcm-secret-key',
  timeout: parseInt(process.env.HCM_TIMEOUT ?? '10000', 10),
  maxRetries: parseInt(process.env.HCM_MAX_RETRIES ?? '3', 10),
  retryDelay: parseInt(process.env.HCM_RETRY_DELAY ?? '1000', 10),
  reconciliationIntervalMs: parseInt(
    process.env.HCM_RECONCILIATION_INTERVAL_MS ?? '900000', // 15 min
    10,
  ),
  webhookCallbackUrl: process.env.WEBHOOK_CALLBACK_URL ?? 'http://localhost:3000/api/v1/webhooks/hcm/balance-update',
}));
