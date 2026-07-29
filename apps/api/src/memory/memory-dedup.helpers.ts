export interface MemoryIdentityInput {
  key: string;
  value: string;
  memoryClass: string;
  scope: string;
  ownerUserId?: string | null;
  clientId?: string | null;
}

export interface MemoryDedupCandidate extends MemoryIdentityInput {
  id: string;
  status: string;
  kind: 'item' | 'candidate';
}

export interface MemoryDedupDecision {
  duplicateId: string | null;
  conflictId: string | null;
  similarity: number;
  reason: 'exact_identity' | 'semantic_duplicate' | 'semantic_conflict' | 'none';
}

export function normalizedMemoryIdentity(input: MemoryIdentityInput): string {
  return [
    normalize(input.memoryClass),
    normalize(input.scope),
    normalize(input.clientId ?? ''),
    normalize(input.ownerUserId ?? ''),
    normalize(input.key),
  ].join('|');
}

/** Deterministic token Jaccard; no network/model call and no content logging. */
export function memoryTextSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Exact identity plus semantic similarity. An active authoritative item is never
 * overwritten: a materially different value becomes a conflict proposal.
 */
export function decideMemoryDedup(
  proposed: MemoryIdentityInput,
  existing: readonly MemoryDedupCandidate[],
  thresholds: { duplicate?: number; conflict?: number } = {},
): MemoryDedupDecision {
  const identity = normalizedMemoryIdentity(proposed);
  const duplicateThreshold = thresholds.duplicate ?? 0.94;
  const conflictThreshold = thresholds.conflict ?? 0.62;
  let best: { row: MemoryDedupCandidate; similarity: number } | null = null;

  for (const row of existing) {
    if (normalizedMemoryIdentity(row) !== identity) continue;
    const similarity = memoryTextSimilarity(proposed.value, row.value);
    if (!best || similarity > best.similarity || (similarity === best.similarity && row.id < best.row.id)) {
      best = { row, similarity };
    }
  }
  if (!best) return { duplicateId: null, conflictId: null, similarity: 0, reason: 'none' };
  if (normalize(proposed.value) === normalize(best.row.value)) {
    return {
      duplicateId: best.row.id,
      conflictId: null,
      similarity: 1,
      reason: 'exact_identity',
    };
  }
  if (best.similarity >= duplicateThreshold) {
    return {
      duplicateId: best.row.id,
      conflictId: null,
      similarity: best.similarity,
      reason: 'semantic_duplicate',
    };
  }
  if (best.similarity >= conflictThreshold || ['active', 'stale', 'conflicted'].includes(best.row.status)) {
    return {
      duplicateId: null,
      conflictId: best.row.id,
      similarity: best.similarity,
      reason: 'semantic_conflict',
    };
  }
  return { duplicateId: null, conflictId: null, similarity: best.similarity, reason: 'none' };
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function tokens(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(/[^\p{L}\p{N}_'-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}
