'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../app/providers';
import { CREATE_WORKFLOW, DELETE_WORKFLOW, WORKFLOWS_FOR_ORG } from '../lib/queries';
import type { Workflow } from '../lib/model';
import { WorkflowEditor } from './WorkflowEditor';

export function Dashboard() {
  const {
    session,
    memberships,
    activeOrgId,
    activeMembership,
    setActiveOrgId,
    signOut,
    runQuery,
    refreshOrganizations,
  } = useAuth();

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');

  const org = activeMembership?.organization;
  const role = activeMembership?.role ?? 'viewer';
  const canCreate = role === 'owner' || role === 'editor';
  const quotaExhausted = org ? org.quota_used >= org.quota_limit : false;

  const loadWorkflows = useCallback(async () => {
    if (!activeOrgId) {
      setWorkflows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await runQuery<{ workflows: Workflow[] }>(WORKFLOWS_FOR_ORG, {
        orgId: activeOrgId,
      });
      setWorkflows(data.workflows);
      setSelectedId((current) =>
        current && data.workflows.some((w) => w.id === current)
          ? current
          : (data.workflows[0]?.id ?? null),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, runQuery]);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadWorkflows(), refreshOrganizations()]);
  }, [loadWorkflows, refreshOrganizations]);

  const selected = workflows.find((w) => w.id === selectedId) ?? null;
  const stats = org?.usage_stats ?? null;

  if (memberships.length === 0) {
    return (
      <div style={{ maxWidth: 640, margin: '80px auto', padding: 16 }}>
        <div className="panel stack">
          <strong>No organizations</strong>
          <span className="muted">
            You are signed in as {session?.user.email}, but you are not a member of any
            organization. Because every permission in this system resolves through org_members,
            an account with no membership can see nothing at all — which is the correct and
            intended outcome, not an error.
          </span>
          <span className="muted">
            Run <span className="mono">npm run seed</span> to create the demo organizations, or ask
            an owner to add you.
          </span>
          <button onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="appbar">
        <strong>AI Agent Workflow Builder</strong>

        <span className="row" style={{ gap: 8 }}>
          <label htmlFor="org" style={{ margin: 0 }}>
            Organization
          </label>
          <select
            id="org"
            value={activeOrgId ?? ''}
            onChange={(e) => setActiveOrgId(e.target.value)}
            style={{ width: 'auto' }}
          >
            {memberships.map((m) => (
              <option key={m.org_id} value={m.org_id}>
                {m.organization.name}
              </option>
            ))}
          </select>
          <span className={`badge ${role}`}>{role}</span>
        </span>

        {org && (
          <span style={{ minWidth: 200 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Usage</span>
              <span className={quotaExhausted ? 'status-failed' : ''}>
                {org.quota_used} / {org.quota_limit} executions
              </span>
            </div>
            <div className="quota-bar">
              <div
                className={`quota-fill ${quotaExhausted ? 'exhausted' : ''}`}
                style={{
                  width: `${Math.min(100, org.quota_limit === 0 ? 100 : (org.quota_used / org.quota_limit) * 100)}%`,
                }}
              />
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {quotaExhausted
                ? 'Quota exhausted — execution is blocked'
                : `${org.quota_limit - org.quota_used} remaining this period`}
            </div>
          </span>
        )}

        <span style={{ flex: 1 }} />
        <span className="muted">{session?.user.email}</span>
        <button onClick={signOut}>Sign out</button>
      </header>

      <div className="layout">
        <aside className="stack">
          <div className="panel stack">
            <strong>Workflows</strong>
            {loading && <span className="muted">Loading…</span>}
            {!loading && workflows.length === 0 && (
              <span className="muted">No workflows in this organization.</span>
            )}
            {workflows.map((w) => (
              <button
                key={w.id}
                onClick={() => setSelectedId(w.id)}
                style={{
                  textAlign: 'left',
                  background: w.id === selectedId ? 'var(--panel-2)' : 'transparent',
                  borderColor: w.id === selectedId ? 'var(--accent)' : 'var(--border)',
                }}
              >
                <div>{w.name}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {w.workflow_steps.length} steps
                  {w.workflow_runs[0] && (
                    <>
                      {' · '}
                      <span className={`status-${w.workflow_runs[0].status}`}>
                        {w.workflow_runs[0].status}
                      </span>
                    </>
                  )}
                </div>
              </button>
            ))}

            {canCreate && (
              <div className="row">
                <input
                  placeholder="New workflow name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <button
                  disabled={newName.trim() === ''}
                  onClick={async () => {
                    setError(null);
                    try {
                      await runQuery(CREATE_WORKFLOW, {
                        orgId: activeOrgId,
                        name: newName.trim(),
                        description: null,
                      });
                      setNewName('');
                      await loadWorkflows();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  Add
                </button>
              </div>
            )}
            {!canCreate && (
              <span className="muted">Viewers cannot create workflows.</span>
            )}
            {error && <div className="error-box">{error}</div>}
          </div>

          {stats && (
            <div className="panel stack" style={{ gap: 4 }}>
              <strong>Organization stats</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                From the organization_usage_stats view.
              </span>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Runs this period</span>
                <span>{stats.runs_this_period}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Completed</span>
                <span className="status-completed">{stats.completed_runs}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Failed</span>
                <span className="status-failed">{stats.failed_runs}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Paused</span>
                <span className="status-paused">{stats.paused_runs}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Avg duration</span>
                <span>
                  {stats.avg_run_duration_seconds === null
                    ? '—'
                    : `${Number(stats.avg_run_duration_seconds).toFixed(1)}s`}
                </span>
              </div>
            </div>
          )}
        </aside>

        <main className="stack">
          {selected ? (
            <>
              <WorkflowEditor
                key={selected.id}
                workflow={selected}
                role={role}
                quotaExhausted={quotaExhausted}
                onChanged={refreshAll}
              />
              {role === 'owner' && (
                <button
                  className="danger"
                  onClick={async () => {
                    await runQuery(DELETE_WORKFLOW, { id: selected.id });
                    setSelectedId(null);
                    await refreshAll();
                  }}
                >
                  Delete workflow
                </button>
              )}
            </>
          ) : (
            <div className="panel muted">Select or create a workflow.</div>
          )}
        </main>
      </div>
    </>
  );
}
