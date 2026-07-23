import { Injectable, Logger } from '@nestjs/common';
import type { MeriContext } from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from '../api-tool-executor.repo.js';

export interface PackProvenance {
  sections: Array<{ name: string; count: number }>;
  omitted?: string[];
}

export interface CompiledPack {
  text: string;
  provenance: PackProvenance;
}

/**
 * Client Context Pack (§6.13). The draft/assistant handlers PRE-COMPILE this by
 * invoking the delegated ToolExecutor (POST /api/clio/tools/:name under the
 * caller bearer) BEFORE the LLM loop — no read tools run inside the loop.
 *
 * WALL-CORRECTNESS (CTX-4 / pitfall #11): client-OWN structured tabs are
 * tenant-scoped (the strategy is for this client); memory-derived
 * prior-engagement + KG come ONLY from the wall-riding tools
 * (query_knowledge_graph / search_memory), which fail-closed for a walled
 * client. Documents are relevance-retrieved top-K, never the full corpus.
 *
 * Stage G5.b (task 60) implements the delegated section reads + per-section
 * token budgeting + graceful "no data" degradation + provenance. This scaffold
 * establishes the seam so the LLM loop (task 59) is wired and testable first.
 */
@Injectable()
export class StrategyContextPackService {
  private readonly logger = new Logger(StrategyContextPackService.name);

  constructor(private readonly toolExecutor: ApiToolExecutorRepo) {}

  async compile(_opts: {
    ctx: MeriContext;
    clientId: string;
    /** goal (draft) or instruction (assistant) — the relevance query for documents. */
    query: string;
    /** slim pack for the rail assistant (overview + targets + relevant KG + plan state). */
    slim: boolean;
  }): Promise<CompiledPack> {
    // Placeholder until task 60 wires the wall-correct delegated reads.
    return { text: '(client context is being assembled)', provenance: { sections: [] } };
  }
}
