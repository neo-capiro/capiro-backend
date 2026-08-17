import { Injectable } from '@nestjs/common';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import type {
  RetrievalRecord,
  RetrievalRequest,
  RetrievalScoringComponent,
  RetrievalScoringObservability,
  RetrievalScoringScore,
  RetrievalScoringSignal,
  RetrievalScoringSignalClass,
} from './retrieval-v2.types.js';

const DEFAULT_RRF_K = 60;
const SIGNAL_CLASS: Record<RetrievalScoringSignal, RetrievalScoringSignalClass> = {
  lexical_exactness: 'relevance',
  semantic_similarity: 'relevance',
  entity_match_confidence: 'confidence',
  source_authority: 'authority',
  freshness: 'freshness',
  graph_relationship_relevance: 'relevance',
  client_relevance: 'relevance',
  temporal_validity: 'validity',
};
const AUTHORITY_PRIORITY = {
  tenant_system_of_record: 2,
  public_system_of_record: 2,
  knowledge_plane: 1,
} as const;

type Mode = 'off' | 'shadow' | 'apply';
interface CandidateState {
  record: RetrievalRecord;
  baselineRank: number;
  currentRank: number;
  fusedScore: number;
  components: RetrievalScoringComponent[];
}
export interface RetrievalScoreResult {
  records: RetrievalRecord[];
  observability: RetrievalScoringObservability;
}

/** RRF is retrieval priority only; it never changes truth, authority, provenance, or coverage. */
@Injectable()
export class RetrievalScoringService {
  constructor(private readonly catalog: SemanticDataCatalogService) {}

  score(
    request: RetrievalRequest,
    baselineRecords: readonly RetrievalRecord[],
    currentRecords: readonly RetrievalRecord[] = baselineRecords,
  ): RetrievalScoreResult {
    const mode = this.mode();
    const rrfK = this.rrfK();
    const baseline = new Map<RetrievalRecord, number>();
    baselineRecords.forEach((record, index) => baseline.set(record, index + 1));
    const states: CandidateState[] = currentRecords.map((record, index) => ({
      record,
      baselineRank: baseline.get(record) ?? index + 1,
      currentRank: index + 1,
      fusedScore: 0,
      components: [],
    }));

    if (mode === 'off' || states.length < 2) {
      return this.result(mode, rrfK, states, [], [...currentRecords], false);
    }

    const arms = new Map<RetrievalScoringSignal, Map<RetrievalRecord, number>>();
    for (const state of states) {
      for (const [signal, value] of Object.entries(this.signalValues(request, state.record)) as Array<
        [RetrievalScoringSignal, number | undefined]
      >) {
        if (value === undefined || !Number.isFinite(value)) continue;
        const arm = arms.get(signal) ?? new Map<RetrievalRecord, number>();
        arm.set(state.record, value);
        arms.set(signal, arm);
      }
    }

    const signalsUsed: RetrievalScoringSignal[] = [];
    for (const [signal, values] of arms) {
      const distinct = new Set(values.values());
      if (values.size === 0 || (distinct.size <= 1 && values.size === states.length)) continue;
      signalsUsed.push(signal);
      const ranked = states
        .filter((state) => values.has(state.record))
        .sort((a, b) => values.get(b.record)! - values.get(a.record)! || a.baselineRank - b.baselineRank);
      let previousValue: number | undefined;
      let previousRank = 0;
      ranked.forEach((state, index) => {
        const rawValue = values.get(state.record)!;
        const signalRank = previousValue !== undefined && rawValue === previousValue ? previousRank : index + 1;
        previousValue = rawValue;
        previousRank = signalRank;
        const contribution = 1 / (rrfK + signalRank);
        state.fusedScore += contribution;
        state.components.push({ signal, signalClass: SIGNAL_CLASS[signal], rawValue, signalRank, contribution });
      });
    }

    const proposed = [...states].sort(
      (a, b) => b.fusedScore - a.fusedScore || a.baselineRank - b.baselineRank,
    );
    const proposedRank = new Map<RetrievalRecord, number>();
    proposed.forEach((state, index) => proposedRank.set(state.record, index + 1));
    const applied = mode === 'apply' && signalsUsed.length > 0;
    const records = applied ? proposed.map((state) => state.record) : [...currentRecords];
    return this.result(mode, rrfK, states, signalsUsed, records, applied, proposedRank);
  }

  private signalValues(
    request: RetrievalRequest,
    record: RetrievalRecord,
  ): Partial<Record<RetrievalScoringSignal, number>> {
    const hints = record.retrievalSignals;
    return {
      ...(hints?.lexicalExactness !== undefined
        ? { lexical_exactness: hints.lexicalExactness }
        : this.exactValue(request, record)),
      ...(hints?.semanticSimilarity !== undefined ? { semantic_similarity: hints.semanticSimilarity } : {}),
      ...(hints?.entityMatchConfidence !== undefined
        ? { entity_match_confidence: hints.entityMatchConfidence }
        : this.entityValue(request, record)),
      source_authority: AUTHORITY_PRIORITY[this.catalog.get(record.domain).authority],
      ...(this.usesFreshness(request) ? this.freshnessValue(record) : {}),
      ...(hints?.graphRelationshipRelevance !== undefined
        ? { graph_relationship_relevance: hints.graphRelationshipRelevance }
        : this.graphValue(record)),
      ...(hints?.clientRelevance !== undefined
        ? { client_relevance: hints.clientRelevance }
        : this.clientValue(request, record)),
      ...(hints?.temporalValidity !== undefined
        ? { temporal_validity: hints.temporalValidity }
        : this.temporalValue(request, record)),
    };
  }

