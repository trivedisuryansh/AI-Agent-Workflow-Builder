/**
 * All engine state reads/writes, in one place.
 *
 * Every function here uses the admin client. That is safe only because the
 * engine is never entered without an authorization decision having already
 * been made by an Action handler (triggerWorkflowRun / approveStep) or by
 * webhook secret validation. See core/authz.ts.
 */

import { adminRequest } from '../lib/hasura.js';
import type {
  Json,
  StepRunRow,
  StepRunStatus,
  WorkflowRunRow,
  WorkflowStepRow,
} from '../types.js';

export interface RunBundle {
  run: WorkflowRunRow & { workflow: { id: string; name: string; org_id: string } };
  steps: WorkflowStepRow[];
  stepRuns: Array<StepRunRow & { workflow_step: { position: number; name: string; type: string } }>;
}

const LOAD_RUN = /* GraphQL */ `
  query LoadRun($run_id: uuid!) {
    workflow_runs_by_pk(id: $run_id) {
      id
      workflow_id
      org_id
      status
      trigger_type
      triggered_by
      input
      resume_position
      started_at
      completed_at
      paused_at
      error
      workflow {
        id
        name
        org_id
        workflow_steps(order_by: { position: asc }) {
          id
          workflow_id
          position
          type
          name
          config
        }
      }
      step_runs {
        id
        workflow_run_id
        workflow_step_id
        status
        input
        output
        error
        attempt_count
        approved_by
        approved_at
        workflow_step {
          position
          name
          type
        }
      }
    }
  }
`;

export async function loadRunBundle(runId: string): Promise<RunBundle | null> {
  const data = await adminRequest<{
    workflow_runs_by_pk:
      | (WorkflowRunRow & {
          workflow: { id: string; name: string; org_id: string; workflow_steps: WorkflowStepRow[] };
          step_runs: RunBundle['stepRuns'];
        })
      | null;
  }>(LOAD_RUN, { run_id: runId });

  const row = data.workflow_runs_by_pk;
  if (!row) return null;

  const { workflow, step_runs, ...run } = row;
  return {
    run: { ...run, workflow: { id: workflow.id, name: workflow.name, org_id: workflow.org_id } },
    steps: [...workflow.workflow_steps].sort((a, b) => a.position - b.position),
    stepRuns: step_runs,
  };
}

/**
 * Atomically claim a pending run for execution.
 *
 * Returns false when another delivery of the same Hasura event already claimed
 * it. Hasura Event Triggers guarantee at-least-once delivery, so without this
 * a retried delivery would run the workflow twice.
 */
const CLAIM_RUN = /* GraphQL */ `
  mutation ClaimRun($run_id: uuid!, $now: timestamptz!) {
    update_workflow_runs(
      where: { id: { _eq: $run_id }, status: { _eq: "pending" } }
      _set: { status: "running", started_at: $now }
    ) {
      affected_rows
    }
  }
`;

export async function claimRunForExecution(runId: string): Promise<boolean> {
  const data = await adminRequest<{ update_workflow_runs: { affected_rows: number } }>(CLAIM_RUN, {
    run_id: runId,
    now: new Date().toISOString(),
  });
  return data.update_workflow_runs.affected_rows === 1;
}

const UPDATE_RUN = /* GraphQL */ `
  mutation UpdateRun($run_id: uuid!, $set: workflow_runs_set_input!) {
    update_workflow_runs_by_pk(pk_columns: { id: $run_id }, _set: $set) {
      id
      status
    }
  }
`;

export async function updateRun(
  runId: string,
  set: Record<string, Json | undefined>,
): Promise<void> {
  await adminRequest(UPDATE_RUN, { run_id: runId, set });
}

export async function markRunPaused(runId: string, resumePosition: number): Promise<void> {
  await updateRun(runId, {
    status: 'paused',
    paused_at: new Date().toISOString(),
    resume_position: resumePosition,
  });
}

export async function markRunCompleted(runId: string): Promise<void> {
  await updateRun(runId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    resume_position: null,
    error: null,
  });
}

export async function markRunFailed(runId: string, error: string): Promise<void> {
  await updateRun(runId, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    resume_position: null,
    error: error.slice(0, 2000),
  });
}

// -----------------------------------------------------------------------------
// step_runs
// -----------------------------------------------------------------------------

const UPSERT_STEP_RUN = /* GraphQL */ `
  mutation UpsertStepRun($object: step_runs_insert_input!, $update: [step_runs_update_column!]!) {
    insert_step_runs_one(
      object: $object
      on_conflict: { constraint: step_runs_unique_per_run, update_columns: $update }
    ) {
      id
      status
      attempt_count
    }
  }
`;

export interface StepRunPatch {
  status?: StepRunStatus;
  input?: Json;
  output?: Json;
  error?: string | null;
  attempt_count?: number;
  started_at?: string | null;
  completed_at?: string | null;
}

export async function upsertStepRun(
  runId: string,
  stepId: string,
  patch: StepRunPatch,
): Promise<{ id: string; status: string; attempt_count: number }> {
  const object = { workflow_run_id: runId, workflow_step_id: stepId, ...patch };
  const update = Object.keys(patch);

  const data = await adminRequest<{
    insert_step_runs_one: { id: string; status: string; attempt_count: number };
  }>(UPSERT_STEP_RUN, { object, update });

  return data.insert_step_runs_one;
}

const INSERT_SKIPPED = /* GraphQL */ `
  mutation InsertSkippedStepRuns($objects: [step_runs_insert_input!]!) {
    insert_step_runs(
      objects: $objects
      on_conflict: { constraint: step_runs_unique_per_run, update_columns: [] }
    ) {
      affected_rows
    }
  }
`;

/**
 * Give every step the run will not reach an observable `skipped` row, so the
 * UI can show the untaken branch greyed out rather than perpetually pending.
 */
export async function markStepsSkipped(runId: string, stepIds: string[]): Promise<number> {
  if (stepIds.length === 0) return 0;
  const now = new Date().toISOString();
  const objects = stepIds.map((id) => ({
    workflow_run_id: runId,
    workflow_step_id: id,
    status: 'skipped',
    completed_at: now,
  }));

  const data = await adminRequest<{ insert_step_runs: { affected_rows: number } }>(INSERT_SKIPPED, {
    objects,
  });
  return data.insert_step_runs.affected_rows;
}
