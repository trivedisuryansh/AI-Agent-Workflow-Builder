/**
 * Admin-scoped GraphQL client.
 *
 * SECURITY NOTE
 * -------------
 * This client carries the Hasura admin secret and therefore bypasses row-level
 * permissions. It exists only inside server-side handlers, never in anything
 * bundled for the browser. Every code path that reaches it must already have
 * performed an explicit authorization check (see core/authz.ts) — the admin
 * secret is used to *write engine state the calling user could not write
 * directly*, not to answer questions on the user's behalf.
 *
 * When a handler needs to answer "may this user see X", it does NOT use this
 * client; it re-asks Hasura with the user's own token so Hasura's permissions
 * remain the single source of truth.
 */

import { config } from './env.js';

export interface GraphQLError {
  message: string;
  extensions?: Record<string, unknown>;
}

export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly errors: GraphQLError[],
    readonly status: number,
  ) {
    super(message);
    this.name = 'GraphQLRequestError';
  }
}

interface RequestOptions {
  /** Override the endpoint (tests / multiple environments). */
  endpoint?: string;
  /** Send a user's JWT instead of the admin secret. */
  userToken?: string;
  /** Explicit role header; only meaningful together with userToken. */
  role?: string;
  timeoutMs?: number;
}

async function execute<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: RequestOptions,
): Promise<T> {
  const endpoint = opts.endpoint ?? config.hasuraEndpoint();
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (opts.userToken) {
    headers.authorization = `Bearer ${opts.userToken}`;
    if (opts.role) headers['x-hasura-role'] = opts.role;
  } else {
    headers['x-hasura-admin-secret'] = config.hasuraAdminSecret();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timed out' : String(err);
    throw new GraphQLRequestError(`GraphQL request to Hasura failed: ${reason}`, [], 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let payload: { data?: T; errors?: GraphQLError[] };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new GraphQLRequestError(
      `Hasura returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`,
      [],
      res.status,
    );
  }

  if (payload.errors?.length) {
    throw new GraphQLRequestError(
      payload.errors.map((e) => e.message).join('; '),
      payload.errors,
      res.status,
    );
  }
  if (!payload.data) {
    throw new GraphQLRequestError(`Hasura returned no data (HTTP ${res.status})`, [], res.status);
  }
  return payload.data;
}

/** Admin-privileged request. Only for engine state writes after authorization. */
export function adminRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: Omit<RequestOptions, 'userToken' | 'role'> = {},
): Promise<T> {
  return execute<T>(query, variables, opts);
}

/**
 * Request executed AS THE USER. Hasura applies the same row-level permissions
 * the browser would get, which is exactly what makes it usable as an
 * authorization probe.
 */
export function userRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  userToken: string,
  opts: Omit<RequestOptions, 'userToken'> = {},
): Promise<T> {
  return execute<T>(query, variables, { ...opts, userToken });
}
