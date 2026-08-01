export const MEMORY_VERSION_KINDS = ['correction', 'restore', 'contradiction'] as const;
export type MemoryVersionKind = (typeof MEMORY_VERSION_KINDS)[number];

export type MemoryVersionActivationDecision = 'duplicate' | 'replace' | 'conflict';

/** Normalize only for deterministic equality checks; never use this as stored content. */
export function normalizeMemoryVersionText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
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
  const identity = candidateId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!identity) throw new Error('immutableMemoryVersionSlug requires a stable candidate id');

  // Keep the full UUID entropy (32 hex characters). Truncate the ROOT, never the
  // suffix: slicing the combined string allowed a 200-character source slug to
  // discard the version identity entirely and collide with the controlling row.
  const suffix = `~v${identity.slice(0, 32)}`;
  const rootBudget = Math.max(0, 200 - suffix.length);
  return `${root.slice(0, rootBudget)}${suffix}`;
}

export function isMemoryVersionKind(value: unknown): value is MemoryVersionKind {
  return (MEMORY_VERSION_KINDS as readonly unknown[]).includes(value);
}
