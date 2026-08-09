/**
 * Static checks over hasura/metadata.
 *
 * Hasura will happily accept a permission that is wrong in the ways that matter
 * here — a filter of {} exposes every row in the database, and a filter keyed
 * on a bare role would grant an editor of Org B rights inside Org A. Neither is
 * a syntax error, so they are checked explicitly.
 *
 * Run: node scripts/validate-metadata.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const metadataDir = join(root, 'hasura', 'metadata');

const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}
function ok(msg) {
  notes.push(msg);
}

// -----------------------------------------------------------------------------

const tables = parse(readFileSync(join(metadataDir, 'databases/default/tables/tables.yaml'), 'utf8'));
const actions = parse(readFileSync(join(metadataDir, 'actions.yaml'), 'utf8'));
const functions = parse(readFileSync(join(metadataDir, 'databases/default/functions/functions.yaml'), 'utf8'));
const crons = parse(readFileSync(join(metadataDir, 'cron_triggers.yaml'), 'utf8'));

const name = (t) => `${t.table.schema}.${t.table.name}`;

/** Does this boolean expression bottom out in an org_members membership test? */
function mentionsMembership(node) {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(mentionsMembership);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'org_members') return true;
    if (mentionsMembership(v)) return true;
  }
  return false;
}

/** Does it reference the authenticated user rather than a constant? */
function mentionsSessionUser(node) {
  if (node === null) return false;
  if (typeof node === 'string') return node === 'X-Hasura-User-Id';
  if (typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(mentionsSessionUser);
  return Object.values(node).some(mentionsSessionUser);
}

function isEmptyFilter(f) {
  return f === undefined || f === null || (typeof f === 'object' && Object.keys(f).length === 0);
}

// ---------------------------------------------------------------- table checks

const EXPECTED_TABLES = [
  'public.organizations',
  'public.org_members',
  'public.workflows',
  'public.workflow_steps',
  'public.workflow_triggers',
  'public.workflow_runs',
  'public.step_runs',
  'public.workflow_outputs',
  'public.notifications',
  'public.quota_reservations',
  'public.organization_usage_stats',
];

const tracked = tables.map(name);
for (const t of EXPECTED_TABLES) {
  if (!tracked.includes(t)) fail(`table ${t} is not tracked in metadata`);
}
ok(`${tracked.length} tables tracked`);

const PERMISSION_KEYS = [
  'select_permissions',
  'insert_permissions',
  'update_permissions',
  'delete_permissions',
];

for (const table of tables) {
  const label = name(table);

  for (const key of PERMISSION_KEYS) {
    for (const perm of table[key] ?? []) {
      const p = perm.permission;
      const where = `${label} ${key.replace('_permissions', '')} [role=${perm.role}]`;

      if (perm.role !== 'user') {
        fail(`${where}: unexpected Hasura role "${perm.role}" — only "user" should exist`);
      }

      // A filter (select/update/delete) must be membership-scoped.
      if (key !== 'insert_permissions') {
        if (isEmptyFilter(p.filter)) {
          fail(`${where}: filter is empty — this exposes every row in the table`);
        } else if (!mentionsMembership(p.filter)) {
          fail(`${where}: filter does not reach org_members — authorization is not org-scoped`);
        } else if (!mentionsSessionUser(p.filter)) {
          fail(`${where}: filter never references X-Hasura-User-Id`);
        }
      }

      // insert/update must have a check that is likewise scoped.
      if (key === 'insert_permissions' || key === 'update_permissions') {
        if (isEmptyFilter(p.check)) {
          if (key === 'insert_permissions') {
            fail(`${where}: insert check is empty — any user could insert any row`);
          }
        } else if (!mentionsMembership(p.check)) {
          fail(`${where}: check does not reach org_members`);
        }
      }
    }
  }
}

// ------------------------------------------------- engine-owned tables are RO

for (const t of ['public.workflow_runs', 'public.step_runs', 'public.workflow_outputs', 'public.notifications', 'public.quota_reservations']) {
  const table = tables.find((x) => name(x) === t);
  if (!table) continue;
  for (const key of ['insert_permissions', 'update_permissions', 'delete_permissions']) {
    if ((table[key] ?? []).length > 0) {
      fail(
        `${t} has ${key} for role user — this table must be engine-written only ` +
          `(otherwise quota / approval can be bypassed with a plain mutation)`,
      );
    }
  }
}
ok('workflow_runs, step_runs, workflow_outputs, notifications, quota_reservations are read-only for role user');

// ------------------------------------------------------------ Layer 2 checks

function collectNin(node, column, acc = []) {
  if (node === null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    node.forEach((n) => collectNin(n, column, acc));
    return acc;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === column && v && typeof v === 'object' && Array.isArray(v._nin)) acc.push(v._nin);
    else collectNin(v, column, acc);
  }
  return acc;
}

