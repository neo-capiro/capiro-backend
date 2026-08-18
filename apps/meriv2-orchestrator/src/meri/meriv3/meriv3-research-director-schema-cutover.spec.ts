import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import {
  MeriV3SemanticCompatibilityTools,
  type MeriSemanticCompatibilitySchema,
} from './meriv3-semantic-compatibility-tools.js';
import { MeriV3SemanticRuntimeStore } from './meriv3-semantic-runtime.store.js';

const schema = (name: string): MeriSemanticCompatibilitySchema => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {} },
});

function config(values: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as never;
}

function quickCompanyPlan(): MeriRetrievalPlan {
  return {
    version: 1,
    queryClass: 'lookup',
    subjectScope: 'external_entity',
    targetHint: 'Overland AI',
    recipeTool: 'research_external_company',
    requireCompleteCoverage: false,
    requiredDomains: ['public_web'],
    optionalDomains: ['clients', 'internal_research'],
    recommendedTools: [
      'research_external_company',
      'lookup_client_registry',
      'search_research_sources',
      'search_public_web',
      'scrape_web_page',
    ],
    timeWindow: null,
    activeClients: [],
    reasons: ['recipe:research_external_company', 'quick-company-profile'],
  };
}

describe('Research Director schema cutover', () => {
  test('the canonical flag hides only the legacy model-facing reasoning schema', () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED: 'true',
        MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS: 'tenant-1',
      }),
    );

    const prepared = tools.prepareSchemas(
      [
        schema('research_external_company'),
        schema('research_federal_market_strategy'),
        schema('resolve_entity'),
      ],
      'tenant-1',
    );

    expect(prepared.map((item) => item.name)).toEqual([
      'research_federal_market_strategy',
      'resolve_entity',
    ]);
  });

  test('preserves the bounded company-profile schema inside a quick-profile turn', () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED: 'true',
        MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS: 'tenant-1',
      }),
    );

    const prepared = MeriV3SemanticRuntimeStore.run(
      {
        tenantId: 'tenant-1',
        request: 'What does Overland AI do?',
        recentUserContext: '',
        plan: quickCompanyPlan(),
      },
      () =>
        tools.prepareSchemas(
          [
            schema('research_external_company'),
            schema('research_federal_market_strategy'),
            schema('search_public_web'),
          ],
          'tenant-1',
        ),
    );

    expect(prepared.map((item) => item.name)).toEqual([
      'research_external_company',
      'research_federal_market_strategy',
      'search_public_web',
    ]);
  });

  test('the same global flag cannot widen past its tenant allowlist', () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED: 'true',
        MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS: 'tenant-2',
      }),
    );

    expect(
      tools
        .prepareSchemas([schema('research_external_company')], 'tenant-1')
        .map((item) => item.name),
    ).toEqual(['research_external_company']);
  });
});
