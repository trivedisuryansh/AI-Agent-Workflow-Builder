'use client';

import { useEffect, useMemo, useState } from 'react';

import { useAuth, type OrgRole } from '../app/providers';
import {
  DELETE_STEP,
  DELETE_TRIGGER,
  GET_WEBHOOK_URL,
  INSERT_STEP,
  INSERT_TRIGGER,
  SET_TRIGGER_ENABLED,
  SWAP_STEP_POSITIONS,
  TRIGGER_WORKFLOW_RUN,
  UPDATE_STEP,
  UPDATE_WORKFLOW,
} from '../lib/queries';
import {
  defaultConfigFor,
  OWNER_ONLY_STEP_TYPES,
  OWNER_ONLY_TRIGGER_TYPES,
  STEP_LABELS,
  type StepType,
  type TriggerType,
  type Workflow,
} from '../lib/model';
import { RunPanel } from './RunPanel';

const ALL_STEP_TYPES: StepType[] = [
  'llm_call',
  'http_request',
  'conditional_branch',
  'approval_gate',
  'db_write',
  'notify',
];

const ALL_TRIGGER_TYPES: TriggerType[] = ['manual', 'webhook', 'scheduled'];

export function WorkflowEditor({
  workflow,
  role,
  quotaExhausted,
  onChanged,
}: {
  workflow: Workflow;
  role: OrgRole;
  quotaExhausted: boolean;
  onChanged: () => Promise<void>;
}) {
  const { runQuery, refreshOrganizations } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(
    workflow.workflow_runs[0]?.id ?? null,
  );
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [newStepType, setNewStepType] = useState<StepType>('llm_call');
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState('');

  const isOwner = role === 'owner';
  const canEdit = role === 'owner' || role === 'editor';
  const canRun = canEdit;

  // Follow the newest run when the workflow is reloaded after a trigger.
  useEffect(() => {
    const latest = workflow.workflow_runs[0]?.id ?? null;
    if (latest && latest !== activeRunId) setActiveRunId(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.workflow_runs[0]?.id]);

  const availableStepTypes = useMemo(
    () => ALL_STEP_TYPES.filter((t) => isOwner || !OWNER_ONLY_STEP_TYPES.includes(t)),
    [isOwner],
  );
  const availableTriggerTypes = useMemo(
    () =>
      ALL_TRIGGER_TYPES.filter(
        (t) =>
          (isOwner || !OWNER_ONLY_TRIGGER_TYPES.includes(t)) &&
          !workflow.workflow_triggers.some((existing) => existing.type === t),
      ),
    [isOwner, workflow.workflow_triggers],
  );

  async function act<T>(fn: () => Promise<T>): Promise<T | null> {
    setError(null);
    setBusy(true);
    try {
      const result = await fn();
      await onChanged();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const nextPosition = (workflow.workflow_steps.at(-1)?.position ?? 0) + 1;

  async function addStep() {
    await act(() =>
      runQuery(INSERT_STEP, {
        workflowId: workflow.id,
        position: nextPosition,
        type: newStepType,
        name: STEP_LABELS[newStepType],
        config: defaultConfigFor(newStepType),
      }),
    );
  }

  async function move(index: number, direction: -1 | 1) {
    const steps = workflow.workflow_steps;
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const a = steps[index];
    const b = steps[target];
    // Both updates in ONE request so the deferred unique constraint tolerates
    // the moment where the two rows share a position.
    await act(() =>
      runQuery(SWAP_STEP_POSITIONS, {
        aId: a.id,
        aPos: b.position,
        bId: b.id,
        bPos: a.position,
      }),
    );
  }

  async function saveConfig(stepId: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configDraft);
    } catch (err) {
      setError(`Config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const done = await act(() =>
      runQuery(UPDATE_STEP, { id: stepId, set: { config: parsed } }),
    );
    if (done) setEditingStepId(null);
  }

  async function run() {
    const data = await act(() =>
      runQuery<{ triggerWorkflowRun: { run_id: string } }>(TRIGGER_WORKFLOW_RUN, {
        workflowId: workflow.id,
        input: { source: 'manual' },
      }),
    );
    if (data) {
      setActiveRunId(data.triggerWorkflowRun.run_id);
      await refreshOrganizations();
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <input
              value={workflow.name}
              disabled={!canEdit || busy}
              onChange={() => undefined}
              onBlur={(e) => {
                if (e.target.value !== workflow.name) {
                  void act(() =>
                    runQuery(UPDATE_WORKFLOW, {
                      id: workflow.id,
                      set: { name: e.target.value },
                    }),
                  );
                }
              }}
              defaultValue={workflow.name}
              key={`${workflow.id}-name`}
            />
          </div>
          <button className="primary" disabled={!canRun || busy || quotaExhausted} onClick={run}>
            {quotaExhausted ? 'Quota exhausted' : 'Run workflow'}
          </button>
        </div>

        <textarea
          rows={2}
          placeholder="Description"
          disabled={!canEdit || busy}
          defaultValue={workflow.description ?? ''}
          key={`${workflow.id}-desc`}
          onBlur={(e) => {
            if (e.target.value !== (workflow.description ?? '')) {
              void act(() =>
                runQuery(UPDATE_WORKFLOW, {
                  id: workflow.id,
                  set: { description: e.target.value },
                }),
              );
            }
          }}
        />

        {!canRun && (
          <span className="muted">
            Your role is <strong>{role}</strong>, which cannot trigger runs. The
            triggerWorkflowRun Action rejects it server-side regardless of this button.
          </span>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>

      {/* ------------------------------------------------------------ steps */}
      <div className="panel stack">
        <strong>Steps</strong>

        {workflow.workflow_steps.length === 0 && (
          <span className="muted">No steps yet. Add one below.</span>
        )}

        {workflow.workflow_steps.map((step, index) => (
          <div key={step.id} className="step-row">
            <span className="mono muted" style={{ width: 20 }}>
              {step.position}
            </span>
            <div style={{ flex: 1 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  <strong>{step.name}</strong>{' '}
                  <span className="muted">({STEP_LABELS[step.type]})</span>
                  {OWNER_ONLY_STEP_TYPES.includes(step.type) && (
                    <span className="badge owner" style={{ marginLeft: 6 }}>
                      owner only
                    </span>
                  )}
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <button disabled={!canEdit || busy || index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button
                    disabled={!canEdit || busy || index === workflow.workflow_steps.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    disabled={!canEdit || busy}
                    onClick={() => {
                      setEditingStepId(editingStepId === step.id ? null : step.id);
                      setConfigDraft(JSON.stringify(step.config, null, 2));
                    }}
                  >
                    config
                  </button>
                  <button
                    className="danger"
                    disabled={!canEdit || busy}
                    onClick={() => act(() => runQuery(DELETE_STEP, { id: step.id }))}
                  >
                    remove
                  </button>
                </span>
              </div>

              {editingStepId === step.id && (
                <div className="stack" style={{ marginTop: 8 }}>
                  <textarea
                    rows={10}
                    value={configDraft}
                    onChange={(e) => setConfigDraft(e.target.value)}
                  />
                  <div className="row">
                    <button className="primary" disabled={busy} onClick={() => saveConfig(step.id)}>
                      Save config
                    </button>
                    <button onClick={() => setEditingStepId(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {canEdit && (
          <div className="row">
            <select
              value={newStepType}
              onChange={(e) => setNewStepType(e.target.value as StepType)}
              style={{ maxWidth: 260 }}
            >
              {availableStepTypes.map((t) => (
                <option key={t} value={t}>
                  {STEP_LABELS[t]}
                </option>
              ))}
            </select>
            <button disabled={busy} onClick={addStep}>
              Add step
            </button>
          </div>
        )}
        {canEdit && !isOwner && (
          <span className="muted">
            DB Write and Notify are not offered because your role is editor. Submitting them
            directly is refused by the Hasura insert check and by a database trigger.
          </span>
        )}
      </div>

      {/* --------------------------------------------------------- triggers */}
      <div className="panel stack">
        <strong>Triggers</strong>
        {workflow.workflow_triggers.length === 0 && <span className="muted">None.</span>}

        {workflow.workflow_triggers.map((trigger) => (
          <div key={trigger.id} className="step-row" style={{ alignItems: 'center' }}>
            <span style={{ flex: 1 }}>
              <strong>{trigger.type}</strong>{' '}
              <span className={trigger.enabled ? 'status-completed' : 'muted'}>
                {trigger.enabled ? 'enabled' : 'disabled'}
              </span>
              {OWNER_ONLY_TRIGGER_TYPES.includes(trigger.type) && (
                <span className="badge owner" style={{ marginLeft: 6 }}>
                  owner only
                </span>
              )}
            </span>
            {trigger.type === 'webhook' && isOwner && (
              <button
                disabled={busy}
                onClick={async () => {
                  const data = await act(() =>
                    runQuery<{ getWebhookUrl: { url: string } }>(GET_WEBHOOK_URL, {
                      triggerId: trigger.id,
                    }),
                  );
                  if (data) setWebhookUrl(data.getWebhookUrl.url);
                }}
              >
                Reveal URL
              </button>
            )}
            <button
              disabled={!canEdit || busy || (trigger.type === 'webhook' && !isOwner)}
              onClick={() =>
                act(() =>
                  runQuery(SET_TRIGGER_ENABLED, { id: trigger.id, enabled: !trigger.enabled }),
                )
              }
            >
              {trigger.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className="danger"
              disabled={!canEdit || busy || (trigger.type === 'webhook' && !isOwner)}
              onClick={() => act(() => runQuery(DELETE_TRIGGER, { id: trigger.id }))}
            >
              remove
            </button>
          </div>
        ))}

        {webhookUrl && (
          <div className="ok-box">
            <div>Webhook URL (owner-only; the secret is not readable through GraphQL):</div>
            <div className="mono" style={{ wordBreak: 'break-all', marginTop: 6 }}>
              {webhookUrl}
            </div>
          </div>
        )}

        {canEdit && availableTriggerTypes.length > 0 && (
          <div className="row">
            <select id="newTrigger" defaultValue={availableTriggerTypes[0]} style={{ maxWidth: 260 }}>
              {availableTriggerTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              disabled={busy}
              onClick={() => {
                const el = document.getElementById('newTrigger') as HTMLSelectElement | null;
                const type = (el?.value ?? 'manual') as TriggerType;
                void act(() =>
                  runQuery(INSERT_TRIGGER, {
                    workflowId: workflow.id,
                    type,
                    config: type === 'scheduled' ? { every_minutes: 60 } : {},
                  }),
                );
              }}
            >
              Add trigger
            </button>
          </div>
        )}
        {canEdit && !isOwner && (
          <span className="muted">Webhook triggers are owner-only (Layer 2).</span>
        )}
      </div>

      {/* -------------------------------------------------------------- run */}
      {activeRunId && (
        <RunPanel runId={activeRunId} workflow={workflow} canApprove={canEdit} />
      )}

      {workflow.workflow_runs.length > 0 && (
        <div className="panel stack">
          <strong>Recent runs</strong>
          {workflow.workflow_runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setActiveRunId(r.id)}
              style={{ textAlign: 'left', background: r.id === activeRunId ? 'var(--panel-2)' : undefined }}
            >
              <span className={`status-${r.status}`}>{r.status}</span>{' '}
              <span className="muted">· {r.trigger_type} ·</span>{' '}
              <span className="mono muted">{r.id.slice(0, 8)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
