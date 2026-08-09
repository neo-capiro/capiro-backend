import {
  allAcceptedContextRefs,
  type OutreachCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';

export class OutreachContextSponsorPolicyError extends Error {
  readonly name = 'OutreachContextSponsorPolicyError';
}

/**
 * Client-specific context may be shared across a campaign only when that
 * campaign has exactly one explicit client sponsor and every client-specific
 * reference belongs to that client. Multi-client, coalition, firm and internal
 * campaigns remain client-neutral until per-client context packets exist.
 */
export function assertOutreachContextSponsorIsolation(
  spec: OutreachCampaignSpecV1,
): void {
  const clientIds = [
    ...new Set(
      allAcceptedContextRefs(spec)
        .map((entry) => entry.clientId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (clientIds.length === 0) return;

  const sponsorClient =
    spec.sponsor.kind === 'client' && spec.sponsor.clientRefs.length === 1
      ? spec.sponsor.clientRefs[0]?.clientId ?? null
      : null;
  if (!sponsorClient) {
    throw new OutreachContextSponsorPolicyError(
      'Client-specific context requires a single explicit client sponsor.',
    );
  }
  if (clientIds.some((clientId) => clientId !== sponsorClient)) {
    throw new OutreachContextSponsorPolicyError(
      'Client-specific context does not match the campaign sponsor client.',
    );
  }
}
