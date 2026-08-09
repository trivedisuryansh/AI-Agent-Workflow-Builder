/**
 * Layer 1 authorization and cross-organization isolation.
 *
 * Every assertion here goes over the wire as the real user with a real Nhost
 * JWT. The Org B actor knows Org A's UUIDs (the fixture hands them over
 * deliberately) and still gets nothing — which is the whole claim.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { asAdmin, asUser, asUserOk, fixture, type Fixture } from './helpers';

let f: Fixture;

beforeAll(async () => {
  f = await fixture();
});

// -----------------------------------------------------------------------------

describe('organization visibility', () => {
  it('a user sees only the organizations they are a member of', async () => {
    const a = await asUserOk<{ org_members: Array<{ org_id: string; role: string }> }>(
      f.ownerA,
      /* GraphQL */ `query { org_members { org_id role } }`,
    );
    const b = await asUserOk<{ org_members: Array<{ org_id: string; role: string }> }>(
      f.ownerB,
      /* GraphQL */ `query { org_members { org_id role } }`,
    );

    expect(a.org_members.map((m) => m.org_id)).toContain(f.orgAId);
    expect(a.org_members.map((m) => m.org_id)).not.toContain(f.orgBId);

    expect(b.org_members.map((m) => m.org_id)).toContain(f.orgBId);
    expect(b.org_members.map((m) => m.org_id)).not.toContain(f.orgAId);
  });

  it('Org B cannot read Org A even by naming its id directly', async () => {
    const result = await asUserOk<{ organizations: unknown[] }>(
      f.ownerB,
      /* GraphQL */ `
        query ($id: uuid!) {
          organizations(where: { id: { _eq: $id } }) {
            id
            name
            quota_used
          }
        }
      `,
      { id: f.orgAId },
    );
    // Not an error — an empty set. The row simply does not exist for this user.
    expect(result.organizations).toEqual([]);
  });

  it('all three Org A roles can read the organization', async () => {
    for (const actor of [f.ownerA, f.editorA, f.viewerA]) {
      const r = await asUserOk<{ organizations: Array<{ id: string }> }>(
        actor,
        /* GraphQL */ `query ($id: uuid!) { organizations(where: { id: { _eq: $id } }) { id } }`,
        { id: f.orgAId },
      );
      expect(r.organizations, `${actor.label} should see Org A`).toHaveLength(1);
    }
  });
});

// -----------------------------------------------------------------------------

