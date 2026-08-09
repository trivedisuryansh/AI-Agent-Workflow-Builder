/**
 * Run creation.
 *
 * Creating the row is the whole job: the Event Trigger on workflow_runs INSERT
 * is what actually starts execution. Splitting it that way keeps the Action
 * response fast (the client gets a run id to subscribe to immediately) and
 * means a crashed handler cannot leave a run that nobody will ever pick up —
 * Hasura will redeliver the event.
 *
 * Note the columns NOT passed: org_id is derived by a database trigger from the
 * workflow, so it cannot be spoofed even here.
 */

import { adminRequest } from '../lib/hasura';
import { releaseQuota, reserveQuota, type QuotaReservation } from './quota';
import type { Json, TriggerType } from '../types';

const CREATE_RUN = /* GraphQL */ `
  mutation CreateWorkflowRun(
    $workflow_id: uuid!
    $trigger_type: String!
    $triggered_by: uuid
    $input: jsonb!
  ) {
    insert_workflow_runs_one(
      object: {
        workflow_id: $workflow_id
        trigger_type: $trigger_type
        triggered_by: $triggered_by
        input: $input
        status: "pending"
      }
    ) {
      id
      status
      org_id
      created_at
    }
  }
`;

export interface CreatedRun {
  runId: string;
  status: string;
  orgId: string;
  quota: QuotaReservation;
}

/**
 * Reserve quota, then create the run. If run creation fails, the reservation is
 * refunded so a transient database error does not silently cost the customer an
 * execution.
 */
export async function createRunWithQuota(params: {
  workflowId: string;
  orgId: string;
  triggerType: TriggerType;
  triggeredBy: string | null;
  input: Json;
}): Promise<CreatedRun> {
  const quota = await reserveQuota(params.orgId);

  try {
    const data = await adminRequest<{
      insert_workflow_runs_one: { id: string; status: string; org_id: string } | null;
    }>(CREATE_RUN, {
      workflow_id: params.workflowId,
      trigger_type: params.triggerType,
      triggered_by: params.triggeredBy,
      input: params.input ?? {},
    });

    const row = data.insert_workflow_runs_one;
    if (!row) throw new Error('workflow_run insert returned no row');

    return { runId: row.id, status: row.status, orgId: row.org_id, quota };
  } catch (err) {
    await releaseQuota(params.orgId);
    throw err;
  }
}
