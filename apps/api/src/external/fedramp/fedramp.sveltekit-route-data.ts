import {
  FEDRAMP_IMPACT_LEVEL_VOCABULARY,
  FEDRAMP_STATUS_VOCABULARY,
} from '@capiro/meriv2-core';

/** This decoder is an audit aid only; it is deliberately not wired to the FedRAMP client. */
export const FEDRAMP_SVELTE_ROUTE_DATA_URL = 'https://fedramp.gov/marketplace/products/__data.json';
export const FEDRAMP_SVELTE_ROUTE_DATA_SOURCE_ID = 'fedramp-marketplace-sveltekit-route-data';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_ROUTE_NODES = 8;
const MAX_GRAPH_SLOTS = 100_000;
const MAX_PRODUCTS = 2_000;
const MAX_ID_LENGTH = 160;
const MAX_NAME_LENGTH = 1_000;
// Mirrors the verified numeric/suffix shapes in fedramp.client.ts and adds only
// the seven named legacy product IDs observed in the official page payload.
const PRODUCT_ID_PATTERN = /^(?:(?:FR|F)\d{9,10}(?:A|XL|XM)?|AGENCYAMAZONEW|AGENCYHUDSAAS|AGENCYNITCIAAS|AGENCYWC2|MSO365MT|MSO365MTA|SOCRATA)$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface FedrampSvelteRouteProduct {
  id: string;
  csp: string;
  cso: string;
  status: string;
  impactLevel: string;
}

export interface FedrampSvelteRouteSnapshot {
  sourceId: typeof FEDRAMP_SVELTE_ROUTE_DATA_SOURCE_ID;
  sourceUrl: typeof FEDRAMP_SVELTE_ROUTE_DATA_URL;
  observedAt: string;
  lastChange: string;
  sourceCount: number;
  products: FedrampSvelteRouteProduct[];
  authority: 'unverified-route-snapshot';
  uncertainty: readonly [
    'undocumented-framework-route-data',
    'freshness-and-inventory-completeness-unverified',
    'source-count-is-snapshot-array-length-only',
    'not-suitable-for-negative-claims',
  ];
}

export class FedrampSvelteRouteDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FedrampSvelteRouteDataError';
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireIndex(value: unknown, length: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length) {
    throw new FedrampSvelteRouteDataError(`Invalid or out-of-range ${label} reference`);
  }
  return value as number;
}

/** Resolve only a single observed devalue graph edge to a plain scalar string. */
function resolveCoreString(data: unknown[], reference: unknown, label: string, maxLength: number): string {
  const index = requireIndex(reference, data.length, `${label} graph`);
  const value = data[index];
  // No recursion or tag decoding is permitted for product core fields.
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new FedrampSvelteRouteDataError(`Invalid, empty, tagged, or non-scalar ${label}`);
  }
  return value;
}

function resolveLastChange(data: unknown[], reference: unknown): string {
  const index = requireIndex(reference, data.length, 'last_change graph');
  const taggedDate = data[index];
  if (!Array.isArray(taggedDate) || taggedDate.length !== 2
    || taggedDate[0] !== 'Date' || typeof taggedDate[1] !== 'string'
    || !isStrictUtcTimestamp(taggedDate[1])) {
    throw new FedrampSvelteRouteDataError('Invalid source meta.last_change Date tag');
  }
  return taggedDate[1];
}

function isStrictUtcTimestamp(value: string): boolean {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const fraction = value.match(/\.(\d{1,3})Z$/)?.[1];
  const canonicalInput = fraction
    ? value.replace(/\.\d{1,3}Z$/, `.${fraction.padEnd(3, '0')}Z`)
    : value.replace(/Z$/, '.000Z');
  return new Date(milliseconds).toISOString() === canonicalInput;
}

/**
 * Decode only the observed FedRAMP SvelteKit page-data shape. This does not execute source code,
 * recursively unflatten devalue data, or imply a stable API, a complete current inventory, or
 * support for absence/negative claims.
 */
