import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { estimateTokens, type MeriContext } from '@capiro/meriv2-core';
import { currentGovernedMeriContext } from '../meri-governed-context.runtime.js';

export interface PackProvenance {
  sections: Array<{ name: string; count: number }>;
  omitted?: string[];
}

export interface PackHealth {
  status: 'ok' | 'degraded' | 'conflicted';
  missingRequired: string[];
  omittedOptional: string[];
  openMaterialConflicts?: Array<{
    id: string;
    factAId: string;
    factBId: string;
    factA: string;
    factB: string;
  }>;
}

export interface CompiledPack {
  text: string;
  provenance: PackProvenance;
  health: PackHealth;
}

const ALLOWED_OPERATIONS = new Set([
  'strategies.generate',
  'workspace.generate',
  'outreach.generate',
]);
const REQUIRED_DOMAINS = new Set(['clients', 'strategies_work']);

/**
 * Compatibility projection for the mature Strategy prompt/response contract.
 *
 * Phase 25 retired the feature-local Client Context Pack compiler. The main API
 * has already resolved scope, run Retrieval V2 and persisted ContextPacket V2.
 * This class now only turns that request-scoped governed projection into the
 * historical `{text, provenance, health}` shape used by StrategyAssistantService.
 * It owns no delegated reads, search_memory call, graph walk, embeddings, vector
 * store, independent coverage engine or packet persistence.
 */
@Injectable()
export class StrategyContextPackService {
  private readonly logger = new Logger(StrategyContextPackService.name);

  async compile(opts: {
    ctx: MeriContext;
    clientId: string;
    query: string;
    slim: boolean;
  }): Promise<CompiledPack> {
    void opts.query;
    void opts.slim;
    const governed = currentGovernedMeriContext();
    if (
      !governed ||
      !ALLOWED_OPERATIONS.has(governed.operationId) ||
      governed.contextPacket.clientId !== opts.clientId ||
      opts.ctx.contextPacket?.clientId !== opts.clientId ||
      typeof governed.prompt !== 'string' ||
      !governed.prompt.trim()
    ) {
      throw new ForbiddenException('Strategy Context Pack requires governed Context Plane input');
    }

    const coverage = governed.retrieval.coverage;
    const unavailable = new Set([
      ...coverage.missingDomains,
      ...coverage.partialDomains,
    ]);
    const missingRequired = [...REQUIRED_DOMAINS].filter((domain) => unavailable.has(domain));
    const omittedOptional = [...unavailable].filter((domain) => !REQUIRED_DOMAINS.has(domain));
    const degraded =
      governed.contextPacket.degraded ||
      !coverage.complete ||
      !coverage.paginationComplete ||
      coverage.truncated ||
      missingRequired.length > 0;

    const provenance: PackProvenance = {
      sections: [
        { name: 'ContextPacket V2', count: governed.contextPacket.items.length },
        { name: 'Shared Retrieval V2', count: coverage.recordsReturned },
      ],
      ...(unavailable.size
        ? { omitted: [...unavailable].map((domain) => `Retrieval domain: ${domain}`) }
        : {}),
    };
    const health: PackHealth = {
      status: degraded ? 'degraded' : 'ok',
      missingRequired,
      omittedOptional,
    };
    this.logger.log(
      `governed strategy context projected: ${coverage.recordsReturned} record(s), ` +
        `~${estimateTokens(governed.prompt)} tokens, health=${health.status}`,
    );
    return { text: governed.prompt, provenance, health };
  }
}
