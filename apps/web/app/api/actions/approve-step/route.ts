/**
 * Action: approveStep
 *
 * Approval is an Action rather than an update permission because the decision
 * depends on runtime state that a row-level rule cannot express: is the run
 * currently paused, is this step genuinely an approval_gate, and has the
 * approval already been consumed.
 *
 * The authorization chain is walked from the step_run id alone:
 *   step_run -> workflow_run -> workflow -> organization -> org_members(caller)
 * Nothing about the organization or the caller's role is taken from the request.
 */

import { NextResponse } from 'next/server';

import { approveAndResume, authorizeApproval, isUuid, requireUserId } from '@wfb/engine';

import {
  assertCalledByHasura,
  errorResponse,
  HandlerError,
  parseActionPayload,
} from '../../../../lib/action-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Resumption runs the remaining steps inline, which may include an LLM call.
export const maxDuration = 60;

interface Input {
  step_run_id: string;
  note?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCalledByHasura(request);

    const payload = await parseActionPayload<Input>(request);
    const userId = requireUserId(payload.session_variables);

    const stepRunId = payload.input?.step_run_id;
    if (!isUuid(stepRunId)) {
      throw new HandlerError('step_run_id must be a UUID.', 400, 'bad_request');
    }

    // Throws for: non-member, wrong role, not an approval_gate, run not paused,
    // or already approved.
    await authorizeApproval(stepRunId, userId);

    // Claims the approval atomically, then executes everything after the gate.
    const result = await approveAndResume(stepRunId, userId);

    return NextResponse.json({
      step_run_id: result.stepRunId,
      run_id: result.runId,
      approved_by: result.approvedBy,
      approved_at: result.approvedAt,
      // The genuine post-resumption status: 'completed', 'failed', or 'paused'
      // again if the workflow contains a second approval gate.
      run_status:
        result.outcome.status === 'skipped_already_running' || result.outcome.status === 'noop'
          ? 'running'
          : result.outcome.status,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
