/**
 * Event Trigger receiver: notifications INSERT.
 *
 * Completes the notify architecture:
 *   notify step -> notifications row -> Event Trigger -> here -> Slack
 *
 * With NOTIFY_MODE=log there is no outbound call; the row is marked sent and
 * the payload is logged. That is a disclosed stub for the delivery leg only —
 * the row, the trigger, this handler, and the status write-back are all real,
 * so wiring a SLACK_WEBHOOK_URL is the entire difference.
 */

import { NextResponse } from 'next/server';

import { adminRequest, config } from '@wfb/engine';

import {
  assertCalledByHasura,
  errorResponse,
  parseEventPayload,
} from '../../../../lib/action-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface NotificationRow {
  id: string;
  org_id: string;
  channel: string;
  status: string;
  payload: { title?: string; message?: string; workflow_run_id?: string };
}

const MARK_DELIVERED = /* GraphQL */ `
  mutation MarkNotification($id: uuid!, $status: String!, $sent_at: timestamptz, $error: String) {
    update_notifications_by_pk(
      pk_columns: { id: $id }
      _set: { status: $status, sent_at: $sent_at, error: $error }
    ) {
      id
      status
    }
  }
`;

async function deliverToSlack(row: NotificationRow): Promise<void> {
  const url = config.slackWebhookUrl();
  if (!url) {
    throw new Error('NOTIFY_MODE=slack but SLACK_WEBHOOK_URL is not set');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `*${row.payload.title ?? 'Workflow notification'}*\n${row.payload.message ?? ''}`,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Slack returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCalledByHasura(request);

    const payload = await parseEventPayload<NotificationRow>(request);
    const row = payload.event.data.new;
    if (!row?.id) return NextResponse.json({ ok: true, skipped: 'no row' });
    if (row.status !== 'pending') {
      return NextResponse.json({ ok: true, skipped: `already ${row.status}` });
    }

    const mode = config.notifyMode();
    try {
      if (mode === 'slack' && row.channel === 'slack') {
        await deliverToSlack(row);
      } else {
        console.log(
          `[notify:${mode}] org=${row.org_id} run=${row.payload.workflow_run_id ?? '-'} ` +
            `channel=${row.channel} title=${JSON.stringify(row.payload.title)} ` +
            `message=${JSON.stringify(row.payload.message)}`,
        );
      }

      await adminRequest(MARK_DELIVERED, {
        id: row.id,
        status: 'sent',
        sent_at: new Date().toISOString(),
        error: null,
      });
      return NextResponse.json({ ok: true, notification_id: row.id, delivered_via: mode });
    } catch (deliveryError) {
      const message = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
      await adminRequest(MARK_DELIVERED, {
        id: row.id,
        status: 'failed',
        sent_at: null,
        error: message.slice(0, 1000),
      });
      // Non-2xx so Hasura's retry schedule gets a chance at a transient outage.
      return NextResponse.json(
        { ok: false, notification_id: row.id, error: message },
        { status: 502 },
      );
    }
  } catch (err) {
    return errorResponse(err);
  }
}
