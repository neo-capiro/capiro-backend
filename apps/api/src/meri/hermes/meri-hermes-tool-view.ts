/**
 * Proposed Meri-to-worker contract. It is deliberately separate from the
 * pinned Hermes /v1/runs wire type: v2026.9.14 cannot consume this view.
 * Every set here must be resolved by the server for this run. A route is only
 * a relevance hint; it cannot grant a tool.
 */
import { createHash } from 'node:crypto';

/** Exact OpenAI-style model-facing function schema observed at the boundary. */
export type MeriHermesToolSchemaV1 = Readonly<Record<string, unknown> & {
  readonly type: 'function';
  readonly function: Readonly<Record<string, unknown> & { readonly name: string }>;
}>;

export const MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1 =
  'capiro.meri.phase4.worker-catalog/v1' as const;
export const MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1 =
  'capiro.meri.phase4.applied-tool-view/v1' as const;

export interface MeriHermesToolViewInputsV1 {
  catalogVersion: string;
  expectedCatalogVersion: string;
  meriCatalogDigest: string;
  expectedMeriCatalogDigest: string;
  capabilityMappingVersion: string;
  expectedCapabilityMappingVersion: string;
  capabilityMappingDigest: string;
  expectedCapabilityMappingDigest: string;
  catalogTools: readonly MeriHermesToolSchemaV1[];
  deploymentToolNames: readonly string[];
  authorizedToolNames: readonly string[];
  availableToolNames: readonly string[];
  requiredToolNames: readonly string[];
  relevantToolNames: readonly string[];
  runLocalToolNames: readonly string[];
}

const compiledToolViewBrand: unique symbol = Symbol('compiledMeriHermesToolViewV1');

export interface MeriHermesToolViewV1 {
  readonly [compiledToolViewBrand]: true;
  readonly version: 1;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly toolViewDigest: string;
  readonly meriCatalogDigest: string;
  readonly capabilityMappingVersion: string;
  readonly capabilityMappingDigest: string;
  readonly toolNames: readonly string[];
  readonly requiredToolNames: readonly string[];
}

export class MeriHermesToolViewError extends Error {
  constructor(readonly code: 'stale_catalog' | 'invalid_tool_view' | 'required_tool_unavailable') {
    super(code);
  }
}

const validNames = (names: readonly string[]): boolean =>
  Array.isArray(names) && names.every((name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name));
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new MeriHermesToolViewError('invalid_tool_view');
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (!validUnicode(value)) throw new MeriHermesToolViewError('invalid_tool_view');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new MeriHermesToolViewError('invalid_tool_view');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MeriHermesToolViewError('invalid_tool_view');
    }
    const keys = Object.keys(record);
    if (keys.some((key) => !validUnicode(key))) {
      throw new MeriHermesToolViewError('invalid_tool_view');
    }
    keys.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`).join(',')}}`;
  }
  throw new MeriHermesToolViewError('invalid_tool_view');
}

function digest(domain: string, value: unknown): string {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  if (bytes.length > 1_048_576) throw new MeriHermesToolViewError('invalid_tool_view');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return createHash('sha256').update(domain, 'utf8').update(length).update(bytes).digest('hex');
}

function toolName(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const candidate = schema as { type?: unknown; function?: unknown };
  if (candidate.type !== 'function' || !candidate.function ||
      typeof candidate.function !== 'object' || Array.isArray(candidate.function)) return null;
  const name = (candidate.function as { name?: unknown }).name;
  const outerName = (schema as { name?: unknown }).name;
  return typeof name === 'string' && validNames([name]) &&
    (outerName === undefined || outerName === name) ? name : null;
}

