/**
 * Seed the demo tenants, users, and the workflow the assignment scenario needs.
 *
 *   npm run seed
 *
 * Creates:
 *   Org A  — owner, editor, viewer
 *   Org B  — owner with NO membership in Org A (the cross-org attacker)
 *   A 6-step workflow in Org A that branches on a real LLM classification.
 *
 * Idempotent: re-running reuses existing users/orgs and rebuilds the demo
 * workflow's steps so you can reset the demo without a database wipe.
 */

import { adminGql, ensureUser, loadEnv, log, need, nhostUrls } from './lib/common.mjs';

loadEnv();
need('HASURA_GRAPHQL_ADMIN_SECRET');

const password = process.env.SEED_PASSWORD?.trim() || 'Passw0rd!seed';

// NOTE: hasura-auth validates displayName and rejects some punctuation —
// parentheses produce a bare HTTP 400 with an empty body. Keep these plain.
const PEOPLE = [
  { key: 'ownerA',  email: process.env.TEST_ORG_A_OWNER_EMAIL  || 'owner.a@example.test',  name: 'Ada Owner - Org A',   org: 'A', role: 'owner'  },
  { key: 'editorA', email: process.env.TEST_ORG_A_EDITOR_EMAIL || 'editor.a@example.test', name: 'Eli Editor - Org A',  org: 'A', role: 'editor' },
  { key: 'viewerA', email: process.env.TEST_ORG_A_VIEWER_EMAIL || 'viewer.a@example.test', name: 'Vic Viewer - Org A',  org: 'A', role: 'viewer' },
  { key: 'ownerB',  email: process.env.TEST_ORG_B_OWNER_EMAIL  || 'owner.b@example.test',  name: 'Bo Owner - Org B',    org: 'B', role: 'owner'  },
];

const UPSERT_ORG = /* GraphQL */ `
  mutation UpsertOrg($name: String!, $slug: String!, $limit: Int!) {
    insert_organizations_one(
      object: { name: $name, slug: $slug, quota_limit: $limit }
      on_conflict: { constraint: organizations_slug_key, update_columns: [name] }
    ) {
      id
      name
      slug
      quota_used
      quota_limit
    }
  }
`;

const UPSERT_MEMBER = /* GraphQL */ `
  mutation UpsertMember($org_id: uuid!, $user_id: uuid!, $role: String!) {
    insert_org_members_one(
      object: { org_id: $org_id, user_id: $user_id, role: $role }
      on_conflict: { constraint: org_members_unique_membership, update_columns: [role] }
    ) {
      id
      role
    }
  }
`;

const FIND_WORKFLOW = /* GraphQL */ `
  query FindWorkflow($org_id: uuid!, $name: String!) {
    workflows(where: { org_id: { _eq: $org_id }, name: { _eq: $name } }, limit: 1) {
      id
    }
  }
`;

const CREATE_WORKFLOW = /* GraphQL */ `
  mutation CreateWorkflow($org_id: uuid!, $name: String!, $description: String!, $created_by: uuid!) {
    insert_workflows_one(
      object: {
        org_id: $org_id
        name: $name
        description: $description
        status: "active"
        created_by: $created_by
      }
    ) {
      id
    }
  }
`;

const CLEAR_STEPS = /* GraphQL */ `
  mutation ClearSteps($workflow_id: uuid!) {
    delete_workflow_steps(where: { workflow_id: { _eq: $workflow_id } }) {
      affected_rows
    }
  }
`;

const INSERT_STEPS = /* GraphQL */ `
  mutation InsertSteps($objects: [workflow_steps_insert_input!]!) {
    insert_workflow_steps(objects: $objects) {
      returning {
        id
        position
        type
        name
      }
    }
  }
`;

const UPSERT_TRIGGER = /* GraphQL */ `
  mutation UpsertTrigger($workflow_id: uuid!, $type: String!, $config: jsonb!, $created_by: uuid!) {
    insert_workflow_triggers_one(
      object: {
        workflow_id: $workflow_id
        type: $type
        config: $config
        enabled: true
        created_by: $created_by
      }
      on_conflict: {
        constraint: workflow_triggers_unique_type
        update_columns: [enabled, config]
      }
    ) {
      id
      type
      webhook_secret
    }
  }
`;

