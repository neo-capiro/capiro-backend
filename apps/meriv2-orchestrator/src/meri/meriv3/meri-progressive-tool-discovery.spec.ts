import {
  MERI_PROGRESSIVE_DISCOVERY_CONTROL_NAMES,
  MeriProgressiveToolDiscovery,
  type MeriProgressiveToolSchema,
} from './meri-progressive-tool-discovery.js';
import { MeriRunBudget } from './meriv3-run-budget.js';

function schema(
  name: string,
  description: string,
  required: string[] = [],
): MeriProgressiveToolSchema {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(required.map((field) => [field, { type: 'string' }])),
      required,
    },
  };
}

function discovery(args: {
  authorized?: MeriProgressiveToolSchema[];
  exposed?: MeriProgressiveToolSchema[];
  authorizeLoad?: (schema: MeriProgressiveToolSchema) => boolean;
} = {}) {
  const exposed = args.exposed ?? [schema('search_memory', 'Search governed memory', ['query'])];
  const authorized =
    args.authorized ?? [
      ...exposed,
      schema(
        'search_procurement_forecasts',
        'Search procurement forecasts with native pagination and agency filters.',
        ['query'],
      ),
      schema(
        'mcp__hubspot__search_companies',
        'Search authorized HubSpot companies.',
        ['query'],
      ),
    ];
  return new MeriProgressiveToolDiscovery({
    authorizedSchemas: authorized,
    exposedSchemas: exposed,
    budget: MeriRunBudget.fromToolRoundCeiling(10),
    authorizeLoad: args.authorizeLoad ?? (() => true),
  });
}

describe('MeriProgressiveToolDiscovery', () => {
  test('keeps control schema and handler ownership explicit without adding executable leaves', () => {
    const subject = discovery();
    const schemaNames = new Set(subject.controlSchemas().map((item) => item.name));

    expect(schemaNames).toEqual(MERI_PROGRESSIVE_DISCOVERY_CONTROL_NAMES);
    for (const name of schemaNames) expect(subject.handles(name)).toBe(true);
    expect(subject.handles('search_procurement_forecasts')).toBe(false);
  });

  test('searches only omitted authorized schemas, then loads the exact canonical schema', () => {
    const exact = schema(
      'search_procurement_forecasts',
      'Search procurement forecasts with native pagination and agency filters.',
      ['query'],
    );
    const subject = discovery({
      authorized: [
        schema('search_memory', 'Search governed memory', ['query']),
        exact,
        schema('mcp__hubspot__search_companies', 'Search authorized HubSpot companies.', [
          'query',
        ]),
      ],
    });
    const search = subject.execute('tool_search', {
      queries: ['procurement forecasts', 'hubspot companies'],
      limit: 5,
    });

    expect(search.matchedNames).toEqual([
      'search_procurement_forecasts',
      'mcp__hubspot__search_companies',
    ]);
    expect(search.result).toMatchObject({
      results: [
        { queryIndex: 0, matches: ['search_procurement_forecasts'] },
        { queryIndex: 1, matches: ['mcp__hubspot__search_companies'] },
      ],
      tools: {
        search_procurement_forecasts: { source: 'native' },
        mcp__hubspot__search_companies: { source: 'mcp' },
      },
    });

    const described = subject.execute('tool_describe', {
      names: ['search_procurement_forecasts'],
    });
    expect(described.loadedNames).toEqual(['search_procurement_forecasts']);
    expect(subject.exposedSchemas()[1]).toBe(exact);
    expect(subject.exposedSchemas()[1]?.input_schema).toEqual(
      (described.result.tools as Record<string, { parameters: Record<string, unknown> }>)[
        'search_procurement_forecasts'
      ]?.parameters,
    );
  });

  test('never turns unknown, malformed, undiscovered, or currently disallowed names into schemas', () => {
    const malformed = schema('bad-name', 'Malformed name');
    const subject = discovery({
      authorized: [
        schema('search_memory', 'Search memory'),
        schema('search_procurement_forecasts', 'Search procurement forecasts'),
        malformed,
      ],
      authorizeLoad: () => false,
    });

    const beforeSearch = subject.execute('tool_describe', {
      names: ['search_procurement_forecasts', 'invented_private_name'],
    });
    expect(beforeSearch.loadedNames).toEqual([]);
    expect(subject.exposedSchemas().map((item) => item.name)).toEqual(['search_memory']);

    subject.execute('tool_search', { queries: ['procurement forecasts'] });
    const disallowed = subject.execute('tool_describe', {
      names: ['search_procurement_forecasts', 'bad-name'],
    });
    expect(disallowed.loadedNames).toEqual([]);
    expect(disallowed.result).toMatchObject({ unavailableCount: 2 });
    expect(subject.exposedSchemas().map((item) => item.name)).toEqual(['search_memory']);
  });

  test('bounds multi-query work, attempts, result counts, and schema growth under the run budget', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      schema(`rare_reader_${index}`, `Rare reader capability ${index} alpha`, ['query']),
    );
    const subject = discovery({
      authorized: [schema('search_memory', 'Search memory'), ...many],
    });

    const tooManyQueries = subject.execute('tool_search', {
      queries: ['one', 'two', 'three', 'four', 'five'],
    });
    expect(tooManyQueries.resultCode).toBe('invalid_queries');

    const bounded = subject.execute('tool_search', { queries: ['rare reader'], limit: 99 });
    expect(bounded.matchedNames).toHaveLength(5);
    expect(JSON.stringify(bounded.result).length).toBeLessThan(12_000);

    subject.execute('tool_search', { queries: ['rare reader'] });
    const capped = subject.execute('tool_search', { queries: ['rare reader'] });
    expect(capped.resultCode).toBe('search_attempt_limit');
  });
});
