/**
 * Cron receiver: scheduled trigger sweep.
 *
 * One Hasura cron drives every scheduled trigger, rather than one Hasura cron
 * per workflow. Adding a schedule is then an ordinary row insert governed by the
 * same Layer 1 permissions as any other trigger, instead of a metadata write.
 *
 * Trigger config: { "every_minutes": 60 }  (default 60, floor 15 — the cron
 * itself only runs every 15 minutes, so anything finer would be a lie).
 *
 * Each dispatch reserves quota like any other run, so a scheduled workflow
 * cannot outrun its organization's allowance; when the quota is gone the sweep
 * records the rejection and moves on to the next trigger.
 */

import { NextResponse } from 'next/server';

import { adminRequest, AuthorizationError, createRunWithQuota, type Json } from '@wfb/engine';

import { assertCalledByHasura, errorResponse } from '../../../../lib/action-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MIN_INTERVAL_MINUTES = 15;

const DUE_TRIGGERS = /* GraphQL */ `
  query DueScheduledTriggers {
    workflow_triggers(
      where: { type: { _eq: "scheduled" }, enabled: { _eq: true } }
      order_by: { created_at: asc }
      limit: 100
    ) {
      id
      config
      workflow {
        id
        org_id
        status
        workflow_steps_aggregate {
          aggregate {
            count
          }
        }
        workflow_runs(
          where: { trigger_type: { _eq: "scheduled" } }
          order_by: { created_at: desc }
          limit: 1
        ) {
          id
          created_at
        }
      }
    }
  }
`;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCalledByHasura(request);

    const data = await adminRequest<{
      workflow_triggers: Array<{
        id: string;
        config: { every_minutes?: number };
        workflow: {
          id: string;
          org_id: string;
          status: string;
          workflow_steps_aggregate: { aggregate: { count: number } | null };
          workflow_runs: Array<{ id: string; created_at: string }>;
        };
      }>;
    }>(DUE_TRIGGERS, {});

    const now = Date.now();
    const dispatched: string[] = [];
    const skipped: Array<{ trigger_id: string; reason: string }> = [];

    for (const trigger of data.workflow_triggers) {
      const wf = trigger.workflow;

      if (wf.status === 'archived') {
        skipped.push({ trigger_id: trigger.id, reason: 'workflow archived' });
        continue;
      }
      if ((wf.workflow_steps_aggregate.aggregate?.count ?? 0) === 0) {
        skipped.push({ trigger_id: trigger.id, reason: 'workflow has no steps' });
        continue;
      }

      const intervalMinutes = Math.max(
        MIN_INTERVAL_MINUTES,
        Number(trigger.config?.every_minutes ?? 60),
      );
      const last = wf.workflow_runs[0];
      if (last) {
        const elapsedMinutes = (now - new Date(last.created_at).getTime()) / 60_000;
        if (elapsedMinutes < intervalMinutes) {
          skipped.push({
            trigger_id: trigger.id,
            reason: `not due (${Math.round(elapsedMinutes)}m of ${intervalMinutes}m elapsed)`,
          });
          continue;
        }
      }

      try {
        const created = await createRunWithQuota({
          workflowId: wf.id,
          orgId: wf.org_id,
          triggerType: 'scheduled',
          triggeredBy: null,
          input: { source: 'scheduled', trigger_id: trigger.id } as Json,
        });
        dispatched.push(created.runId);
      } catch (err) {
        // One organization being out of quota must not stop the sweep.
        const reason =
          err instanceof AuthorizationError ? err.message : `dispatch failed: ${String(err)}`;
        skipped.push({ trigger_id: trigger.id, reason });
      }
    }

    return NextResponse.json({
      ok: true,
      considered: data.workflow_triggers.length,
      dispatched,
      skipped,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
