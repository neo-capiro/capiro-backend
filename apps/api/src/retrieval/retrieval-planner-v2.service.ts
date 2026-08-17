import { Injectable } from '@nestjs/common';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import type { RetrievalPlan, RetrievalRequest } from './retrieval-v2.types.js';

@Injectable()
export class RetrievalPlannerV2Service {
  constructor(private readonly catalog: SemanticDataCatalogService) {}

  plan(request: RetrievalRequest): RetrievalPlan {
    if (request.requestedDomains.length === 0) {
      throw new Error('Retrieval V2 requires at least one requested domain');
    }
    if (request.exactLexical && request.queryClass !== 'lookup') {
      throw new Error('Phase 11 exact lexical retrieval requires queryClass=lookup');
    }

    const requestedDomains = [...new Set(request.requestedDomains)];
    const entries = requestedDomains.map((domain) => {
      const dataset = this.catalog.get(domain);
      const supported = request.exactLexical
        ? dataset.queryCapabilities.exactFiltering
        : dataset.supportedQueryClasses.includes(request.queryClass);
      return {
        dataset,
        supported,
        reason: supported
          ? undefined
          : request.exactLexical
            ? `${domain} does not support exact filtering`
            : `${domain} does not support query class ${request.queryClass}`,
      };
    });

    return {
      queryClass: request.queryClass,
      requestedDomains,
      entries,
    };
  }
}
