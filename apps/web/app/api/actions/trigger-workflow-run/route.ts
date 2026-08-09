/**
 * Action: triggerWorkflowRun
 *
 * The order of operations matters and is deliberate:
 *   1. verify the request really came from Hasura      (shared secret)
 *   2. extract the caller from session_variables       (never from input)
 *   3. authorize against org_members                   (Layer 1)
 *   4. reserve quota atomically                        (before any work)
 *   5. create the run                                  (Event Trigger executes it)
 *
 * A user from another organization fails at step 3 with the same "not found"
 * they would get for a UUID that does not exist, so this endpoint cannot be
 * used to probe which workflow ids are real.
 */

import { NextResponse } from 'next/server';

import {
  authorizeWorkflowExecution,
  createRunWithQuota,
  isUuid,
  requireUserId,
  type Json,
} from '@wfb/engine';

import {
  assertCalledByHasura,
  errorResponse,
  HandlerError,
  parseActionPayload,
} from '../../../../lib/action-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Input {
  workflow_id: string;
  input?: Json;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCalledByHasura(request);

    const payload = await parseActionPayload<Input>(request);
    const userId = requireUserId(payload.session_variables);

    const workflowId = payload.input?.workflow_id;
    if (!isUuid(workflowId)) {
      throw new HandlerError('workflow_id must be a UUID.', 400, 'bad_request');
    }

    // Layer 1: membership + role, derived from the database.
    const authz = await authorizeWorkflowExecution(workflowId, userId);

    const created = await createRunWithQuota({
      workflowId: authz.workflowId,
      orgId: authz.orgId,
      triggerType: 'manual',
      triggeredBy: userId,
      input: (payload.input?.input ?? {}) as Json,
    });

    return NextResponse.json({
      run_id: created.runId,
      status: created.status,
      workflow_id: authz.workflowId,
      quota_used: created.quota.used,
      quota_limit: created.quota.limit,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