/**
 * The demo workflow.
 *
 *   1 llm_call            classify the ticket, returning JSON
 *   2 http_request        enrich from a public API
 *   3 conditional_branch  reads step 1's REAL output
 *        true  -> continue to 4 (approval gate)
 *        false -> jump to 6 (notify), marking 4 and 5 skipped
 *   4 approval_gate       pauses the run
 *   5 db_write            owner-only; persists the verdict
 *   6 notify              owner-only; enqueues a notification row
 */
function demoSteps(workflowId, ownerId) {
  return [
    {
      workflow_id: workflowId,
      created_by: ownerId,
      position: 1,
      type: 'llm_call',
      name: 'Classify support ticket',
      config: {
        // Deliberately strict. A small local model (llama3.2 3B) will happily
        // invent labels like "high_priority" from a loose prompt, and the
        // branch compares against an exact string. Enumerating the permitted
        // values, forbidding invention, and showing two examples was measured
        // to give the correct label on every test ticket.
        system_prompt:
          'You are a strict classifier. You output ONLY a JSON object and nothing else.\n' +
          'The JSON MUST have exactly these three keys: "label", "confidence", "reason".\n' +
          '"label" MUST be exactly one of these two strings, copied character for character:\n' +
          '  "needs_approval"\n' +
          '  "auto_resolve"\n' +
          'No other value for "label" is permitted. Do not invent labels such as "high_priority".\n' +
          'Use "needs_approval" when the ticket mentions refunds, money back, outages, service being ' +
          'down, cancellations, legal threats, or an angry customer.\n' +
          'Use "auto_resolve" for everything else, such as how-to questions and simple account changes.\n' +
          '"confidence" is a number between 0 and 1. "reason" is a short string under 15 words.\n\n' +
          'Example input: The site is down and I demand a refund.\n' +
          'Example output: {"label":"needs_approval","confidence":0.95,"reason":"outage and refund request"}\n\n' +
          'Example input: How do I change my profile picture?\n' +
          'Example output: {"label":"auto_resolve","confidence":0.9,"reason":"simple how-to question"}',
        prompt:
          'Classify this support ticket:\n\n{{trigger.body.text}}\n\n' +
          'Respond with the JSON object only.',
        parse_json: true,
        temperature: 0,
        max_tokens: 2048,
        max_attempts: 2,
      },
    },
    {
      workflow_id: workflowId,
      created_by: ownerId,
      position: 2,
      type: 'http_request',
      name: 'Enrich from external API',
      config: {
        method: 'GET',
        // Public, dependency-free, and returns JSON. Deliberately NOT a private
        // address — the SSRF guard would refuse one.
        url: 'https://httpbingo.org/uuid',
        timeout_ms: 10000,
        max_attempts: 2,
        base_delay_ms: 500,
      },
    },
    {
      workflow_id: workflowId,
      created_by: ownerId,
      position: 3,
      type: 'conditional_branch',
      name: 'Does this need human approval?',
      config: {
        condition: {
          // Reads the LLM step's actual parsed output from this run.
          path: 'steps.1.output.json.label',
          operator: 'equals',
          value: 'needs_approval',
        },
        on_true: { action: 'continue' },
        on_false: { goto_position: 6 },
      },
    },
    {
      workflow_id: workflowId,
      created_by: ownerId,
      position: 4,
      type: 'approval_gate',
      name: 'Human approval required',
      config: {
        message:
          'The classifier flagged this ticket as needing approval. ' +
          'An owner or editor must approve before it is recorded and announced.',
      },
    },
    {
      workflow_id: workflowId,
      created_by: ownerId,
      position: 5,
      type: 'db_write',
      name: 'Persist verdict',
      config: {
        key: 'verdict',
        value: {
          label: '{{steps.1.output.json.label}}',
          confidence: '{{steps.1.output.json.confidence}}',
          reason: '{{steps.1.output.json.reason}}',
          enrichment: '{{steps.2.output.json}}',
        },
      },
    },
    {
      workflow_id: workflowId,
      created_by: ownerId,
      position: 6,
      type: 'notify',
      name: 'Announce outcome',
      config: {
        channel: 'log',
        title: 'Ticket triage complete',
        message: 'Run {{run.id}} finished. Classification: {{steps.1.output.json.label}}.',
      },
    },
  ];
}

