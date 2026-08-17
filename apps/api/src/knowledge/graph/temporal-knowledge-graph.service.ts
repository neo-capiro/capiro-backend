import { Injectable } from '@nestjs/common';
import {
  normalizeTemporalGraphHistoryInput,
  normalizeTemporalGraphWalkInput,
} from './temporal-knowledge-graph.helpers.js';
import { TemporalKnowledgeGraphRepository } from './temporal-knowledge-graph.repository.js';
import type {
  TemporalKnowledgeGraphEdge,
  TemporalKnowledgeGraphHistoryInput,
  TemporalKnowledgeGraphWalkInput,
} from './temporal-knowledge-graph.types.js';

/**
 * Canonical, temporal relation reasoning over Phase 1-7 Knowledge Plane facts.
 * This service is deliberately read-only: it neither resolves identity nor
 * creates assertions/evidence. Phase 5 canonical IDs are the node identity and
 * Phase 3 assertion/evidence rows remain the source of truth.
 */
@Injectable()
export class TemporalKnowledgeGraphService {
  constructor(private readonly repository: TemporalKnowledgeGraphRepository) {}

  /** Relations that were both valid and already known at `asOf`. */
  walkAsOf(input: TemporalKnowledgeGraphWalkInput): Promise<TemporalKnowledgeGraphEdge[]> {
    return this.repository.walkAsOf(normalizeTemporalGraphWalkInput(input));
  }

  /**
   * Chronological relation history overlapping a validity window, capped by a
   * transaction-time `observedThrough` instant to prevent hindsight leakage.
   */
  relationHistory(
    input: TemporalKnowledgeGraphHistoryInput,
  ): Promise<TemporalKnowledgeGraphEdge[]> {
    return this.repository.relationHistory(normalizeTemporalGraphHistoryInput(input));
  }
}
