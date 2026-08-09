/**
 * Apply migrations + metadata to the configured Hasura instance.
 *
 *   npm run hasura:apply
 *
 * Wraps the real Hasura CLI so the repository stays reproducible with the
 * standard tooling — nothing here is applied by hand, which is what makes the
 * committed metadata authoritative rather than decorative.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnv, log, need, nhostUrls, ROOT } from './lib/common.mjs';

loadEnv();

const hasuraDir = join(ROOT, 'hasura');
const localBinary = join(ROOT, '.tools', process.platform === 'win32' ? 'hasura.exe' : 'hasura');
const binary = existsSync(localBinary) ? localBinary : 'hasura';

const { hasuraBase } = nhostUrls();
const endpoint = process.env.HASURA_ENDPOINT?.trim() || hasuraBase;
const adminSecret = need('HASURA_GRAPHQL_ADMIN_SECRET');

function run(args, label) {
  log.step(label);
  const result = spawnSync(
    binary,
    [...args, '--endpoint', endpoint, '--admin-secret', adminSecret, '--skip-update-check'],
    { cwd: hasuraDir, stdio: 'inherit', shell: false },
  );

  if (result.error) {
    log.fail(`Could not run the Hasura CLI (${binary}): ${result.error.message}`);
    log.info('Install it, or place the binary at .tools/hasura(.exe).');
    process.exit(1);
  }
  if (result.status !== 0) {
    log.fail(`${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
  log.ok(`${label} done`);
}

console.log(`Target: ${endpoint}`);

run(['migrate', 'apply', '--database-name', 'default'], 'Applying migrations');
run(['metadata', 'apply'], 'Applying metadata');
run(['metadata', 'reload'], 'Reloading metadata');

// Surfaces inconsistencies (an untracked table, a broken relationship, an
// Action pointing at an unreachable handler) instead of leaving them latent.
log.step('Checking metadata consistency');
const check = spawnSync(
  binary,
  ['metadata', 'inconsistency', 'list', '--endpoint', endpoint, '--admin-secret', adminSecret, '--skip-update-check'],
  { cwd: hasuraDir, stdio: 'inherit', shell: false },
);
if (check.status !== 0) {
  log.warn('Hasura reported metadata inconsistencies — see the output above.');
  process.exit(1);
}
log.ok('Metadata is consistent');

console.log('\nNext: npm run seed\n');
