import type { Prisma } from '@prisma/client';

export const INTERNAL_RESEARCH_SAFE_READ_ARTIFACT_KIND =
  'internal_research_safe_read_result';

export interface ClioArtifactPrivacyMarker {
  kind?: unknown;
  metadata?: unknown;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Server-only artifacts never participate in ordinary artifact surfaces. */
export function isInternalClioArtifact(value: ClioArtifactPrivacyMarker | null | undefined): boolean {
  return (
    value?.kind === INTERNAL_RESEARCH_SAFE_READ_ARTIFACT_KIND ||
    metadataRecord(value?.metadata).serverOnly === true
  );
}

/** Prisma-compatible predicate for atomic ordinary-artifact reads and writes. */
export function ordinaryClioArtifactWhere(): Prisma.ClioArtifactWhereInput {
  return {
    AND: [
      { kind: { not: INTERNAL_RESEARCH_SAFE_READ_ARTIFACT_KIND } },
      { NOT: { metadata: { path: ['serverOnly'], equals: true } } },
    ],
  };
}
