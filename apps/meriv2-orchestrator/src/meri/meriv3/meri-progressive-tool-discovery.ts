import type { MeriRunBudget } from './meriv3-run-budget.js';

export interface MeriProgressiveToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const MERI_TOOL_SEARCH = 'tool_search';
export const MERI_TOOL_DESCRIBE = 'tool_describe';
export const MERI_PROGRESSIVE_DISCOVERY_CONTROL_NAMES = new Set([
  MERI_TOOL_SEARCH,
  MERI_TOOL_DESCRIBE,
]);

const MAX_QUERIES_PER_CALL = 4;
const MAX_RESULTS_PER_QUERY = 5;
const MAX_QUERY_CHARACTERS = 120;
const MAX_DESCRIBE_NAMES = 8;
const MAX_LOADED_SCHEMAS = 8;
const MAX_SCHEMA_GROWTH_CHARACTERS = 12_000;
const MAX_DESCRIPTION_CHARACTERS = 240;
const MAX_REQUIRED_FIELDS = 16;
const MAX_REQUIRED_FIELD_CHARACTERS = 64;
const MAX_SEARCH_ATTEMPTS = 3;
const MAX_DESCRIBE_ATTEMPTS = 3;

export interface MeriProgressiveDiscoveryOutcome {
  result: Record<string, unknown>;
  matchedNames: string[];
  loadedNames: string[];
  resultCode: string;
}

interface SearchableSchema {
  schema: MeriProgressiveToolSchema;
  nameTokens: Set<string>;
  descriptionTokens: Set<string>;
  parameterTokens: Set<string>;
}

function boundedStringList(
  value: unknown,
  maximum: number,
  maximumCharacters: number,
): string[] | null {
  const raw = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maximum) return null;
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const normalized = item.trim().slice(0, maximumCharacters);
    if (!normalized) return null;
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result.length ? result : null;
}

function tokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 32);
}

function schemaParameterNames(schema: MeriProgressiveToolSchema): string[] {
  const properties = schema.input_schema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties as Record<string, unknown>).slice(0, 64)
    : [];
}

function requiredFields(schema: MeriProgressiveToolSchema): string[] {
  return Array.isArray(schema.input_schema.required)
    ? schema.input_schema.required
        .filter((value): value is string => typeof value === 'string')
        .slice(0, MAX_REQUIRED_FIELDS)
        .map((value) => value.slice(0, MAX_REQUIRED_FIELD_CHARACTERS))
    : [];
}

function validSchema(schema: MeriProgressiveToolSchema): boolean {
  return (
    typeof schema.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(schema.name) &&
    !MERI_PROGRESSIVE_DISCOVERY_CONTROL_NAMES.has(schema.name) &&
    typeof schema.description === 'string' &&
    Boolean(schema.input_schema) &&
    typeof schema.input_schema === 'object' &&
    !Array.isArray(schema.input_schema)
  );
}

function controlSchema(name: string): MeriProgressiveToolSchema {
  if (name === MERI_TOOL_SEARCH) {
    return {
      name,
      description:
        'Search the current request-scoped governed capability registry for authorized tools omitted from this provider request. Search does not grant access. Follow with tool_describe to load an exact schema in a later provider request.',
      input_schema: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_QUERIES_PER_CALL,
            description: 'Bounded keyword queries, one per needed capability.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_RESULTS_PER_QUERY,
          },
        },
        required: ['queries'],
        additionalProperties: false,
      },
    };
  }
  return {
    name,
    description:
      'Load exact schemas returned by tool_search. Only searched, still-authorized names can be loaded, and loaded leaf tools execute through the ordinary governed registry path.',
    input_schema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_DESCRIBE_NAMES,
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
  };
}

/**
 * Request-local progressive disclosure over the already-authorized canonical
 * schema surface. It owns no handlers and no durable catalog: executable leaf
 * definitions remain in the shared registry and are re-authorized by the
 * caller before a schema is loaded.
 */