async function main() {
  const { graphql, auth } = nhostUrls();
  console.log(`Auth:    ${auth}`);
  console.log(`GraphQL: ${graphql}`);

  // ------------------------------------------------------------------ users
  log.step('Creating test users');
  const users = {};
  for (const person of PEOPLE) {
    const user = await ensureUser(person.email, password, person.name);
    users[person.key] = user;
    log.ok(`${person.email.padEnd(26)} ${user.id} ${user.created ? '(created)' : '(existing)'}`);
  }

  // ------------------------------------------------------------------- orgs
  log.step('Creating organizations');
  const { insert_organizations_one: orgA } = await adminGql(UPSERT_ORG, {
    name: 'Org A — Acme Support',
    slug: 'org-a-acme',
    limit: 20,
  });
  const { insert_organizations_one: orgB } = await adminGql(UPSERT_ORG, {
    name: 'Org B — Globex',
    slug: 'org-b-globex',
    limit: 20,
  });
  log.ok(`Org A ${orgA.id}  quota ${orgA.quota_used}/${orgA.quota_limit}`);
  log.ok(`Org B ${orgB.id}  quota ${orgB.quota_used}/${orgB.quota_limit}`);

  // ------------------------------------------------------------ memberships
  log.step('Assigning organization roles');
  for (const person of PEOPLE) {
    const org = person.org === 'A' ? orgA : orgB;
    await adminGql(UPSERT_MEMBER, {
      org_id: org.id,
      user_id: users[person.key].id,
      role: person.role,
    });
    log.ok(`${person.email.padEnd(26)} ${person.role} in Org ${person.org}`);
  }
  log.info('Org B owner has NO membership in Org A — that is the cross-org test subject.');

  // --------------------------------------------------------------- workflow
  log.step('Building the demo workflow in Org A');
  const name = 'Support ticket triage';

  const existing = await adminGql(FIND_WORKFLOW, { org_id: orgA.id, name });
  let workflowId = existing.workflows[0]?.id;

  if (workflowId) {
    await adminGql(CLEAR_STEPS, { workflow_id: workflowId });
    log.info('Existing workflow found; steps cleared and rebuilt.');
  } else {
    const created = await adminGql(CREATE_WORKFLOW, {
      org_id: orgA.id,
      name,
      description:
        'LLM classifies a ticket, an HTTP call enriches it, a branch reads the real ' +
        'classification, and anything needing sign-off pauses at an approval gate.',
      created_by: users.ownerA.id,
    });
    workflowId = created.insert_workflows_one.id;
  }
  log.ok(`Workflow ${workflowId}`);

  const inserted = await adminGql(INSERT_STEPS, {
    objects: demoSteps(workflowId, users.ownerA.id),
  });
  for (const step of inserted.insert_workflow_steps.returning) {
    log.ok(`  ${step.position}. ${step.name} (${step.type})`);
  }

  // --------------------------------------------------------------- triggers
  log.step('Creating triggers');
  const manual = await adminGql(UPSERT_TRIGGER, {
    workflow_id: workflowId,
    type: 'manual',
    config: {},
    created_by: users.ownerA.id,
  });
  log.ok(`manual  ${manual.insert_workflow_triggers_one.id}`);

  const webhook = await adminGql(UPSERT_TRIGGER, {
    workflow_id: workflowId,
    type: 'webhook',
    config: {},
    created_by: users.ownerA.id,
  });
  const wh = webhook.insert_workflow_triggers_one;
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  log.ok(`webhook ${wh.id}`);

  // ---------------------------------------------------------------- summary
  console.log(`\n${'='.repeat(74)}`);
  console.log('SEED COMPLETE');
  console.log('='.repeat(74));
  console.log(`\nSign in at ${base} with password: ${password}\n`);
  for (const person of PEOPLE) {
    console.log(`  ${person.email.padEnd(28)} ${person.role.padEnd(7)} Org ${person.org}`);
  }
  console.log(`\nWebhook URL (owner-only secret, also available via the Reveal URL button):`);
  console.log(`  ${base}/api/webhook/${wh.id}?secret=${wh.webhook_secret}\n`);
  console.log('Fire it with:');
  console.log(
    `  curl -X POST "${base}/api/webhook/${wh.id}?secret=${wh.webhook_secret}" \\\n` +
      `    -H "content-type: application/json" \\\n` +
      `    -d '{"text":"Our checkout has been down for an hour and I want a refund."}'\n`,
  );
  console.log('That text trips the classifier into needs_approval, so the run pauses.');
  console.log('A neutral message such as "How do I change my avatar?" takes the other branch.\n');
}

main().catch((err) => {
  log.fail(err.message);
  process.exitCode = 1;
});
