/**
 * Integration test harness.
 *
 * These tests run against a REAL Hasura instance with the committed metadata
 * applied and `npm run seed` already executed. They sign in as the seeded users
 * and send ordinary GraphQL over HTTP, exactly as the browser does — no admin
 * secret, no test-only bypass. That is the point: an assertion only means
 * something if it exercises the same path an attacker would.
 *
 * Prerequisites:
 *   npm run hasura:apply
 *   npm run seed
 *   npm run dev            (Actions and Event Triggers must be reachable)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadEnv();

function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Integration tests need ${name}. See .env.example.`);
}

export const SUBDOMAIN = env('NEXT_PUBLIC_NHOST_SUBDOMAIN');
export const REGION = env('NEXT_PUBLIC_NHOST_REGION');
export const AUTH_URL = `https://${SUBDOMAIN}.auth.${REGION}.nhost.run/v1`;
export const GRAPHQL_URL = env(
  'HASURA_GRAPHQL_ENDPOINT',
  `https://${SUBDOMAIN}.hasura.${REGION}.nhost.run/v1/graphql`,
);
export const WS_URL = GRAPHQL_URL.replace(/^http/, 'ws');
export const ADMIN_SECRET = env('HASURA_GRAPHQL_ADMIN_SECRET');
export const APP_BASE_URL = env('APP_BASE_URL', 'http://localhost:3000');
export const SEED_PASSWORD = env('SEED_PASSWORD', 'Passw0rd!seed');

export const EMAILS = {
  ownerA: env('TEST_ORG_A_OWNER_EMAIL', 'owner.a@example.test'),
  editorA: env('TEST_ORG_A_EDITOR_EMAIL', 'editor.a@example.test'),
  viewerA: env('TEST_ORG_A_VIEWER_EMAIL', 'viewer.a@example.test'),
  ownerB: env('TEST_ORG_B_OWNER_EMAIL', 'owner.b@example.test'),
};

// -----------------------------------------------------------------------------

export interface Actor {
  label: string;
  userId: string;
  accessToken: string;
}

export interface GqlResult<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

export async function signIn(label: string, email: string): Promise<Actor> {
  const res = await fetch(`${AUTH_URL}/signin/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  const payload = (await res.json()) as {
    session?: { accessToken: string; user: { id: string } };
    message?: string;
  };
  if (!res.ok || !payload.session) {
    throw new Error(
      `Could not sign in ${email}: ${payload.message ?? res.status}. Did you run "npm run seed"?`,
    );
  }
  return { label, userId: payload.session.user.id, accessToken: payload.session.accessToken };
}

/** Send a GraphQL request AS a user. Returns the raw envelope so tests can assert on errors. */
export async function asUser<T>(
  actor: Actor,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GqlResult<T>> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${actor.accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as GqlResult<T>;
}

/** Same, but throws on any GraphQL error — for steps that must succeed. */
export async function asUserOk<T>(
  actor: Actor,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const result = await asUser<T>(actor, query, variables);
  if (result.errors?.length) {
    throw new Error(`[${actor.label}] ${result.errors.map((e) => e.message).join('; ')}`);
  }
  if (!result.data) throw new Error(`[${actor.label}] no data returned`);
  return result.data;
}

/** Admin request, used ONLY to set up and inspect fixtures, never to assert authorization. */
export async function asAdmin<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await res.json()) as GqlResult<T>;
  if (payload.errors?.length) {
    throw new Error(`[admin] ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  return payload.data as T;
}

// -----------------------------------------------------------------------------

export const ORG_QUERY = /* GraphQL */ `
  query MyOrgs {
    org_members {
      org_id
      role
      organization {
        id
        name
        slug
        quota_used
        quota_limit
      }
    }
  }
`;

export const DEMO_WORKFLOW_QUERY = /* GraphQL */ `
  query DemoWorkflow($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: asc }, limit: 1) {
      id
      name
      org_id
      workflow_steps(order_by: { position: asc }) {
        id
        position
        type
        name
      }
      workflow_triggers {
        id
        type
        enabled
      }
    }
  }
`;

export interface Fixture {
  ownerA: Actor;
  editorA: Actor;
  viewerA: Actor;
  ownerB: Actor;
  orgAId: string;
  orgBId: string;
  workflowId: string;
  steps: Array<{ id: string; position: number; type: string; name: string }>;
  webhookTriggerId: string | null;
}

let cached: Fixture | null = null;

/** Sign everyone in once and locate the seeded Org A workflow. */
export async function fixture(): Promise<Fixture> {
  if (cached) return cached;

  const [ownerA, editorA, viewerA, ownerB] = await Promise.all([
    signIn('ownerA', EMAILS.ownerA),
    signIn('editorA', EMAILS.editorA),
    signIn('viewerA', EMAILS.viewerA),
    signIn('ownerB', EMAILS.ownerB),
  ]);

  const aOrgs = await asUserOk<{ org_members: Array<{ org_id: string; role: string }> }>(
    ownerA,
    ORG_QUERY,
  );
  const bOrgs = await asUserOk<{ org_members: Array<{ org_id: string; role: string }> }>(
    ownerB,
    ORG_QUERY,
  );

  const orgAId = aOrgs.org_members.find((m) => m.role === 'owner')?.org_id;
  const orgBId = bOrgs.org_members.find((m) => m.role === 'owner')?.org_id;
  if (!orgAId || !orgBId) throw new Error('Seeded organizations not found. Run "npm run seed".');
  if (orgAId === orgBId) throw new Error('Org A and Org B resolved to the same organization.');

  const wf = await asUserOk<{
    workflows: Array<{
      id: string;
      workflow_steps: Fixture['steps'];
      workflow_triggers: Array<{ id: string; type: string }>;
    }>;
  }>(ownerA, DEMO_WORKFLOW_QUERY, { orgId: orgAId });

  const workflow = wf.workflows[0];
  if (!workflow) throw new Error('Seeded workflow not found in Org A. Run "npm run seed".');

  cached = {
    ownerA,
    editorA,
    viewerA,
    ownerB,
    orgAId,
    orgBId,
    workflowId: workflow.id,
    steps: workflow.workflow_steps,
    webhookTriggerId: workflow.workflow_triggers.find((t) => t.type === 'webhook')?.id ?? null,
  };
  return cached;
}

/** Give an organization headroom so a quota ceiling does not fail an unrelated test. */
export async function ensureQuota(orgId: string, atLeast = 25): Promise<void> {
  await asAdmin(
    /* GraphQL */ `
      mutation TopUp($id: uuid!, $limit: Int!) {
        update_organizations_by_pk(
          pk_columns: { id: $id }
          _set: { quota_used: 0, quota_limit: $limit }
        ) {
          id
          quota_used
          quota_limit
        }
      }
    `,
    { id: orgId, limit: atLeast },
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until predicate holds or the deadline passes. Returns the last value seen. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 60_000, intervalMs = 1000, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await sleep(intervalMs);
    last = await fn();
  }
  if (predicate(last)) return last;
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}. Last value: ${JSON.stringify(last).slice(0, 500)}`);
}
