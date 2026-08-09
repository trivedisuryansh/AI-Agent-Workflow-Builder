/**
 * Nhost Auth client.
 *
 * Talks to the Nhost Auth REST API directly rather than through the Nhost SDK.
 * The reason is deliberate: @nhost/nhost-js v4 is a rewrite that the React
 * binding has not caught up to, and the auth surface used here (sign in, sign
 * up, refresh, sign out) is four stable endpoints. Fewer moving parts, and the
 * JWT handling stays visible, which matters for a project whose whole point is
 * where authority comes from.
 *
 * TOKEN STORAGE: the session lives in localStorage so a reload keeps you signed
 * in. That is readable by any script on the origin, i.e. it trades XSS
 * resistance for simplicity — the standard trade an SPA makes. It is acceptable
 * here because the access token grants exactly the Hasura permissions the user
 * already has, and because the sensitive operations (approval, execution) are
 * Actions that re-derive authority server-side rather than trusting anything
 * the token holder asserts.
 */

export interface NhostUser {
  id: string;
  email: string;
  displayName: string;
}

export interface NhostSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which accessToken stops being accepted. */
  expiresAt: number;
  user: NhostUser;
}

const STORAGE_KEY = 'wfb.session';

/**
 * URL resolution.
 *
 * Nhost Cloud URLs are derived from subdomain + region. The explicit overrides
 * exist so the identical code can point at the local docker-compose stack
 * (Postgres + Hasura + Nhost's own hasura-auth image), where the services are
 * on localhost ports rather than *.nhost.run. Overrides win when present.
 */
function subdomain(): string {
  const v = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
  if (!v) {
    throw new Error(
      'Set NEXT_PUBLIC_NHOST_SUBDOMAIN and NEXT_PUBLIC_NHOST_REGION (Nhost Cloud), ' +
        'or NEXT_PUBLIC_NHOST_AUTH_URL and NEXT_PUBLIC_NHOST_GRAPHQL_URL (local stack). ' +
        'Copy .env.example to .env.local.',
    );
  }
  return v;
}

function region(): string {
  const v = process.env.NEXT_PUBLIC_NHOST_REGION;
  if (!v) throw new Error('NEXT_PUBLIC_NHOST_REGION is not set. Copy .env.example to .env.local.');
  return v;
}

export function authUrl(): string {
  const override = process.env.NEXT_PUBLIC_NHOST_AUTH_URL;
  if (override) return override.replace(/\/+$/, '');
  return `https://${subdomain()}.auth.${region()}.nhost.run/v1`;
}

export function graphqlHttpUrl(): string {
  const override = process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL;
  if (override) return override;
  return `https://${subdomain()}.hasura.${region()}.nhost.run/v1/graphql`;
}

export function graphqlWsUrl(): string {
  // Same origin as the HTTP endpoint, so http->ws and https->wss.
  return graphqlHttpUrl().replace(/^http/, 'ws');
}

// -----------------------------------------------------------------------------

interface RawSession {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  user: { id: string; email: string; displayName: string };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${authUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AuthError(`Could not reach Nhost Auth: ${String(err)}`, 0);
  }

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* handled below */
  }

  if (!res.ok) {
    const message =
      (payload as { message?: string; error?: string } | null)?.message ??
      (payload as { error?: string } | null)?.error ??
      `Authentication failed (HTTP ${res.status})`;
    throw new AuthError(message, res.status);
  }
  return payload as T;
}

function toSession(raw: RawSession): NhostSession {
  return {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    // Refresh a minute early so an in-flight request never lands on an expired token.
    expiresAt: Date.now() + Math.max(0, raw.accessTokenExpiresIn - 60) * 1000,
    user: raw.user,
  };
}

export async function signIn(email: string, password: string): Promise<NhostSession> {
  const data = await post<{ session: RawSession | null; mfa?: unknown }>('/signin/email-password', {
    email,
    password,
  });
  if (!data.session) {
    throw new AuthError('This account requires multi-factor authentication, which is not supported here.', 400);
  }
  const session = toSession(data.session);
  persist(session);
  return session;
}

export async function signUp(
  email: string,
  password: string,
  displayName: string,
): Promise<NhostSession | null> {
  const data = await post<{ session: RawSession | null }>('/signup/email-password', {
    email,
    password,
    options: { displayName },
  });
  // Null session means the project requires email verification.
  if (!data.session) return null;
  const session = toSession(data.session);
  persist(session);
  return session;
}

export async function refresh(refreshToken: string): Promise<NhostSession> {
  const data = await post<RawSession>('/token', { refreshToken });
  const session = toSession(data);
  persist(session);
  return session;
}

export async function signOut(session: NhostSession | null): Promise<void> {
  clear();
  if (!session) return;
  try {
    await post('/signout', { refreshToken: session.refreshToken, all: false });
  } catch {
    // Local state is already cleared; a failed server-side revoke is not worth
    // blocking the user's sign-out on.
  }
}

// ------------------------------------------------------------------ storage

export function persist(session: NhostSession): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clear(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function load(): NhostSession | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NhostSession;
    if (!parsed?.accessToken || !parsed?.refreshToken || !parsed?.user?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Return a valid session, refreshing it first if the access token is stale. */
export async function ensureFresh(session: NhostSession): Promise<NhostSession> {
  if (Date.now() < session.expiresAt) return session;
  return refresh(session.refreshToken);
}
