/** Shared helpers for the repo's operational scripts. */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Minimal .env loader.
 *
 * Deliberately does NOT overwrite variables already present in the process
 * environment, so CI and shell exports win over a local file.
 */
export function loadEnv(files = ['.env.local', '.env']) {
  for (const file of files) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;

    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq === -1) continue;

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function need(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(
      `\nMissing ${name}.\n` +
        `Copy .env.example to .env.local and fill it in, then re-run.\n`,
    );
    process.exit(1);
  }
  return v.trim();
}

/**
 * Resolve service URLs for either target.
 *
 * Explicit overrides (used by the local docker-compose stack) win; otherwise
 * the Nhost Cloud convention of subdomain + region applies.
 */
export function nhostUrls() {
  const authOverride = process.env.NEXT_PUBLIC_NHOST_AUTH_URL?.trim();
  const gqlOverride =
    process.env.HASURA_GRAPHQL_ENDPOINT?.trim() ||
    process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL?.trim();

  if (authOverride && gqlOverride) {
    return {
      auth: authOverride.replace(/\/+$/, ''),
      graphql: gqlOverride,
      // Strip the /v1/graphql suffix to get the base the Hasura CLI wants.
      hasuraBase: gqlOverride.replace(/\/v1\/graphql\/?$/, ''),
    };
  }

  const sub = need('NEXT_PUBLIC_NHOST_SUBDOMAIN');
  const region = need('NEXT_PUBLIC_NHOST_REGION');
  return {
    auth: authOverride || `https://${sub}.auth.${region}.nhost.run/v1`,
    graphql: gqlOverride || `https://${sub}.hasura.${region}.nhost.run/v1/graphql`,
    hasuraBase: `https://${sub}.hasura.${region}.nhost.run`,
  };
}

/** Admin-privileged GraphQL request. Server-side scripts only. */
export async function adminGql(query, variables = {}) {
  const { graphql } = nhostUrls();
  const res = await fetch(graphql, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': need('HASURA_GRAPHQL_ADMIN_SECRET'),
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Hasura returned non-JSON (HTTP ${res.status}): ${text.slice(0, 400)}`);
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join('; '));
  }
  return payload.data;
}

/** GraphQL request as a specific signed-in user, so permissions apply. */
export async function userGql(query, variables, accessToken) {
  const { graphql } = nhostUrls();
  const res = await fetch(graphql, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await res.json();
  return payload;
}

export async function authPost(path, body) {
  const { auth } = nhostUrls();
  const res = await fetch(`${auth}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  return { ok: res.ok, status: res.status, payload };
}

/**
 * Create the user if absent, then sign in.
 * Returns { id, email, accessToken }.
 */
export async function ensureUser(email, password, displayName) {
  const signup = await authPost('/signup/email-password', {
    email,
    password,
    options: { displayName },
  });

  if (signup.ok && signup.payload?.session) {
    const s = signup.payload.session;
    return { id: s.user.id, email, accessToken: s.accessToken, created: true };
  }

  // Already registered, or the project requires email verification.
  const signin = await authPost('/signin/email-password', { email, password });
  if (signin.ok && signin.payload?.session) {
    const s = signin.payload.session;
    return { id: s.user.id, email, accessToken: s.accessToken, created: false };
  }

  const detail =
    signin.payload?.message ?? signup.payload?.message ?? `HTTP ${signin.status}`;
  throw new Error(
    `Could not create or sign in ${email}: ${detail}\n` +
      `If this says the email is unverified, turn OFF "Require email verification" in the ` +
      `Nhost dashboard under Auth > Sign-in methods, or verify the address manually.`,
  );
}

export const log = {
  step: (m) => console.log(`\n[36m▸ ${m}[0m`),
  ok: (m) => console.log(`  [32m✓[0m ${m}`),
  info: (m) => console.log(`    ${m}`),
  warn: (m) => console.log(`  [33m![0m ${m}`),
  fail: (m) => console.error(`  [31m✗[0m ${m}`),
};
