/** Shapes the UI renders, mirroring what the GraphQL documents select. */

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

export interface WorkflowStep {
  id: string;
  position: number;
  type: StepType;
  name: string;
  config: Record<string, unknown>;
}

export interface WorkflowTrigger {
  id: string;
  type: TriggerType;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface WorkflowRunSummary {
  id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  started_at: string | null;
  completed_at: string | null;
  paused_at?: string | null;
  error: string | null;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'archived';
  created_at: string;
  workflow_steps: WorkflowStep[];
  workflow_triggers: WorkflowTrigger[];
  workflow_runs: WorkflowRunSummary[];
}

export interface StepRun {
  id: string;
  workflow_step_id: string;
  status: StepRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  attempt_count: number;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  workflow_step: { id: string; position: number; name: string; type: StepType };
}

/**
 * Step types only an organization OWNER may add. Mirrors
 * RESTRICTED_STEP_TYPES in the engine and the Hasura permission expression.
 *
 * This constant drives whether the UI offers these options. That is a
 * convenience, NOT a control: an editor who bypasses the UI and posts the
 * mutation directly is refused by the Hasura insert check, and refused again by
 * a database trigger. See tests/integration/layer2-restrictions.test.ts.
 */
export const OWNER_ONLY_STEP_TYPES: readonly StepType[] = ['db_write', 'notify'];
export const OWNER_ONLY_TRIGGER_TYPES: readonly TriggerType[] = ['webhook'];

export const STEP_LABELS: Record<StepType, string> = {
  llm_call: 'LLM Call',
  http_request: 'HTTP Request',
  conditional_branch: 'Conditional Branch',
  approval_gate: 'Approval Gate',
  db_write: 'DB Write',
  notify: 'Notify',
};

export const STEP_ICONS: Record<StepRunStatus | 'unstarted', string> = {
  completed: '✓',
  running: '→',
  paused: '⏸',
  failed: '✗',
  skipped: '⊘',
  pending: '○',
  unstarted: '○',
};

/** Sensible starting config when a step is added, so nothing is born invalid. */
export function defaultConfigFor(type: StepType): Record<string, unknown> {
  switch (type) {
    case 'llm_call':
      return {
        system_prompt:
          'You classify support tickets. Reply ONLY with JSON: {"label":"needs_approval"|"auto_resolve","confidence":0-1,"reason":"..."}',
        prompt: 'Ticket: {{trigger.body.text}}',
        parse_json: true,
        max_attempts: 2,
      };
    case 'http_request':
      return {
        method: 'GET',
        url: 'https://httpbingo.org/uuid',
        timeout_ms: 10000,
        max_attempts: 2,
      };
    case 'conditional_branch':
      return {
        condition: {
          path: 'steps.1.output.json.label',
          operator: 'equals',
          value: 'needs_approval',
        },
        on_true: { action: 'continue' },
        on_false: { action: 'end' },
      };
    case 'approval_gate':
      return { message: 'A human needs to confirm this before the workflow continues.' };
    case 'db_write':
      return { key: 'verdict', value: '{{steps.1.output.json}}' };
    case 'notify':
      return {
        channel: 'log',
        title: 'Workflow finished',
        message: 'Run {{run.id}} completed after approval.',
      };
  }
}
