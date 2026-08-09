/**
 * Shared plumbing for Hasura Action / Event Trigger handlers.
 *
 * Two independent things are verified on every request:
 *
 *  1. That the caller is Hasura. These routes are public HTTPS endpoints; if
 *     anyone could POST to them with a hand-written body containing
 *     `session_variables: { "x-hasura-user-id": <victim> }`, the entire
 *     authorization model would collapse. The shared secret in the
 *     x-action-secret header (configured in metadata, stored in Hasura's env)
 *     is what makes the session_variables block trustworthy.
 *
 *  2. That the identity comes from session_variables and NOT from the input
 *     payload — enforced by the handlers, which never read a user or org id
 *     out of `input`.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { AuthorizationError, config, type SessionVariables } from '@wfb/engine';

export interface HasuraActionPayload<TInput> {
  action: { name: string };
  input: TInput;
  session_variables: SessionVariables;
  request_query?: string;
}

export interface HasuraEventPayload<TRow> {
  id: string;
  trigger: { name: string };
  table: { schema: string; name: string };
  event: {
    op: 'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL';
    data: { old: TRow | null; new: TRow | null };
    session_variables: SessionVariables | null;
  };
  delivery_info: { current_retry: number; max_retries: number };
}

/** Constant-time comparison so the secret cannot be recovered byte by byte. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so the failure takes a similar amount of time.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export class HandlerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

/** Throws unless the request carries the shared secret Hasura was configured with. */
export function assertCalledByHasura(request: Request): void {
  const provided = request.headers.get('x-action-secret') ?? '';
  let expected: string;
  try {
    expected = config.actionSecret();
  } catch {
    // Misconfiguration must fail closed, never open.
    throw new HandlerError(
      'Server is misconfigured: ACTION_WEBHOOK_SECRET is not set.',
      500,
      'server_misconfigured',
    );
  }
  if (!provided || !secretsMatch(provided, expected)) {
    throw new HandlerError('Forbidden.', 403, 'forbidden');
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_state: 409,
  quota_exhausted: 429,
};

/**
 * Hasura surfaces { message, extensions } from a non-2xx response as a GraphQL
 * error, which is how the client sees a clean reason string.
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HandlerError) {
    return NextResponse.json(
      { message: err.message, extensions: { code: err.code } },
      { status: err.status },
    );
  }
  if (err instanceof AuthorizationError) {
    return NextResponse.json(
      { message: err.message, extensions: { code: err.code } },
      { status: STATUS_BY_CODE[err.code] ?? 403 },
    );
  }

  // Anything unexpected: log server-side with detail, return an opaque message.
  // Internal errors sometimes carry table names or SQL, which is not the
  // client's business.
  console.error('[handler] unhandled error', err);
  return NextResponse.json(
    { message: 'Internal error executing this operation.', extensions: { code: 'internal' } },
    { status: 500 },
  );
}

export async function parseActionPayload<TInput>(
  request: Request,
): Promise<HasuraActionPayload<TInput>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HandlerError('Request body was not valid JSON.', 400, 'bad_request');
  }

  const payload = body as HasuraActionPayload<TInput>;
  if (!payload || typeof payload !== 'object' || !payload.input) {
    throw new HandlerError('Malformed Hasura action payload.', 400, 'bad_request');
  }
  return payload;
}

export async function parseEventPayload<TRow>(
  request: Request,
): Promise<HasuraEventPayload<TRow>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HandlerError('Request body was not valid JSON.', 400, 'bad_request');
  }
  const payload = body as HasuraEventPayload<TRow>;
  if (!payload?.event?.data) {
    throw new HandlerError('Malformed Hasura event payload.', 400, 'bad_request');
  }
  return payload;
}
