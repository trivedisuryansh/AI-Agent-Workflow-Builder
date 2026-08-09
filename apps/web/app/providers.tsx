'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { gql, disposeWsClient } from '../lib/gql';
import {
  ensureFresh,
  load,
  signIn as apiSignIn,
  signOut as apiSignOut,
  signUp as apiSignUp,
  type NhostSession,
} from '../lib/nhost';
import { MY_ORGANIZATIONS } from '../lib/queries';

export type OrgRole = 'owner' | 'editor' | 'viewer';

export interface UsageStats {
  total_runs: number;
  runs_this_period: number;
  completed_runs: number;
  failed_runs: number;
  paused_runs: number;
  quota_remaining: number;
  avg_run_duration_seconds: number | null;
}

export interface Membership {
  id: string;
  role: OrgRole;
  org_id: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    quota_used: number;
    quota_limit: number;
    quota_period_start: string;
    usage_stats: UsageStats | null;
  };
}

interface AuthContextValue {
  session: NhostSession | null;
  loading: boolean;
  memberships: Membership[];
  activeOrgId: string | null;
  activeMembership: Membership | null;
  setActiveOrgId: (id: string) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  refreshOrganizations: () => Promise<void>;
  runQuery: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <Providers>');
  return ctx;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<NhostSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(null);

  const runQuery = useCallback(
    async <T,>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      if (!session) throw new Error('Not signed in.');
      const fresh = await ensureFresh(session);
      if (fresh.accessToken !== session.accessToken) setSession(fresh);
      return gql<T>(query, variables, fresh);
    },
    [session],
  );

  const loadOrganizations = useCallback(
    async (forSession: NhostSession) => {
      const data = await gql<{ org_members: Membership[] }>(
        MY_ORGANIZATIONS,
        {},
        await ensureFresh(forSession),
      );
      setMemberships(data.org_members);
      setActiveOrgIdState((current) => {
        if (current && data.org_members.some((m) => m.org_id === current)) return current;
        return data.org_members[0]?.org_id ?? null;
      });
    },
    [],
  );

  // Restore a persisted session on first paint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = load();
      if (!stored) {
        setLoading(false);
        return;
      }
      try {
        const fresh = await ensureFresh(stored);
        if (cancelled) return;
        setSession(fresh);
        await loadOrganizations(fresh);
      } catch {
        // Expired or revoked refresh token: fall back to signed out.
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadOrganizations]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const next = await apiSignIn(email, password);
      setSession(next);
      await loadOrganizations(next);
    },
    [loadOrganizations],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      const next = await apiSignUp(email, password, displayName);
      if (!next) return 'Check your inbox to verify your email address, then sign in.';
      setSession(next);
      await loadOrganizations(next);
      return null;
    },
    [loadOrganizations],
  );

  const signOut = useCallback(async () => {
    const current = session;
    setSession(null);
    setMemberships([]);
    setActiveOrgIdState(null);
    disposeWsClient();
    await apiSignOut(current);
  }, [session]);

  const refreshOrganizations = useCallback(async () => {
    if (session) await loadOrganizations(session);
  }, [session, loadOrganizations]);

  const activeMembership = useMemo(
    () => memberships.find((m) => m.org_id === activeOrgId) ?? null,
    [memberships, activeOrgId],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      memberships,
      activeOrgId,
      activeMembership,
      setActiveOrgId: setActiveOrgIdState,
      signIn,
      signUp,
      signOut,
      refreshOrganizations,
      runQuery,
    }),
    [
      session,
      loading,
      memberships,
      activeOrgId,
      activeMembership,
      signIn,
      signUp,
      signOut,
      refreshOrganizations,
      runQuery,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
