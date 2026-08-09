/**
 * Layer 2: restricted workflow capabilities.
 *
 * Being an editor of an organization does not grant every capability inside it.
 * db_write and notify steps, and webhook triggers, are owner-only. These tests
 * bypass the UI entirely and submit the mutations directly, because "the button
 * is hidden" is not a security control.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { asUser, asUserOk, fixture, type Fixture } from './helpers';

let f: Fixture;
let scratchWorkflowId: string;

const CREATE_WORKFLOW = /* GraphQL */ `
  mutation ($org: uuid!, $name: String!) {
    insert_workflows_one(object: { org_id: $org, name: $name }) { id }
  }
`;

const INSERT_STEP = /* GraphQL */ `
  mutation ($wf: uuid!, $pos: Int!, $type: String!, $name: String!, $config: jsonb!) {
    insert_workflow_steps_one(
      object: { workflow_id: $wf, position: $pos, type: $type, name: $name, config: $config }
    ) {
      id
      type
    }
  }
`;

const INSERT_TRIGGER = /* GraphQL */ `
  mutation ($wf: uuid!, $type: String!) {
    insert_workflow_triggers_one(object: { workflow_id: $wf, type: $type, config: {} }) {
      id
      type
    }
  }
`;

beforeAll(async () => {
  f = await fixture();
  // A scratch workflow so these tests never disturb the demo one.
  const created = await asUserOk<{ insert_workflows_one: { id: string } }>(
    f.ownerA,
    CREATE_WORKFLOW,
    { org: f.orgAId, name: `layer2-scratch-${Date.now()}` },
  );
  scratchWorkflowId = created.insert_workflows_one.id;
});

// -----------------------------------------------------------------------------

describe('restricted step types are owner-only', () => {
  let nextPos = 100;

  it('an owner CAN add a db_write step', async () => {
    const r = await asUser<{ insert_workflow_steps_one: { id: string; type: string } }>(
      f.ownerA,
      INSERT_STEP,
      {
        wf: scratchWorkflowId,
        pos: nextPos++,
        type: 'db_write',
        name: 'owner db write',
        config: { key: 'k', value: 1 },
      },
    );
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data?.insert_workflow_steps_one.type).toBe('db_write');
  });

  it('an owner CAN add a notify step', async () => {
    const r = await asUser<{ insert_workflow_steps_one: { type: string } }>(f.ownerA, INSERT_STEP, {
      wf: scratchWorkflowId,
      pos: nextPos++,
      type: 'notify',
      name: 'owner notify',
      config: { channel: 'log', message: 'hi' },
    });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data?.insert_workflow_steps_one.type).toBe('notify');
  });

  it('an editor CANNOT add a db_write step', async () => {
    const r = await asUser(f.editorA, INSERT_STEP, {
      wf: scratchWorkflowId,
      pos: nextPos++,
      type: 'db_write',
      name: 'editor db write',
      config: { key: 'k', value: 1 },
    });
    expect(r.errors, 'editor db_write must be rejected').toBeDefined();
  });

  it('an editor CANNOT add a notify step', async () => {
    const r = await asUser(f.editorA, INSERT_STEP, {
      wf: scratchWorkflowId,
      pos: nextPos++,
      type: 'notify',
      name: 'editor notify',
      config: { channel: 'log', message: 'hi' },
    });
    expect(r.errors, 'editor notify must be rejected').toBeDefined();
  });

  it('an editor CAN add the unrestricted step types', async () => {
    for (const type of ['llm_call', 'http_request', 'conditional_branch', 'approval_gate']) {
      const r = await asUser<{ insert_workflow_steps_one: { type: string } }>(
        f.editorA,
        INSERT_STEP,
        {
          wf: scratchWorkflowId,
          pos: nextPos++,
          type,
          name: `editor ${type}`,
          config: type === 'llm_call' ? { prompt: 'hi' } : {},
        },
      );
      expect(r.errors, `editor should be allowed ${type}: ${JSON.stringify(r.errors)}`).toBeUndefined();
      expect(r.data?.insert_workflow_steps_one.type).toBe(type);
    }
  });

  it('a viewer cannot add any step at all', async () => {
    const r = await asUser(f.viewerA, INSERT_STEP, {
      wf: scratchWorkflowId,
      pos: nextPos++,
      type: 'llm_call',
      name: 'viewer step',
      config: { prompt: 'hi' },
    });
    expect(r.errors).toBeDefined();
  });

  it('an editor cannot convert an existing step INTO a restricted type', async () => {
    // Create a permitted step as the editor, then try to promote it.
    const created = await asUserOk<{ insert_workflow_steps_one: { id: string } }>(
      f.editorA,
      INSERT_STEP,
      {
        wf: scratchWorkflowId,
        pos: nextPos++,
        type: 'http_request',
        name: 'to be promoted',
        config: { url: 'https://example.com' },
      },
    );

    const r = await asUser<{ update_workflow_steps_by_pk: unknown }>(
      f.editorA,
      /* GraphQL */ `
        mutation ($id: uuid!) {
          update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: { type: "db_write" }) {
            id
            type
          }
        }
      `,
      { id: created.insert_workflow_steps_one.id },
    );

    // The update check refuses the new value; if the filter matched nothing the
    // result is null. Either is a rejection.
    expect(r.errors !== undefined || r.data?.update_workflow_steps_by_pk === null).toBe(true);
  });

  it('an editor cannot modify an owner-created db_write step', async () => {
    const owned = await asUserOk<{ insert_workflow_steps_one: { id: string } }>(
      f.ownerA,
      INSERT_STEP,
      {
        wf: scratchWorkflowId,
        pos: nextPos++,
        type: 'db_write',
        name: 'owner only write',
        config: { key: 'protected', value: 1 },
      },
    );

    const r = await asUser<{ update_workflow_steps_by_pk: unknown }>(
      f.editorA,
      /* GraphQL */ `
        mutation ($id: uuid!) {
          update_workflow_steps_by_pk(
            pk_columns: { id: $id }
            _set: { config: { key: "hijacked", value: 2 } }
          ) { id }
        }
      `,
      { id: owned.insert_workflow_steps_one.id },
    );
    expect(r.errors !== undefined || r.data?.update_workflow_steps_by_pk === null).toBe(true);
  });

  it('an editor cannot delete an owner-created db_write step', async () => {
    const owned = await asUserOk<{ insert_workflow_steps_one: { id: string } }>(
      f.ownerA,
      INSERT_STEP,
      {
        wf: scratchWorkflowId,
        pos: nextPos++,
        type: 'db_write',
        name: 'owner only write 2',
        config: { key: 'protected2', value: 1 },
      },
    );

    const r = await asUser<{ delete_workflow_steps_by_pk: unknown }>(
      f.editorA,
      /* GraphQL */ `
        mutation ($id: uuid!) { delete_workflow_steps_by_pk(id: $id) { id } }
      `,
      { id: owned.insert_workflow_steps_one.id },
    );
    expect(r.errors !== undefined || r.data?.delete_workflow_steps_by_pk === null).toBe(true);
  });
});

