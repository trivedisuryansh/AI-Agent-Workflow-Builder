'use client';

/**
 * Thin React binding over graphql-ws.
 *
 * Deliberately not a cache layer: the subscription IS the source of truth for
 * run state, so what arrives on the socket is rendered directly. No optimistic
 * local status is ever written, because a status the UI invented rather than
 * observed is precisely the kind of fake liveness this project must not have.
 */

import { useEffect, useRef, useState } from 'react';

import { getWsClient } from './gql';
import { ensureFresh, type NhostSession } from './nhost';

export interface SubscriptionState<T> {
  data: T | null;
  error: string | null;
  connected: boolean;
}

export function useSubscription<T>(
  query: string,
  variables: Record<string, unknown>,
  session: NhostSession | null,
  enabled = true,
): SubscriptionState<T> {
  const [state, setState] = useState<SubscriptionState<T>>({
    data: null,
    error: null,
    connected: false,
  });

  // Serialized so an inline object literal in the caller does not restart the
  // subscription on every render.
  const varsKey = JSON.stringify(variables);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (!enabled || !session) {
      setState({ data: null, error: null, connected: false });
      return;
    }

    let disposed = false;

    const client = getWsClient(async () => {
      const fresh = await ensureFresh(sessionRef.current!);
      return fresh.accessToken;
    });

    const unsubscribe = client.subscribe<T>(
      { query, variables: JSON.parse(varsKey) as Record<string, unknown> },
      {
        next: (message) => {
          if (disposed) return;
          if (message.errors?.length) {
            setState((s) => ({ ...s, error: message.errors![0].message, connected: true }));
            return;
          }
          setState({ data: (message.data as T) ?? null, error: null, connected: true });
        },
        error: (err) => {
          if (disposed) return;
          const message =
            err instanceof Error ? err.message
            : Array.isArray(err) ? err.map((e) => String((e as Error).message ?? e)).join('; ')
            : String(err);
          setState((s) => ({ ...s, error: message, connected: false }));
        },
        complete: () => {
          if (!disposed) setState((s) => ({ ...s, connected: false }));
        },
      },
    );

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [query, varsKey, enabled, session?.user.id]);

  return state;
}
