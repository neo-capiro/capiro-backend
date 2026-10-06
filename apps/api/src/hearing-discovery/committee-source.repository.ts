/**
 * `committee_source` persistence — the Phase 3 source registry.
 *
 * Every discovery/enrichment/probe job reads its work list from here, and every
 * run writes back checked/success/error + a health state, so "which official
 * source is currently broken" is a query rather than a log-grep. That
 * observability is the point: a silently failing committee source is the failure
 * mode this table exists to prevent.
 *
 * Typed against `PrismaClient` (not `PrismaService`) so the batch scripts, which
 * construct their own client outside Nest DI exactly like `sync-hearings.ts`,
 * can use the same repository as the HTTP app. Every table this file touches is
 * GLOBAL (no tenant_id, no RLS), so no tenant scope applies.
 */
import type { PrismaClient } from '@prisma/client';
import type {
  Chamber,
  SourceDescriptor,
  SourceHealth,
  SourceHealthState,
  SourceType,
} from './hearing-discovery.types.js';

export interface CommitteeSourceInput {
  committeeSystemCode: string | null;
  chamber: Chamber;
  sourceType: SourceType;
  sourceUrl: string;
  adapterKey: string;
  priority: number;
  parserVersion?: string | null;
  enabled?: boolean;
}

/**
 * A source that failed but succeeded within this window is DEGRADED (transient
 * upstream blip); one that has not succeeded inside it is FAILING (needs a
 * human/adapter fix). 26h so a once-daily source gets one full cycle of grace
 * before it is called failing.
 */
export const DEGRADED_GRACE_MS = 26 * 60 * 60 * 1000;

export class CommitteeSourceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Idempotent registration. Keyed on the schema's `@@unique([adapterKey,
   * sourceUrl])`, so re-running the seeder never forks a second row for the same
   * official URL. `enabled` is deliberately NOT reset on update: an operator who
   * disabled a broken committee source must not have it silently re-enabled by
   * the next seed run.
   */
  async ensureSource(input: CommitteeSourceInput): Promise<SourceDescriptor> {
    const row = await this.prisma.committeeSource.upsert({
      where: { adapterKey_sourceUrl: { adapterKey: input.adapterKey, sourceUrl: input.sourceUrl } },
      create: {
        committeeSystemCode: input.committeeSystemCode,
        chamber: input.chamber,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        adapterKey: input.adapterKey,
        priority: input.priority,
        parserVersion: input.parserVersion ?? null,
        enabled: input.enabled ?? true,
      },
      update: {
        committeeSystemCode: input.committeeSystemCode,
        chamber: input.chamber,
        sourceType: input.sourceType,
        priority: input.priority,
        parserVersion: input.parserVersion ?? null,
      },
    });
    return toDescriptor(row);
  }

  /** Enabled sources for a job, best-priority first. */
  async listEnabled(filter?: {
    adapterKey?: string;
    chamber?: Chamber;
    sourceType?: SourceType;
    committeeSystemCode?: string;
    oldestCheckedFirst?: boolean;
  }): Promise<SourceDescriptor[]> {
    const rows = await this.prisma.committeeSource.findMany({
      where: {
        enabled: true,
        ...(filter?.adapterKey ? { adapterKey: filter.adapterKey } : {}),
        ...(filter?.chamber ? { chamber: filter.chamber } : {}),
        ...(filter?.sourceType ? { sourceType: filter.sourceType } : {}),
        ...(filter?.committeeSystemCode ? { committeeSystemCode: filter.committeeSystemCode } : {}),
      },
      orderBy: filter?.oldestCheckedFirst
        ? [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { sourceUrl: 'asc' }]
        : [{ priority: 'asc' }, { sourceUrl: 'asc' }],
    });
    return rows.map(toDescriptor);
  }

  /** Every source, enabled or not — the coverage audit needs the disabled ones. */
  async listAll(): Promise<
    Array<
      SourceDescriptor & {
        enabled: boolean;
        sourceHealth: SourceHealthState;
        lastCheckedAt: Date | null;
        lastSuccessAt: Date | null;
        lastError: string | null;
        lastErrorAt: Date | null;
      }
    >
  > {
    const rows = await this.prisma.committeeSource.findMany({
      orderBy: [{ chamber: 'asc' }, { committeeSystemCode: 'asc' }, { priority: 'asc' }],
    });
    return rows.map((r) => ({
      ...toDescriptor(r),
      enabled: r.enabled,
      sourceHealth: r.sourceHealth as SourceHealthState,
      lastCheckedAt: r.lastCheckedAt,
      lastSuccessAt: r.lastSuccessAt,
      lastError: r.lastError,
      lastErrorAt: r.lastErrorAt,
    }));
  }

  /** Stamp an attempt before the fetch, so a hung source still shows as checked. */
  async markChecked(sourceId: string, at: Date): Promise<void> {
    await this.prisma.committeeSource.update({
      where: { id: sourceId },
      data: { lastCheckedAt: at },
    });
  }

  /**
   * Record a run outcome and derive the health state. A success always clears
   * the error text — leaving a stale error behind next to a fresh success is how
   * a source that self-healed keeps looking broken on the coverage dashboard.
   */
  async recordOutcome(
    sourceId: string,
    outcome: SourceHealth,
    at: Date,
    parserVersion?: string | null,
  ): Promise<SourceHealthState> {
    if (outcome.ok) {
      await this.prisma.committeeSource.update({
        where: { id: sourceId },
        data: {
          lastCheckedAt: at,
          lastSuccessAt: at,
          lastError: null,
          lastErrorAt: null,
          sourceHealth: 'healthy',
          ...(parserVersion ? { parserVersion } : {}),
        },
      });
      return 'healthy';
    }
    const current = await this.prisma.committeeSource.findUnique({
      where: { id: sourceId },
      select: { lastSuccessAt: true },
    });
    const recentSuccess =
      current?.lastSuccessAt != null &&
      at.getTime() - current.lastSuccessAt.getTime() <= DEGRADED_GRACE_MS;
    const health: SourceHealthState = recentSuccess ? 'degraded' : 'failing';
    await this.prisma.committeeSource.update({
      where: { id: sourceId },
      data: {
        lastCheckedAt: at,
        lastErrorAt: at,
        // Bounded: an upstream HTML error page must not write a megabyte of
        // markup into the registry row every 10 minutes.
        lastError: (outcome.error ?? 'unknown error').slice(0, 2000),
        sourceHealth: health,
      },
    });
    return health;
  }
}

function toDescriptor(row: {
  id: string;
  committeeSystemCode: string | null;
  chamber: string;
  sourceType: string;
  sourceUrl: string;
  adapterKey: string;
  priority: number;
  parserVersion: string | null;
}): SourceDescriptor {
  return {
    id: row.id,
    committeeSystemCode: row.committeeSystemCode,
    chamber: row.chamber as Chamber,
    sourceType: row.sourceType as SourceType,
    sourceUrl: row.sourceUrl,
    adapterKey: row.adapterKey,
    priority: row.priority,
    parserVersion: row.parserVersion,
  };
}
