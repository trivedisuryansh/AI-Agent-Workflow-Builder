/**
 * End-to-end workflow execution: the assignment's core scenario.
 *
 * trigger -> run -> step_runs -> LLM -> HTTP -> conditional branch ->
 * approval pause -> live subscription -> approve -> resume -> completion,
 * plus the cross-org approval and subscription attacks.
 *
 * Requires `npm run dev` (or a deployed APP_BASE_URL) so Hasura can reach the
 * Action and Event Trigger handlers.
 */

import { createClient } from 'graphql-ws';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  asAdmin,
  asUser,
  asUserOk,
  ensureQuota,
  fixture,
  waitFor,
  WS_URL,
  type Actor,
  type Fixture,
} from './helpers';

let f: Fixture;

const TRIGGER = /* GraphQL */ `
  mutation ($id: uuid!, $input: jsonb) {
    triggerWorkflowRun(workflow_id: $id, input: $input) {
      run_id
      status
      quota_used
      quota_limit
    }
  }
`;

const RUN_STATE = /* GraphQL */ `
  query ($id: uuid!) {
    workflow_runs_by_pk(id: $id) {
      id
      status
      error
      started_at
      completed_at
      paused_at
      resume_position
    }
    step_runs(where: { workflow_run_id: { _eq: $id } }, order_by: { created_at: asc }) {
      id
      status
      output
      error
      attempt_count
      approved_by
      approved_at
      workflow_step {
        position
        type
        name
      }
    }
  }
`;

interface RunState {
  workflow_runs_by_pk: {
    id: string;
    status: string;
    error: string | null;
    completed_at: string | null;
    paused_at: string | null;
    resume_position: number | null;
  } | null;
  step_runs: Array<{
    id: string;
    status: string;
    output: Record<string, unknown> | null;
    error: string | null;
    attempt_count: number;
    approved_by: string | null;
    approved_at: string | null;
    workflow_step: { position: number; type: string; name: string };
  }>;
}

const readRun = (actor: Actor, runId: string) =>
  asUserOk<RunState>(actor, RUN_STATE, { id: runId });

/** Text engineered to make the classifier choose the approval branch. */
const ESCALATE_TEXT =
  'Our checkout has been completely down for over an hour, we are losing sales, ' +
  'and I am demanding a full refund immediately. This is unacceptable.';

/** Text that should take the auto-resolve branch. */
const BENIGN_TEXT = 'Hi, could you tell me how to change the avatar on my profile? Thanks!';

beforeAll(async () => {
  f = await fixture();
  await ensureQuota(f.orgAId, 60);
});

// -----------------------------------------------------------------------------

