import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TANGO_ERROR_KINDS } from './tango.errors.js';
import { TANGO_RESOURCE_TYPES, type TangoResourceType } from './tango.types.js';

/**
 * Provider-owned persistence for MakeGov/Tango — snapshots, crosswalk links,
 * sync checkpoints, and API usage.
 *
 * ── Why this exists before anything syncs ─────────────────────────────────────
 *
 * P15's whole job is to create this substrate BEFORE any data flows, so the
 * shape of "how Capiro stores a Tango observation" is fixed, reviewed and
 * rehearsed independent of any sync logic. Nothing calls this service yet —
 * that starts at P19 (entity shadow sync) — so every method here is exercised
 * only by its own spec until then.
 *
 * ── Every table this service writes is GLOBAL ─────────────────────────────────
 *
 * None of `tango_resource_snapshot`, `tango_resource_link`,
 * `tango_sync_checkpoint`, or `tango_api_usage` carry a `tenantId`, so none are
 * in `PrismaService.tenantScopedModels` and none have RLS. That is correct, not
 * an oversight: a Tango observation is a fact about the federal marketplace, the
 * same category as the existing `federal_grant` / `sam_opportunity` tables. A
 * plain `this.prisma.tangoResourceSnapshot.*` call is therefore the right idiom
 * here — no `withTenant`, no `withSystem`, no `// tenant-scope-exempt:` comment,
 * because there is no tenant dimension for any of those to protect.
 */

// ── Vocabularies, exported so a caller and a test share one source of truth ──

export const LOCAL_LINK_RESOURCE_TYPES = [
  'sam_opportunity',
  'federal_grant',
  'federal_contractor',
  'federal_award',
] as const;
export type LocalLinkResourceType = (typeof LOCAL_LINK_RESOURCE_TYPES)[number];

export const LINK_BASES = ['exact_identifier', 'reviewed_manual'] as const;
export type LinkBasis = (typeof LINK_BASES)[number];

