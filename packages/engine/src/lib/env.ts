/**
 * Environment access.
 *
 * Read lazily through functions rather than captured at module load so tests
 * can rearrange process.env between cases, and so a missing variable fails at
 * the point of use with a precise message instead of at import time.
 */

export function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for what it is and where to get it.`,
    );
  }
  return v.trim();
}

export function optional(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function boolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export const config = {
  hasuraEndpoint: () => required('HASURA_GRAPHQL_ENDPOINT'),
  hasuraAdminSecret: () => required('HASURA_GRAPHQL_ADMIN_SECRET'),
  actionSecret: () => required('ACTION_WEBHOOK_SECRET'),
  appBaseUrl: () => optional('APP_BASE_URL', 'http://localhost:3000'),

  llmProvider: () => optional('LLM_PROVIDER', 'groq'),
  llmApiKey: () => optional('LLM_API_KEY'),
  llmModel: () => optional('LLM_MODEL', 'llama-3.3-70b-versatile'),
  llmTimeoutMs: () => intEnv('LLM_TIMEOUT_MS', 30_000),
  // Local models are slower than a hosted API; the default timeout above is
  // generous enough, but this stays overridable for larger models.
  ollamaBaseUrl: () => optional('OLLAMA_BASE_URL', 'http://localhost:11434/v1'),

  httpTimeoutMs: () => intEnv('HTTP_STEP_TIMEOUT_MS', 10_000),
  httpMaxResponseBytes: () => intEnv('HTTP_STEP_MAX_RESPONSE_BYTES', 262_144),
  httpAllowPrivateNetwork: () => boolEnv('HTTP_STEP_ALLOW_PRIVATE_NETWORK', false),

  notifyMode: () => optional('NOTIFY_MODE', 'log'),
  slackWebhookUrl: () => optional('SLACK_WEBHOOK_URL'),

  stepMaxAttempts: () => intEnv('STEP_MAX_ATTEMPTS', 2),
  stepRetryBaseDelayMs: () => intEnv('STEP_RETRY_BASE_DELAY_MS', 500),
};