describe('full run: branch true -> approval pause -> approve -> resume -> complete', () => {
  let runId: string;

  it('the owner triggers a run and gets a run id back immediately', async () => {
    const r = await asUser<{ triggerWorkflowRun: { run_id: string; status: string } }>(
      f.ownerA,
      TRIGGER,
      { id: f.workflowId, input: { body: { text: ESCALATE_TEXT } } },
    );
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    runId = r.data!.triggerWorkflowRun.run_id;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('executes the LLM and HTTP steps, then pauses at the approval gate', async () => {
    const state = await waitFor(
      () => readRun(f.ownerA, runId),
      (s) => s.workflow_runs_by_pk?.status === 'paused' || s.workflow_runs_by_pk?.status === 'failed',
      { timeoutMs: 90_000, label: 'run to reach paused' },
    );

    const run = state.workflow_runs_by_pk!;
    expect(run.error, `run failed: ${run.error}`).toBeNull();
    expect(run.status).toBe('paused');
    expect(run.paused_at).not.toBeNull();

    const byPosition = new Map(state.step_runs.map((s) => [s.workflow_step.position, s]));

    // 1. LLM produced real output.
    const llm = byPosition.get(1)!;
    expect(llm.status).toBe('completed');
    expect(llm.output).toMatchObject({ provider: expect.any(String) });
    expect(typeof (llm.output as { text?: string }).text).toBe('string');

    // 2. HTTP call succeeded.
    const http = byPosition.get(2)!;
    expect(http.status).toBe('completed');
    expect((http.output as { status?: number }).status).toBeGreaterThanOrEqual(200);
    expect((http.output as { status?: number }).status).toBeLessThan(300);

    // 3. Branch evaluated against the LLM's ACTUAL output for this run.
    const branch = byPosition.get(3)!;
    expect(branch.status).toBe('completed');
    const branchOut = branch.output as { matched: boolean; resolved: unknown; path: string };
    expect(branchOut.path).toBe('steps.1.output.json.label');
    expect(branchOut.matched).toBe(true);
    expect(branchOut.resolved).toBe('needs_approval');

    // 4. Approval gate is paused, and nothing beyond it has run.
    const gate = byPosition.get(4)!;
    expect(gate.status).toBe('paused');

    const dbWrite = byPosition.get(5);
    expect(
      dbWrite === undefined || dbWrite.status === 'pending',
      'db_write must NOT execute before approval',
    ).toBe(true);
  });

  it('a viewer cannot approve', async () => {
    const state = await readRun(f.ownerA, runId);
    const gate = state.step_runs.find((s) => s.status === 'paused')!;

    const r = await asUser(
      f.viewerA,
      /* GraphQL */ `mutation ($id: uuid!) { approveStep(step_run_id: $id) { run_status } }`,
      { id: gate.id },
    );
    expect(r.errors).toBeDefined();
    expect(r.errors![0].message).toMatch(/viewer|required to approve/i);
  });

  it('Org B cannot approve an Org A gate even with the exact step_run id', async () => {
    const state = await readRun(f.ownerA, runId);
    const gate = state.step_runs.find((s) => s.status === 'paused')!;

    const r = await asUser(
      f.ownerB,
      /* GraphQL */ `mutation ($id: uuid!) { approveStep(step_run_id: $id) { run_status } }`,
      { id: gate.id },
    );
    expect(r.errors).toBeDefined();
    expect(r.errors![0].message).toMatch(/not found|do not have access/i);

    // And the run is still paused — the failed attempt changed nothing.
    const after = await readRun(f.ownerA, runId);
    expect(after.workflow_runs_by_pk!.status).toBe('paused');
    expect(after.step_runs.find((s) => s.id === gate.id)!.approved_by).toBeNull();
  });

  it('Org B cannot observe the run through a subscription', async () => {
    // Subscribes with a valid Org B token to a known Org A run id.
    const client = createClient({
      url: WS_URL,
      lazy: true,
      retryAttempts: 0,
      connectionParams: { headers: { authorization: `Bearer ${f.ownerB.accessToken}` } },
    });

    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose();
        resolve();
      }, 8000);

      const dispose = client.subscribe(
        {
          query: /* GraphQL */ `
            subscription ($id: uuid!) {
              step_runs(where: { workflow_run_id: { _eq: $id } }) { id status output }
            }
          `,
          variables: { id: runId },
        },
        {
          next: (msg) => {
            received.push((msg.data as { step_runs?: unknown[] })?.step_runs ?? []);
          },
          error: (err) => {
            clearTimeout(timer);
            // A hard rejection is also an acceptable outcome.
            resolve();
            void err;
          },
          complete: () => {
            clearTimeout(timer);
            resolve();
          },
        },
      );
      void reject;
    });

    await client.dispose();

    // Whatever arrived must contain no rows: the permission filter applies to
    // subscriptions exactly as it does to queries.
    for (const batch of received) {
      expect(batch, 'Org B received Org A step_runs over a subscription').toEqual([]);
    }
  });

  it('an owner CAN approve, and the remaining steps then actually execute', async () => {
    const before = await readRun(f.ownerA, runId);
    const gate = before.step_runs.find((s) => s.status === 'paused')!;

    const r = await asUser<{ approveStep: { run_status: string; approved_by: string } }>(
      f.ownerA,
      /* GraphQL */ `
        mutation ($id: uuid!) {
          approveStep(step_run_id: $id) { step_run_id run_id approved_by approved_at run_status }
        }
      `,
      { id: gate.id },
    );
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data!.approveStep.approved_by).toBe(f.ownerA.userId);

    const state = await waitFor(
      () => readRun(f.ownerA, runId),
      (s) => ['completed', 'failed'].includes(s.workflow_runs_by_pk?.status ?? ''),
      { timeoutMs: 60_000, label: 'run to finish after approval' },
    );

    const run = state.workflow_runs_by_pk!;
    expect(run.error, `run failed after approval: ${run.error}`).toBeNull();
    expect(run.status).toBe('completed');
    expect(run.completed_at).not.toBeNull();

    const byPosition = new Map(state.step_runs.map((s) => [s.workflow_step.position, s]));

    // The gate records who approved it.
    const approvedGate = byPosition.get(4)!;
    expect(approvedGate.status).toBe('completed');
    expect(approvedGate.approved_by).toBe(f.ownerA.userId);
    expect(approvedGate.approved_at).not.toBeNull();

    // The steps AFTER the gate genuinely ran — the run was not just flipped
    // to completed on approval.
    expect(byPosition.get(5)!.status, 'db_write must run after approval').toBe('completed');
    expect((byPosition.get(5)!.output as { written?: boolean }).written).toBe(true);
    expect(byPosition.get(6)!.status, 'notify must run after approval').toBe('completed');
  });

  it('the db_write landed in workflow_outputs scoped to the correct organization', async () => {
    const r = await asUserOk<{
      workflow_outputs: Array<{ key: string; org_id: string; value: unknown }>;
    }>(
      f.ownerA,
      /* GraphQL */ `
        query ($run: uuid!) {
          workflow_outputs(where: { workflow_run_id: { _eq: $run } }) { key org_id value }
        }
      `,
      { run: runId },
    );

    expect(r.workflow_outputs.length).toBeGreaterThan(0);
    expect(r.workflow_outputs[0].key).toBe('verdict');
    expect(r.workflow_outputs[0].org_id).toBe(f.orgAId);
  });

  it('the notify step produced a notification row drained by the Event Trigger', async () => {
    const state = await waitFor(
      () =>
        asUserOk<{ notifications: Array<{ status: string; channel: string; error: string | null }> }>(
          f.ownerA,
          /* GraphQL */ `
            query ($run: uuid!) {
              notifications(where: { workflow_run_id: { _eq: $run } }) { status channel error }
            }
          `,
          { run: runId },
        ),
      (s) => s.notifications.length > 0 && s.notifications[0].status !== 'pending',
      { timeoutMs: 45_000, label: 'notification to be delivered by the Event Trigger' },
    );

    expect(state.notifications[0].status).toBe('sent');
  });

  it('approving twice is rejected', async () => {
    const state = await readRun(f.ownerA, runId);
    const gate = state.step_runs.find((s) => s.workflow_step.position === 4)!;

    const r = await asUser(
      f.ownerA,
      /* GraphQL */ `mutation ($id: uuid!) { approveStep(step_run_id: $id) { run_status } }`,
      { id: gate.id },
    );
    expect(r.errors).toBeDefined();
    expect(r.errors![0].message).toMatch(/already been processed|not awaiting approval|not paused/i);
  });
});

