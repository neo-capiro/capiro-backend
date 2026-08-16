import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { CanonicalSourceAdapterService } from './canonical-source-adapter.service.js';
import type {
  CanonicalSourceSyncResult,
  CanonicalSourceSyncStatus,
  ClientIdentitySource,
  ClientPersonIdentitySource,
  ConfirmedClientMappingIdentitySource,
  EngagementContactIdentitySource,
} from './canonical-source-adapter.types.js';
import { CanonicalSourceBackfillRepository } from './canonical-source-backfill.repository.js';
import type {
  CanonicalBackfillSource,
  CanonicalSourceBackfillOptions,
  CanonicalSourceBackfillPageResult,
} from './canonical-source-backfill.types.js';
import {
  CanonicalEntityBackfillCheckpointRepository,
  type CanonicalEntityBackfillCheckpointRecord,
} from './canonical-entity-backfill-checkpoint.repository.js';

type CanonicalBackfillRecord =
  | ConfirmedClientMappingIdentitySource
  | ClientIdentitySource
  | ClientPersonIdentitySource
  | EngagementContactIdentitySource;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const ALL_STATUSES: CanonicalSourceSyncStatus[] = [
  'linked',
  'created',
  'ambiguous',
  'skipped',
  'would_link',
  'would_create',
  'failed',
];

export interface CanonicalSourceBackfillRunToCompletionOptions
  extends Omit<CanonicalSourceBackfillOptions, 'afterId'> {
  /** Bounds how many pages one invocation processes before returning; omit to run to completion or failure. */
  maxPages?: number;
}

export interface CanonicalSourceBackfillRunToCompletionResult {
  pages: CanonicalSourceBackfillPageResult[];
  checkpoint: CanonicalEntityBackfillCheckpointRecord;
}

/** Runs one bounded, keyset-paginated canonical-source backfill page. */
@Injectable()
export class CanonicalSourceBackfillService {
  constructor(
    private readonly repository: CanonicalSourceBackfillRepository,
    private readonly adapter: CanonicalSourceAdapterService,
    @Optional() private readonly checkpoints?: CanonicalEntityBackfillCheckpointRepository,
  ) {}

  /**
   * Durable, resumable driver over {@link runPage}: reads the last persisted
   * checkpoint cursor for (tenantId, source) — resuming a prior run rather
   * than restarting it — then loops bounded pages, persisting the checkpoint
   * after each one, until the source is exhausted, a page fails, or
   * `maxPages` is reached. A checkpoint already 'completed' is a no-op so a
   * later invocation can never re-run a finished source from scratch.
   */
  async runToCompletion(
    tenantId: string,
    options: CanonicalSourceBackfillRunToCompletionOptions,
  ): Promise<CanonicalSourceBackfillRunToCompletionResult> {
    if (!this.checkpoints) {
      throw new BadRequestException(
        'runToCompletion requires a CanonicalEntityBackfillCheckpointRepository.',
      );
    }

    const existing = await this.checkpoints.startOrResume(tenantId, options.source);
    if (existing.status === 'completed') {
      return { pages: [], checkpoint: existing };
    }

    const pages: CanonicalSourceBackfillPageResult[] = [];
    let cursor = existing.cursor;
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    let checkpoint = existing;

    for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
      const page = await this.runPage(tenantId, { ...options, afterId: cursor });
      pages.push(page);

      const firstFailure = page.failures[0];
      checkpoint = await this.checkpoints.recordPage(tenantId, options.source, {
        nextCursor: page.nextCursor,
        scanned: page.scanned,
        created: page.counts.created,
        linked: page.counts.linked,
        ambiguous: page.counts.ambiguous,
        skipped: page.counts.skipped,
        failed: page.counts.failed,
        complete: page.complete,
        errorMessage: firstFailure
          ? `${firstFailure.sourceKind}:${firstFailure.sourceId}:${firstFailure.errorCode}`
          : null,
      });

      cursor = page.nextCursor;
      if (page.complete || firstFailure) break;
    }

    return { pages, checkpoint };
  }

  async runPage(
    tenantId: string,
    options: CanonicalSourceBackfillOptions,
  ): Promise<CanonicalSourceBackfillPageResult> {
    const limit = normalizeLimit(options.limit);
    const afterId = options.afterId?.trim() || null;
    const records = await this.loadRecords(
      tenantId,
      options.source,
      afterId,
      limit,
    );
    const results: CanonicalSourceSyncResult[] = [];
    const failures: CanonicalSourceBackfillPageResult['failures'] = [];
    let lastProcessedId = afterId;
    let haltedOnFailure = false;

    // Deliberately sequential. Identity writes are small, and serial execution
    // makes unique-identifier conflict behavior deterministic during backfill.
    for (const record of records) {
      try {
        results.push(
          await this.syncRecord(options.source, record, {
            dryRun: options.dryRun ?? false,
            actorUserId: options.actorUserId ?? null,
          }),
        );
        lastProcessedId = record.id;
      } catch (error) {
        results.push({
          sourceKind: options.source,
          sourceId: record.id,
          status: 'failed',
          entityId: null,
          resolutionId: null,
          candidates: [],
          reason: errorCode(error),
        });
        failures.push({
          sourceKind: options.source,
          sourceId: record.id,
          errorCode: errorCode(error),
        });
        haltedOnFailure = true;
        break;
      }
    }

    const counts = Object.fromEntries(
      ALL_STATUSES.map((status) => [
        status,
        results.filter((result) => result.status === status).length,
      ]),
    ) as Record<CanonicalSourceSyncStatus, number>;
    const nextCursor = haltedOnFailure
      ? lastProcessedId
      : records.length === limit
        ? records.at(-1)?.id ?? null
        : null;

    return {
      tenantId,
      source: options.source,
      dryRun: options.dryRun ?? false,
      scanned: results.length,
      counts,
      failures,
      nextCursor,
      complete: !haltedOnFailure && nextCursor === null,
    };
  }

  private async loadRecords(
    tenantId: string,
    source: CanonicalBackfillSource,
    afterId: string | null,
    limit: number,
  ): Promise<CanonicalBackfillRecord[]> {
    switch (source) {
      case 'confirmed_client_mapping':
        return this.repository.listConfirmedClientMappings(
          tenantId,
          afterId,
          limit,
        );
      case 'client':
        return this.repository.listClients(tenantId, afterId, limit);
      case 'client_person':
        return this.repository.listClientPeople(tenantId, afterId, limit);
      case 'engagement_contact':
        return this.repository.listEngagementContacts(
          tenantId,
          afterId,
          limit,
        );
    }
  }

  private async syncRecord(
    source: CanonicalBackfillSource,
    record: CanonicalBackfillRecord,
    options: { dryRun: boolean; actorUserId: string | null },
  ): Promise<CanonicalSourceSyncResult> {
    switch (source) {
      case 'confirmed_client_mapping':
        return this.adapter.syncConfirmedClientMapping(
          record as ConfirmedClientMappingIdentitySource,
          options,
        );
      case 'client':
        return this.adapter.syncClient(record as ClientIdentitySource, options);
      case 'client_person':
        return this.adapter.syncClientPerson(
          record as ClientPersonIdentitySource,
          options,
        );
      case 'engagement_contact':
        return this.adapter.syncEngagementContact(
          record as EngagementContactIdentitySource,
          options,
        );
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  const candidate = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_LIMIT) {
    throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return candidate;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return 'CanonicalSourceBackfillError';
}
