/**
 * Event Trigger receiver: workflow_runs INSERT.
 *
 * This is what actually executes a workflow. Authorization already happened in
 * whichever path created the run (the triggerWorkflowRun Action or a
 * secret-validated webhook), so there is no user here to authorize — only the
 * shared secret proving Hasura is the caller.
 *
 * Hasura guarantees at-least-once delivery, so this may be invoked more than
 * once for the same run. executeRun() claims the run with a conditional status
 * update and returns 'skipped_already_running' for the loser, which is reported
 * as a 200 so Hasura stops retrying.
 */

import { NextResponse } from 'next/server';

import { executeRun } from '@wfb/engine';

import {
  assertCalledByHasura,
  errorResponse,
  parseEventPayload,
} from '../../../../lib/action-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 60s is the ceiling on Vercel's Hobby tier, and higher values fail the deploy
// rather than being clamped. A full run of the demo workflow is ~6s (one LLM
// call plus one HTTP call), so this is not a real constraint. If a workflow
// ever needs longer, the right fix is splitting execution across event
// deliveries rather than raising this.
export const maxDuration = 60;

interface WorkflowRunRow {
  id: string;
  status: string;
  workflow_id: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCalledByHasura(request);

    const payload = await parseEventPayload<WorkflowRunRow>(request);
    const row = payload.event.data.new;

    if (!row?.id) {
      return NextResponse.json({ ok: true, skipped: 'no row in event payload' });
    }
    if (row.status !== 'pending') {
      // Only a freshly created run starts execution here.
      return NextResponse.json({ ok: true, skipped: `status was ${row.status}` });
    }

    const outcome = await executeRun(row.id, 'start');

    return NextResponse.json({
      ok: true,
      run_id: outcome.runId,
      status: outcome.status,
      executed_steps: outcome.executedSteps,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