// -----------------------------------------------------------------------------

describe('the other branch: no approval needed', () => {
  it('a benign ticket skips the gate and the run completes without pausing', async () => {
    const trigger = await asUser<{ triggerWorkflowRun: { run_id: string } }>(f.editorA, TRIGGER, {
      id: f.workflowId,
      input: { body: { text: BENIGN_TEXT } },
    });
    expect(trigger.errors, JSON.stringify(trigger.errors)).toBeUndefined();
    const runId = trigger.data!.triggerWorkflowRun.run_id;

    const state = await waitFor(
      () => readRun(f.editorA, runId),
      (s) => ['completed', 'failed', 'paused'].includes(s.workflow_runs_by_pk?.status ?? ''),
      { timeoutMs: 90_000, label: 'benign run to settle' },
    );

    const run = state.workflow_runs_by_pk!;
    const byPosition = new Map(state.step_runs.map((s) => [s.workflow_step.position, s]));
    const branchOut = byPosition.get(3)?.output as { matched?: boolean; resolved?: unknown };

    // The branch must have read a real classification. If the model called this
    // one needs_approval anyway, the run legitimately pauses — assert on the
    // branch's own decision rather than on the model's opinion.
    expect(branchOut?.matched).toBe(branchOut?.resolved === 'needs_approval');

    if (branchOut?.matched === false) {
      expect(run.status).toBe('completed');
      // Skipped steps are observable, not silently missing.
      expect(byPosition.get(4)!.status).toBe('skipped');
      expect(byPosition.get(5)!.status).toBe('skipped');
      expect(byPosition.get(6)!.status).toBe('completed');
    } else {
      expect(run.status).toBe('paused');
    }
  });
});

// -----------------------------------------------------------------------------