function canonicalSchemas(tools: readonly MeriHermesToolSchemaV1[]):
readonly MeriHermesToolSchemaV1[] {
  if (!Array.isArray(tools) || tools.length > 4096 ||
      tools.some((tool) => toolName(tool) === null)) {
    throw new MeriHermesToolViewError('invalid_tool_view');
  }
  const normalized = tools.map((tool) => {
    const schema = JSON.parse(canonicalJson(tool)) as MeriHermesToolSchemaV1;
    return Object.freeze(schema);
  }).sort((left, right) => {
    const leftName = toolName(left)!;
    const rightName = toolName(right)!;
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  if (normalized.some((tool, index) => index > 0 &&
      toolName(tool) === toolName(normalized[index - 1]))) {
    throw new MeriHermesToolViewError('invalid_tool_view');
  }
  return Object.freeze(normalized);
}

/**
 * Versioned digest contract shared by the trusted compiler and the worker
 * claim path. The caller supplies the raw observed model-facing schemas; this
 * function, not the caller, derives both hashes.
 */
export function computeMeriHermesObservedToolDigestsV1(
  catalogTools: readonly MeriHermesToolSchemaV1[],
  appliedToolSchemas: readonly MeriHermesToolSchemaV1[],
): Readonly<{ catalogDigest: string; toolViewDigest: string }> {
  const catalog = canonicalSchemas(catalogTools);
  const applied = canonicalSchemas(appliedToolSchemas);
  const byName = new Map(catalog.map((tool) => [toolName(tool)!, canonicalJson(tool)]));
  if (applied.some((schema) => byName.get(toolName(schema)!) !== canonicalJson(schema))) {
    throw new MeriHermesToolViewError('required_tool_unavailable');
  }
  return Object.freeze({
    catalogDigest: digest(MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1, catalog),
    toolViewDigest: digest(MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1, applied),
  });
}

/** Build a new immutable snapshot; never mutate a worker or process-wide list. */
export function compileMeriHermesToolViewV1(input: MeriHermesToolViewInputsV1): MeriHermesToolViewV1 {
  if (!VERSION_ID.test(input.catalogVersion) ||
      input.catalogVersion !== input.expectedCatalogVersion ||
      !SHA256.test(input.meriCatalogDigest) ||
      input.meriCatalogDigest !== input.expectedMeriCatalogDigest ||
      !VERSION_ID.test(input.capabilityMappingVersion) ||
      input.capabilityMappingVersion !== input.expectedCapabilityMappingVersion ||
      !SHA256.test(input.capabilityMappingDigest) ||
      input.capabilityMappingDigest !== input.expectedCapabilityMappingDigest) {
    throw new MeriHermesToolViewError('stale_catalog');
  }
  const lists = [
    input.deploymentToolNames, input.authorizedToolNames,
    input.availableToolNames, input.requiredToolNames, input.relevantToolNames,
    input.runLocalToolNames,
  ];
  if (lists.some((names) => !validNames(names))) {
    throw new MeriHermesToolViewError('invalid_tool_view');
  }
  const catalogNames = input.catalogTools.map((tool) => toolName(tool) ?? '');
  if (!validNames(catalogNames)) throw new MeriHermesToolViewError('invalid_tool_view');
  const catalog = new Set(catalogNames);
  const ceiling = new Set(input.deploymentToolNames);
  const authorized = new Set(input.authorizedToolNames);
  const available = new Set(input.availableToolNames);
  const eligible = (name: string): boolean =>
    catalog.has(name) && ceiling.has(name) && authorized.has(name) && available.has(name);
  if (input.requiredToolNames.some((name) => !eligible(name))) {
    throw new MeriHermesToolViewError('required_tool_unavailable');
  }
  const selected = new Set([
    ...input.requiredToolNames,
    ...input.relevantToolNames.filter(eligible),
    ...input.runLocalToolNames.filter(eligible),
  ]);
  const toolNames = [...selected].sort();
  const catalogSchemas = canonicalSchemas(input.catalogTools);
  const schemasByName = new Map(catalogSchemas.map((schema) => [toolName(schema)!, schema]));
  const appliedSchemas = toolNames.map((name) => schemasByName.get(name)!);
  const digests = computeMeriHermesObservedToolDigestsV1(catalogSchemas, appliedSchemas);
  return Object.freeze({
    [compiledToolViewBrand]: true as const,
    version: 1 as const,
    catalogVersion: input.catalogVersion,
    catalogDigest: digests.catalogDigest,
    toolViewDigest: digests.toolViewDigest,
    meriCatalogDigest: input.meriCatalogDigest,
    capabilityMappingVersion: input.capabilityMappingVersion,
    capabilityMappingDigest: input.capabilityMappingDigest,
    toolNames: Object.freeze(toolNames),
    requiredToolNames: Object.freeze([...new Set(input.requiredToolNames)].sort()),
  });
}

/** Reject a structural object constructed outside the server-side compiler. */
export function isCompiledMeriHermesToolViewV1(value: unknown): value is MeriHermesToolViewV1 {
  if (!value || typeof value !== 'object') return false;
  const view = value as MeriHermesToolViewV1;
  return view[compiledToolViewBrand] === true && Object.isFrozen(view) && view.version === 1 &&
    VERSION_ID.test(view.catalogVersion) && SHA256.test(view.catalogDigest) &&
    SHA256.test(view.toolViewDigest) && SHA256.test(view.meriCatalogDigest) &&
    VERSION_ID.test(view.capabilityMappingVersion) &&
    SHA256.test(view.capabilityMappingDigest) &&
    validNames(view.toolNames) && validNames(view.requiredToolNames) &&
    Object.isFrozen(view.toolNames) && Object.isFrozen(view.requiredToolNames) &&
    new Set(view.toolNames).size === view.toolNames.length &&
    new Set(view.requiredToolNames).size === view.requiredToolNames.length &&
    view.requiredToolNames.every((name) => view.toolNames.includes(name));
}
