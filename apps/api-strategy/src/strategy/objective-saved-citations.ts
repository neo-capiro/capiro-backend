import type { readObjectiveSavedReviewState } from './objective-saved-review.js';

export interface CurrentObjectiveEvidence {
  ref: string; sourceId: string; asOfMs: number; scope: 'client' | 'tenant-shared'; clientId: string | null;
  reviewState: 'accepted' | 'pending'; kind: 'context_fact' | 'governed_memory' | 'reference_calendar';
  title: string; text: string; locator: string; version: string;
}
type SavedState = Awaited<ReturnType<typeof readObjectiveSavedReviewState>>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export function hasOriginalAcceptedCitation(saved: SavedState): boolean {
  const admitted = new Set(saved.evidence.filter(e => e.reviewState === 'accepted').map(e => e.ref));
  return saved.nodes.some(node => {
    const sources = object(node.provenance).sources;
    return Array.isArray(sources) && sources.slice(0, 64).some(value => admitted.has(object(value).ref as string));
  });
}
/** Original refs come only from the immutable snapshot and original publication. Current reads confer no write authority. */
export function projectSavedObjectiveCitations(saved: SavedState, current: readonly CurrentObjectiveEvidence[]) {
  const admitted = new Map(saved.evidence.filter(e => e.reviewState === 'accepted').map(e => [e.ref, e]));
  const fresh = new Map(current.map(e => [e.ref, e]));
  return { source: saved.review.source, nodes: saved.nodes.map(node => {
    const raw = object(node.provenance).sources;
    const sources = Array.isArray(raw) ? raw.slice(0, 64) : [];
    return { sourceNodeId: node.id, citations: sources.map((value, index) => {
      const ref = object(value).ref;
      if (typeof ref !== 'string' || !admitted.has(ref)) return { index, state: 'unavailable' as const };
      const found = fresh.get(ref);
      if (found?.reviewState === 'accepted') return { index, state: 'available' as const,
        kind: found.kind, title: found.title, text: found.text.slice(0, 24_000), textComplete: found.text.length <= 24_000, locator: found.locator,
        version: found.version, asOfMs: admitted.get(ref)!.asOfMs };
      const match = /^(context-fact|governed-memory|calendar-baseline|calendar-override):([^:]+):([a-f0-9]{64})$/.exec(ref);
      const changed = match && current.some(e => e.ref.startsWith(`${match[1]}:${match[2]}:`));
      // A visible changed source establishes only stale identity, never the historic excerpt.
      return changed ? { index, state: 'changed' as const, version: match[3] }
        : { index, state: 'unavailable' as const };
    }) };
  }) };
}
