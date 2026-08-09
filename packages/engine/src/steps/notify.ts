/**
 * notify — enqueue a notification row.
 *
 * The step itself does not talk to Slack. It inserts into `notifications`, and
 * a Hasura Event Trigger on that INSERT calls /api/events/notification, which
 * performs the delivery and writes back status/sent_at. That indirection is the
 * point: delivery gets Hasura's retry semantics, the workflow is not blocked on
 * a third party, and the architecture is the one the brief asks for
 * (row -> Event Trigger -> function -> Slack).
 *
 * With NOTIFY_MODE=log the delivery function records the payload and marks the
 * row sent without an outbound call, so the whole path is exercised even
 * without Slack credentials.
 */

import { adminRequest } from '../lib/hasura.js';
import { StepError, type Json, type NotifyConfig, type StepExecutionResult } from '../types.js';

const INSERT_NOTIFICATION = /* GraphQL */ `
  mutation InsertNotification(
    $run_id: uuid!
    $step_run_id: uuid
    $channel: String!
    $payload: jsonb!
  ) {
    insert_notifications_one(
      object: {
        workflow_run_id: $run_id
        step_run_id: $step_run_id
        channel: $channel
        payload: $payload
      }
    ) {
      id
      org_id
      status
      created_at
    }
  }
`;

export async function executeNotify(
  cfg: NotifyConfig,
  runId: string,
  stepRunId: string,
): Promise<StepExecutionResult> {
  if (typeof cfg.message !== 'string' || cfg.message.trim() === '') {
    throw new StepError('notify requires a non-empty "message"', { permanent: true });
  }

  const channel = cfg.channel ?? 'log';
  if (!['slack', 'email', 'log'].includes(channel)) {
    throw new StepError(`notify "channel" must be slack, email, or log (got ${channel})`, {
      permanent: true,
    });
  }

  const payload: Record<string, Json> = {
    title: cfg.title ?? 'Workflow notification',
    message: cfg.message,
    workflow_run_id: runId,
  };

  const data = await adminRequest<{
    insert_notifications_one: { id: string; org_id: string; status: string; created_at: string } | null;
  }>(INSERT_NOTIFICATION, {
    run_id: runId,
    step_run_id: stepRunId,
    channel,
    payload,
  });

  const row = data.insert_notifications_one;
  if (!row) throw new StepError('notify produced no notification row', { permanent: false });

  return {
    output: {
      notification_id: row.id,
      org_id: row.org_id,
      channel,
      // 'pending' here is correct and expected: the Event Trigger flips it to
      // 'sent' or 'failed' out of band. The run does not wait on delivery.
      delivery_status: row.status,
      enqueued_at: row.created_at,
    },
  };
}
