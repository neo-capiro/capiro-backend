export const MEMORY_VERSION_KINDS = ['correction', 'restore', 'contradiction'] as const;
export type MemoryVersionKind = (typeof MEMORY_VERSION_KINDS)[number];

export type MemoryVersionActivationDecision = 'duplicate' | 'replace' | 'conflict';

/** Normalize only for deterministic equality checks; never use this as stored content. */
export function normalizeMemoryVersionText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * Explicit correction/restore proposals replace the controlling version. An explicit
 * contradiction preserves both sides and opens a conflict. Exact content never creates
 * another controlling row, regardless of proposal kind.
 */
export function classifyMemoryVersionActivation(
  kind: MemoryVersionKind,
  proposedText: string,
  controllingText: string | null,
): MemoryVersionActivationDecision {
  if (
    controllingText !== null &&
    normalizeMemoryVersionText(proposedText) === normalizeMemoryVersionText(controllingText)
  ) {
    return 'duplicate';
  }
  return kind === 'contradiction' ? 'conflict' : 'replace';
}

/** Stable, bounded slug for a new immutable version. */
export function immutableMemoryVersionSlug(baseSlug: string, candidateId: string): string {
  const root = baseSlug.replace(/~(?:c|v)[a-z0-9-]+$/i, '');
  const suffix = candidateId.replace(/-/g, '').slice(0, 12).toLowerCase();
  return `${root}~v${suffix}`.slice(0, 200);
}

export function isMemoryVersionKind(value: unknown): value is MemoryVersionKind {
  return (MEMORY_VERSION_KINDS as readonly unknown[]).includes(value);
}
