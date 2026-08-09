/**
 * Action: getWebhookUrl
 *
 * The webhook secret is the webhook's only credential, so it is excluded from
 * every Hasura select permission. This is the one door it comes out of, and it
 * is owner-only — an editor cannot create a webhook trigger (Layer 2), so it
 * would be inconsistent to let them read the secret of one an owner created.
 */

import { NextResponse } from 'next/server';

import { adminRequest, AuthorizationError, config, isUuid, requireUserId, type OrgRole } from '@wfb/engine';

import {
  assertCalledByHasura,
  errorResponse,
  HandlerError,
  parseActionPayload,
} from '../../../../lib/action-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Input {
  trigger_id: string;
}

const TRIGGER_AUTHZ = /* GraphQL */ `
  query WebhookTriggerAuthz($trigger_id: uuid!, $user_id: uuid!) {
    workflow_triggers_by_pk(id: $trigger_id) {
      id
      type
      enabled
      webhook_secret
      workflow {
        id
        organization {
          id
          org_members(where: { user_id: { _eq: $user_id } }) {
            role
          }
        }
      }
    }
  }
`;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCalledByHasura(request);

    const payload = await parseActionPayload<Input>(request);
    const userId = requireUserId(payload.session_variables);

    const triggerId = payload.input?.trigger_id;
    if (!isUuid(triggerId)) {
      throw new HandlerError('trigger_id must be a UUID.', 400, 'bad_request');
    }

    const data = await adminRequest<{
      workflow_triggers_by_pk: {
        id: string;
        type: string;
        enabled: boolean;
        webhook_secret: string | null;
        workflow: { id: string; organization: { id: string; org_members: Array<{ role: OrgRole }> } };
      } | null;
    }>(TRIGGER_AUTHZ, { trigger_id: triggerId, user_id: userId });

    const trigger = data.workflow_triggers_by_pk;
    const membership = trigger?.workflow.organization.org_members[0];

    // Indistinguishable from "does not exist", as everywhere else.
    if (!trigger || !membership) {
      throw new AuthorizationError('Trigger not found or you do not have access to it.', 'not_found');
    }
    if (membership.role !== 'owner') {
      throw new AuthorizationError(
        `Only an organization owner may reveal a webhook URL (your role: ${membership.role}).`,
        'forbidden',
      );
    }
    if (trigger.type !== 'webhook' || !trigger.webhook_secret) {
      throw new AuthorizationError(
        `Trigger ${triggerId} is a "${trigger.type}" trigger and has no webhook URL.`,
        'invalid_state',
      );
    }

    const base = config.appBaseUrl().replace(/\/+$/, '');
    return NextResponse.json({
      trigger_id: trigger.id,
      url: `${base}/api/webhook/${trigger.id}?secret=${trigger.webhook_secret}`,
      enabled: trigger.enabled,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
