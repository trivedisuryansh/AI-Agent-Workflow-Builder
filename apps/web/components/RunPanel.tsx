'use client';

import { useMemo, useState } from 'react';

import { useAuth } from '../app/providers';
import { useSubscription } from '../lib/useSubscription';
import { APPROVE_STEP, WATCH_RUN, WATCH_RUN_STATUS, WORKFLOW_OUTPUTS } from '../lib/queries';
import {
  STEP_ICONS,
  STEP_LABELS,
  type RunStatus,
  type StepRun,
  type Workflow,
} from '../lib/model';

/**
 * Live run view.
 *
 * Everything rendered here comes off two GraphQL subscriptions. No status is
 * ever set locally in response to a click — pressing Approve calls the Action
 * and then waits for the socket to report what actually happened, which is why
 * a failure after approval shows as failed rather than as a wishful "done".
 */
export function RunPanel({
  runId,
  workflow,
  canApprove,
}: {
  runId: string;
  workflow: Workflow;
  canApprove: boolean;
}) {
  const { session, runQuery, refreshOrganizations } = useAuth();
  const [approving, setApproving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<{
    workflow_outputs: Array<{ id: string; key: string; value: unknown }>;
    notifications: Array<{ id: string; channel: string; status: string; error: string | null }>;
  } | null>(null);

  const stepRunsState = useSubscription<{ step_runs: StepRun[] }>(
    WATCH_RUN,
    { runId },
    session,
    Boolean(runId),
  );

  const runState = useSubscription<{
    workflow_runs: Array<{
      id: string;
      status: RunStatus;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
      paused_at: string | null;
    }>;
  }>(WATCH_RUN_STATUS, { runId }, session, Boolean(runId));

  const run = runState.data?.workflow_runs?.[0] ?? null;
  const stepRuns = stepRunsState.data?.step_runs ?? [];

  const byStepId = useMemo(() => {
    const map = new Map<string, StepRun>();
    for (const sr of stepRuns) map.set(sr.workflow_step_id, sr);
    return map;
  }, [stepRuns]);

  const pausedStepRun = stepRuns.find((sr) => sr.status === 'paused');
  const terminal = run && ['completed', 'failed', 'cancelled'].includes(run.status);

  async function loadOutputs() {
    try {
      const data = await runQuery<typeof outputs>(WORKFLOW_OUTPUTS, { runId });
      setOutputs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function approve(stepRunId: string) {
    setError(null);
    setApproving(stepRunId);
    try {
      await runQuery(APPROVE_STEP, { stepRunId, note: null });
      // Deliberately not setting any local status: the subscription reports the
      // real outcome, including a failure in a step after the gate.
      await refreshOrganizations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(null);
    }
  }

  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Run</strong>
        <span className="row" style={{ gap: 8 }}>
          {run ? (
            <span className={`status-${run.status}`}>
              {run.status === 'running' && <span className="spinner" />} {run.status.toUpperCase()}
            </span>
          ) : (
            <span className="muted">connecting…</span>
          )}
          <span
            className="muted mono"
            title={stepRunsState.connected ? 'Subscription connected' : 'Subscription offline'}
          >
            {stepRunsState.connected ? '● live' : '○ offline'}
          </span>
        </span>
      </div>

      <div className="mono muted">{runId}</div>

      {stepRunsState.error && <div className="error-box">Subscription: {stepRunsState.error}</div>}
      {error && <div className="error-box">{error}</div>}
      {run?.error && <div className="error-box">{run.error}</div>}

      <div className="stack" style={{ gap: 6 }}>
        {workflow.workflow_steps.map((step) => {
          const sr = byStepId.get(step.id);
          const status = sr?.status ?? 'pending';
          const icon = STEP_ICONS[status] ?? '○';
          return (
            <div key={step.id} className="step-row" style={{ alignItems: 'center' }}>
              <span className={`status-${status}`} style={{ width: 16, textAlign: 'center' }}>
                {status === 'running' ? <span className="spinner" /> : icon}
              </span>
              <span style={{ flex: 1 }}>
                <span className="muted mono">{step.position}.</span> {step.name}{' '}
                <span className="muted">({STEP_LABELS[step.type]})</span>
                {sr && sr.attempt_count > 1 && (
                  <span className="muted"> · attempt {sr.attempt_count}</span>
                )}
                {sr?.approved_at && <span className="status-completed"> · approved</span>}
                {sr?.error && <div className="mono status-failed">{sr.error}</div>}
                {status === 'paused' && (
                  <div className="status-paused" style={{ fontWeight: 600 }}>
                    Waiting for approval
                  </div>
                )}
              </span>
              {sr?.output != null && (
                <details>
                  <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                    output
                  </summary>
                  <pre>{JSON.stringify(sr.output, null, 2)}</pre>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {pausedStepRun && (
        <div className="panel stack" style={{ borderColor: 'var(--warn)' }}>
          <strong className="status-paused">Waiting for approval</strong>
          <span className="muted">
            {(pausedStepRun.input as { message?: string } | null)?.message ??
              'This run is paused at an approval gate.'}
          </span>
          {canApprove ? (
            <button
              className="primary"
              disabled={approving !== null}
              onClick={() => approve(pausedStepRun.id)}
            >
              {approving ? 'Approving…' : 'Approve and resume'}
            </button>
          ) : (
            <span className="muted">
              Your role in this organization cannot approve. Approval is enforced by the
              approveStep Action, not by this button being hidden.
            </span>
          )}
        </div>
      )}

      {terminal && (
        <div className="row" style={{ gap: 8 }}>
          <button onClick={loadOutputs}>Show persisted outputs &amp; notifications</button>
        </div>
      )}

      {outputs && (
        <div className="stack" style={{ gap: 8 }}>
          <div>
            <strong>workflow_outputs</strong>
            {outputs.workflow_outputs.length === 0 ? (
              <div className="muted">none</div>
            ) : (
              outputs.workflow_outputs.map((o) => (
                <div key={o.id}>
                  <span className="mono">{o.key}</span>
                  <pre>{JSON.stringify(o.value, null, 2)}</pre>
                </div>
              ))
            )}
          </div>
          <div>
            <strong>notifications</strong>
            {outputs.notifications.length === 0 ? (
              <div className="muted">none</div>
            ) : (
              outputs.notifications.map((n) => (
                <div key={n.id} className="mono">
                  {n.channel} · <span className={`status-${n.status === 'sent' ? 'completed' : 'failed'}`}>{n.status}</span>
                  {n.error ? ` · ${n.error}` : ''}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
