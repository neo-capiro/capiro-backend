import snapshot from './reference-data/naics-psc.generated.json';

export type ProfileBuildReferenceKind = 'naics' | 'psc';

export type ProfileBuildReferenceEntry = Readonly<{
  kind: ProfileBuildReferenceKind;
  code: string;
  label: string;
  version: string;
  status: 'active';
  sourceUrl: string;
  sourcePublishedAt: string | null;
  sourceRetrievedAt: string;
  validFrom: string | null;
  validTo: null;
}>;

export type ProfileBuildReferenceLookup =
  | { status: 'valid'; entry: ProfileBuildReferenceEntry }
  | { status: 'invalid_format' | 'unknown_code' | 'inactive_code' };

const MAX_QUERY_LENGTH = 160;
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 30;

function createCatalog(kind: ProfileBuildReferenceKind) {
  const source = snapshot[kind];
  const entries: readonly ProfileBuildReferenceEntry[] = Object.freeze(
    source.entries.map((entry) =>
      Object.freeze({
        ...entry,
        kind,
        version: source.version,
        status: 'active' as const,
        sourceUrl: source.sourceUrl,
        sourcePublishedAt: source.sourcePublishedAt,
        sourceRetrievedAt: source.sourceRetrievedAt,
        validTo: null,
      }),
    ),
  );
  return {
    entries,
    byCode: new Map(entries.map((entry) => [entry.code, entry])),
    searchable: entries.map((entry) => ({
      entry,
      text: `${entry.code} ${entry.label}`.toUpperCase(),
    })),
    inactiveCodes: new Set<string>(source.inactiveCodes),
  };
}

// Importing builds a small in-memory index only. No network, database, model, timers or I/O.
const CATALOGS = { naics: createCatalog('naics'), psc: createCatalog('psc') };

/**
 * Exact assignable-code validation: six-digit national NAICS industries or active
 * four-character PSCs. A formatted code is insufficient unless the source lists it.
 */
export function lookupProfileBuildReferenceCode(
  kind: ProfileBuildReferenceKind,
  value: string,
): ProfileBuildReferenceLookup {
  if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH)
    return { status: 'invalid_format' };
  const code = value.trim().toUpperCase();
  const format = kind === 'naics' ? /^\d{6}$/ : /^[A-Z0-9]{4}$/;
  if (!format.test(code)) return { status: 'invalid_format' };
  const catalog = CATALOGS[kind];
  const entry = catalog.byCode.get(code);
  if (entry) return { status: 'valid', entry };
  return { status: catalog.inactiveCodes.has(code) ? 'inactive_code' : 'unknown_code' };
}

/**
 * Bounded literal search of the pinned official edition. All tokens must match;
 * exact codes and code prefixes rank first, with stable code ordering thereafter.
 * Empty/oversized queries return no suggestions. Only active assignable codes appear.
 */
export function searchProfileBuildReferenceCatalog(
  kind: ProfileBuildReferenceKind,
  query: string,
  limit = DEFAULT_RESULTS,
): readonly ProfileBuildReferenceEntry[] {
  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) return [];
  const normalized = query.trim().toUpperCase();
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/);
  const count = Number.isFinite(limit)
    ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(limit)))
    : DEFAULT_RESULTS;
  const ranked: ProfileBuildReferenceEntry[][] = [[], [], []];
  for (const { entry, text } of CATALOGS[kind].searchable) {
    if (!tokens.every((token) => text.includes(token))) continue;
    const rank = entry.code === normalized ? 0 : entry.code.startsWith(normalized) ? 1 : 2;
    // Keep at most the response limit per rank, even for broad one-character queries.
    if (ranked[rank]!.length < count) ranked[rank]!.push(entry);
  }
  return ranked.flat().slice(0, count);
}
