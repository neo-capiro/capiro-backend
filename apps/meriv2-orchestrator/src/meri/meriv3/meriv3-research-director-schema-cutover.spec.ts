import {
  MeriV3SemanticCompatibilityTools,
  type MeriSemanticCompatibilitySchema,
} from './meriv3-semantic-compatibility-tools.js';

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
