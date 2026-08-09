/**
 * Quota enforcement.
 *
 * The concurrency case is the interesting one. The naive implementation reads
 * quota_used, compares it, and writes back — which lets N simultaneous requests
 * all observe the same pre-increment value and all proceed. reserve_org_quota()
 * does the check and the increment while holding a row lock, so the surplus
 * callers see the incremented value and are refused.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { asAdmin, asUser, asUserOk, ensureQuota, fixture, type Fixture } from './helpers';

let f: Fixture;

const TRIGGER = /* GraphQL */ `
  mutation ($id: uuid!) {
    triggerWorkflowRun(workflow_id: $id, input: {}) {
      run_id
      quota_used
      quota_limit
    }
  }
`;

const SET_QUOTA = /* GraphQL */ `
  mutation ($id: uuid!, $used: Int!, $limit: Int!) {
    update_organizations_by_pk(
      pk_columns: { id: $id }
      _set: { quota_used: $used, quota_limit: $limit }
    ) {
      quota_used
      quota_limit
    }
  }
`;

const READ_QUOTA = /* GraphQL */ `
  query ($id: uuid!) {
    organizations_by_pk(id: $id) { quota_used quota_limit }
  }
`;

beforeAll(async () => {
  f = await fixture();
});

describe('quota accounting', () => {
  it('one execution consumes exactly one unit', async () => {
    await asAdmin(SET_QUOTA, { id: f.orgAId, used: 0, limit: 10 });

    const r = await asUser<{ triggerWorkflowRun: { quota_used: number; quota_limit: number } }>(
      f.ownerA,
      TRIGGER,
      { id: f.workflowId },
    );
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data!.triggerWorkflowRun.quota_used).toBe(1);
    expect(r.data!.triggerWorkflowRun.quota_limit).toBe(10);

    const after = await asAdmin<{ organizations_by_pk: { quota_used: number } }>(READ_QUOTA, {
      id: f.orgAId,
    });
    expect(after.organizations_by_pk.quota_used).toBe(1);
  });

  it('execution is rejected once the quota is exhausted', async () => {
    await asAdmin(SET_QUOTA, { id: f.orgAId, used: 5, limit: 5 });

    const r = await asUser(f.ownerA, TRIGGER, { id: f.workflowId });
    expect(r.errors).toBeDefined();
    expect(r.errors![0].message).toMatch(/quota/i);

    // And nothing was consumed by the rejected attempt.
    const after = await asAdmin<{ organizations_by_pk: { quota_used: number } }>(READ_QUOTA, {
      id: f.orgAId,
    });
    expect(after.organizations_by_pk.quota_used).toBe(5);
  });

  it('no run row is created when the quota check fails', async () => {
    await asAdmin(SET_QUOTA, { id: f.orgAId, used: 3, limit: 3 });

    const before = await asAdmin<{ workflow_runs_aggregate: { aggregate: { count: number } } }>(
      /* GraphQL */ `
        query ($wf: uuid!) {
          workflow_runs_aggregate(where: { workflow_id: { _eq: $wf } }) { aggregate { count } }
        }
      `,
      { wf: f.workflowId },
    );

    const r = await asUser(f.ownerA, TRIGGER, { id: f.workflowId });
    expect(r.errors).toBeDefined();

    const after = await asAdmin<{ workflow_runs_aggregate: { aggregate: { count: number } } }>(
      /* GraphQL */ `
        query ($wf: uuid!) {
          workflow_runs_aggregate(where: { workflow_id: { _eq: $wf } }) { aggregate { count } }
        }
      `,
      { wf: f.workflowId },
    );

    expect(after.workflow_runs_aggregate.aggregate.count).toBe(
      before.workflow_runs_aggregate.aggregate.count,
    );
  });

  it('concurrent triggers cannot exceed the limit', async () => {
    const LIMIT = 5;
    const CONCURRENT = 20;
    await asAdmin(SET_QUOTA, { id: f.orgAId, used: 0, limit: LIMIT });

    // Fired together, deliberately without awaiting in sequence.
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        asUser<{ triggerWorkflowRun: { run_id: string } }>(f.ownerA, TRIGGER, {
          id: f.workflowId,
        }),
      ),
    );

    const granted = results.filter((r) => !r.errors && r.data?.triggerWorkflowRun.run_id);
    const refused = results.filter((r) => r.errors);

    expect(granted.length, `expected exactly ${LIMIT} grants`).toBe(LIMIT);
    expect(refused.length).toBe(CONCURRENT - LIMIT);
    for (const r of refused) expect(r.errors![0].message).toMatch(/quota/i);

    const after = await asAdmin<{ organizations_by_pk: { quota_used: number } }>(READ_QUOTA, {
      id: f.orgAId,
    });
    // No overshoot: quota_used never passes quota_limit.
    expect(after.organizations_by_pk.quota_used).toBe(LIMIT);
  });

  it('quota is scoped per organization', async () => {
    await asAdmin(SET_QUOTA, { id: f.orgAId, used: 5, limit: 5 });
    await ensureQuota(f.orgBId, 10);

    // Org A exhausted...
    const aResult = await asUser(f.ownerA, TRIGGER, { id: f.workflowId });
    expect(aResult.errors).toBeDefined();

    // ...has no bearing on Org B's allowance.
    const b = await asUserOk<{ organizations_by_pk: { quota_used: number; quota_limit: number } }>(
      f.ownerB,
      READ_QUOTA,
      { id: f.orgBId },
    );
    expect(b.organizations_by_pk.quota_used).toBe(0);
    expect(b.organizations_by_pk.quota_limit).toBe(10);
  });

  it('the aggregation view reflects usage for the caller’s own organization', async () => {
    await ensureQuota(f.orgAId, 40);
    await asUserOk(f.ownerA, TRIGGER, { id: f.workflowId });

    const stats = await asUserOk<{
      organization_usage_stats: Array<{
        org_id: string;
        quota_used: number;
        quota_remaining: number;
        total_runs: number;
      }>;
    }>(
      f.ownerA,
      /* GraphQL */ `
        query ($org: uuid!) {
          organization_usage_stats(where: { org_id: { _eq: $org } }) {
            org_id
            quota_used
            quota_remaining
            total_runs
          }
        }
      `,
      { org: f.orgAId },
    );

    const row = stats.organization_usage_stats[0];
    expect(row).toBeDefined();
    expect(row.org_id).toBe(f.orgAId);
    expect(row.quota_used).toBeGreaterThanOrEqual(1);
    expect(row.quota_remaining).toBe(40 - row.quota_used);
    expect(row.total_runs).toBeGreaterThan(0);
  });

  it('the quota audit log is owner-only', async () => {
    const owner = await asUser<{ quota_reservations: unknown[] }>(
      f.ownerA,
      /* GraphQL */ `
        query ($org: uuid!) {
          quota_reservations(where: { org_id: { _eq: $org } }, limit: 5) { allowed reason }
        }
      `,
      { org: f.orgAId },
    );
    expect(owner.errors).toBeUndefined();
    expect((owner.data!.quota_reservations as unknown[]).length).toBeGreaterThan(0);

    const editor = await asUserOk<{ quota_reservations: unknown[] }>(
      f.editorA,
      /* GraphQL */ `
        query ($org: uuid!) {
          quota_reservations(where: { org_id: { _eq: $org } }, limit: 5) { allowed }
        }
      `,
      { org: f.orgAId },
    );
    expect(editor.quota_reservations).toEqual([]);
  });
});