describe('cross-organization data access', () => {
  const WORKFLOW_BY_ID = /* GraphQL */ `
    query ($id: uuid!) {
      workflows(where: { id: { _eq: $id } }) {
        id
        name
        org_id
      }
    }
  `;

  it('Org B gets nothing when querying an Org A workflow by its exact id', async () => {
    const r = await asUserOk<{ workflows: unknown[] }>(f.ownerB, WORKFLOW_BY_ID, {
      id: f.workflowId,
    });
    expect(r.workflows).toEqual([]);
  });

  it('workflows_by_pk returns null for Org B', async () => {
    const r = await asUserOk<{ workflows_by_pk: unknown }>(
      f.ownerB,
      /* GraphQL */ `query ($id: uuid!) { workflows_by_pk(id: $id) { id name } }`,
      { id: f.workflowId },
    );
    expect(r.workflows_by_pk).toBeNull();
  });

  it('Org B cannot read Org A workflow steps by workflow id', async () => {
    const r = await asUserOk<{ workflow_steps: unknown[] }>(
      f.ownerB,
      /* GraphQL */ `
        query ($wf: uuid!) {
          workflow_steps(where: { workflow_id: { _eq: $wf } }) { id type name config }
        }
      `,
      { wf: f.workflowId },
    );
    expect(r.workflow_steps).toEqual([]);
  });

  it('Org B cannot read Org A workflow steps by their exact step ids', async () => {
    const ids = f.steps.map((s) => s.id);
    const r = await asUserOk<{ workflow_steps: unknown[] }>(
      f.ownerB,
      /* GraphQL */ `
        query ($ids: [uuid!]!) {
          workflow_steps(where: { id: { _in: $ids } }) { id type }
        }
      `,
      { ids },
    );
    expect(r.workflow_steps).toEqual([]);
  });

  it('an unfiltered workflows query returns only the caller’s own organization', async () => {
    // The strongest form: no where clause at all. Hasura still applies the
    // row-level filter, so Org A's rows are simply not in the result.
    const r = await asUserOk<{ workflows: Array<{ id: string; org_id: string }> }>(
      f.ownerB,
      /* GraphQL */ `query { workflows { id org_id } }`,
    );
    for (const w of r.workflows) expect(w.org_id).toBe(f.orgBId);
    expect(r.workflows.map((w) => w.id)).not.toContain(f.workflowId);
  });

  it('Org B cannot read Org A runs or step_runs even knowing the ids', async () => {
    // Fixture data via admin, so the ids are definitely real.
    const runs = await asAdmin<{ workflow_runs: Array<{ id: string }> }>(
      /* GraphQL */ `
        query ($wf: uuid!) {
          workflow_runs(where: { workflow_id: { _eq: $wf } }, limit: 5) { id }
        }
      `,
      { wf: f.workflowId },
    );

    const asB = await asUserOk<{ workflow_runs: unknown[]; step_runs: unknown[] }>(
      f.ownerB,
      /* GraphQL */ `
        query ($wf: uuid!, $runIds: [uuid!]!) {
          workflow_runs(where: { workflow_id: { _eq: $wf } }) { id status }
          step_runs(where: { workflow_run_id: { _in: $runIds } }) { id status output }
        }
      `,
      { wf: f.workflowId, runIds: runs.workflow_runs.map((r) => r.id) },
    );

    expect(asB.workflow_runs).toEqual([]);
    expect(asB.step_runs).toEqual([]);
  });

  it('Org B cannot read Org A workflow_outputs or notifications', async () => {
    const r = await asUserOk<{ workflow_outputs: unknown[]; notifications: unknown[] }>(
      f.ownerB,
      /* GraphQL */ `
        query ($org: uuid!) {
          workflow_outputs(where: { org_id: { _eq: $org } }) { id key value }
          notifications(where: { org_id: { _eq: $org } }) { id payload }
        }
      `,
      { org: f.orgAId },
    );
    expect(r.workflow_outputs).toEqual([]);
    expect(r.notifications).toEqual([]);
  });

  it('the usage aggregation does not leak another organization’s counts', async () => {
    const r = await asUserOk<{ organization_usage_stats: unknown[] }>(
      f.ownerB,
      /* GraphQL */ `
        query ($org: uuid!) {
          organization_usage_stats(where: { org_id: { _eq: $org } }) {
            org_id
            total_runs
            completed_runs
          }
        }
      `,
      { org: f.orgAId },
    );
    expect(r.organization_usage_stats).toEqual([]);
  });

  it('aggregate counts cannot be used as a side channel', async () => {
    const r = await asUserOk<{
      workflows_aggregate: { aggregate: { count: number } };
    }>(
      f.ownerB,
      /* GraphQL */ `
        query ($org: uuid!) {
          workflows_aggregate(where: { org_id: { _eq: $org } }) { aggregate { count } }
        }
      `,
      { org: f.orgAId },
    );
    expect(r.workflows_aggregate.aggregate.count).toBe(0);
  });
});

// -----------------------------------------------------------------------------