export class MeriProgressiveToolDiscovery {
  private readonly searchable: SearchableSchema[];
  private readonly initialSchemas: MeriProgressiveToolSchema[];
  private readonly discoveredNames = new Set<string>();
  private readonly loaded = new Map<string, MeriProgressiveToolSchema>();
  private searchAttempts = 0;
  private describeAttempts = 0;
  private loadedCharacters = 0;
  private readonly maximumAttempts: number;

  constructor(args: {
    authorizedSchemas: readonly MeriProgressiveToolSchema[];
    exposedSchemas: readonly MeriProgressiveToolSchema[];
    budget: MeriRunBudget;
    authorizeLoad: (schema: MeriProgressiveToolSchema) => boolean;
  }) {
    this.authorizeLoad = args.authorizeLoad;
    const exposed = new Set(args.exposedSchemas.map((schema) => schema.name));
    this.initialSchemas = args.exposedSchemas.filter(validSchema);
    this.searchable = args.authorizedSchemas
      .filter((schema) => validSchema(schema) && !exposed.has(schema.name))
      .map((schema) => ({
        schema,
        nameTokens: new Set(tokens(schema.name)),
        descriptionTokens: new Set(tokens(schema.description)),
        parameterTokens: new Set(tokens(schemaParameterNames(schema).join(' '))),
      }));
    const gatherModelCalls = Math.max(
      0,
      args.budget.limits.maxModelCalls - args.budget.limits.synthesisModelCallReserve,
    );
    this.maximumAttempts = Math.min(
      MAX_SEARCH_ATTEMPTS + MAX_DESCRIBE_ATTEMPTS,
      gatherModelCalls,
    );
  }

  private readonly authorizeLoad: (schema: MeriProgressiveToolSchema) => boolean;

  active(): boolean {
    return this.searchable.length > 0;
  }

  controlSchemas(): MeriProgressiveToolSchema[] {
    return this.active() ? [controlSchema(MERI_TOOL_SEARCH), controlSchema(MERI_TOOL_DESCRIBE)] : [];
  }

  exposedSchemas(): MeriProgressiveToolSchema[] {
    return [...this.initialSchemas, ...this.loaded.values()];
  }

  handles(name: string): boolean {
    return this.active() && MERI_PROGRESSIVE_DISCOVERY_CONTROL_NAMES.has(name);
  }

  execute(name: string, input: Record<string, unknown>): MeriProgressiveDiscoveryOutcome {
    if (!this.handles(name)) return this.failure('unavailable');
    if (this.searchAttempts + this.describeAttempts >= this.maximumAttempts) {
      return this.failure('attempt_limit');
    }
    return name === MERI_TOOL_SEARCH ? this.search(input) : this.describe(input);
  }