describe('retry on a failing external call', () => {
  it('retries a 500 and records attempt_count before failing the run', async () => {
    // A dedicated workflow whose only step is guaranteed to fail transiently.
    const created = await asUserOk<{ insert_workflows_one: { id: string } }>(
      f.ownerA,
      /* GraphQL */ `
        mutation ($org: uuid!, $name: String!) {
          insert_workflows_one(object: { org_id: $org, name: $name, status: "active" }) { id }
        }
      `,
      { org: f.orgAId, name: `retry-probe-${Date.now()}` },
    );
    const wfId = created.insert_workflows_one.id;

    await asUserOk(
      f.ownerA,
      /* GraphQL */ `
        mutation ($wf: uuid!, $config: jsonb!) {
          insert_workflow_steps_one(
            object: {
              workflow_id: $wf
              position: 1
              type: "http_request"
              name: "always 500"
              config: $config
            }
          ) { id }
        }
      `,
      {
        wf: wfId,
        config: {
          method: 'GET',
          // 500 is transient by policy, so it must be retried.
          url: 'https://httpbin.org/status/500',
          max_attempts: 2,
          base_delay_ms: 200,
          timeout_ms: 10000,
        },
      },
    );

    const trigger = await asUserOk<{ triggerWorkflowRun: { run_id: string } }>(f.ownerA, TRIGGER, {
      id: wfId,
      input: {},
    });
    const runId = trigger.triggerWorkflowRun.run_id;

    const state = await waitFor(
      () => readRun(f.ownerA, runId),
      (s) => ['completed', 'failed'].includes(s.workflow_runs_by_pk?.status ?? ''),
      { timeoutMs: 90_000, label: 'retry probe run to fail' },
    );

    expect(state.workflow_runs_by_pk!.status).toBe('failed');
    const step = state.step_runs[0];
    expect(step.status).toBe('failed');
    // The mandatory retry: two attempts were genuinely made.
    expect(step.attempt_count).toBe(2);
    expect(step.error).toMatch(/500/);
  });

  it('does not retry a permanent 404', async () => {
    const created = await asUserOk<{ insert_workflows_one: { id: string } }>(
      f.ownerA,
      /* GraphQL */ `
        mutation ($org: uuid!, $name: String!) {
          insert_workflows_one(object: { org_id: $org, name: $name, status: "active" }) { id }
        }
      `,
      { org: f.orgAId, name: `permanent-probe-${Date.now()}` },
    );
    const wfId = created.insert_workflows_one.id;

    await asUserOk(
      f.ownerA,
      /* GraphQL */ `
        mutation ($wf: uuid!, $config: jsonb!) {
          insert_workflow_steps_one(
            object: {
              workflow_id: $wf
              position: 1
              type: "http_request"
              name: "always 404"
              config: $config
            }
          ) { id }
        }
      `,
      {
        wf: wfId,
        config: {
          method: 'GET',
          url: 'https://httpbin.org/status/404',
          max_attempts: 3,
          base_delay_ms: 100,
          timeout_ms: 10000,
        },
      },
    );

    const trigger = await asUserOk<{ triggerWorkflowRun: { run_id: string } }>(f.ownerA, TRIGGER, {
      id: wfId,
      input: {},
    });

    const state = await waitFor(
      () => readRun(f.ownerA, trigger.triggerWorkflowRun.run_id),
      (s) => ['completed', 'failed'].includes(s.workflow_runs_by_pk?.status ?? ''),
      { timeoutMs: 60_000, label: 'permanent-failure run' },
    );

    expect(state.workflow_runs_by_pk!.status).toBe('failed');
    // Stopped after ONE attempt despite max_attempts: 3 — a 404 will not heal.
    expect(state.step_runs[0].attempt_count).toBe(1);
  });
});

// -----------------------------------------------------------------------------

describe('webhook trigger', () => {
  it('runs the workflow when called with the correct secret, and refuses without it', async () => {
    expect(f.webhookTriggerId, 'seed did not create a webhook trigger').toBeTruthy();

    const urlResult = await asUserOk<{ getWebhookUrl: { url: string } }>(
      f.ownerA,
      /* GraphQL */ `mutation ($id: uuid!) { getWebhookUrl(trigger_id: $id) { url } }`,
      { id: f.webhookTriggerId },
    );
    const url = urlResult.getWebhookUrl.url;

    // Wrong secret must be refused.
    const bad = await fetch(url.replace(/secret=.*$/, 'secret=deadbeef'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: BENIGN_TEXT }),
    });
    expect(bad.status).toBe(401);

    // Correct secret starts a run.
    const good = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: ESCALATE_TEXT }),
    });
    expect(good.status).toBe(202);
    const body = (await good.json()) as { run_id: string };
    expect(body.run_id).toMatch(/^[0-9a-f-]{36}$/);

    const state = await waitFor(
      () => readRun(f.ownerA, body.run_id),
      (s) => ['paused', 'completed', 'failed'].includes(s.workflow_runs_by_pk?.status ?? ''),
      { timeoutMs: 90_000, label: 'webhook run to settle' },
    );
    expect(state.workflow_runs_by_pk!.status).not.toBe('pending');

    // Recorded as webhook-triggered, with no user attributed.
    const meta = await asAdmin<{
      workflow_runs_by_pk: { trigger_type: string; triggered_by: string | null; input: unknown };
    }>(
      /* GraphQL */ `
        query ($id: uuid!) {
          workflow_runs_by_pk(id: $id) { trigger_type triggered_by input }
        }
      `,
      { id: body.run_id },
    );
    expect(meta.workflow_runs_by_pk.trigger_type).toBe('webhook');
    expect(meta.workflow_runs_by_pk.triggered_by).toBeNull();
    expect(meta.workflow_runs_by_pk.input).toMatchObject({ source: 'webhook' });
  });
});
