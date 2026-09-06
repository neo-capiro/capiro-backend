import { BadRequestException } from '@nestjs/common';

export const CLIENT_PROFILE_SECTIONS = [
  'capabilities', 'people', 'facilities', 'submissionHistory',
] as const;
export type ClientProfileSection = (typeof CLIENT_PROFILE_SECTIONS)[number];

export interface ClientProfileQuery {
  section?: ClientProfileSection;
  afterId?: string;
  limit: number;
}

/** Cursors identify a record inside an already authorized client/section. They
 * convey no authority, and cannot be reused to change the query's scope. */
export function parseClientProfileQuery(
  input: Record<string, unknown>,
  clientId: string,
): ClientProfileQuery {
  const { section, cursor } = input;
  if (section !== undefined && !CLIENT_PROFILE_SECTIONS.includes(section as ClientProfileSection)) {
    throw new BadRequestException('Unknown client profile section');
  }
  const limit = input.limit ?? 25;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new BadRequestException('limit must be an integer between 1 and 50');
  }
  let afterId: string | undefined;
  if (cursor !== undefined) {
    if (!section || typeof cursor !== 'string' || cursor.length > 1024 || !/^[\w-]+$/.test(cursor)) {
      throw new BadRequestException('A profile cursor requires its original section');
    }
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        parsed.v !== 1 || parsed.clientId !== clientId || parsed.section !== section ||
        typeof parsed.afterId !== 'string' || !parsed.afterId
      ) throw new Error('scope mismatch');
      afterId = parsed.afterId;
    } catch {
      throw new BadRequestException('Invalid profile cursor for this client and section');
    }
  }
  return { section: section as ClientProfileSection | undefined, afterId, limit };
}

interface ProfileRecord {
  id: string;
  updatedAt?: unknown;
}

export interface ClientProfileCoverage {
  status: 'complete' | 'partial' | 'unavailable' | 'not_requested';
  total: number | null;
  returned: number;
  limit: number;
  truncated: boolean | null;
  nextCursor: string | null;
  representation: 'summary' | 'full';
  source: { tool: 'get_client_context'; clientId: string; section: ClientProfileSection };
  sourceReferences: Array<{ recordId: string; updatedAt?: unknown }>;
  error?: 'section_unavailable';
}

/** Keep navigation/coverage small and before record text in tool serialization.
 * Per-record references remain available separately after the profile data. */
export function clientProfileCoverageHeader(coverage: ClientProfileCoverage) {
  const { sourceReferences: _sourceReferences, ...header } = coverage;
  return header;
}

/** Reuses full-list domain reads, rather than a second set of profile queries.
 * The returned record-ID cursor remains stable when other rows are inserted or
 * deleted. Selected-section reads return complete records (no text clipping). */
export async function readClientProfileSection<T extends ProfileRecord, S>(input: {
  clientId: string;
  section: ClientProfileSection;
  query: ClientProfileQuery;
  load: () => Promise<T[]>;
  summarize: (row: T) => S;
}): Promise<{ items: Array<T | S>; coverage: ClientProfileCoverage }> {
  const { clientId, section, query, load, summarize } = input;
  const base: ClientProfileCoverage = {
    status: 'not_requested', total: null, returned: 0, limit: query.limit,
    truncated: null, nextCursor: null, representation: query.section ? 'full' : 'summary',
    source: { tool: 'get_client_context', clientId, section }, sourceReferences: [],
  };
  if (query.section && query.section !== section) return { items: [], coverage: base };
  let rows: T[];
  try {
    rows = await load();
  } catch {
    return { items: [], coverage: { ...base, status: 'unavailable', error: 'section_unavailable' } };
  }
  // Do not let ties or edits in the domain service's display ordering move a
  // record between pages. All profile IDs are immutable UUIDs.
  const ordered = [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const start = query.afterId
    ? ordered.findIndex((row) => row.id > query.afterId!)
    : 0;
  const offset = start < 0 ? ordered.length : start;
  const page = ordered.slice(offset, offset + query.limit);
  const truncated = offset + page.length < ordered.length;
  const nextCursor = truncated && page.length
    ? Buffer.from(JSON.stringify({ v: 1, clientId, section, afterId: page[page.length - 1]!.id })).toString('base64url')
    : null;
  return {
    items: query.section ? page : page.map(summarize),
    coverage: {
      ...base, status: truncated ? 'partial' : 'complete', total: rows.length,
      returned: page.length, truncated, nextCursor,
      sourceReferences: page.map((row) => ({ recordId: row.id, updatedAt: row.updatedAt })),
    },
  };
}
