import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SearchService, type SearchCategory } from '../../search/search.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';
import {
  OUTREACH_GOVERNMENT_RECORD_CATEGORIES,
  outreachContextScopeV1Schema,
  outreachContextSelectionV1Schema,
  type OutreachContextSelectionV1,
} from './outreach-context.contract.js';

const inputSchemaZod = z
  .object({
    query: z.string().min(2).max(500),
    categories: z.array(z.enum(OUTREACH_GOVERNMENT_RECORD_CATEGORIES)).max(12).default([]),
    intendedClass: z.enum(['required_policy', 'campaign_fact', 'target_specific', 'group_safe']),
    scope: outreachContextScopeV1Schema,
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ResearchGovernmentInput = z.infer<typeof inputSchemaZod>;

export interface GovernmentResearchCandidateV1 {
  category: SearchCategory;
  id: string;
  title: string;
  subtitle: string | null;
  date: string | null;
  href: string | null;
  selection: OutreachContextSelectionV1;
}

export interface ResearchGovernmentDataV1 {
  candidates: GovernmentResearchCandidateV1[];
  byCategory: Record<string, number>;
}

const inputSchema: CapabilityRuntimeSchema<ResearchGovernmentInput> = {
  name: 'research_government.input.v1',
  parse(value) {
    return inputSchemaZod.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<ResearchGovernmentDataV1>> = {
  name: 'research_government.output.v1',
  parse(value) {
    return assertCapabilityResult<ResearchGovernmentDataV1>(value, 'research_government');
  },
};

@Injectable()
export class ResearchGovernmentCapability {
  constructor(private readonly search: SearchService) {}

  definition(): CapabilityDefinition<ResearchGovernmentInput, ResearchGovernmentDataV1> {
    return {
      name: 'research_government',
      description:
        'Search Capiro’s source-backed government datasets and return exact references suitable for governed context review.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 20_000,
      maxResultCount: 50,
      maxResultBytes: 192_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    rawInput: ResearchGovernmentInput,
  ): Promise<CapabilityResult<ResearchGovernmentDataV1>> {
    const input = inputSchemaZod.parse(rawInput);
    const response = await this.search.search(input.query, Math.min(20, input.limit));
    const allowed = new Set<SearchCategory>(
      input.categories.length
        ? (input.categories as SearchCategory[])
        : (OUTREACH_GOVERNMENT_RECORD_CATEGORIES as unknown as SearchCategory[]),
    );
    const candidates = response.results
      .filter((result) => allowed.has(result.category))
      .map((result) => ({
        category: result.category,
        id: result.id,
        title: result.title,
        subtitle: result.subtitle ?? null,
        date: result.date ?? null,
        href: result.href ?? null,
        selection: outreachContextSelectionV1Schema.parse({
          locator: {
            source: 'government_record',
            category: result.category,
            id: result.id,
          },
          contextClass: input.intendedClass,
          scope: input.scope,
        }),
      }))
      .slice(0, input.limit);
    const byCategory: Record<string, number> = {};
    for (const result of candidates) {
      byCategory[result.category] = (byCategory[result.category] ?? 0) + 1;
    }
    const retrievedAt = new Date().toISOString();
    return {
      capability: 'research_government',
      schemaVersion: 1,
      data: { candidates, byCategory },
      provenance: candidates.map((result) => ({
        recordType: result.category,
        recordId: result.id,
        sourceSystem: sourceSystem(result.category),
        sourceDate: result.date,
        lastVerifiedAt: result.date,
        retrievedAt,
        verificationClass: 'authoritative',
        classification: 'fact',
      })),
      exclusions: [],
      scope: { tenantId: ctx.tenantId, clientId: null },
      freshness: {
        asOf: retrievedAt,
        degraded: false,
        reasons: [],
      },
      authorization: { filtered: false, restrictedCount: 0 },
    };
  }
}

function sourceSystem(category: SearchCategory): string {
  switch (category) {
    case 'bill':
    case 'hearing':
      return 'congress.gov';
    case 'award':
      return 'usaspending.gov';
    case 'lda_filing':
      return 'lda.senate.gov';
    case 'sec_filing':
      return 'sec.gov';
    case 'fara_registration':
      return 'justice.gov/fara';
    case 'gao_report':
      return 'gao.gov';
    case 'crs_report':
      return 'crsreports.congress.gov';
    case 'regulatory_docket':
      return 'regulations.gov';
    case 'intel_article':
      return 'capiro_intelligence';
    case 'state_bill':
      return 'legiscan';
    case 'federal_register':
      return 'federalregister.gov';
  }
}
