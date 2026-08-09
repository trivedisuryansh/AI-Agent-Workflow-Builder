/**
 * Browser-side GraphQL.
 *
 * Every request here carries the USER's access token — never an admin secret,
 * which exists only in server-side environment variables and is never sent to
 * the browser. That means Hasura applies row-level permissions to everything
 * the UI does, and the UI cannot see or change anything the user could not
 * reach with a hand-written query. The UI hides controls for convenience; the
 * permissions are what actually enforce it.
 */

import { createClient, type Client } from 'graphql-ws';

import { ensureFresh, graphqlHttpUrl, graphqlWsUrl, type NhostSession } from './nhost';

export class GqlError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GqlError';
  }
}

export async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  session: NhostSession,
): Promise<T> {
  const fresh = await ensureFresh(session);

  const res = await fetch(graphqlHttpUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${fresh.accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };

  if (payload.errors?.length) {
    const first = payload.errors[0];
    throw new GqlError(first.message, first.extensions?.code);
  }
  if (!payload.data) throw new GqlError('No data returned.');
  return payload.data;
}

// -----------------------------------------------------------------------------
// Subscriptions
// -----------------------------------------------------------------------------

let wsClient: Client | null = null;
let wsTokenSource: (() => Promise<string>) | null = null;

/**
 * One shared socket for the app. The token is fetched per connection attempt,
 * so a reconnect after an expiry uses a refreshed token rather than replaying
 * a dead one.
 */
export function getWsClient(getToken: () => Promise<string>): Client {
  wsTokenSource = getToken;
  if (wsClient) return wsClient;

  wsClient = createClient({
    url: graphqlWsUrl(),
    lazy: true,
    retryAttempts: 10,
    shouldRetry: () => true,
    connectionParams: async () => {
      const token = await wsTokenSource!();
      return { headers: { authorization: `Bearer ${token}` } };
    },
  });
  return wsClient;
}

export function disposeWsClient(): void {
  wsClient?.dispose();
  wsClient = null;
  wsTokenSource = null;
}