  private search(input: Record<string, unknown>): MeriProgressiveDiscoveryOutcome {
    this.searchAttempts += 1;
    if (this.searchAttempts > MAX_SEARCH_ATTEMPTS) return this.failure('search_attempt_limit');
    const queries = boundedStringList(
      input.queries,
      MAX_QUERIES_PER_CALL,
      MAX_QUERY_CHARACTERS,
    );
    if (!queries) return this.failure('invalid_queries');
    const requestedLimit = typeof input.limit === 'number' ? Math.floor(input.limit) : 5;
    const limit = Math.max(1, Math.min(MAX_RESULTS_PER_QUERY, requestedLimit));
    const matchedNames: string[] = [];
    const tools: Record<string, unknown> = {};
    const results = queries.map((query, queryIndex) => {
      const queryTokens = [...new Set(tokens(query))];
      const exact = query.trim().toLowerCase();
      const hits = queryTokens.length
        ? this.searchable
            .map((entry) => {
              const exactName = entry.schema.name.toLowerCase() === exact;
              const everyTermMatches = queryTokens.every(
                (token) =>
                  entry.nameTokens.has(token) ||
                  entry.descriptionTokens.has(token) ||
                  entry.parameterTokens.has(token),
              );
              if (!exactName && !everyTermMatches) return null;
              const score = exactName
                ? Number.MAX_SAFE_INTEGER
                : queryTokens.reduce(
                    (total, token) =>
                      total +
                      (entry.nameTokens.has(token) ? 4 : 0) +
                      (entry.descriptionTokens.has(token) ? 2 : 0) +
                      (entry.parameterTokens.has(token) ? 1 : 0),
                    0,
                  );
              return { entry, score };
            })
            .filter(
              (value): value is { entry: SearchableSchema; score: number } => value !== null,
            )
            .sort(
              (left, right) =>
                right.score - left.score ||
                left.entry.schema.name.localeCompare(right.entry.schema.name),
            )
            .slice(0, limit)
        : [];
      const matches = hits.map(({ entry }) => entry.schema.name);
      for (const { entry } of hits) {
        this.discoveredNames.add(entry.schema.name);
        if (!matchedNames.includes(entry.schema.name)) matchedNames.push(entry.schema.name);
        tools[entry.schema.name] = {
          description: entry.schema.description.slice(0, MAX_DESCRIPTION_CHARACTERS),
          required: requiredFields(entry.schema),
          source: entry.schema.name.startsWith('mcp__') ? 'mcp' : 'native',
        };
      }
      return { queryIndex, matches };
    });
    return {
      result: {
        results,
        tools,
        totalAvailable: this.searchable.length,
        limits: {
          queries: MAX_QUERIES_PER_CALL,
          resultsPerQuery: MAX_RESULTS_PER_QUERY,
          loadableSchemas: MAX_LOADED_SCHEMAS,
        },
      },
      matchedNames,
      loadedNames: [],
      resultCode: matchedNames.length ? 'matches' : 'no_matches',
    };
  }

  private describe(input: Record<string, unknown>): MeriProgressiveDiscoveryOutcome {
    this.describeAttempts += 1;
    if (this.describeAttempts > MAX_DESCRIBE_ATTEMPTS) {
      return this.failure('describe_attempt_limit');
    }
    const names = boundedStringList(input.names, MAX_DESCRIBE_NAMES, 128);
    if (!names) return this.failure('invalid_names');
    const byName = new Map(this.searchable.map((entry) => [entry.schema.name, entry.schema]));
    const tools: Record<string, unknown> = {};
    const loadedNames: string[] = [];
    let unavailableCount = 0;
    let capacityCount = 0;
    for (const name of names) {
      const schema = byName.get(name);
      if (!schema || !this.discoveredNames.has(name) || !this.authorizeLoad(schema)) {
        unavailableCount += 1;
        continue;
      }
      if (this.loaded.has(name)) {
        loadedNames.push(name);
        tools[name] = {
          description: schema.description,
          parameters: schema.input_schema,
        };
        continue;
      }
      const schemaCharacters = JSON.stringify(schema).length;
      if (
        this.loaded.size >= MAX_LOADED_SCHEMAS ||
        this.loadedCharacters + schemaCharacters > MAX_SCHEMA_GROWTH_CHARACTERS
      ) {
        capacityCount += 1;
        continue;
      }
      this.loaded.set(name, schema);
      this.loadedCharacters += schemaCharacters;
      loadedNames.push(name);
      tools[name] = {
        description: schema.description,
        parameters: schema.input_schema,
      };
    }
    return {
      result: {
        tools,
        loaded: loadedNames,
        unavailableCount,
        capacityCount,
        remainingSchemaSlots: Math.max(0, MAX_LOADED_SCHEMAS - this.loaded.size),
      },
      matchedNames: [],
      loadedNames,
      resultCode: loadedNames.length ? 'loaded' : 'not_loaded',
    };
  }

  private failure(resultCode: string): MeriProgressiveDiscoveryOutcome {
    return {
      result: { error: 'Progressive discovery request was rejected.', code: resultCode },
      matchedNames: [],
      loadedNames: [],
      resultCode,
    };
  }
}