// -----------------------------------------------------------------------------

describe('webhook triggers are owner-only', () => {
  it('an editor CANNOT create a webhook trigger', async () => {
    const r = await asUser(f.editorA, INSERT_TRIGGER, {
      wf: scratchWorkflowId,
      type: 'webhook',
    });
    expect(r.errors, 'editor webhook trigger must be rejected').toBeDefined();
  });

  it('an editor CAN create a manual trigger', async () => {
    const r = await asUser<{ insert_workflow_triggers_one: { type: string } }>(
      f.editorA,
      INSERT_TRIGGER,
      { wf: scratchWorkflowId, type: 'manual' },
    );
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data?.insert_workflow_triggers_one.type).toBe('manual');
  });

  it('an owner CAN create a webhook trigger', async () => {
    const r = await asUser<{ insert_workflow_triggers_one: { id: string; type: string } }>(
      f.ownerA,
      INSERT_TRIGGER,
      { wf: scratchWorkflowId, type: 'webhook' },
    );
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data?.insert_workflow_triggers_one.type).toBe('webhook');
  });

  it('the webhook secret is not readable through GraphQL by anyone', async () => {
    // The column is absent from the select permission, so naming it is a
    // schema-level error rather than a filtered-out value.
    const r = await asUser(
      f.ownerA,
      /* GraphQL */ `
        query ($wf: uuid!) {
          workflow_triggers(where: { workflow_id: { _eq: $wf } }) { id type webhook_secret }
        }
      `,
      { wf: scratchWorkflowId },
    );
    expect(r.errors).toBeDefined();
    expect(r.errors![0].message).toMatch(/webhook_secret/i);
  });

  it('getWebhookUrl is owner-only', async () => {
    const triggers = await asUserOk<{
      workflow_triggers: Array<{ id: string; type: string }>;
    }>(
      f.ownerA,
      /* GraphQL */ `
        query ($wf: uuid!) {
          workflow_triggers(where: { workflow_id: { _eq: $wf }, type: { _eq: "webhook" } }) { id type }
        }
      `,
      { wf: scratchWorkflowId },
    );
    const triggerId = triggers.workflow_triggers[0]?.id;
    expect(triggerId).toBeTruthy();

    const GET_URL = /* GraphQL */ `
      mutation ($id: uuid!) {
        getWebhookUrl(trigger_id: $id) { url enabled }
      }
    `;

    const ownerResult = await asUser<{ getWebhookUrl: { url: string } }>(f.ownerA, GET_URL, {
      id: triggerId,
    });
    expect(ownerResult.errors, JSON.stringify(ownerResult.errors)).toBeUndefined();
    expect(ownerResult.data?.getWebhookUrl.url).toContain('/api/webhook/');

    const editorResult = await asUser(f.editorA, GET_URL, { id: triggerId });
    expect(editorResult.errors, 'editor must not reveal the webhook URL').toBeDefined();

    const orgBResult = await asUser(f.ownerB, GET_URL, { id: triggerId });
    expect(orgBResult.errors, 'Org B must not reveal an Org A webhook URL').toBeDefined();
    expect(orgBResult.errors![0].message).toMatch(/not found|do not have access/i);
  });
});