export function decodeFedrampSvelteRouteData(
  jsonText: string,
  observedAt: string,
): FedrampSvelteRouteSnapshot {
  if (Buffer.byteLength(jsonText, 'utf8') > MAX_INPUT_BYTES) {
    throw new FedrampSvelteRouteDataError('Route data exceeds byte limit');
  }
  if (!isStrictUtcTimestamp(observedAt)) {
    throw new FedrampSvelteRouteDataError('Invalid observation timestamp');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    throw new FedrampSvelteRouteDataError('Invalid route-data JSON');
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['type', 'nodes']) || parsed.type !== 'data'
    || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0 || parsed.nodes.length > MAX_ROUTE_NODES) {
    throw new FedrampSvelteRouteDataError('Unsupported route-data envelope');
  }

  let totalSlots = 0;
  const roots: Array<{ nodeData: unknown[]; routeRoot: JsonRecord }> = [];
  for (const node of parsed.nodes) {
    if (!isRecord(node) || node.type !== 'data' || !Array.isArray(node.data)) {
      throw new FedrampSvelteRouteDataError('Malformed route-data node');
    }
    totalSlots += node.data.length;
    if (totalSlots > MAX_GRAPH_SLOTS) {
      throw new FedrampSvelteRouteDataError('Route-data graph exceeds slot limit');
    }
    const routeRoot = node.data[0];
    if (isRecord(routeRoot) && Object.prototype.hasOwnProperty.call(routeRoot, 'fedRAMPData')) {
      roots.push({ nodeData: node.data, routeRoot });
    }
  }
  if (roots.length !== 1) {
    throw new FedrampSvelteRouteDataError('Missing or ambiguous fedRAMPData root');
  }

  const { nodeData: data, routeRoot } = roots[0]!;
  if (!hasOnlyKeys(routeRoot, ['fedRAMPData'])) {
    throw new FedrampSvelteRouteDataError('Unsupported fedRAMPData root shape');
  }
  const fedRampIndex = requireIndex(routeRoot.fedRAMPData, data.length, 'fedRAMPData');
  const fedRampData = data[fedRampIndex];
  if (!isRecord(fedRampData) || !hasOnlyKeys(fedRampData, ['meta', 'data'])) {
    throw new FedrampSvelteRouteDataError('Unsupported fedRAMPData object shape');
  }
  const metaIndex = requireIndex(fedRampData.meta, data.length, 'meta');
  const meta = data[metaIndex];
  if (!isRecord(meta) || !hasOnlyKeys(meta, ['last_change', 'produced_by'])) {
    throw new FedrampSvelteRouteDataError('Unsupported source metadata shape');
  }
  const lastChange = resolveLastChange(data, meta.last_change);
  resolveCoreString(data, meta.produced_by, 'meta.produced_by', 200);

  const collectionIndex = requireIndex(fedRampData.data, data.length, 'fedRAMPData.data');
  const collection = data[collectionIndex];
  if (!isRecord(collection) || !Object.prototype.hasOwnProperty.call(collection, 'Products')) {
    throw new FedrampSvelteRouteDataError('Products collection is missing');
  }
  const productsIndex = requireIndex(collection.Products, data.length, 'Products');
  const productRefs = data[productsIndex];
  if (!Array.isArray(productRefs) || productRefs.length === 0 || productRefs.length > MAX_PRODUCTS) {
    throw new FedrampSvelteRouteDataError('Products is not a bounded, non-empty reference array');
  }

  const ids = new Set<string>();
  const products: FedrampSvelteRouteProduct[] = [];
  for (const productReference of productRefs) {
    const productIndex = requireIndex(productReference, data.length, 'product');
    const product = data[productIndex];
    if (!isRecord(product)) throw new FedrampSvelteRouteDataError('Product reference is not an object');
    const id = resolveCoreString(data, product.id, 'product.id', MAX_ID_LENGTH);
    const csp = resolveCoreString(data, product.csp, 'product.csp', MAX_NAME_LENGTH);
    const cso = resolveCoreString(data, product.cso, 'product.cso', MAX_NAME_LENGTH);
    const status = resolveCoreString(data, product.status, 'product.status', 200);
    const impactLevel = resolveCoreString(data, product.impact_level, 'product.impact_level', 100);
    if (!PRODUCT_ID_PATTERN.test(id)) {
      throw new FedrampSvelteRouteDataError(`Unsupported product ID shape ${id}`);
    }
    if (ids.has(id)) throw new FedrampSvelteRouteDataError(`Duplicate product ID ${id}`);
    if (!(FEDRAMP_STATUS_VOCABULARY as readonly string[]).includes(status)) {
      throw new FedrampSvelteRouteDataError(`Unknown product status for ${id}`);
    }
    if (!(FEDRAMP_IMPACT_LEVEL_VOCABULARY as readonly string[]).includes(impactLevel)) {
      throw new FedrampSvelteRouteDataError(`Unknown product impact level for ${id}`);
    }
    ids.add(id);
    products.push({ id, csp, cso, status, impactLevel });
  }

  return {
    sourceId: FEDRAMP_SVELTE_ROUTE_DATA_SOURCE_ID,
    sourceUrl: FEDRAMP_SVELTE_ROUTE_DATA_URL,
    observedAt,
    lastChange,
    sourceCount: products.length,
    products,
    authority: 'unverified-route-snapshot',
    uncertainty: [
      'undocumented-framework-route-data',
      'freshness-and-inventory-completeness-unverified',
      'source-count-is-snapshot-array-length-only',
      'not-suitable-for-negative-claims',
    ],
  };
}
