/**
 * Apply this project's metadata to a Hasura instance WITHOUT clobbering
 * metadata that instance already owns.
 *
 *   node scripts/hasura-merge-metadata.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * `hasura metadata apply` performs a replace_metadata: it swaps the entire
 * document. That is exactly right for a local stack this repo owns outright,
 * and exactly wrong for an Nhost Cloud project, which already tracks 16 tables
 * across the `auth` and `storage` schemas. Replacing wholesale would untrack
 * them and break sign-in and file storage.
 *
 * So instead:
 *   1. export metadata from the SOURCE (the local stack, where
 *      `hasura metadata apply` has already run and the CLI has correctly
 *      compiled actions.graphql into custom_types)
 *   2. export metadata from the TARGET (Nhost Cloud)
 *   3. keep every TARGET table outside the `public` schema, take every
 *      `public` table from SOURCE, and take actions / custom types / cron
 *      triggers / functions from SOURCE
 *   4. replace_metadata on the target with the merged document
 *
 * Reusing the local export rather than re-parsing actions.graphql means the
 * GraphQL SDL is compiled by the Hasura CLI itself, not by a hand-rolled parser.
 *
 * The target's source `configuration` block (its database connection) is
 * preserved untouched — that is Nhost's, not ours.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnv, log, ROOT } from './lib/common.mjs';

loadEnv();

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SOURCE_ENDPOINT = arg('source', 'http://localhost:8080').replace(/\/+$/, '');
const SOURCE_SECRET = arg('source-secret', process.env.LOCAL_HASURA_ADMIN_SECRET || 'wfb-local-admin-secret');
const TARGET_ENDPOINT = arg('target', '').replace(/\/+$/, '');
const TARGET_SECRET = arg('target-secret', process.env.HASURA_GRAPHQL_ADMIN_SECRET || '');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Optional literal substitution for the two values Hasura would normally read
 * from its own environment.
 *
 * The committed metadata deliberately uses {{ACTION_BASE_URL}} and
 * value_from_env: ACTION_WEBHOOK_SECRET, which is the right shape for a real
 * deployment: the URL and the shared secret live in the platform's environment,
 * not in a metadata document.
 *
 * But applying metadata to a managed Hasura you cannot set environment
 * variables on is a genuine situation — a hosted project whose dashboard you do
 * not control, or a verification pass before the handlers are deployed. These
 * flags inline the values instead.
 *
 * TRADE-OFF, stated plainly: --action-secret writes the shared secret into the
 * metadata document in cleartext, where anyone with admin access can read it
 * back via export_metadata. That is strictly weaker than an env reference. Use
 * it for verification, then re-run WITHOUT these flags once the platform env
 * vars exist, which restores the env-reference form.
 */
const ACTION_BASE_URL = arg('action-base-url', '').replace(/\/+$/, '');
const ACTION_SECRET = arg('action-secret', '');

if (!TARGET_ENDPOINT || !TARGET_SECRET) {
  console.error(
    'Usage: node scripts/hasura-merge-metadata.mjs --target=https://<sub>.hasura.<region>.nhost.run \\\n' +
      '         [--target-secret=... | HASURA_GRAPHQL_ADMIN_SECRET] \\\n' +
      '         [--source=http://localhost:8080] [--source-secret=...] [--dry-run]',
  );
  process.exit(1);
}

