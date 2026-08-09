/**
 * Runtime authorization for Action handlers.
 *
 * THE RULE: nothing in the request body is trusted. The caller's identity comes
 * only from Hasura's session_variables (which Hasura derives from the verified
 * Nhost JWT and the client cannot forge). Organization and role are then
 * DERIVED by walking the database:
 *
 *     X-Hasura-User-Id
 *        -> step_run -> workflow_run -> workflow -> organization
 *        -> org_members(org_id, user_id) -> role
 *
 * A client that supplies org_id, role, or user_id gets those fields ignored.
 * A client that guesses a valid UUID from another organization fails at the
 * org_members lookup, which is the only place a role can come from.
 */

import { adminRequest } from '../lib/hasura.js';
import {
  ROLES_THAT_MAY_APPROVE,
  ROLES_THAT_MAY_EXECUTE,
  type OrgRole,
  type RunStatus,
  type StepRunStatus,
  type TriggerType,
} from '../types.js';

/** A failure that should surface to the client as a clean Action error. */
export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unauthenticated'
      | 'not_found'
      | 'forbidden'
      | 'invalid_state'
      | 'quota_exhausted' = 'forbidden',
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export interface SessionVariables {
  'x-hasura-user-id'?: string;
  'x-hasura-role'?: string;
  [k: string]: string | undefined;
}

/**
 * Extract the authenticated user id.
 *
 * Hasura populates these from the JWT it verified. The `admin` role is only
 * reachable with the admin secret, i.e. server-to-server, so it is not accepted
 * as a user identity here — an Action that needs a real user must have one.
 */
export function requireUserId(session: SessionVariables | undefined): string {
  const role = session?.['x-hasura-role'];
  const userId = session?.['x-hasura-user-id'];

  if (!userId || userId.trim() === '') {
    throw new AuthorizationError(
      role === 'admin'
        ? 'This action requires an authenticated end user; it cannot be called with the admin secret alone.'
        : 'Not authenticated.',
      'unauthenticated',
    );
  }
  return userId;
}

// -----------------------------------------------------------------------------
// Membership resolution
// -----------------------------------------------------------------------------

const WORKFLOW_AUTHZ = /* GraphQL */ `
  query WorkflowAuthorizationChain($workflow_id: uuid!, $user_id: uuid!) {
    workflows_by_pk(id: $workflow_id) {
      id
      name
      org_id
      status
      organization {
        id
        name
        quota_used
        quota_limit
        org_members(where: { user_id: { _eq: $user_id } }) {
          role
        }
      }
      workflow_steps_aggregate {
        aggregate {
          count
        }
      }
    }
  }
`;

export interface WorkflowAuthzResult {
  workflowId: string;
  workflowName: string;
  orgId: string;
  role: OrgRole;
  stepCount: number;
  quota: { used: number; limit: number };
}

/**
 * Authorize a user to execute a workflow.
 *
 * Deliberately returns the SAME error for "workflow does not exist" and
 * "workflow exists but you are not a member". Distinguishing them would turn
 * this Action into an oracle that confirms which UUIDs are real workflows in
 * other organizations.
 */
export async function authorizeWorkflowExecution(
  workflowId: string,
  userId: string,
  allowedRoles: readonly OrgRole[] = ROLES_THAT_MAY_EXECUTE,
): Promise<WorkflowAuthzResult> {
  if (!isUuid(workflowId)) {
    throw new AuthorizationError('workflow_id must be a UUID.', 'not_found');
  }

  const data = await adminRequest<{
    workflows_by_pk: {
      id: string;
      name: string;
      org_id: string;
      status: string;
      organization: {
        id: string;
        name: string;
        quota_used: number;
        quota_limit: number;
        org_members: Array<{ role: OrgRole }>;
      };
      workflow_steps_aggregate: { aggregate: { count: number } | null };
    } | null;
  }>(WORKFLOW_AUTHZ, { workflow_id: workflowId, user_id: userId });

  const wf = data.workflows_by_pk;
  const membership = wf?.organization.org_members[0];

  if (!wf || !membership) {
    throw new AuthorizationError(
      'Workflow not found or you do not have access to it.',
      'not_found',
    );
  }

  if (!allowedRoles.includes(membership.role)) {
    throw new AuthorizationError(
      `Your role in this organization is "${membership.role}"; ${allowedRoles.join(' or ')} is required to run a workflow.`,
      'forbidden',
    );
  }

  if (wf.status === 'archived') {
    throw new AuthorizationError('This workflow is archived and cannot be run.', 'invalid_state');
  }

  const stepCount = wf.workflow_steps_aggregate.aggregate?.count ?? 0;
  if (stepCount === 0) {
    throw new AuthorizationError('This workflow has no steps to execute.', 'invalid_state');
  }

  return {
    workflowId: wf.id,
    workflowName: wf.name,
    orgId: wf.org_id,
    role: membership.role,
    stepCount,
    quota: { used: wf.organization.quota_used, limit: wf.organization.quota_limit },
  };
}

