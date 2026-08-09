/**
 * Approval recording and resumption.
 *
 * authorizeApproval() has already established that the caller is a member of
 * the owning organization with a permitted role, that the step really is an
 * approval_gate, that the run is paused, and that nobody has approved it yet.
 *
 * Those checks are a read, so two simultaneous approvals could both pass them.
 * The write below is therefore conditional on the same preconditions and
 * reports affected_rows: whoever loses the race gets a clean "already
 * processed" rather than a double resume.
 */

import { adminRequest } from '../lib/hasura';
import { AuthorizationError } from './authz';
import { executeRun, type ExecutionOutcome } from './engine';

const CLAIM_APPROVAL = /* GraphQL */ `
  mutation ClaimApproval($step_run_id: uuid!, $user_id: uuid!, $now: timestamptz!) {
    update_step_runs(
      where: {
        id: { _eq: $step_run_id }
        status: { _eq: "paused" }
        approved_by: { _is_null: true }
      }
      _set: {
        status: "completed"
        approved_by: $user_id
        approved_at: $now
        completed_at: $now
        error: null
      }
    ) {
      affected_rows
      returning {
        id
        workflow_run_id
        approved_at
        approved_by
      }
    }
  }
`;

export interface ApprovalResult {
  stepRunId: string;
  runId: string;
  approvedBy: string;
  approvedAt: string;
  outcome: ExecutionOutcome;
}

export async function approveAndResume(
  stepRunId: string,
  userId: string,
): Promise<ApprovalResult> {
  const now = new Date().toISOString();

  const data = await adminRequest<{
    update_step_runs: {
      affected_rows: number;
      returning: Array<{
        id: string;
        workflow_run_id: string;
        approved_at: string;
        approved_by: string;
      }>;
    };
  }>(CLAIM_APPROVAL, { step_run_id: stepRunId, user_id: userId, now });

  const row = data.update_step_runs.returning[0];
  if (data.update_step_runs.affected_rows !== 1 || !row) {
    throw new AuthorizationError(
      'This approval was already processed by another request.',
      'invalid_state',
    );
  }

  // Resume the remaining steps. The run is NOT marked completed here — the
  // engine runs whatever comes after the gate and decides the final status.
  const outcome = await executeRun(row.workflow_run_id, 'resume');

  return {
    stepRunId: row.id,
    runId: row.workflow_run_id,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    outcome,
  };
}