async function metadataApi(endpoint, secret, body) {
  const res = await fetch(`${endpoint}/v1/metadata`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON from ${endpoint} (HTTP ${res.status}): ${text.slice(0, 400)}`);
  }
  if (!res.ok) {
    throw new Error(`${endpoint} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 1200)}`);
  }
  return json;
}

const exportMetadata = (endpoint, secret) =>
  metadataApi(endpoint, secret, { type: 'export_metadata', args: {} });

const describe = (tables) => tables.map((t) => `${t.table.schema}.${t.table.name}`);

// -----------------------------------------------------------------------------

log.step('Exporting metadata from source (this project)');
const source = await exportMetadata(SOURCE_ENDPOINT, SOURCE_SECRET);
const sourceDefault = (source.sources ?? []).find((s) => s.name === 'default');
if (!sourceDefault) throw new Error(`Source ${SOURCE_ENDPOINT} has no "default" database source.`);

const ourTables = (sourceDefault.tables ?? []).filter((t) => t.table.schema === 'public');
const ourFunctions = (sourceDefault.functions ?? []).filter((f) => f.function.schema === 'public');
log.ok(`${ourTables.length} public tables, ${ourFunctions.length} functions`);
log.info(describe(ourTables).join(', '));
log.ok(`${(source.actions ?? []).length} actions, ${(source.cron_triggers ?? []).length} cron triggers`);

log.step('Exporting metadata from target');
const target = await exportMetadata(TARGET_ENDPOINT, TARGET_SECRET);
const targetDefault = (target.sources ?? []).find((s) => s.name === 'default');
if (!targetDefault) throw new Error(`Target ${TARGET_ENDPOINT} has no "default" database source.`);

const backupPath = join(ROOT, '.tools', 'nhost-metadata-backup.json');
writeFileSync(backupPath, JSON.stringify(target, null, 2));
log.ok(`backup written to ${backupPath}`);

const preserved = (targetDefault.tables ?? []).filter((t) => t.table.schema !== 'public');
const replaced = (targetDefault.tables ?? []).filter((t) => t.table.schema === 'public');
log.ok(`preserving ${preserved.length} non-public tables owned by the target`);
log.info(describe(preserved).join(', ') || '(none)');
if (replaced.length > 0) {
  log.warn(`replacing ${replaced.length} existing public tables: ${describe(replaced).join(', ')}`);
}

// ------------------------------------------------------------------ merge

const merged = {
  ...target,
  version: 3,
  sources: (target.sources ?? []).map((s) =>
    s.name !== 'default'
      ? s
      : {
          ...s,
          // The target's own database connection block stays exactly as it is.
          configuration: s.configuration,
          tables: [...preserved, ...ourTables],
          functions: ourFunctions,
        },
  ),
  actions: source.actions ?? [],
  custom_types: source.custom_types ?? {},
  cron_triggers: source.cron_triggers ?? [],
};

// ------------------------------------------------- optional literal inlining

if (ACTION_BASE_URL || ACTION_SECRET) {
  let urlCount = 0;
  let secretCount = 0;

  const inlineHeaders = (headers) =>
    (headers ?? []).map((h) => {
      if (ACTION_SECRET && h.value_from_env === 'ACTION_WEBHOOK_SECRET') {
        secretCount += 1;
        const { value_from_env, ...rest } = h;
        void value_from_env;
        return { ...rest, value: ACTION_SECRET };
      }
      return h;
    });

  const inlineUrl = (url) => {
    if (ACTION_BASE_URL && typeof url === 'string' && url.includes('{{ACTION_BASE_URL}}')) {
      urlCount += 1;
      return url.replace('{{ACTION_BASE_URL}}', ACTION_BASE_URL);
    }
    return url;
  };

  for (const src of merged.sources) {
    for (const table of src.tables ?? []) {
      for (const trigger of table.event_triggers ?? []) {
        trigger.webhook = inlineUrl(trigger.webhook);
        trigger.headers = inlineHeaders(trigger.headers);
      }
    }
  }
  for (const action of merged.actions ?? []) {
    if (action.definition) {
      action.definition.handler = inlineUrl(action.definition.handler);
      action.definition.headers = inlineHeaders(action.definition.headers);
    }
  }
  for (const cron of merged.cron_triggers ?? []) {
    cron.webhook = inlineUrl(cron.webhook);
    cron.headers = inlineHeaders(cron.headers);
  }

  log.warn(
    `inlined ${urlCount} handler URL(s)` +
      (ACTION_SECRET ? ` and ${secretCount} shared-secret header(s)` : ''),
  );
  if (ACTION_SECRET) {
    log.info('The secret is now stored in the metadata in cleartext rather than');
    log.info('referenced from the environment. Re-run without --action-secret once');
    log.info('ACTION_WEBHOOK_SECRET exists in the target\'s environment.');
  }
}

const mergedPath = join(ROOT, '.tools', 'merged-metadata.json');
writeFileSync(mergedPath, JSON.stringify(merged, null, 2));
log.ok(`merged document written to ${mergedPath}`);

const finalTables = merged.sources.find((s) => s.name === 'default').tables;
log.info(`final table count: ${finalTables.length} (${preserved.length} preserved + ${ourTables.length} ours)`);

if (DRY_RUN) {
  log.warn('--dry-run: not applying');
  process.exit(0);
}

// ------------------------------------------------------------------ apply

log.step('Applying merged metadata to target');
try {
  const result = await metadataApi(TARGET_ENDPOINT, TARGET_SECRET, {
    type: 'replace_metadata',
    args: {
      // Surfaces problems instead of silently dropping them.
      allow_inconsistent_metadata: false,
      metadata: merged,
    },
  });
  log.ok(`replace_metadata: ${JSON.stringify(result).slice(0, 200)}`);
} catch (err) {
  log.fail(err.message);
  if (/not.*found.*env|environment variable/i.test(err.message)) {
    log.info('');
    log.info('Hasura resolves {{ACTION_BASE_URL}} and ACTION_WEBHOOK_SECRET from ITS OWN');
    log.info('environment. Set both in the Nhost dashboard under');
    log.info('Settings > Environment Variables, then re-run this script.');
  }
  process.exit(1);
}

log.step('Checking consistency');
const inconsistent = await metadataApi(TARGET_ENDPOINT, TARGET_SECRET, {
  type: 'get_inconsistent_metadata',
  args: {},
});
if (inconsistent.is_consistent) {
  log.ok('metadata is consistent');
} else {
  log.fail(`${inconsistent.inconsistent_objects?.length ?? 0} inconsistent object(s):`);
  for (const o of inconsistent.inconsistent_objects ?? []) {
    log.info(`- ${o.reason ?? JSON.stringify(o).slice(0, 200)}`);
  }
  process.exit(1);
}

console.log('\nDone. Next: seed the target, then run the integration suites against it.\n');
