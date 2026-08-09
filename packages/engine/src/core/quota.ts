/**
 * Quota reservation.
 *
 * The interesting part is not this file — it is reserve_org_quota() in the
 * migration, which does the check and the increment while holding a row lock on
 * the organization. Doing it here in TypeScript would reintroduce exactly the
 * race the brief asks about: two requests both read quota_used = 19, both
 * decide 19 < 20, and both write 20.
 *
 * Because the reservation is taken BEFORE the run row is created, a failure to
 * create the run must refund it, or a transient error would permanently consume
 * a unit of the organization's allowance.
 */

import { adminRequest } from '../lib/hasura';
import { AuthorizationError } from './authz';

const RESERVE = /* GraphQL */ `
  mutation ReserveOrgQuota($org_id: uuid!) {
    reserve_org_quota(args: { p_org_id: $org_id }) {
      allowed
      reason
      quota_used
      quota_limit
    }
  }
`;

const RELEASE = /* GraphQL */ `
  mutation ReleaseOrgQuota($org_id: uuid!) {
    release_org_quota(args: { p_org_id: $org_id }) {
      quota_used
      quota_limit
    }
  }
`;

export interface QuotaReservation {
  used: number;
  limit: number;
}

export async function reserveQuota(orgId: string): Promise<QuotaReservation> {
  const data = await adminRequest<{
    reserve_org_quota: Array<{
      allowed: boolean;
      reason: string | null;
      quota_used: number;
      quota_limit: number;
    }>;
  }>(RESERVE, { org_id: orgId });

  const row = data.reserve_org_quota[0];
  if (!row) {
    throw new AuthorizationError('Quota reservation returned no result.', 'invalid_state');
  }

  if (!row.allowed) {
    if (row.reason === 'organization_not_found') {
      throw new AuthorizationError('Organization not found.', 'not_found');
    }
    throw new AuthorizationError(
      `Execution quota exhausted for this organization (${row.quota_used}/${row.quota_limit} used this period).`,
      'quota_exhausted',
    );
  }

  return { used: row.quota_used, limit: row.quota_limit };
}

export async function releaseQuota(orgId: string): Promise<void> {
  try {
    await adminRequest(RELEASE, { org_id: orgId });
  } catch (err) {
    // A failed refund must not mask the original error that triggered it.
    console.error('[quota] refund failed for org', orgId, err);
  }
}
