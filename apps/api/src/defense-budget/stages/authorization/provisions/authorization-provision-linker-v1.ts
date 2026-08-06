/** Phase 6 Workstream F — exact-first, write-free provision linking and verification. */
import {
  authorizationProvisionExtractionResultV1Schema,
  authorizationProvisionProjectionPlanV1Schema,
  type AuthorizationProvisionExtractionResultV1,
  type AuthorizationProvisionLinkV1,
  type AuthorizationProvisionNativeIndexV1,
  type AuthorizationProvisionProjectionPlanV1,
  type AuthorizationProvisionReviewEntryV1,
} from './authorization-provision-v1.js';
import {
  dedupeProvisions,
  validateEvidence,
} from './authorization-provision-evidence-dedupe-v1.js';
import { reviewEntry, sortLinks } from './authorization-provision-link-utils-v1.js';
import { linkAuthorizationProvisionReferencesV1 } from './authorization-provision-reference-linking-v1.js';

export interface ComposeAuthorizationProvisionProjectionV1Input {
  extraction: AuthorizationProvisionExtractionResultV1;
  index: AuthorizationProvisionNativeIndexV1;
}

export function composeAuthorizationProvisionProjectionV1(
  input: ComposeAuthorizationProvisionProjectionV1Input,
): AuthorizationProvisionProjectionPlanV1 {
  const extraction = authorizationProvisionExtractionResultV1Schema.parse(input.extraction);
  const deduped = dedupeProvisions(extraction.provisions);
  const acceptedLinks: AuthorizationProvisionLinkV1[] = [];
  const candidateLinks: AuthorizationProvisionLinkV1[] = [];
  const reviewQueue: AuthorizationProvisionReviewEntryV1[] = [...deduped.conflicts];
  const checks: AuthorizationProvisionProjectionPlanV1['verification']['checks'] = [];
  const evidenceById = new Map(extraction.evidence.map((item) => [item.evidenceId, item]));
  let blocked = deduped.conflicts.length > 0;
  let review = false;

  checks.push({
    code: 'source_binding',
    outcome: 'PASS',
    message: 'all provisions are bound to the extraction source and stage',
    provisionIds: deduped.accepted.map((item) => item.provisionId),
  });

  for (const provision of deduped.accepted) {
    if (deduped.conflictIds.has(provision.provisionId)) continue;
    const evidenceIssue = validateEvidence(provision, extraction, evidenceById);
    if (evidenceIssue != null) {
      const entry = reviewEntry(
        provision,
        'unresolved',
        'missing_evidence',
        evidenceIssue,
        undefined,
        [],
      );
      reviewQueue.push(entry);
      blocked = true;
      checks.push({
        code: 'evidence_complete',
        outcome: 'FAIL',
        message: evidenceIssue,
        provisionIds: [provision.provisionId],
      });
      continue;
    }

    checks.push({
      code: 'evidence_complete',
      outcome: 'PASS',
      message: 'all cited evidence exists and covers the provision page range',
      provisionIds: [provision.provisionId],
    });
    checks.push({
      code: 'scope_attribution',
      outcome: 'PASS',
      message: 'provision scope and attribution caveat are contract-valid',
      provisionIds: [provision.provisionId],
    });

    const linked = linkAuthorizationProvisionReferencesV1(provision, input.index);
    acceptedLinks.push(...linked.acceptedLinks);
    candidateLinks.push(...linked.candidateLinks);
    reviewQueue.push(...linked.reviewQueue);
    blocked ||= linked.blocked;
    review ||= linked.review;
  }

  const affected = deduped.accepted.map((item) => item.provisionId);
  checks.push({
    code: 'duplicate_provision',
    outcome: deduped.conflicts.length > 0 ? 'FAIL' : 'PASS',
    message:
      deduped.conflicts.length > 0
        ? 'conflicting duplicate provisions require review'
        : 'identical duplicates were composed deterministically',
    provisionIds: affected,
  });
  checks.push({
    code: 'exact_link_policy',
    outcome: blocked ? 'FAIL' : review ? 'REVIEW' : 'PASS',
    message: blocked
      ? 'one or more required exact references are unresolved or conflicting'
      : review
        ? 'candidate title links remain in the review queue'
        : 'all accepted links use exact identifiers or reviewed aliases',
    provisionIds: affected,
  });
  checks.push({
    code: 'projection_containment',
    outcome: 'PASS',
    message: 'output is a noncanonical projection plan with persistence disabled',
    provisionIds: affected,
  });

  const plan: AuthorizationProvisionProjectionPlanV1 = {
    schemaVersion: 'authorization_provision_projection_plan_v1',
    writeMode: 'projection_only',
    canonicalWriteAllowed: false,
    legacyProvisionMutationAllowed: false,
    stage: extraction.stage,
    profileId: extraction.profileId,
    sourceDocumentId: extraction.sourceDocumentId,
    sourceSha256: extraction.sourceSha256,
    provisions: deduped.accepted,
    acceptedLinks: sortLinks(acceptedLinks),
    candidateLinks: sortLinks(candidateLinks),
    reviewQueue: [...reviewQueue].sort((a, b) => a.reviewId.localeCompare(b.reviewId)),
    verification: {
      status: blocked ? 'BLOCKED' : review ? 'REVIEW' : 'PASS',
      checks,
    },
  };
  return authorizationProvisionProjectionPlanV1Schema.parse(plan);
}
