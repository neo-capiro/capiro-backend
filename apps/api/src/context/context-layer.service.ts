import { Injectable } from '@nestjs/common';
import {
  normalizeContextLayers,
  type ContextRequest,
  type EvidenceContextLayer,
  type NormalizedContextLayers,
  type SteeringLayer,
} from '@capiro/meriv2-core';
import {
  RETRIEVAL_DOMAINS,
  type RetrievalDomain,
} from '../retrieval/retrieval-v2.types.js';
import type { ContextResolutionResult } from './context-resolver.types.js';

/**
 * Exhaustive Phase 16 mapping from Retrieval V2 domains into the two factual
 * context layers. Adding a RetrievalDomain now requires an explicit layer
 * decision instead of silently creating a feature-specific context bucket.
 */
export const CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN: Readonly<
  Record<RetrievalDomain, EvidenceContextLayer>
> = {
  clients: 'live-authoritative',
  contacts: 'live-authoritative',
  mail: 'institutional-knowledge',
  meetings: 'institutional-knowledge',
  tasks: 'live-authoritative',
  action_recommendations: 'live-authoritative',
  outreach: 'institutional-knowledge',
  strategies_work: 'institutional-knowledge',
  program_elements: 'live-authoritative',
  legiwatch_bills: 'live-authoritative',
  hearings: 'live-authoritative',
  grants: 'live-authoritative',
  contracts_opportunities: 'live-authoritative',
  federal_awards: 'live-authoritative',
  directory: 'live-authoritative',
  district_nexus: 'live-authoritative',
  institutional_knowledge: 'institutional-knowledge',
};

const CLIENT_STEERING_LAYERS = new Set<SteeringLayer>([
  'client-steering',
  'client-people',
]);

export interface ContextLayerCompilerBridge {
  /** The universal five-layer architecture produced between resolver and compiler. */
  contextLayers: NormalizedContextLayers;
  /** Legacy steering compiler input, narrowed to the explicit resolved subject. */
  compilerRequest: ContextRequest;
}

@Injectable()
export class ContextLayerService {
  /** Map a Phase 15 resolver result into exactly five normalized architecture slots. */
  fromResolution(resolution: ContextResolutionResult): NormalizedContextLayers {
    const sources = splitRetrievalDomains(
      resolution.retrievalRequest?.requestedDomains ?? [],
    );
    return normalizeContextLayers({
      subjectClientIds: resolution.subjectScope.clientIds,
      liveAuthoritativeSources: sources.liveAuthoritativeSources,
      institutionalKnowledgeSources: sources.institutionalKnowledgeSources,
    });
  }

  /** Map the existing steering compiler request into the same shared contract. */
  fromCompilerRequest(request: ContextRequest): NormalizedContextLayers {
    return normalizeContextLayers({
      selectedSteeringLayers: request.layers,
      subjectClientIds: request.clientId ? [request.clientId] : [],
    });
  }

  /**
   * Bridge a resolved request to today's single-client steering compiler without
   * confusing UI focus with SubjectScope. Phase 17 will add factual evidence to
   * ContextPacket V2; Phase 16 only normalizes and preserves the boundary.
   *
   * A portfolio subject is deliberately not narrowed to one client. Because the
   * current steering compiler has one clientId, client steering is omitted from
   * that compatibility request while Layer C retains the full subject client set.
   */
  bridgeToCompiler(
    resolution: ContextResolutionResult,
    request: ContextRequest,
  ): ContextLayerCompilerBridge {
    const subjectClientIds = uniqueStrings(resolution.subjectScope.clientIds);
    const singleClientId = subjectClientIds.length === 1 ? subjectClientIds[0]! : null;
    const selectedSteeringLayers = request.layers.filter(
      (layer) => singleClientId !== null || !CLIENT_STEERING_LAYERS.has(layer),
    );
    const sources = splitRetrievalDomains(
      resolution.retrievalRequest?.requestedDomains ?? [],
    );

    return {
      contextLayers: normalizeContextLayers({
        selectedSteeringLayers,
        subjectClientIds,
        liveAuthoritativeSources: sources.liveAuthoritativeSources,
        institutionalKnowledgeSources: sources.institutionalKnowledgeSources,
      }),
      compilerRequest: {
        ...request,
        clientId: singleClientId,
        layers: selectedSteeringLayers,
      },
    };
  }
}

function splitRetrievalDomains(domains: readonly RetrievalDomain[]): {
  liveAuthoritativeSources: RetrievalDomain[];
  institutionalKnowledgeSources: RetrievalDomain[];
} {
  const liveAuthoritativeSources: RetrievalDomain[] = [];
  const institutionalKnowledgeSources: RetrievalDomain[] = [];

  for (const domain of uniqueRetrievalDomains(domains)) {
    if (CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN[domain] === 'live-authoritative') {
      liveAuthoritativeSources.push(domain);
    } else {
      institutionalKnowledgeSources.push(domain);
    }
  }

  return { liveAuthoritativeSources, institutionalKnowledgeSources };
}

function uniqueRetrievalDomains(domains: readonly RetrievalDomain[]): RetrievalDomain[] {
  const allowed = new Set<RetrievalDomain>(RETRIEVAL_DOMAINS);
  return [...new Set(domains)].filter((domain) => allowed.has(domain));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ];
}