export const LINK_STATUSES = ['active', 'rejected', 'superseded'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const CONFIDENCE_BANDS = ['high', 'medium', 'low'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const CONFLICT_STATES = ['none', 'field_conflict', 'identity_conflict'] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];

export const CHECKPOINT_COMPLETENESS = ['in_progress', 'complete', 'incomplete'] as const;
export type CheckpointCompleteness = (typeof CHECKPOINT_COMPLETENESS)[number];

/** 'success' plus every TangoErrorKind (tango.errors.ts), one shared vocabulary. */
export const USAGE_STATUSES = ['success', ...TANGO_ERROR_KINDS] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

// ── Secret scrubbing ─────────────────────────────────────────────────────────

/** A normalized payload contained something that looks like a credential. */
export class TangoSecretDetectedError extends BadRequestException {
  constructor(path: string) {
    super(
      `Refusing to store this payload: a value at "${path}" looks like a credential. ` +
        'No Tango observation may ever persist a secret-shaped string — fix the mapper ' +
        'that produced this, do not redact and continue.',
    );
  }
}

const SECRET_KEY_NAME = /api[-_]?key|apikey|authorization|token|secret|password|bearer/i;
/** Mirrors the shape-detection half of tango.errors.ts's redaction patterns. */
const SECRET_VALUE_SHAPE = /(?:^|[^0-9a-z])(?:sk|pk|api)[-_][a-z]+[-_][A-Za-z0-9]{16,}|bearer\s+\S{16,}/i;

/**
 * Throws if anything in `value` looks like a credential — by KEY NAME or by
 * VALUE SHAPE. Bounded depth and breadth, same reasoning as
 * `redactUnknown` in tango.errors.ts: a hostile or malformed payload must not
 * hang this check.
 *
 * Deliberately THROWS rather than redacting-and-continuing. Redacting in place
 * would hide the real bug — a secret has no business being in a NORMALIZED
 * domain object at all, since the mapper's allow-list only ever requests
 * business fields. Its presence means something upstream is wrong, and that is
 * worth a loud failure, not a quietly scrubbed field.
 */
export function assertNoSecretsIn(value: unknown, path = '$', depth = 0): void {
  if (depth > 8) return; // matches redactUnknown's bound; deeper than any real payload
  if (typeof value === 'string') {
    if (SECRET_VALUE_SHAPE.test(value)) throw new TangoSecretDetectedError(path);
    return;
  }
  if (Array.isArray(value)) {
    value
      .slice(0, 50)
      .forEach((item, i) => assertNoSecretsIn(item, `${path}[${i}]`, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
      if (SECRET_KEY_NAME.test(key)) throw new TangoSecretDetectedError(`${path}.${key}`);
      assertNoSecretsIn(v, `${path}.${key}`, depth + 1);
    }
  }
}

// ── Canonicalization and hashing ─────────────────────────────────────────────

/**
 * A stable string form of `value`: object keys sorted recursively, array order
 * PRESERVED (array order is data; only key order is provider noise).
 *
 * This is what makes the natural-key duplicate check honest. Two observations
 * of the same content, serialized by the provider (or by our own mapper) in a
 * different key order, must hash IDENTICALLY — otherwise every sync would look
 * like a change even when nothing did.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Lower-case hex SHA-256. Matches the `^[0-9a-f]{64}$` CHECK on both hash columns. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The canonical content hash of a normalized payload. */
export function computeContentHash(normalized: unknown): string {
  return sha256Hex(canonicalize(normalized));
}

/**
 * The canonical fingerprint of a filter object, for `tango_sync_checkpoint`.
 *
 * Exported so every caller (P19, P22, P24, P27) computes it the same way —
 * the checkpoint's whole safety property (different filters never collide,
 * same filters always resume) depends on every caller agreeing on this.
 */
export function computeFilterFingerprint(filters: Record<string, unknown>): string {
  return sha256Hex(canonicalize(filters));
}

// ── Inputs ────────────────────────────────────────────────────────────────────

export interface WriteSnapshotInput {
  resourceType: TangoResourceType;
  externalId: string;
  schemaVersion?: number;
  sourceUpdatedAt: string | null;
  sourceUrl?: string | null;
  normalized: Record<string, unknown>;
}

export interface WriteSnapshotResult {
  id: string;
  version: number;
  contentSha256: string;
  /** FALSE when this exact content already existed — nothing was written. */
  created: boolean;
}

export interface ProposeLinkInput {
  localResourceType: LocalLinkResourceType;
  localResourceId: string;
  tangoResourceType: TangoResourceType;
  tangoExternalId: string;
  basis: LinkBasis;
  confidenceBand: ConfidenceBand;
}

export interface ReviewLinkInput {
  status: LinkStatus;
  reviewedBy: string;
  reviewNotes?: string | null;
}

export interface WriteCheckpointInput {
  syncVerb: string;
  resourceType: TangoResourceType;
  filterFingerprint: string;
  cursor?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  completeness?: CheckpointCompleteness;
  rowsProcessed?: number;
}

export interface RecordUsageInput {
  callFamily: string;
  status: UsageStatus;
  rowCount?: number | null;
  rateLimitRemaining?: number | null;
  rateLimitLimit?: number | null;
  rateLimitResetIn?: number | null;
  durationMs: number;
  /** Defaults to now, truncated to the minute. Overridable only for tests. */
  at?: Date;
}

function assertKnownResourceType(value: string): TangoResourceType {
  if (!(TANGO_RESOURCE_TYPES as readonly string[]).includes(value)) {
    throw new BadRequestException(
      `Unknown Tango resource type "${value}". Known types: ${TANGO_RESOURCE_TYPES.join(', ')}`,
    );
  }
  return value as TangoResourceType;
}

function assertKnownLocalType(value: string): LocalLinkResourceType {
  if (!(LOCAL_LINK_RESOURCE_TYPES as readonly string[]).includes(value)) {
    throw new BadRequestException(
      `Unsupported local resource type "${value}" for a Tango link. Only global reference ` +
        `tables may be linked: ${LOCAL_LINK_RESOURCE_TYPES.join(', ')}. A tenant-owned ` +
        'resource is never valid here.',
    );
  }
  return value as LocalLinkResourceType;
}

/** Truncate to the minute, UTC. Matches `timestamp_bucket`'s purpose: cheap aggregation. */
function minuteBucket(at: Date): Date {
  const bucketed = new Date(at);
  bucketed.setUTCSeconds(0, 0);
  return bucketed;
}

@Injectable()
export class TangoStoreService {
  private readonly logger = new Logger(TangoStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Snapshots ────────────────────────────────────────────────────────────

  /**
   * Write one observation, honoring the versioned-head policy.
   *
   * 1. Compute the canonical content hash.
   * 2. If a row with this EXACT (resourceType, externalId, contentSha256)
   *    already exists — a true no-op. Nothing is written, not even a
   *    timestamp; the observation row is immutable once created.
   * 3. Otherwise, in one transaction: supersede the current active row (if
   *    any) and insert the new one as the active head, versioned one past it.
   */
  async writeSnapshot(input: WriteSnapshotInput): Promise<WriteSnapshotResult> {
    assertKnownResourceType(input.resourceType);
    assertNoSecretsIn(input.normalized);
    const contentSha256 = computeContentHash(input.normalized);
    const providerFetchedAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tangoResourceSnapshot.findUnique({
        where: {
          resourceType_externalId_contentSha256: {
            resourceType: input.resourceType,
            externalId: input.externalId,
            contentSha256,
          },
        },
        select: { id: true, version: true },
      });
      if (existing) {
        return { id: existing.id, version: existing.version, contentSha256, created: false };
      }

      const currentHead = await tx.tangoResourceSnapshot.findFirst({
        where: { resourceType: input.resourceType, externalId: input.externalId, active: true },
        select: { id: true, version: true },
      });
      if (currentHead) {
        await tx.tangoResourceSnapshot.update({
          where: { id: currentHead.id },
          data: { active: false, supersededAt: providerFetchedAt },
        });
      }

      const created = await tx.tangoResourceSnapshot.create({
        data: {
          resourceType: input.resourceType,
          externalId: input.externalId,
          schemaVersion: input.schemaVersion ?? 1,
          sourceUpdatedAt: input.sourceUpdatedAt ? new Date(input.sourceUpdatedAt) : null,
          providerFetchedAt,
          sourceUrl: input.sourceUrl ?? null,
          contentSha256,
          normalizedJsonb: input.normalized as object,
          active: true,
          version: (currentHead?.version ?? 0) + 1,
        },
        select: { id: true, version: true },
      });
      return { id: created.id, version: created.version, contentSha256, created: true };
    });
  }

  /** The current head for one resource, or null if it has never been observed. */
  async getActiveSnapshot(resourceType: TangoResourceType, externalId: string) {
    return this.prisma.tangoResourceSnapshot.findFirst({
      where: { resourceType, externalId, active: true },
    });
  }

  /** Every observation of one resource, oldest first — the full change history. */
  async getSnapshotHistory(resourceType: TangoResourceType, externalId: string) {
    return this.prisma.tangoResourceSnapshot.findMany({
      where: { resourceType, externalId },
      orderBy: { version: 'asc' },
    });
  }

  // ── Links ────────────────────────────────────────────────────────────────

  /**
   * Propose a link. Idempotent, and NEVER resurrects a rejected one.
   *
   * If the exact (local, tango) pair already has a row — active, rejected, or
   * superseded — this returns that row UNCHANGED. Automated crosswalk code
   * (P27) calls this; it must never be the thing that undoes a human's
   * rejection. Only {@link reviewLink}, an explicit human action, may change an
   * existing row's status.
   */
  async proposeLink(input: ProposeLinkInput) {
    assertKnownLocalType(input.localResourceType);
    assertKnownResourceType(input.tangoResourceType);

    const existing = await this.prisma.tangoResourceLink.findUnique({
      where: {
        localResourceType_localResourceId_tangoResourceType_tangoExternalId: {
          localResourceType: input.localResourceType,
          localResourceId: input.localResourceId,
          tangoResourceType: input.tangoResourceType,
          tangoExternalId: input.tangoExternalId,
        },
      },
    });
    if (existing) return existing;

    return this.prisma.tangoResourceLink.create({
      data: {
        localResourceType: input.localResourceType,
        localResourceId: input.localResourceId,
        tangoResourceType: input.tangoResourceType,
        tangoExternalId: input.tangoExternalId,
        basis: input.basis,
        confidenceBand: input.confidenceBand,
        status: 'active',
        conflictState: 'none',
      },
    });
  }

  /**
   * An explicit human review decision on an EXISTING link. Always stamps the
   * actor and timestamp — the CHECK constraint requires both whenever `status`
   * is 'rejected', but this stamps them for every transition, not only that
   * one, so "who reviewed this last" is always answerable.
   *
   * Unlike {@link proposeLink}, this MAY move a rejected link back to active.
   * That distinction is deliberate: durability protects a human decision from
   * being silently overwritten by AUTOMATION, not from being deliberately
   * corrected by a human who reviews it again.
   */
  async reviewLink(linkId: string, input: ReviewLinkInput) {
    return this.prisma.tangoResourceLink.update({
      where: { id: linkId },
      data: {
        status: input.status,
        reviewedBy: input.reviewedBy,
        reviewedAt: new Date(),
        reviewNotes: input.reviewNotes ?? null,
      },
    });
  }

  async findLinksForTangoResource(tangoResourceType: TangoResourceType, tangoExternalId: string) {
    return this.prisma.tangoResourceLink.findMany({
      where: { tangoResourceType, tangoExternalId },
    });
  }

  // ── Checkpoints ──────────────────────────────────────────────────────────

  async readCheckpoint(syncVerb: string, resourceType: TangoResourceType, filterFingerprint: string) {
    return this.prisma.tangoSyncCheckpoint.findUnique({
      where: { syncVerb_resourceType_filterFingerprint: { syncVerb, resourceType, filterFingerprint } },
    });
  }

  /**
   * Create-or-update the checkpoint for one (verb, resource, filter) walk.
   *
   * `rowsProcessed` ADDS to the existing count on update rather than replacing
   * it — a checkpoint write happens once per page, and each call reports that
   * page's row count, not the running total.
   */
  async writeCheckpoint(input: WriteCheckpointInput) {
    assertKnownResourceType(input.resourceType);
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tangoSyncCheckpoint.findUnique({
        where: {
          syncVerb_resourceType_filterFingerprint: {
            syncVerb: input.syncVerb,
            resourceType: input.resourceType,
            filterFingerprint: input.filterFingerprint,
          },
        },
      });
      if (!existing) {
        return tx.tangoSyncCheckpoint.create({
          data: {
            syncVerb: input.syncVerb,
            resourceType: input.resourceType,
            filterFingerprint: input.filterFingerprint,
            cursor: input.cursor ?? null,
            windowStart: input.windowStart ? new Date(input.windowStart) : null,
            windowEnd: input.windowEnd ? new Date(input.windowEnd) : null,
            completeness: input.completeness ?? 'in_progress',
            rowsProcessed: input.rowsProcessed ?? 0,
            lastRunAt: now,
          },
        });
      }
      return tx.tangoSyncCheckpoint.update({
        where: { id: existing.id },
        data: {
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          ...(input.windowStart !== undefined
            ? { windowStart: input.windowStart ? new Date(input.windowStart) : null }
            : {}),
          ...(input.windowEnd !== undefined
            ? { windowEnd: input.windowEnd ? new Date(input.windowEnd) : null }
            : {}),
          ...(input.completeness !== undefined ? { completeness: input.completeness } : {}),
          rowsProcessed: existing.rowsProcessed + (input.rowsProcessed ?? 0),
          lastRunAt: now,
        },
      });
    });
  }

  // ── Usage ────────────────────────────────────────────────────────────────

  /**
   * Record one call's outcome.
   *
   * Built field-by-field from a narrowly-typed input rather than by spreading
   * the caller's object — a caller that widened its own local type to include
   * a header or a key cannot get it into this table by accident, because
   * nothing here ever forwards an unlisted field to Prisma.
   */
  async recordUsage(input: RecordUsageInput) {
    if (!(USAGE_STATUSES as readonly string[]).includes(input.status)) {
      throw new BadRequestException(
        `Unknown usage status "${input.status}". Known values: ${USAGE_STATUSES.join(', ')}`,
      );
    }
    return this.prisma.tangoApiUsage.create({
      data: {
        callFamily: input.callFamily,
        timestampBucket: minuteBucket(input.at ?? new Date()),
        status: input.status,
        rowCount: input.rowCount ?? null,
        rateLimitRemaining: input.rateLimitRemaining ?? null,
        rateLimitLimit: input.rateLimitLimit ?? null,
        rateLimitResetIn: input.rateLimitResetIn ?? null,
        durationMs: input.durationMs,
      },
    });
  }
}