// -----------------------------------------------------------------------------
// Approval authorization — the full chain, derived from the step_run id alone
// -----------------------------------------------------------------------------

const APPROVAL_AUTHZ = /* GraphQL */ `
  query ApprovalAuthorizationChain($step_run_id: uuid!, $user_id: uuid!) {
    step_runs_by_pk(id: $step_run_id) {
      id
      status
      approved_by
      approved_at
      workflow_step {
        id
        type
        name
        position
      }
      workflow_run {
        id
        status
        org_id
        workflow_id
        workflow {
          id
          name
          org_id
          organization {
            id
            org_members(where: { user_id: { _eq: $user_id } }) {
              role
            }
          }
        }
      }
    }
  }
`;

export interface ApprovalAuthzResult {
  stepRunId: string;
  stepName: string;
  stepPosition: number;
  runId: string;
  workflowId: string;
  orgId: string;
  role: OrgRole;
}

export async function authorizeApproval(
  stepRunId: string,
  userId: string,
  allowedRoles: readonly OrgRole[] = ROLES_THAT_MAY_APPROVE,
): Promise<ApprovalAuthzResult> {
  if (!isUuid(stepRunId)) {
    throw new AuthorizationError('step_run_id must be a UUID.', 'not_found');
  }

  const data = await adminRequest<{
    step_runs_by_pk: {
      id: string;
      status: StepRunStatus;
      approved_by: string | null;
      approved_at: string | null;
      workflow_step: { id: string; type: string; name: string; position: number };
      workflow_run: {
        id: string;
        status: RunStatus;
        org_id: string;
        workflow_id: string;
        workflow: {
          id: string;
          name: string;
          org_id: string;
          organization: { id: string; org_members: Array<{ role: OrgRole }> };
        };
      };
    } | null;
  }>(APPROVAL_AUTHZ, { step_run_id: stepRunId, user_id: userId });

  const sr = data.step_runs_by_pk;
  const membership = sr?.workflow_run.workflow.organization.org_members[0];

  // Same indistinguishable error as above: a non-member learns nothing about
  // whether the UUID they guessed exists.
  if (!sr || !membership) {
    throw new AuthorizationError(
      'Approval step not found or you do not have access to it.',
      'not_found',
    );
  }

  if (!allowedRoles.includes(membership.role)) {
    throw new AuthorizationError(
      `Your role in this organization is "${membership.role}"; ${allowedRoles.join(' or ')} is required to approve.`,
      'forbidden',
    );
  }

  // The step must genuinely be an approval gate — approving an llm_call would
  // otherwise be a way to hand-complete an arbitrary step.
  if (sr.workflow_step.type !== 'approval_gate') {
    throw new AuthorizationError(
      `Step "${sr.workflow_step.name}" is a ${sr.workflow_step.type}, not an approval_gate.`,
      'invalid_state',
    );
  }

  if (sr.approved_at !== null || sr.approved_by !== null) {
    throw new AuthorizationError('This approval has already been processed.', 'invalid_state');
  }

  if (sr.status !== 'paused') {
    throw new AuthorizationError(
      `This step is "${sr.status}", not awaiting approval.`,
      'invalid_state',
    );
  }

  if (sr.workflow_run.status !== 'paused') {
    throw new AuthorizationError(
      `The run is "${sr.workflow_run.status}", not paused.`,
      'invalid_state',
    );
  }

  return {
    stepRunId: sr.id,
    stepName: sr.workflow_step.name,
    stepPosition: sr.workflow_step.position,
    runId: sr.workflow_run.id,
    workflowId: sr.workflow_run.workflow_id,
    orgId: sr.workflow_run.org_id,
    role: membership.role,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
