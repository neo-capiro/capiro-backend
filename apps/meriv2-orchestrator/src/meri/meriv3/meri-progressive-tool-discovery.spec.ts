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

function discovery(
  args: {
    authorized?: MeriProgressiveToolSchema[];
    exposed?: MeriProgressiveToolSchema[];
    resolveCurrentSchemas?: () => Promise<MeriProgressiveToolSchema[]>;
    authorizeCurrentSchema?: (schema: MeriProgressiveToolSchema) => Promise<boolean>;
  } = {},
) {
  const exposed = args.exposed ?? [schema('search_memory', 'Search governed memory', ['query'])];
  const authorized = args.authorized ?? [
    ...exposed,
    schema(
      'search_procurement_forecasts',
      'Search procurement forecasts with native pagination and agency filters.',
      ['query'],
    ),
    schema('mcp__hubspot__search_companies', 'Search authorized HubSpot companies.', ['query']),
  ];
  return new MeriProgressiveToolDiscovery({
    authorizedSchemas: authorized,
    exposedSchemas: exposed,
    budget: MeriRunBudget.fromToolRoundCeiling(10),
    resolveCurrentSchemas: args.resolveCurrentSchemas ?? (async () => authorized),
    authorizeCurrentSchema: args.authorizeCurrentSchema,
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

  test('searches only omitted authorized schemas, then loads the exact canonical schema', async () => {
    const exact = schema(
      'search_procurement_forecasts',
      'Search procurement forecasts with native pagination and agency filters.',
      ['query'],
    );
    const subject = discovery({
      authorized: [
        schema('search_memory', 'Search governed memory', ['query']),
        exact,
        schema('mcp__hubspot__search_companies', 'Search authorized HubSpot companies.', ['query']),
      ],
    });
    const search = await subject.execute('tool_search', {
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

    const described = await subject.execute('tool_describe', {
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

  test('never turns unknown, malformed, undiscovered, or currently disallowed names into schemas', async () => {
    const malformed = schema('bad-name', 'Malformed name');
    const subject = discovery({
      authorized: [
        schema('search_memory', 'Search memory'),
        schema('search_procurement_forecasts', 'Search procurement forecasts'),
        malformed,
      ],
      authorizeCurrentSchema: async () => false,
    });

    const beforeSearch = await subject.execute('tool_describe', {
      names: ['search_procurement_forecasts', 'invented_private_name'],
    });
    expect(beforeSearch.loadedNames).toEqual([]);
    expect(subject.exposedSchemas().map((item) => item.name)).toEqual(['search_memory']);

    await subject.execute('tool_search', { queries: ['procurement forecasts'] });
    const disallowed = await subject.execute('tool_describe', {
      names: ['search_procurement_forecasts', 'bad-name'],
    });
    expect(disallowed.loadedNames).toEqual([]);
    expect(disallowed.result).toMatchObject({ unavailableCount: 2 });
    expect(subject.exposedSchemas().map((item) => item.name)).toEqual(['search_memory']);
  });

  test('bounds multi-query work, attempts, result counts, and schema growth under the run budget', async () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      schema(`rare_reader_${index}`, `Rare reader capability ${index} alpha`, ['query']),
    );
    const subject = discovery({
      authorized: [schema('search_memory', 'Search memory'), ...many],
    });

    const tooManyQueries = await subject.execute('tool_search', {
      queries: ['one', 'two', 'three', 'four', 'five'],
    });
    expect(tooManyQueries.resultCode).toBe('invalid_queries');

    const bounded = await subject.execute('tool_search', {
      queries: ['rare reader'],
      limit: 99,
    });
    expect(bounded.matchedNames).toHaveLength(5);
    expect(JSON.stringify(bounded.result).length).toBeLessThan(12_000);

    await subject.execute('tool_search', { queries: ['rare reader'] });
    const capped = await subject.execute('tool_search', { queries: ['rare reader'] });
    expect(capped.resultCode).toBe('search_attempt_limit');
  });

  test('uses a fresh fail-closed authority surface for search, describe, and loaded schemas', async () => {
    const rare = schema('search_procurement_forecasts', 'Search procurement forecasts.', ['query']);
    let current = [schema('search_memory', 'Search memory'), rare];
    const subject = discovery({
      authorized: current,
      resolveCurrentSchemas: async () => current,
    });

    current = [current[0]!];
    const withdrawnBeforeSearch = await subject.execute('tool_search', {
      queries: ['procurement forecasts'],
    });
    expect(withdrawnBeforeSearch.matchedNames).toEqual([]);
    expect(JSON.stringify(withdrawnBeforeSearch.result)).not.toContain(rare.name);

    current = [current[0]!, rare];
    await subject.execute('tool_search', { queries: ['procurement forecasts'] });
    current = [current[0]!];
    const withdrawnBeforeDescribe = await subject.execute('tool_describe', {
      names: [rare.name],
    });
    expect(withdrawnBeforeDescribe.loadedNames).toEqual([]);
    expect(subject.exposedSchemas().map(({ name }) => name)).toEqual(['search_memory']);
  });

  test('removes a loaded schema when its exact current surface changes or lookup fails', async () => {
    const rare = schema('search_procurement_forecasts', 'Search procurement forecasts.', ['query']);
    let current: MeriProgressiveToolSchema[] = [schema('search_memory', 'Search memory'), rare];
    let lookupFails = false;
    const subject = discovery({
      authorized: current,
      resolveCurrentSchemas: async () => {
        if (lookupFails) throw new Error('current catalog unavailable');
        return current;
      },
    });
    await subject.execute('tool_search', { queries: ['procurement forecasts'] });
    await subject.execute('tool_describe', { names: [rare.name] });

    current = [{ ...rare, input_schema: { ...rare.input_schema, required: ['cursor'] } }];
    await subject.refreshLoaded();
    expect(subject.isLoaded(rare.name)).toBe(false);
    expect(subject.exposedSchemas().map(({ name }) => name)).toEqual(['search_memory']);

    current = [current[0]!, rare];
    await subject.execute('tool_describe', { names: [rare.name] });
    expect(subject.isLoaded(rare.name)).toBe(true);
    lookupFails = true;
    await subject.refreshLoaded();
    expect(subject.isLoaded(rare.name)).toBe(false);
  });
});
