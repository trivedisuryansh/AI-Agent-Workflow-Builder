/**
 * Public webhook trigger endpoint.
 *
 * POST /api/webhook/{trigger_id}?secret=...      (or X-Webhook-Secret header)
 *
 * This is the one route in the application that is genuinely public — no Nhost
 * session, no Hasura shared secret. Its security rests entirely on:
 *
 *   - a 32-byte secret minted by the database, never chosen by a client, never
 *     exposed through any select permission, and readable only by an owner
 *     through the getWebhookUrl Action;
 *   - constant-time comparison, so the secret cannot be recovered byte by byte;
 *   - the trigger row having to exist, be of type 'webhook', and be enabled;
 *   - the same organization quota as every other execution path, so a leaked
 *     URL cannot be used to run up unbounded LLM spend;
 *   - a body size cap, and the body being stored as run input (data), never
 *     evaluated as configuration.
 *
 * Knowing a trigger UUID is not sufficient — the UUID is half of a two-part
 * credential and the secret is the half that matters.
 *
 * Documented residual risk: possession of the URL is authority, as with any
 * webhook. Rotation is by deleting and recreating the trigger, which mints a
 * fresh secret. There is no per-caller identity, so runs created this way have
 * triggered_by = NULL.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { adminRequest, createRunWithQuota, isUuid, AuthorizationError, type Json } from '@wfb/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

const LOAD_TRIGGER = /* GraphQL */ `
  query LoadWebhookTrigger($trigger_id: uuid!) {
    workflow_triggers_by_pk(id: $trigger_id) {
      id
      type
      enabled
      webhook_secret
      config
      workflow {
        id
        org_id
        status
        workflow_steps_aggregate {
          aggregate {
            count
          }
        }
      }
    }
  }
`;

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ triggerId: string }> },
): Promise<NextResponse> {
  const { triggerId } = await context.params;

  // A single opaque failure for every rejection reason below. Distinguishing
  // "no such trigger" from "wrong secret" would let an attacker enumerate valid
  // trigger ids for free.
  const deny = () =>
    NextResponse.json({ error: 'Invalid webhook trigger or secret.' }, { status: 401 });

  try {
    if (!isUuid(triggerId)) return deny();

    const url = new URL(request.url);
    const provided = url.searchParams.get('secret') ?? request.headers.get('x-webhook-secret') ?? '';
    if (provided === '') return deny();

    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Payload too large.' }, { status: 413 });
    }

    const data = await adminRequest<{
      workflow_triggers_by_pk: {
        id: string;
        type: string;
        enabled: boolean;
        webhook_secret: string | null;
        config: Record<string, Json>;
        workflow: {
          id: string;
          org_id: string;
          status: string;
          workflow_steps_aggregate: { aggregate: { count: number } | null };
        };
      } | null;
    }>(LOAD_TRIGGER, { trigger_id: triggerId });

    const trigger = data.workflow_triggers_by_pk;
    if (!trigger || trigger.type !== 'webhook' || !trigger.webhook_secret) return deny();
    if (!secretsMatch(provided, trigger.webhook_secret)) return deny();

    // Past this point the caller is authenticated, so errors can be specific.
    if (!trigger.enabled) {
      return NextResponse.json({ error: 'This webhook trigger is disabled.' }, { status: 409 });
    }
    if (trigger.workflow.status === 'archived') {
      return NextResponse.json({ error: 'This workflow is archived.' }, { status: 409 });
    }
    if ((trigger.workflow.workflow_steps_aggregate.aggregate?.count ?? 0) === 0) {
      return NextResponse.json({ error: 'This workflow has no steps.' }, { status: 409 });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Payload too large.' }, { status: 413 });
    }

    let body: Json = {};
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw) as Json;
      } catch {
        return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
      }
    }

    const created = await createRunWithQuota({
      workflowId: trigger.workflow.id,
      orgId: trigger.workflow.org_id,
      triggerType: 'webhook',
      // No end user is involved in a webhook call.
      triggeredBy: null,
      // The payload is DATA available to steps as {{trigger.body...}}. It never
      // becomes step configuration, so a caller cannot inject a db_write target
      // or redirect an http_request.
      input: { source: 'webhook', trigger_id: trigger.id, body } as Json,
    });

    return NextResponse.json(
      {
        ok: true,
        run_id: created.runId,
        workflow_id: trigger.workflow.id,
        quota_used: created.quota.used,
        quota_limit: created.quota.limit,
      },
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof AuthorizationError && err.code === 'quota_exhausted') {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    console.error('[webhook] unhandled error', err);
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
