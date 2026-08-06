/** Phase 6 Workstream F — evidence completeness and duplicate composition. */
import {
  type AuthorizationProvisionExtractionResultV1,
  type AuthorizationProvisionReviewEntryV1,
  type AuthorizationProvisionV1,
} from './authorization-provision-v1.js';
import { reviewEntry } from './authorization-provision-link-utils-v1.js';
import { normalize, uniqueReferences } from './authorization-provision-targets-v1.js';

export interface DedupedProvisions {
  accepted: AuthorizationProvisionV1[];
  conflicts: AuthorizationProvisionReviewEntryV1[];
  conflictIds: Set<string>;
}

export function validateEvidence(
  provision: AuthorizationProvisionV1,
  extraction: AuthorizationProvisionExtractionResultV1,
  evidenceById: Map<string, AuthorizationProvisionExtractionResultV1['evidence'][number]>,
): string | null {
  if (
    extraction.omittedPages.some(
      (page) => page >= provision.pageRange.startPage && page <= provision.pageRange.endPage,
    )
  ) {
    return 'provision page range intersects an omitted physical page';
  }
  const resolved = provision.evidenceIds.map((id) => evidenceById.get(id));
  if (resolved.some((item) => item == null)) {
    return 'one or more provision evidence IDs are missing';
  }
  const evidence = resolved.filter(
    (item): item is NonNullable<typeof item> => item != null,
  );
  if (evidence.some((item) => item.sourceSha256 !== provision.sourceSha256)) {
    return 'provision evidence source SHA does not match the provision source';
  }
  const pages = new Set(evidence.map((item) => item.page));
  if (!pages.has(provision.pageRange.startPage) || !pages.has(provision.pageRange.endPage)) {
    return 'provision evidence does not cover both page-range boundaries';
  }
  return null;
}

export function dedupeProvisions(provisions: readonly AuthorizationProvisionV1[]): DedupedProvisions {
  const byNaturalKey = new Map<string, AuthorizationProvisionV1[]>();
  for (const provision of provisions) {
    const key = [
      provision.sourceDocumentId,
      provision.committee,
      provision.fiscalYear,
      normalize(provision.heading),
      provision.pageRange.startPage,
    ].join('|');
    const group = byNaturalKey.get(key) ?? [];
    group.push(provision);
    byNaturalKey.set(key, group);
  }

  const accepted: AuthorizationProvisionV1[] = [];
  const conflicts: AuthorizationProvisionReviewEntryV1[] = [];
  const conflictIds = new Set<string>();
  for (const group of byNaturalKey.values()) {
    const sorted = [...group].sort((a, b) => a.provisionId.localeCompare(b.provisionId));
    const first = sorted[0]!;
    const equivalent = sorted.every(
      (item) =>
        item.fullText === first.fullText &&
        item.pageRange.endPage === first.pageRange.endPage &&
        item.actionType === first.actionType &&
        item.scope === first.scope,
    );
    if (!equivalent) {
      for (const item of sorted) {
        conflictIds.add(item.provisionId);
        conflicts.push(
          reviewEntry(
            item,
            'conflicting',
            'duplicate_conflict',
            'same source/committee/fiscal-year/heading/start-page has conflicting text ' +
              'or semantics',
            undefined,
            [],
          ),
        );
      }
      continue;
    }
    accepted.push({
      ...first,
      evidenceIds: [...new Set(sorted.flatMap((item) => item.evidenceIds))].sort(),
      references: uniqueReferences(sorted.flatMap((item) => item.references)),
    });
  }
  return {
    accepted: accepted.sort((a, b) => a.provisionId.localeCompare(b.provisionId)),
    conflicts,
    conflictIds,
  };
}