  private exactValue(request: RetrievalRequest, record: RetrievalRecord) {
    if (!request.exactLexical) return {};
    return this.string(record.payload, 'exactMatchKind') === request.exactLexical.kind
      ? { lexical_exactness: 1 }
      : {};
  }

  private entityValue(request: RetrievalRequest, record: RetrievalRecord) {
    const requested = new Set(request.canonicalEntityIds ?? []);
    if (requested.size && record.canonicalEntityIds?.some((id) => requested.has(id))) {
      return { entity_match_confidence: 1 };
    }
    // Graph edge confidence is factual metadata, not identity confidence.
    if (!this.string(record.payload, 'resolutionMethod')) return {};
    const value = this.number(record.payload, 'confidence');
    return value !== undefined && value >= 0 && value <= 1 ? { entity_match_confidence: value } : {};
  }

  private freshnessValue(record: RetrievalRecord) {
    const value = record.updatedAt ?? record.occurredAt;
    return value ? { freshness: value.getTime() } : {};
  }

  private graphValue(record: RetrievalRecord) {
    const depth = this.number(record.payload, 'depth');
    return depth !== undefined && depth >= 0 ? { graph_relationship_relevance: 1 / (1 + depth) } : {};
  }

  private clientValue(request: RetrievalRequest, record: RetrievalRecord) {
    const requested = new Set(request.caller.clientIds ?? []);
    if (!requested.size) return {};
    const ids = new Set<string>();
    this.collectClientIds(record.payload, ids, 0);
    return [...ids].some((id) => requested.has(id)) ? { client_relevance: 1 } : {};
  }

  private temporalValue(request: RetrievalRequest, record: RetrievalRecord) {
    if (request.asOf) {
      const from = this.date(record.payload, 'validFrom') ?? record.occurredAt ?? record.updatedAt;
      const until = this.date(record.payload, 'validUntil');
      if (!from) return {};
      return { temporal_validity: from <= request.asOf && (!until || request.asOf < until) ? 1 : 0 };
    }
    if (request.windowStart && request.windowEnd) {
      const value = record.occurredAt ?? record.updatedAt;
      if (!value) return {};
      return { temporal_validity: value >= request.windowStart && value < request.windowEnd ? 1 : 0 };
    }
    return {};
  }

  private result(
    mode: Mode,
    rrfK: number,
    states: CandidateState[],
    signalsUsed: RetrievalScoringSignal[],
    records: RetrievalRecord[],
    applied: boolean,
    proposedRank?: Map<RetrievalRecord, number>,
  ): RetrievalScoreResult {
    return {
      records,
      observability: {
        status: mode === 'off' ? 'disabled' : mode === 'apply' ? 'applied' : 'shadow',
        algorithm: 'rrf',
        rrfK,
        candidateCount: states.length,
        scoredCount: states.length,
        applied,
        signalsUsed,
        scores: states.map((state) => this.trace(state, proposedRank?.get(state.record) ?? state.currentRank)),
      },
    };
  }

  private trace(state: CandidateState, proposedRank: number): RetrievalScoringScore {
    return {
      domain: state.record.domain,
      recordId: state.record.recordId,
      baselineRank: state.baselineRank,
      currentRank: state.currentRank,
      proposedRank,
      fusedScore: state.fusedScore,
      sourceAuthority: this.catalog.get(state.record.domain).authority,
      components: [...state.components].sort((a, b) => a.signal.localeCompare(b.signal)),
    };
  }

  private usesFreshness(request: RetrievalRequest): boolean {
    return !['entity_history', 'relationship_history', 'temporal_state'].includes(request.queryClass);
  }

  private collectClientIds(value: unknown, out: Set<string>, depth: number): void {
    if (depth > 4 || value == null) return;
    if (Array.isArray(value)) return void value.forEach((item) => this.collectClientIds(item, out, depth + 1));
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'clientId' || key === 'client_id') && typeof child === 'string') out.add(child);
      else if ((key === 'clientIds' || key === 'client_ids') && Array.isArray(child)) {
        child.forEach((item) => { if (typeof item === 'string') out.add(item); });
      } else this.collectClientIds(child, out, depth + 1);
    }
  }

  private string(payload: unknown, key: string): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const value = (payload as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  private number(payload: unknown, key: string): number | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const value = (payload as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  private date(payload: unknown, key: string): Date | undefined {
    const value = this.string(payload, key);
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  private mode(): Mode {
    const value = (process.env.RETRIEVAL_SCORING_MODE ?? 'shadow').trim().toLowerCase();
    return value === 'off' || value === 'apply' ? value : 'shadow';
  }
  private rrfK(): number {
    const value = Number(process.env.RETRIEVAL_RRF_K ?? DEFAULT_RRF_K);
    return Number.isFinite(value) ? Math.min(1_000, Math.max(1, Math.floor(value))) : DEFAULT_RRF_K;
  }
}
