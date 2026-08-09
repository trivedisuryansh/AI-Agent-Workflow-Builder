/**
 * The workflow execution engine.
 *
 * Entered from exactly three places, each of which has already authorized the
 * caller:
 *   - the Event Trigger fired by inserting a workflow_run (manual + webhook)
 *   - the approveStep Action, to resume a paused run
 *   - integration tests
 *
 * Execution is sequential over `position ASC`. A conditional_branch can jump
 * forward or end the run; every step it jumps over is recorded as `skipped`.
 * An approval_gate stops the loop, persists paused state, and returns — the
 * remaining steps are NOT executed until approveStep calls back in with
 * mode: 'resume'.
 */

import { evaluateCondition } from './conditions';
import { emptyContext, resolveTemplates, type RunContext } from './context';
import {
  claimRunForExecution,
  loadRunBundle,
  markRunCompleted,
  markRunFailed,
  markRunPaused,
  markStepsSkipped,
  updateRun,
  upsertStepRun,
  type RunBundle,
} from './repository';
import { resolvePolicy, withRetry } from './retry';
import { executeDbWrite } from '../steps/dbWrite';
import { executeHttpRequest } from '../steps/http';
import { executeLlmCall } from '../steps/llm';
import { executeNotify } from '../steps/notify';
import { config } from '../lib/env';
import {
  StepError,
  type BranchTarget,
  type ConditionalBranchConfig,
  type Json,
  type JsonObject,
  type StepExecutionResult,
  type WorkflowStepRow,
} from '../types';

export type ExecutionMode = 'start' | 'resume';

export interface ExecutionOutcome {
  runId: string;
  status: 'completed' | 'failed' | 'paused' | 'skipped_already_running' | 'noop';
  executedSteps: number;
  pausedAtStepId?: string;
  error?: string;
}

/** Rebuild the template context from step_runs already persisted for this run. */
function buildContext(bundle: RunBundle): RunContext {
  const ctx = emptyContext(
    {
      id: bundle.run.id,
      workflow_id: bundle.run.workflow_id,
      org_id: bundle.run.org_id,
    },
    bundle.run.input as Json,
  );

  const done = bundle.stepRuns
    .filter((sr) => sr.status === 'completed')
    .sort((a, b) => a.workflow_step.position - b.workflow_step.position);

  for (const sr of done) {
    ctx.steps[String(sr.workflow_step.position)] = {
      output: sr.output ?? null,
      status: sr.status,
      name: sr.workflow_step.name,
      type: sr.workflow_step.type,
    };
  }

  const last = done.at(-1);
  ctx.previous = last ? { output: last.output ?? null, status: last.status } : null;
  return ctx;
}

/** Resolve a branch target to an index in the ordered step list. */
function resolveBranchTarget(
  target: BranchTarget,
  steps: WorkflowStepRow[],
  currentIndex: number,
): { kind: 'index'; index: number } | { kind: 'end' } {
  if ('action' in target) {
    if (target.action === 'end') return { kind: 'end' };
    return { kind: 'index', index: currentIndex + 1 };
  }

  if ('goto_step_id' in target) {
    const idx = steps.findIndex((s) => s.id === target.goto_step_id);
    if (idx === -1) {
      throw new StepError(
        `conditional_branch target step ${target.goto_step_id} is not part of this workflow`,
        { permanent: true },
      );
    }
    return { kind: 'index', index: idx };
  }

  const idx = steps.findIndex((s) => s.position === target.goto_position);
  if (idx === -1) {
    throw new StepError(
      `conditional_branch target position ${target.goto_position} does not exist in this workflow`,
      { permanent: true },
    );
  }
  return { kind: 'index', index: idx };
}

async function runStepBody(
  step: WorkflowStepRow,
  resolvedConfig: JsonObject,
  runId: string,
  stepRunId: string,
  ctx: RunContext,
): Promise<StepExecutionResult> {
  switch (step.type) {
    case 'llm_call': {
      const cfg = resolvedConfig as never as import('../types').LlmCallConfig;
      return executeLlmCall(cfg, String(cfg.prompt ?? ''));
    }
    case 'http_request':
      return executeHttpRequest(resolvedConfig as never as import('../types').HttpRequestConfig);
    case 'db_write':
      return executeDbWrite(resolvedConfig as never as import('../types').DbWriteConfig, runId);
    case 'notify':
      return executeNotify(
        resolvedConfig as never as import('../types').NotifyConfig,
        runId,
        stepRunId,
      );
    case 'conditional_branch': {
      const cfg = resolvedConfig as never as ConditionalBranchConfig;
      if (!cfg?.condition?.path || !cfg.condition.operator) {
        throw new StepError('conditional_branch requires condition.path and condition.operator', {
          permanent: true,
        });
      }
      // Evaluated against the LIVE context, i.e. the output the previous step
      // actually produced during this run.
      const evaluation = evaluateCondition(cfg.condition, ctx);
      const branch = evaluation.result ? cfg.on_true : cfg.on_false;
      if (!branch) {
        throw new StepError(
          `conditional_branch is missing an "${evaluation.result ? 'on_true' : 'on_false'}" target`,
          { permanent: true },
        );
      }
      return {
        output: {
          matched: evaluation.result,
          path: evaluation.path,
          operator: evaluation.operator,
          expected: evaluation.expected,
          resolved: evaluation.resolved,
          taken: branch as unknown as Json,
        },
        branch,
      };
    }
    case 'approval_gate':
      // Never reached: the loop intercepts approval gates before executing.
      throw new StepError('approval_gate must be handled by the engine loop', { permanent: true });
    default: {
      const never: never = step.type;
      throw new StepError(`Unknown step type ${String(never)}`, { permanent: true });
    }
  }
}

