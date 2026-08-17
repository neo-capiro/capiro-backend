import type { KnowledgeJsonObject, KnowledgeRef } from '../knowledge.types.js';

export type TemporalKnowledgeGraphDirection = 'out' | 'in' | 'both';

/**
 * Exact Knowledge Plane security partition. Phase 8 deliberately does not try
 * to infer a caller's union of accessible partitions: a query names one exact
 * partition and the SQL boundary matches it byte-semantically (jsonb equality
 * for accessScope, canonical set equality for client refs). Phase 9 may compose
 * multiple already-authorized partitions without weakening this boundary.
 */
export interface TemporalKnowledgeGraphPartition {
  sensitivity: string;
  accessScope: KnowledgeJsonObject;
  clientRefs: readonly KnowledgeRef[];
}

export interface TemporalKnowledgeGraphWalkInput {
  tenantId: string;
  canonicalEntityId: string;
  partition: TemporalKnowledgeGraphPartition;
  asOf: Date;
  maxDepth?: number;
  edgeTypes?: readonly string[];
  fanout?: number;
  rowBudget?: number;
  direction?: TemporalKnowledgeGraphDirection;
}

export interface TemporalKnowledgeGraphHistoryInput {
  tenantId: string;
  canonicalEntityId: string;
  partition: TemporalKnowledgeGraphPartition;
  windowStart: Date;
  windowEnd: Date;
  /**
   * Transaction-time cutoff. Facts learned after this instant are excluded even
   * when their validFrom predates the cutoff, preventing future-knowledge leaks.
   */
  observedThrough: Date;
  edgeTypes?: readonly string[];
  rowBudget?: number;
  direction?: TemporalKnowledgeGraphDirection;
}

export interface TemporalKnowledgeGraphEdge {
  depth: number | null;
  srcCanonicalEntityId: string;
  dstCanonicalEntityId: string;
  edgeType: string;
  confidence: number;
  observedAt: Date;
  validFrom: Date;
  validUntil: Date | null;
  assertionId: string;
  eventId: string;
  evidence: {
    id: string;
    sourceType: string;
    sourceId: string;
    contentHash: string;
    startOffset: number;
    endOffset: number;
  };
  sensitivity: string;
  clientRefKeys: string[];
}

export interface NormalizedTemporalKnowledgeGraphWalkInput
  extends Omit<TemporalKnowledgeGraphWalkInput, 'partition' | 'edgeTypes' | 'direction'> {
  sensitivity: string;
  accessScope: KnowledgeJsonObject;
  clientRefKeys: string[];
  edgeTypes: string[] | null;
  maxDepth: number;
  fanout: number;
  rowBudget: number;
  direction: TemporalKnowledgeGraphDirection;
}

export interface NormalizedTemporalKnowledgeGraphHistoryInput
  extends Omit<TemporalKnowledgeGraphHistoryInput, 'partition' | 'edgeTypes' | 'direction'> {
  sensitivity: string;
  accessScope: KnowledgeJsonObject;
  clientRefKeys: string[];
  edgeTypes: string[] | null;
  rowBudget: number;
  direction: TemporalKnowledgeGraphDirection;
}
