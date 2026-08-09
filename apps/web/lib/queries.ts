/**
 * Every GraphQL document the browser sends.
 *
 * Note that none of these take an org id from application state as an authority
 * — where an $orgId appears it is a FILTER for convenience, not a permission.
 * Hasura intersects it with the caller's org_members rows, so substituting
 * another organization's id returns an empty list rather than its data. The
 * cross-org test suite asserts exactly that.
 */

export const MY_ORGANIZATIONS = /* GraphQL */ `
  query MyOrganizations {
    org_members(order_by: { created_at: asc }) {
      id
      role
      org_id
      organization {
        id
        name
        slug
        quota_used
        quota_limit
        quota_period_start
        usage_stats {
          total_runs
          runs_this_period
          completed_runs
          failed_runs
          paused_runs
          quota_remaining
          avg_run_duration_seconds
        }
      }
    }
  }
`;

export const WORKFLOWS_FOR_ORG = /* GraphQL */ `
  query WorkflowsForOrg($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
      id
      name
      description
      status
      created_at
      workflow_steps(order_by: { position: asc }) {
        id
        position
        type
        name
        config
      }
      workflow_triggers(order_by: { type: asc }) {
        id
        type
        enabled
        config
      }
      workflow_runs(order_by: { created_at: desc }, limit: 1) {
        id
        status
        trigger_type
        started_at
        completed_at
        paused_at
        error
      }
    }
  }
`;

export const RUNS_FOR_WORKFLOW = /* GraphQL */ `
  query RunsForWorkflow($workflowId: uuid!) {
    workflow_runs(
      where: { workflow_id: { _eq: $workflowId } }
      order_by: { created_at: desc }
      limit: 10
    ) {
      id
      status
      trigger_type
      started_at
      completed_at
      error
      created_at
    }
  }
`;

/**
 * The live view. Filtered by workflow_run_id, and additionally constrained by
 * the step_runs select permission, so subscribing to another organization's run
 * id yields an empty stream.
 */
export const WATCH_RUN = /* GraphQL */ `
  subscription WatchWorkflowRun($runId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { created_at: asc }) {
      id
      workflow_step_id
      status
      input
      output
      error
      attempt_count
      approved_by
      approved_at
      started_at
      completed_at
      workflow_step {
        id
        position
        name
        type
      }
    }
  }
`;

export const WATCH_RUN_STATUS = /* GraphQL */ `
  subscription WatchRunStatus($runId: uuid!) {
    workflow_runs(where: { id: { _eq: $runId } }) {
      id
      status
      error
      started_at
      completed_at
      paused_at
    }
  }
`;

export const WATCH_ORG_QUOTA = /* GraphQL */ `
  subscription WatchOrgQuota($orgId: uuid!) {
    organizations(where: { id: { _eq: $orgId } }) {
      id
      quota_used
      quota_limit
    }
  }
`;

// ----------------------------------------------------------------- mutations

export const CREATE_WORKFLOW = /* GraphQL */ `
  mutation CreateWorkflow($orgId: uuid!, $name: String!, $description: String) {
    insert_workflows_one(object: { org_id: $orgId, name: $name, description: $description }) {
      id
      name
    }
  }
`;

export const UPDATE_WORKFLOW = /* GraphQL */ `
  mutation UpdateWorkflow($id: uuid!, $set: workflows_set_input!) {
    update_workflows_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      name
      description
      status
    }
  }
`;

export const DELETE_WORKFLOW = /* GraphQL */ `
  mutation DeleteWorkflow($id: uuid!) {
    delete_workflows_by_pk(id: $id) {
      id
    }
  }
`;

export const INSERT_STEP = /* GraphQL */ `
  mutation InsertStep(
    $workflowId: uuid!
    $position: Int!
    $type: String!
    $name: String!
    $config: jsonb!
  ) {
    insert_workflow_steps_one(
      object: {
        workflow_id: $workflowId
        position: $position
        type: $type
        name: $name
        config: $config
      }
    ) {
      id
      position
      type
      name
    }
  }
`;

export const UPDATE_STEP = /* GraphQL */ `
  mutation UpdateStep($id: uuid!, $set: workflow_steps_set_input!) {
    update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      position
      name
      config
    }
  }
`;

export const DELETE_STEP = /* GraphQL */ `
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) {
      id
    }
  }
`;

/**
 * Reorder in ONE mutation. Hasura wraps a multi-mutation request in a single
 * transaction, and workflow_steps_unique_position is DEFERRABLE, so the
 * intermediate state where two steps briefly share a position is legal until
 * commit. Doing this as separate requests would hit the constraint.
 */
export const SWAP_STEP_POSITIONS = /* GraphQL */ `
  mutation SwapStepPositions($aId: uuid!, $aPos: Int!, $bId: uuid!, $bPos: Int!) {
    a: update_workflow_steps_by_pk(pk_columns: { id: $aId }, _set: { position: $aPos }) {
      id
      position
    }
    b: update_workflow_steps_by_pk(pk_columns: { id: $bId }, _set: { position: $bPos }) {
      id
      position
    }
  }
`;

export const INSERT_TRIGGER = /* GraphQL */ `
  mutation InsertTrigger($workflowId: uuid!, $type: String!, $config: jsonb!) {
    insert_workflow_triggers_one(
      object: { workflow_id: $workflowId, type: $type, config: $config }
    ) {
      id
      type
      enabled
    }
  }
`;

export const SET_TRIGGER_ENABLED = /* GraphQL */ `
  mutation SetTriggerEnabled($id: uuid!, $enabled: Boolean!) {
    update_workflow_triggers_by_pk(pk_columns: { id: $id }, _set: { enabled: $enabled }) {
      id
      enabled
    }
  }
`;

export const DELETE_TRIGGER = /* GraphQL */ `
  mutation DeleteTrigger($id: uuid!) {
    delete_workflow_triggers_by_pk(id: $id) {
      id
    }
  }
`;

// ------------------------------------------------------------------- actions

export const TRIGGER_WORKFLOW_RUN = /* GraphQL */ `
  mutation TriggerWorkflowRun($workflowId: uuid!, $input: jsonb) {
    triggerWorkflowRun(workflow_id: $workflowId, input: $input) {
      run_id
      status
      workflow_id
      quota_used
      quota_limit
    }
  }
`;

export const APPROVE_STEP = /* GraphQL */ `
  mutation ApproveStep($stepRunId: uuid!, $note: String) {
    approveStep(step_run_id: $stepRunId, note: $note) {
      step_run_id
      run_id
      approved_by
      approved_at
      run_status
    }
  }
`;

export const GET_WEBHOOK_URL = /* GraphQL */ `
  mutation GetWebhookUrl($triggerId: uuid!) {
    getWebhookUrl(trigger_id: $triggerId) {
      trigger_id
      url
      enabled
    }
  }
`;

export const WORKFLOW_OUTPUTS = /* GraphQL */ `
  query WorkflowOutputs($runId: uuid!) {
    workflow_outputs(where: { workflow_run_id: { _eq: $runId } }, order_by: { created_at: asc }) {
      id
      key
      value
      created_at
    }
    notifications(where: { workflow_run_id: { _eq: $runId } }, order_by: { created_at: asc }) {
      id
      channel
      status
      payload
      error
      sent_at
    }
  }
`;
