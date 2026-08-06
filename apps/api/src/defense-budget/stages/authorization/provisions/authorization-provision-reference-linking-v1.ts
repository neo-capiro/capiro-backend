/** Phase 6 Workstream F — pure accepted/candidate provision-reference linking. */
import {
  authorizationProvisionTargetV1Schema,
  type AuthorizationProvisionLinkV1,
  type AuthorizationProvisionNativeIndexV1,
  type AuthorizationProvisionReviewEntryV1,
  type AuthorizationProvisionV1,
} from './authorization-provision-v1.js';
import { linkFor, reviewEntry, stableId } from './authorization-provision-link-utils-v1.js';
import {
  containsPhrase,
  exactTargets,
  normalize,
  targetExists,
  targetKey,
  titleTargets,
} from './authorization-provision-targets-v1.js';

export interface ProvisionReferenceLinkingResultV1 {
  acceptedLinks: AuthorizationProvisionLinkV1[];
  candidateLinks: AuthorizationProvisionLinkV1[];
  reviewQueue: AuthorizationProvisionReviewEntryV1[];
  blocked: boolean;
  review: boolean;
}

export function linkAuthorizationProvisionReferencesV1(
  provision: AuthorizationProvisionV1,
  index: AuthorizationProvisionNativeIndexV1,
): ProvisionReferenceLinkingResultV1 {
  const acceptedLinks: AuthorizationProvisionLinkV1[] = [];
  const candidateLinks: AuthorizationProvisionLinkV1[] = [];
  const reviewQueue: AuthorizationProvisionReviewEntryV1[] = [];
  const linkedTargetKeys = new Set<string>();
  let blocked = false;
  let review = false;

  for (const reference of provision.references) {
    if (reference.referenceKind === 'title_only') {
      const targets = titleTargets(reference.title, index);
      if (targets.length === 0) {
        reviewQueue.push(
          reviewEntry(
            provision,
            'unresolved',
            'unresolved_exact_reference',
            `title-only reference "${reference.title}" has no indexed target`,
            reference,
            [],
          ),
        );
        review = true;
        continue;
      }
      if (targets.length > 1) {
        reviewQueue.push(
          reviewEntry(
            provision,
            'conflicting',
            'title_only_match',
            `title-only reference "${reference.title}" matches multiple targets`,
            reference,
            targets,
          ),
        );
        review = true;
        continue;
      }
      const target = targets[0]!;
      const reviewId = stableId('review', {
        provisionId: provision.provisionId,
        title: reference.title,
        target: targetKey(target),
      });
      candidateLinks.push(
        linkFor(provision, target, 'candidate', 'title_only', 0.7, reviewId),
      );
      reviewQueue.push({
        reviewId,
        provisionId: provision.provisionId,
        status: 'candidate',
        reason: 'title_only_match',
        message: 'title-only matching is reviewable and never auto-accepted',
        reference,
        targets: [target],
        evidenceIds: provision.evidenceIds,
      });
      review = true;
      continue;
    }

    const targets = exactTargets(reference, index);
    if (targets.length === 0) {
      reviewQueue.push(
        reviewEntry(
          provision,
          'unresolved',
          'unresolved_exact_reference',
          `exact ${reference.referenceKind} reference does not resolve`,
          reference,
          [],
        ),
      );
      blocked = true;
      continue;
    }
    if (targets.length > 1) {
      reviewQueue.push(
        reviewEntry(
          provision,
          'conflicting',
          'ambiguous_exact_reference',
          `exact ${reference.referenceKind} reference resolves to multiple targets`,
          reference,
          targets,
        ),
      );
      blocked = true;
      continue;
    }
    const target = targets[0]!;
    const key = targetKey(target);
    if (!linkedTargetKeys.has(key)) {
      linkedTargetKeys.add(key);
      acceptedLinks.push(
        linkFor(
          provision,
          target,
          'accepted',
          reference.referenceKind === 'pe_code'
            ? 'exact_pe_code'
            : reference.referenceKind === 'rdte_project'
              ? 'exact_project_code'
              : 'exact_native_reference',
          1,
        ),
      );
    }
  }

  const normalizedText = normalize(`${provision.heading}\n${provision.fullText}`);
  for (const reviewed of index.reviewedAliases) {
    const alias = normalize(reviewed.alias);
    const target = authorizationProvisionTargetV1Schema.parse(reviewed.target);
    if (!alias || !containsPhrase(normalizedText, alias) || !targetExists(target, index)) continue;
    const key = targetKey(target);
    if (linkedTargetKeys.has(key)) continue;
    linkedTargetKeys.add(key);
    acceptedLinks.push(
      linkFor(provision, target, 'accepted', 'reviewed_alias', 0.95, reviewed.reviewId),
    );
  }

  return { acceptedLinks, candidateLinks, reviewQueue, blocked, review };
}