describe('triggerWorkflowRun authorization', () => {
  const TRIGGER = /* GraphQL */ `
    mutation ($id: uuid!) {
      triggerWorkflowRun(workflow_id: $id, input: { source: "test" }) {
        run_id
        status
      }
    }
  `;

  it('an owner can trigger', async () => {
    const r = await asUser<{ triggerWorkflowRun: { run_id: string } }>(f.ownerA, TRIGGER, {
      id: f.workflowId,
    });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data?.triggerWorkflowRun.run_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('an editor can trigger', async () => {
    const r = await asUser<{ triggerWorkflowRun: { run_id: string } }>(f.editorA, TRIGGER, {
      id: f.workflowId,
    });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data?.triggerWorkflowRun.run_id).toBeTruthy();
  });

  it('a viewer cannot trigger', async () => {
    const r = await asUser(f.viewerA, TRIGGER, { id: f.workflowId });
    expect(r.errors).toBeDefined();
    expect(r.errors![0].message).toMatch(/viewer|owner or editor|required/i);
  });

  it('Org B cannot trigger an Org A workflow even with the correct UUID', async () => {
    const r = await asUser(f.ownerB, TRIGGER, { id: f.workflowId });
    expect(r.errors).toBeDefined();
    // Indistinguishable from a nonexistent workflow: the Action must not
    // confirm that this UUID is a real workflow somewhere else.
    expect(r.errors![0].message).toMatch(/not found|do not have access/i);
  });

  it('a random UUID produces the same error as a foreign workflow', async () => {
    const r = await asUser(f.ownerB, TRIGGER, { id: '00000000-0000-4000-8000-000000000000' });
    expect(r.errors).toBeDefined();
    expect(r.errors![0].message).toMatch(/not found|do not have access/i);
  });
});

// -----------------------------------------------------------------------------

describe('write permissions by role', () => {
  const CREATE = /* GraphQL */ `
    mutation ($org: uuid!, $name: String!) {
      insert_workflows_one(object: { org_id: $org, name: $name }) { id }
    }
  `;

  it('an owner can create a workflow', async () => {
    const r = await asUser<{ insert_workflows_one: { id: string } }>(f.ownerA, CREATE, {
      org: f.orgAId,
      name: `owner-created-${Date.now()}`,
    });
    expect(r.errors).toBeUndefined();
    expect(r.data?.insert_workflows_one.id).toBeTruthy();
  });

  it('an editor can create a workflow', async () => {
    const r = await asUser<{ insert_workflows_one: { id: string } }>(f.editorA, CREATE, {
      org: f.orgAId,
      name: `editor-created-${Date.now()}`,
    });
    expect(r.errors).toBeUndefined();
    expect(r.data?.insert_workflows_one.id).toBeTruthy();
  });

  it('a viewer cannot create a workflow', async () => {
    const r = await asUser(f.viewerA, CREATE, { org: f.orgAId, name: 'viewer-attempt' });
    expect(r.errors).toBeDefined();
  });

  it('Org B cannot create a workflow inside Org A', async () => {
    const r = await asUser(f.ownerB, CREATE, { org: f.orgAId, name: 'orgb-attempt' });
    expect(r.errors).toBeDefined();
  });

  it('a viewer cannot rename a workflow', async () => {
    const r = await asUser<{ update_workflows_by_pk: unknown }>(
      f.viewerA,
      /* GraphQL */ `
        mutation ($id: uuid!) {
          update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: "renamed by viewer" }) { id }
        }
      `,
      { id: f.workflowId },
    );
    // Either a permission error, or a null result because no row matched the filter.
    expect(r.errors !== undefined || r.data?.update_workflows_by_pk === null).toBe(true);
  });

  it('only an owner can manage organization membership', async () => {
    const ADD = /* GraphQL */ `
      mutation ($org: uuid!, $user: uuid!) {
        insert_org_members_one(object: { org_id: $org, user_id: $user, role: "viewer" }) { id }
      }
    `;
    const editorAttempt = await asUser(f.editorA, ADD, { org: f.orgAId, user: f.ownerB.userId });
    expect(editorAttempt.errors, 'editor must not add members').toBeDefined();

    const orgBAttempt = await asUser(f.ownerB, ADD, { org: f.orgAId, user: f.ownerB.userId });
    expect(orgBAttempt.errors, 'Org B must not add itself to Org A').toBeDefined();
  });

  it('nobody can raise their own quota_limit', async () => {
    const r = await asUser(
      f.ownerA,
      /* GraphQL */ `
        mutation ($id: uuid!) {
          update_organizations_by_pk(pk_columns: { id: $id }, _set: { quota_limit: 999999 }) { id }
        }
      `,
      { id: f.orgAId },
    );
    // quota_limit is not in the update permission's column list at all.
    expect(r.errors).toBeDefined();
  });

  it('runs cannot be inserted directly, which is what makes the quota check unavoidable', async () => {
    const r = await asUser(
      f.ownerA,
      /* GraphQL */ `
        mutation ($wf: uuid!) {
          insert_workflow_runs_one(
            object: { workflow_id: $wf, trigger_type: "manual", status: "running" }
          ) { id }
        }
      `,
      { wf: f.workflowId },
    );
    expect(r.errors).toBeDefined();
  });

  it('step_runs cannot be updated directly, which is what makes approval an Action', async () => {
    const r = await asUser(
      f.ownerA,
      /* GraphQL */ `
        mutation {
          update_step_runs(where: {}, _set: { status: "completed" }) { affected_rows }
        }
      `,
    );
    expect(r.errors).toBeDefined();
  });
});