export async function executeRun(
  runId: string,
  mode: ExecutionMode = 'start',
): Promise<ExecutionOutcome> {
  let bundle = await loadRunBundle(runId);
  if (!bundle) return { runId, status: 'noop', executedSteps: 0, error: 'run not found' };

  if (['completed', 'failed', 'cancelled'].includes(bundle.run.status)) {
    return { runId, status: 'noop', executedSteps: 0 };
  }

  if (mode === 'start') {
    // At-least-once event delivery means this can be entered twice.
    const claimed = await claimRunForExecution(runId);
    if (!claimed) return { runId, status: 'skipped_already_running', executedSteps: 0 };
    bundle = (await loadRunBundle(runId))!;
  } else {
    await updateRun(runId, { status: 'running', paused_at: null });
  }

  const { steps } = bundle;
  const ctx = buildContext(bundle);

  const defaults = {
    maxAttempts: config.stepMaxAttempts(),
    baseDelayMs: config.stepRetryBaseDelayMs(),
  };

  // Where to begin. On resume, the approval gate has already been completed and
  // resume_position points at the next step to run.
  let index = 0;
  if (mode === 'resume' && bundle.run.resume_position !== null) {
    const from = bundle.run.resume_position;
    index = steps.findIndex((s) => s.position >= from);
    if (index === -1) index = steps.length; // nothing left; fall through to completion
  }

  let executedSteps = 0;

  while (index < steps.length) {
    const step = steps[index];

    // ---------------------------------------------------------------- pause
    if (step.type === 'approval_gate') {
      const existing = bundle.stepRuns.find((sr) => sr.workflow_step_id === step.id);
      const alreadyApproved = existing?.status === 'completed' && existing.approved_at !== null;

      if (!alreadyApproved) {
        const cfg = resolveTemplates(step.config as Json, ctx) as JsonObject;
        await upsertStepRun(runId, step.id, {
          status: 'paused',
          input: cfg,
          started_at: new Date().toISOString(),
          error: null,
        });
        // The next step to execute once someone approves.
        const nextPosition = steps[index + 1]?.position ?? step.position + 1;
        await markRunPaused(runId, nextPosition);

        return {
          runId,
          status: 'paused',
          executedSteps,
          pausedAtStepId: step.id,
        };
      }
      // Approved already — treat it as done and move on.
      index += 1;
      continue;
    }

    // -------------------------------------------------------------- execute
    const resolvedConfig = resolveTemplates(step.config as Json, ctx) as JsonObject;
    const policy = resolvePolicy(
      resolvedConfig as { max_attempts?: number; base_delay_ms?: number },
      defaults,
    );

    const stepRun = await upsertStepRun(runId, step.id, {
      status: 'running',
      input: resolvedConfig,
      started_at: new Date().toISOString(),
      attempt_count: 0,
      error: null,
      output: null,
      completed_at: null,
    });

    let result: StepExecutionResult;
    try {
      result = await withRetry(
        () => runStepBody(step, resolvedConfig, runId, stepRun.id, ctx),
        policy,
        // Persist attempt_count after EVERY attempt so a watching subscription
        // shows "attempt 2 of 2" while the retry is in flight, not after.
        async (info) => {
          await upsertStepRun(runId, step.id, {
            attempt_count: info.attempt,
            ...(info.error && info.willRetry
              ? { error: `attempt ${info.attempt} failed, retrying in ${info.delayMs}ms: ${info.error.message}` }
              : {}),
          });
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await upsertStepRun(runId, step.id, {
        status: 'failed',
        error: message.slice(0, 2000),
        completed_at: new Date().toISOString(),
      });
      // Everything downstream is unreachable — record it rather than leaving it pending.
      await markStepsSkipped(
        runId,
        steps.slice(index + 1).map((s) => s.id),
      );
      await markRunFailed(runId, `step "${step.name}" (${step.type}) failed: ${message}`);
      return { runId, status: 'failed', executedSteps, error: message };
    }

    await upsertStepRun(runId, step.id, {
      status: 'completed',
      output: result.output,
      completed_at: new Date().toISOString(),
      error: null,
    });
    executedSteps += 1;

    // Feed this step's real output forward.
    ctx.steps[String(step.position)] = {
      output: result.output,
      status: 'completed',
      name: step.name,
      type: step.type,
    };
    ctx.previous = { output: result.output, status: 'completed' };

    // --------------------------------------------------------------- branch
    if (result.branch) {
      let target: ReturnType<typeof resolveBranchTarget>;
      try {
        target = resolveBranchTarget(result.branch, steps, index);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await upsertStepRun(runId, step.id, { status: 'failed', error: message });
        await markRunFailed(runId, message);
        return { runId, status: 'failed', executedSteps, error: message };
      }

      if (target.kind === 'end') {
        await markStepsSkipped(
          runId,
          steps.slice(index + 1).map((s) => s.id),
        );
        break;
      }

      if (target.index > index + 1) {
        // Steps between here and the target belong to the untaken branch.
        await markStepsSkipped(
          runId,
          steps.slice(index + 1, target.index).map((s) => s.id),
        );
      }
      if (target.index <= index) {
        const message = `conditional_branch would jump backwards (from position ${step.position}); loops are not supported`;
        await upsertStepRun(runId, step.id, { status: 'failed', error: message });
        await markRunFailed(runId, message);
        return { runId, status: 'failed', executedSteps, error: message };
      }
      index = target.index;
      continue;
    }

    index += 1;
  }

  await markRunCompleted(runId);
  return { runId, status: 'completed', executedSteps };
}
