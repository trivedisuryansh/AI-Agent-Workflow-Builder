/**
 * Shared domain types for the workflow engine.
 *
 * These mirror the database schema in hasura/migrations. Where a value is
 * constrained by a CHECK constraint in Postgres, it is a union type here so the
 * two definitions drift loudly rather than silently.
 */

export type OrgRole = 'owner' | 'editor' | 'viewer';

export type StepType =
  | 'llm_call'
  | 'http_request'
  | 'db_write'
  | 'notify'
  | 'conditional_branch'
  | 'approval_gate';

export type TriggerType = 'manual' | 'webhook' | 'scheduled' | 'database_event';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'skipped';

/** Step types only an organization owner may create or modify. */
export const RESTRICTED_STEP_TYPES: readonly StepType[] = ['db_write', 'notify'];

/** Trigger types only an organization owner may create or modify. */
export const RESTRICTED_TRIGGER_TYPES: readonly TriggerType[] = ['webhook'];

export const ROLES_THAT_MAY_EXECUTE: readonly OrgRole[] = ['owner', 'editor'];
export const ROLES_THAT_MAY_APPROVE: readonly OrgRole[] = ['owner', 'editor'];

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

export interface WorkflowStepRow {
  id: string;
  workflow_id: string;
  position: number;
  type: StepType;
  name: string;
  config: JsonObject;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  org_id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  triggered_by: string | null;
  input: JsonObject;
  resume_position: number | null;
  started_at: string | null;
  completed_at: string | null;
  paused_at: string | null;
  error: string | null;
}

export interface StepRunRow {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string;
  status: StepRunStatus;
  input: Json | null;
  output: Json | null;
  error: string | null;
  attempt_count: number;
  approved_by: string | null;
  approved_at: string | null;
}

// -----------------------------------------------------------------------------
// Step configuration shapes
// -----------------------------------------------------------------------------

export interface RetryConfig {
  /** Total attempts including the first. Minimum 1. Default STEP_MAX_ATTEMPTS. */
  max_attempts?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  base_delay_ms?: number;
}

export interface LlmCallConfig extends RetryConfig {
  provider?: 'groq' | 'openrouter' | 'gemini';
  model?: string;
  system_prompt?: string;
  prompt: string;
  temperature?: number;
  max_tokens?: number;
  /**
   * When set, the raw completion is parsed as JSON and, if it succeeds, exposed
   * as structured output. Used by the demo workflow so the conditional branch
   * can read `output.json.label` from a real model response.
   */
  parse_json?: boolean;
}

export interface HttpRequestConfig extends RetryConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  url: string;
  headers?: Record<string, string>;
  body?: Json;
  timeout_ms?: number;
  /** Treat these status codes as success in addition to 2xx. */
  accept_status?: number[];
}

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'matches'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'exists'
  | 'not_exists'
  | 'is_true'
  | 'is_false';

export interface Condition {
  /** Dot path into the run context, e.g. "previous.output.json.label". */
  path: string;
  operator: ConditionOperator;
  value?: Json;
}

/** Where a branch sends execution next. */
export type BranchTarget =
  | { goto_position: number }
  | { goto_step_id: string }
  | { action: 'continue' }
  | { action: 'end' };

export interface ConditionalBranchConfig {
  condition: Condition;
  on_true: BranchTarget;
  on_false: BranchTarget;
}

export interface DbWriteConfig {
  /** Key within workflow_outputs. Scoped to the current run's organization. */
  key: string;
  value: Json;
}

export interface NotifyConfig {
  channel?: 'slack' | 'email' | 'log';
  title?: string;
  message: string;
}

export interface ApprovalGateConfig {
  /** Shown in the approval UI. */
  message?: string;
}

// -----------------------------------------------------------------------------
// Execution results
// -----------------------------------------------------------------------------

export interface StepExecutionResult {
  output: Json;
  /** Set by conditional_branch to redirect the engine. */
  branch?: BranchTarget;
}

/** Thrown by step executors. `permanent` suppresses retries. */
export class StepError extends Error {
  readonly permanent: boolean;
  readonly details?: Json;

  constructor(message: string, opts: { permanent?: boolean; details?: Json } = {}) {
    super(message);
    this.name = 'StepError';
    this.permanent = opts.permanent ?? false;
    this.details = opts.details;
  }
}

/** Signals that the run must pause rather than fail. */
export class ApprovalRequired extends Error {
  constructor(readonly stepRunId: string) {
    super('approval required');
    this.name = 'ApprovalRequired';
  }
}
