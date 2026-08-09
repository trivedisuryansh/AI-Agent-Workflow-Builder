/** Public surface of the workflow engine package. */

export * from './types';

export { config, boolEnv, intEnv, optional, required } from './lib/env';
export { adminRequest, userRequest, GraphQLRequestError } from './lib/hasura';

export {
  AuthorizationError,
  authorizeApproval,
  authorizeWorkflowExecution,
  isUuid,
  requireUserId,
  type ApprovalAuthzResult,
  type SessionVariables,
  type WorkflowAuthzResult,
} from './core/authz';

export { approveAndResume, type ApprovalResult } from './core/approval';
export { releaseQuota, reserveQuota, type QuotaReservation } from './core/quota';
export { createRunWithQuota, type CreatedRun } from './core/runs';

export { evaluateCondition, type ConditionEvaluation } from './core/conditions';
export {
  emptyContext,
  resolvePath,
  resolveTemplates,
  type RunContext,
} from './core/context';
export { backoffDelay, isRetryable, resolvePolicy, sleep, withRetry } from './core/retry';
export { executeRun, type ExecutionMode, type ExecutionOutcome } from './core/engine';

export {
  claimRunForExecution,
  loadRunBundle,
  markRunCompleted,
  markRunFailed,
  markRunPaused,
  markStepsSkipped,
  updateRun,
  upsertStepRun,
  type RunBundle,
  type StepRunPatch,
} from './core/repository';

export { executeHttpRequest, isBlockedAddress } from './steps/http';
export { executeLlmCall, extractJson } from './steps/llm';
export { executeDbWrite } from './steps/dbWrite';
export { executeNotify } from './steps/notify';
