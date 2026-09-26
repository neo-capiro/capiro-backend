import {
  FEDRAMP_IMPACT_LEVEL_VOCABULARY,
  FEDRAMP_STATUS_VOCABULARY,
} from '@capiro/meriv2-core';

export { FEDRAMP_IMPACT_LEVEL_VOCABULARY, FEDRAMP_STATUS_VOCABULARY };

export const FEDRAMP_MARKETPLACE_URL = 'https://fedramp.gov/marketplace/products/';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface FedrampProductRecord {
  productId: string;
  cspName: string;
  csoName: string;
  status: string;
  impactLevel: string;
  authorizationDate: string | null;
  sponsoringAgencies: string[];
  sourceUrl: string;
  observedAt: string;
}

export class FedrampMarketplaceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function decodeJsString(value: string): string {
  return JSON.parse(`"${value}"`) as string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stringField(body: string, variable: string, field: string): string | null {
  const match = body.match(new RegExp(`(?:^|;)${escapeRegExp(variable)}\\.${field}="((?:\\\\.|[^"\\\\])*)"`));
  return match ? decodeJsString(match[1]!) : null;
}

function dateField(body: string, variable: string, field: string): string | null {
  const match = body.match(new RegExp(`(?:^|;)${escapeRegExp(variable)}\\.${field}=(?:new Date\\((\\d+)\\)|null)`));
  return match?.[1] ? new Date(Number(match[1])).toISOString() : null;
}

function stringArrayField(body: string, variable: string, field: string): string[] {
  const match = body.match(new RegExp(`(?:^|;)${escapeRegExp(variable)}\\.${field}=\\[((?:"(?:\\\\.|[^"\\\\])*",?)*)\\]`));
  if (!match) return [];
  return [...match[1]!.matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((item) => decodeJsString(item[1]!))
    .filter(Boolean);
}

/** Parse the official marketplace's prerendered Svelte assignment payload without executing it. */
export function parseFedrampMarketplaceProducts(
  html: string,
  observedAt: string,
): FedrampProductRecord[] {
  const records: FedrampProductRecord[] = [];
  const assignments = [...html.matchAll(/(?:^|[;\s])([A-Za-z_$][\w$]*)\.id="([^"]+)";/g)];
  const productIdPattern = /^(?:FR|F)\d{9,10}(?:A|XL|XM)?$/;
  const productLikeIdPattern = /^(?:FR|F)\d/;
  const productAssignments = assignments.filter((match) => productIdPattern.test(match[2]!));
  const malformedProductId = assignments.find((match) =>
    productLikeIdPattern.test(match[2]!) && !productIdPattern.test(match[2]!),
  );
  if (malformedProductId) {
    throw new FedrampMarketplaceError(`Unsupported marketplace product ID shape ${malformedProductId[2]}`);
  }
  for (const [index, match] of productAssignments.entries()) {
    const [, variable, productId] = match;
    const next = productAssignments[index + 1];
    const body = html.slice(match.index!, next?.index ?? html.length);
    const cspName = stringField(body, variable!, 'csp');
    const csoName = stringField(body, variable!, 'cso');
    const status = stringField(body, variable!, 'status');
    const impactLevel = stringField(body, variable!, 'impact_level');
    if (!cspName || !csoName || !status || !impactLevel) {
      throw new FedrampMarketplaceError(`Incomplete marketplace record ${productId}`);
    }
    if (!(FEDRAMP_STATUS_VOCABULARY as readonly string[]).includes(status)) {
      throw new FedrampMarketplaceError(`Unknown marketplace status for ${productId}`);
    }
    if (!(FEDRAMP_IMPACT_LEVEL_VOCABULARY as readonly string[]).includes(impactLevel)) {
      throw new FedrampMarketplaceError(`Unknown marketplace impact level for ${productId}`);
    }
    records.push({
      productId: productId!,
      cspName,
      csoName,
      status,
      impactLevel,
      authorizationDate: dateField(body, variable!, 'cert_date'),
      sponsoringAgencies: stringArrayField(body, variable!, 'agency_authorizations'),
      sourceUrl: FEDRAMP_MARKETPLACE_URL,
      observedAt,
    });
  }
  if (!records.length) throw new FedrampMarketplaceError('No FedRAMP product records found');
  return records;
}

async function fetchOnce(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(FEDRAMP_MARKETPLACE_URL, {
    headers: { accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new FedrampMarketplaceError(`FedRAMP marketplace HTTP ${response.status}`, response.status);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new FedrampMarketplaceError('FedRAMP marketplace response exceeds size limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new FedrampMarketplaceError('FedRAMP marketplace response exceeds size limit');
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchFedrampProducts(
  options: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<FedrampProductRecord[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchAndParse = async () =>
    parseFedrampMarketplaceProducts(
      await fetchOnce(fetchImpl),
      (options.now ?? (() => new Date()))().toISOString(),
    );
  try {
    return await fetchAndParse();
  } catch (error) {
    if (error instanceof FedrampMarketplaceError && error.status != null && error.status < 500) throw error;
    // A successful HTTP response can still be a partial/changed payload. Retry it
    // once, then surface the parse failure rather than returning an empty inventory.
    return fetchAndParse();
  }
}