const steps = tables.find((t) => name(t) === 'public.workflow_steps');
for (const key of ['insert_permissions', 'update_permissions', 'delete_permissions']) {
  for (const perm of steps[key] ?? []) {
    for (const exprName of ['check', 'filter']) {
      const expr = perm.permission[exprName];
      if (!expr) continue;
      const nins = collectNin(expr, 'type').flat();
      if (!nins.includes('db_write') || !nins.includes('notify')) {
        fail(
          `workflow_steps ${key} ${exprName}: missing a type _nin restricting db_write/notify — ` +
            `Layer 2 would not hold for editors`,
        );
      }
    }
  }
}
ok('workflow_steps insert/update/delete restrict db_write and notify for editors');

const triggers = tables.find((t) => name(t) === 'public.workflow_triggers');
for (const key of ['insert_permissions', 'update_permissions', 'delete_permissions']) {
  for (const perm of triggers[key] ?? []) {
    for (const exprName of ['check', 'filter']) {
      const expr = perm.permission[exprName];
      if (!expr) continue;
      if (!collectNin(expr, 'type').flat().includes('webhook')) {
        fail(`workflow_triggers ${key} ${exprName}: missing type _nin [webhook] — Layer 2 gap`);
      }
    }
  }
}
ok('workflow_triggers insert/update/delete restrict webhook for editors');

// The webhook secret must never be selectable.
const trigSelect = triggers.select_permissions?.[0]?.permission?.columns ?? [];
if (trigSelect.includes('webhook_secret')) {
  fail('workflow_triggers select exposes webhook_secret — it is the webhook credential');
}
ok('workflow_triggers.webhook_secret is not selectable by role user');

// Quota columns must not be user-updatable.
const orgs = tables.find((t) => name(t) === 'public.organizations');
for (const perm of orgs.update_permissions ?? []) {
  for (const col of perm.permission.columns ?? []) {
    if (col.startsWith('quota_')) {
      fail(`organizations update exposes ${col} — a user could raise their own quota`);
    }
  }
}
ok('organizations quota columns are not user-updatable');

// ------------------------------------------------------------- action checks

const actionNames = (actions.actions ?? []).map((a) => a.name);
for (const required of ['triggerWorkflowRun', 'approveStep']) {
  if (!actionNames.includes(required)) fail(`action ${required} is missing`);
}
for (const a of actions.actions ?? []) {
  const roles = (a.permissions ?? []).map((p) => p.role);
  if (roles.length === 0) fail(`action ${a.name} has no permissions block — it is unreachable`);
  if (a.definition.forward_client_headers) {
    fail(`action ${a.name} forwards client headers — handler input must come from session_variables only`);
  }
  const hasSecret = (a.definition.headers ?? []).some((h) => h.name === 'x-action-secret');
  if (!hasSecret) fail(`action ${a.name} does not send x-action-secret — handler cannot verify the caller is Hasura`);
}
ok(`${actionNames.length} actions defined, all secret-authenticated and permission-gated`);

// --------------------------------------------------------- event trigger checks

const eventTriggers = tables.flatMap((t) => (t.event_triggers ?? []).map((e) => ({ table: name(t), ...e })));
if (!eventTriggers.some((e) => e.name === 'workflow_run_created')) {
  fail('event trigger workflow_run_created is missing — runs would never execute');
}
if (!eventTriggers.some((e) => e.name === 'notification_created')) {
  fail('event trigger notification_created is missing — notify step would never deliver');
}
for (const e of eventTriggers) {
  const hasSecret = (e.headers ?? []).some((h) => h.name === 'x-action-secret');
  if (!hasSecret) fail(`event trigger ${e.name} does not send x-action-secret`);
}
ok(`${eventTriggers.length} event triggers defined and secret-authenticated`);

if (!(crons ?? []).some((c) => c.name === 'scheduled_workflow_dispatch')) {
  fail('cron trigger scheduled_workflow_dispatch is missing');
}
ok('scheduled dispatch cron defined');

// ------------------------------------------------------------ function checks

for (const f of functions) {
  if (f.permissions) {
    fail(`function ${f.function.name} exposes role permissions — quota functions must be admin-only`);
  }
}
ok('quota functions are admin-only');

// -----------------------------------------------------------------------------

console.log('\nHasura metadata checks\n' + '='.repeat(60));
for (const n of notes) console.log(`  pass  ${n}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} PROBLEM(S):`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} metadata checks passed.\n`);
