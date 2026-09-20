export interface NexusCursor {
  client: string;
  offset: number;
}

export interface RailRead {
  key: string;
  authorize?: () => Promise<unknown>;
  read: () => Promise<unknown>;
}

type RailOperation = Omit<RailRead, 'key'>;

export interface RailPlanReaders {
  strategic: RailOperation;
  economicFootprint: RailOperation;
  supplierFootprint: RailOperation;
  economicContext: (state: string, district: string) => RailOperation;
  priorityIntelligence: (state: string, district: string) => RailOperation;
}

export interface FootprintRailSource {
  districts: ReadonlyArray<{ districtKey: string }>;
}

export interface RailReadResult {
  status: 'available' | 'unauthorized' | 'unavailable';
  data: unknown;
}

export async function executeRailRead(rail: RailRead): Promise<RailReadResult> {
  if (rail.authorize) {
    try {
      await rail.authorize();
    } catch {
      return { status: 'unauthorized', data: null };
    }
  }
  try {
    return { status: 'available', data: await rail.read() };
  } catch {
    return { status: 'unavailable', data: null };
  }
}

export function deriveLastSyncAt(
  freshness: ReadonlyArray<{ lastSyncedAt?: string | number | Date | null }>,
): Date | undefined {
  const timestamps = freshness.map((source) =>
    source.lastSyncedAt ? new Date(source.lastSyncedAt) : null,
  );
  return timestamps.length && timestamps.every((date) => date && Number.isFinite(date.getTime()))
    ? new Date(Math.min(...timestamps.map((date) => date!.getTime())))
    : undefined;
}

export function buildRailPlan(base: FootprintRailSource, readers: RailPlanReaders): RailRead[] {
  const reads: RailRead[] = [
    { key: 'verified_footprint', read: async () => base },
    { key: 'strategic_relevance', ...readers.strategic },
    { key: 'economic_footprint', ...readers.economicFootprint },
    { key: 'supplier_footprint_status', ...readers.supplierFootprint },
  ];
  const districts = [...new Set(base.districts.map((district) => district.districtKey))].sort();
  for (const key of districts) {
    const match = /^([A-Z]{2})-(\d{1,2})$/.exec(key);
    if (!match) continue;
    const state = match[1]!;
    const district = match[2]!;
    reads.push(
      { key: `economic_context:${key}`, ...readers.economicContext(state, district) },
      {
        key: `priority_intelligence:${key}`,
        ...readers.priorityIntelligence(state, district),
      },
    );
  }
  return reads;
}

export interface AdvanceCursorInput {
  clientIds: string[];
  clientIndex: number;
  clientId: string;
  offset: number;
  pageLength: number;
  railCount: number;
}

export interface AdvancedCursor {
  moreRails: boolean;
  hasMore: boolean;
  nextCursor?: string;
}

export function advanceCursor(input: AdvanceCursorInput): AdvancedCursor {
  const moreRails = input.offset + input.pageLength < input.railCount;
  const nextClientIndex = moreRails ? input.clientIndex : input.clientIndex + 1;
  const hasMore = moreRails || nextClientIndex < input.clientIds.length;
  if (!hasMore) return { moreRails, hasMore };

  return {
    moreRails,
    hasMore,
    nextCursor: Buffer.from(
      JSON.stringify({
        client: moreRails ? input.clientId : input.clientIds[nextClientIndex]!,
        offset: moreRails ? input.offset + input.pageLength : 0,
      }),
    ).toString('base64url'),
  };
}

export function parseCursor(cursor?: string): NexusCursor | undefined {
  if (!cursor || cursor.length > 512) return undefined;
  try {
    const data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as NexusCursor;
    return typeof data.client === 'string' && Number.isSafeInteger(data.offset) && data.offset >= 0
      ? data
      : undefined;
  } catch {
    return undefined;
  }
}
