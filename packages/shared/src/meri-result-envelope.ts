/**
 * Provider-neutral, additive model-facing result contract for Meri reads.
 * The legacy payload remains intact; adapters must supply observations rather
 * than infer completeness, freshness, or source availability from that payload.
 */
export type MeriReadFamily = 'search' | 'document' | 'memory' | 'legislative' | 'task' | 'action';

export type MeriResultOutcome =
  | 'succeeded'
  | 'partial'
  | 'blocked'
  | 'needs_input'
  | 'not_found_within_scope'
  | 'unavailable'
  | 'failed';

export type MeriCoverageCompleteness = 'complete' | 'partial' | 'unknown';

export interface MeriResultProvenance {
  readonly recordId?: string;
  readonly sourceId?: string;
  readonly sourceVersion?: string;
  readonly locator?: string;
  readonly url?: string;
  readonly observedAt?: string | null;
}

export interface MeriResultSourceObservation {
  readonly family: MeriReadFamily;
  /** Stable source/dataset identity, not a display label. */
  readonly sourceId: string;
  readonly availability: 'available' | 'unavailable' | 'blocked' | 'not_queried' | 'unknown';
  /** Scope actually applied or declared by the source adapter. */
  readonly scope: Readonly<Record<string, string | number | boolean | null>>;
  /** Source observation time. Null/omitted means unknown; generated time is not substituted. */
  readonly observedAt?: string | null;
  readonly coverage: {
    readonly completeness: MeriCoverageCompleteness;
    readonly continuation?: { readonly hasMore: boolean; readonly cursor?: string | null };
    readonly returnedCount?: number;
    readonly matchedCount?: number | null;
  };
  readonly provenance: readonly MeriResultProvenance[];
  readonly failure?: { readonly code: string; readonly message?: string };
}

export interface MeriResultEnvelope<TLegacyPayload = unknown> {
  readonly contract: 'meri.result-envelope.v1';
  readonly outcome: MeriResultOutcome;
  /** Preserves the existing tool response shape for compatibility. */
  readonly legacyPayload: TLegacyPayload;
  readonly sources: readonly MeriResultSourceObservation[];
  readonly truncation: { readonly truncated: boolean; readonly reason?: string };
  readonly errors: readonly { readonly code: string; readonly message?: string }[];
}

/**
 * Wraps an existing result without rewriting it. All semantic metadata is
 * caller-supplied so absent legacy fields cannot accidentally imply a complete
 * search or a successful source read.
 */
export function createMeriResultEnvelope<T>(input: {
  readonly outcome: MeriResultOutcome;
  readonly legacyPayload: T;
  readonly sources: readonly MeriResultSourceObservation[];
  readonly truncation?: { readonly truncated: boolean; readonly reason?: string };
  readonly errors?: readonly { readonly code: string; readonly message?: string }[];
}): MeriResultEnvelope<T> {
  return {
    contract: 'meri.result-envelope.v1',
    outcome: input.outcome,
    legacyPayload: input.legacyPayload,
    sources: input.sources,
    truncation: input.truncation ?? { truncated: false },
    errors: input.errors ?? [],
  };
}
