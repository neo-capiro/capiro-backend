import { federalHearingWhere } from './hearing-geography.js';
import { resolveCanonicalHearingId } from './hearing-alias.js';
/**
 * `committee_hearing` persistence for the canonical reconciler.
 *
 * Owns the two operations that decide whether Phase 3 produces one canonical
 * hearing per official event or a pile of duplicates:
 *
 *   1. {@link resolveHearingId} — walk the deterministic match ladder from
 *      `hearing-identity.ts` and return the FIRST existing row that matches, so
 *      a Senate hearing already published by Congress.gov as `cm-119-{eventId}`
 *      is recognized rather than re-created under a synthetic `sen-...` id.
 *   2. {@link applyProjection} — write the projection additively inside one
 *      transaction together with its `committee_site_update` signals, so a
 *      crash can never leave a bumped `source_revision` with no matching change
 *      feed entry (or the reverse).
 *
 * Existing row ids are NEVER rewritten. A reschedule/cancellation updates the
 * same row; nothing here deletes or replaces a canonical hearing.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import {
  canonicalHearingId,
  clockKey,
  displayChamber,
  matchKeys,
  normalizeEventType,
  normalizedTitleKey,
} from './hearing-identity.js';
import {
  legacyOwnedId,
  planCanonicalWrite,
  type CanonicalWritePlan,
  type ExistingHearing,
  type ProjectedHearing,
} from './canonical-diff.js';
import { ET_ZONE } from './hearing-time.js';
import {
  committeeUpdateStatementTime,
  lockCommitteeUpdateStreams,
} from './committee-update-serialization.js';
import { recordFederalCalendar } from './federal-calendar-transition.js';
import type { CommitteeUpdateObservation, SourceEvent } from './hearing-discovery.types.js';

/**
 * Which ladder rung matched, for the run report and the reconciler tests.
 *
 * `observation` is the strongest rung and is resolved by the RECONCILER, not
 * here: it means this source had already reported this external event id and we
 * had already linked it. The rest are the structural ladder in
 * `hearing-identity.matchKeys`, in descending confidence.
 */
export type MatchOutcome =
  | { kind: 'observation' | 'id' | 'natural' | 'day' | 'title'; hearingId: string }
  | { kind: 'new'; hearingId: string };

export interface ApplyProjectionResult {
  hearingId: string;
  created: boolean;
  plan: CanonicalWritePlan;
  /** Site-update rows actually inserted (post-dedupe). */
  updatesInserted: number;
}

/** Columns the reconciler reads back for diffing. */
const EXISTING_SELECT = {
  id: true,
  geographicJurisdiction: true,
  congress: true,
  chamber: true,
  committeeName: true,
  committeeCode: true,
  committeeSystemCode: true,
  subcommitteeSystemCode: true,
  title: true,
  type: true,
  date: true,
  startsAt: true,
  time: true,
  timezone: true,
  location: true,
  url: true,
  witnesses: true,
  eventStatus: true,
  visibility: true,
  sourceRevision: true,
  lastOfficialUpdateAt: true,
  streamAvailability: true,
  coverageStatus: true,
} as const;

export class CanonicalHearingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  resolveAlias(hearingId: string): Promise<string> {
    return resolveCanonicalHearingId(this.prisma, hearingId);
  }

  /**
   * Resolve an observed event to an existing canonical hearing, or report that
   * it is new. Walks the ladder in confidence order and stops at the first hit;
   * the weakest rung (normalized title) still requires the same chamber,
   * committee and calendar day, so it can never merge two unrelated events.
   */
  async resolveHearingId(event: SourceEvent, adapterKey: string): Promise<MatchOutcome> {
    for (const key of matchKeys(event, adapterKey)) {
      if (key.kind === 'id' && key.id) {
        const hit = await this.prisma.committeeHearing.findUnique({
          where: { id: key.id },
          select: { id: true, chamber: true, geographicJurisdiction: true },
        });
        if (
          hit &&
          (hit.chamber !== displayChamber(event.chamber) ||
            (hit.geographicJurisdiction && hit.geographicJurisdiction !== 'US'))
        )
          throw new Error('Official hearing ID is occupied by a different scope');
        if (
          hit &&
          hit.chamber === displayChamber(event.chamber) &&
          (!hit.geographicJurisdiction || hit.geographicJurisdiction === 'US')
        )
          return { kind: 'id', hearingId: await this.resolveAlias(hit.id) };
        continue;
      }
      const p = key.predicate;
      if (!p) continue;
      const where: Prisma.CommitteeHearingWhereInput = {
        chamber: p.chamber,
        date: p.calendarDate,
      };
      // Match on the system code when we have one, else fall back to the
      // display name — a committee-site source often has only the name.
      if (p.committeeSystemCode) {
        where.OR = [
          { committeeSystemCode: p.committeeSystemCode },
          { committeeCode: p.committeeSystemCode },
        ];
      } else if (p.committeeName) {
        where.committeeName = p.committeeName;
      }
      const rows = await this.prisma.committeeHearing.findMany({
        where: federalHearingWhere(where),
        select: { id: true, startsAt: true, title: true },
        // Bounded: a committee never holds this many events in one day, and an
        // unbounded scan on a bad predicate must not read the table.
        take: 50,
      });
      const hit = rows.find((row) => {
        if (key.kind === 'natural')
          return p.clock !== undefined && clockKey(row.startsAt) === p.clock;
        if (key.kind === 'title') return normalizedTitleKey(row.title) === p.titleKey;
        // 'day': a single event that day for this committee is an unambiguous
        // match; two or more is ambiguous and must fall through to the title
        // rung rather than pick one arbitrarily.
        return rows.length === 1;
      });
      if (hit) return { kind: key.kind, hearingId: hit.id };
    }
    return { kind: 'new', hearingId: canonicalHearingId(event, adapterKey) };
  }

  async loadExisting(hearingId: string): Promise<ExistingHearing | null> {
    const row = await this.prisma.committeeHearing.findUnique({
      where: { id: hearingId },
      select: EXISTING_SELECT,
    });
    if (!row) return null;
    return { ...row, witnesses: row.witnesses ?? [] };
  }

  /**
   * Write the projection for one hearing. Creates the row when it does not
   * exist; otherwise applies only the additive patch the diff produced. The
   * canonical write and its change-feed rows share ONE transaction.
   */
  async applyProjection(
    hearingId: string,
    projected: ProjectedHearing,
    opts: { now: Date; sourceUrl: string; parserVersion: string; sourceId?: string | null },
  ): Promise<ApplyProjectionResult> {
    let existing = await this.loadExisting(hearingId);
    let plan = planCanonicalWrite(existing, projected, opts);

    // A brand-new row needs a calendar day; the column is NOT NULL and a
    // fabricated one would file the event under the wrong day forever.
    if (!existing && !projected.calendarDate) {
      throw new Error(
        `refusing to create canonical hearing ${hearingId} with no observed calendar date`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (process.env.LEGIWATCH_CALENDAR_TRANSITIONS_ENABLED === 'true') {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hearingId},0))`;
        existing = await tx.committeeHearing.findUnique({
          where: { id: hearingId },
          select: EXISTING_SELECT,
        });
        plan = planCanonicalWrite(existing, projected, opts);
      }
      let created = false;
      if (existing?.geographicJurisdiction && existing.geographicJurisdiction !== 'US')
        throw new Error('Federal projection cannot update a state event');
      if (!existing) {
        await tx.committeeHearing.create({
          data: {
            id: hearingId,
            geographicJurisdiction: 'US',
            chamber: displayChamber(projected.chamber),
            committeeName: projected.committeeName ?? 'Unknown committee',
            committeeCode: projected.committeeSystemCode,
            title: projected.title ?? '(untitled)',
            date: projected.calendarDate as Date,
            time: projected.displayTime,
            startsAt: projected.startsAt,
            timezone: projected.timeZone ?? ET_ZONE,
            location: projected.location,
            type: normalizeEventType(projected.eventType),
            witnesses: projected.witnesses,
            url: projected.officialPageUrl,
            congress: projected.congress,
            committeeSystemCode: projected.committeeSystemCode,
            subcommitteeSystemCode: projected.subcommitteeSystemCode,
            visibility: projected.visibility ?? 'public',
            eventStatus: projected.eventStatus ?? 'scheduled',
            lastOfficialUpdateAt: projected.lastOfficialUpdateAt,
            coverageStatus: 'discovered',
            syncedAt: opts.now,
          },
        });
        created = true;
      } else if (Object.keys(plan.patch).length > 0) {
        await tx.committeeHearing.update({
          where: { id: hearingId },
          data: { ...plan.patch, geographicJurisdiction: 'US', syncedAt: opts.now },
        });
      }
      if (existing && process.env.LEGIWATCH_CALENDAR_TRANSITIONS_ENABLED === 'true') {
        const scoped = await tx.committeeHearing.findUniqueOrThrow({
          where: { id: hearingId },
          select: { geographicJurisdiction: true },
        });
        if (scoped.geographicJurisdiction === null)
          await tx.committeeHearing.update({
            where: { id: hearingId },
            data: { geographicJurisdiction: 'US' },
          });
        else if (scoped.geographicJurisdiction !== 'US')
          throw new Error('Federal projection cannot update a state event');
      }

      // The plan's updates were built before the row existed, so back-fill the
      // hearing id here rather than leaving a dangling change-feed row.
      const updates = plan.updates.map((u) => ({ ...u, hearingId: u.hearingId ?? hearingId }));
      const updatesInserted = await insertSiteUpdates(tx, updates, opts.now, opts.sourceId ?? null);
      if (process.env.LEGIWATCH_CALENDAR_TRANSITIONS_ENABLED === 'true')
        await recordFederalCalendar(tx, hearingId, projected, opts);
      return { created, updatesInserted };
    });

    return { hearingId, created: result.created, plan, updatesInserted: result.updatesInserted };
  }

  /**
   * Recompute `stream_availability` from this hearing's candidate rows. Kept as
   * a denormalized rollup (Phase 2's design) so the calendar can filter on
   * stream state without joining candidates per row.
   *
   * Phase 3 only ever asserts the three states discovery can honestly know:
   * `none` (looked, found nothing), `embedded_third_party` (an official page
   * embeds someone else's player), and `live_only` (a first-party media URL was
   * advertised). Promoting a hearing to `archived` is Phase 4's archive
   * reconciliation, and the true LIVE/READY states belong to the resolver.
   */
  async refreshStreamAvailability(hearingId: string): Promise<string> {
    const candidates = await this.prisma.hearingStreamCandidate.findMany({
      where: { hearingId },
      select: { mediaUrl: true, mediaType: true, provider: true, capturePolicy: true },
    });
    let availability = 'unknown';
    if (candidates.length === 0) {
      availability = 'none';
    } else if (candidates.some((c) => c.mediaUrl && c.capturePolicy !== 'BLOCKED')) {
      availability = 'live_only';
    } else {
      availability = 'embedded_third_party';
    }
    await this.prisma.committeeHearing.update({
      where: { id: hearingId },
      data: { streamAvailability: availability },
    });
    return availability;
  }

  /** True when `sync-hearings.ts` owns this row's legacy display columns. */
  isLegacyOwned(hearingId: string): boolean {
    return legacyOwnedId(hearingId);
  }
}

/**
 * Insert change-feed rows, skipping any whose `contentHash` is already present
 * for the same committee — the dedupe that keeps a 10-minute scraper from
 * re-announcing an unchanged fact 144 times a day. `lastSeenAt` is refreshed on
 * a duplicate so "we still see this" stays true without a new row.
 */
async function insertSiteUpdates(
  tx: Prisma.TransactionClient,
  updates: CommitteeUpdateObservation[],
  now: Date,
  sourceId: string | null,
): Promise<number> {
  // Follow initialization takes the same ordered advisory locks before it
  // records its alert boundary. This removes the invisible late-commit window:
  // either these rows commit before the boundary scan, or their persisted
  // timestamp is established after the follow transaction releases the lock.
  await lockCommitteeUpdateStreams(
    tx,
    updates.map((update) => update.committeeSystemCode),
  );
  let inserted = 0;
  for (const u of updates) {
    const existing = await tx.committeeSiteUpdate.findFirst({
      where: { committeeSystemCode: u.committeeSystemCode, contentHash: u.contentHash },
      select: { id: true },
    });
    if (existing) {
      await tx.committeeSiteUpdate.update({
        where: { id: existing.id },
        data: { lastSeenAt: now },
      });
      continue;
    }
    const persistedAt = await committeeUpdateStatementTime(tx);
    await tx.committeeSiteUpdate.create({
      data: {
        committeeSystemCode: u.committeeSystemCode,
        hearingId: u.hearingId ?? null,
        updateType: u.updateType,
        normalizedTitle: u.normalizedTitle,
        normalizedSummary: u.normalizedSummary ?? null,
        sourceUrl: u.sourceUrl,
        officialPublishedAt: u.officialPublishedAt ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        // Prisma's database default is transaction_timestamp(). A producer can
        // begin before a follow, wait on the stream lock, and commit afterward;
        // use the post-lock database clock as the durable alert-order marker.
        createdAt: persistedAt,
        contentHash: u.contentHash,
        previousValue: u.previousValue ?? null,
        newValue: u.newValue ?? null,
        sourceId,
        parserVersion: u.parserVersion ?? null,
      },
    });
    inserted += 1;
  }
  return inserted;
}

export { insertSiteUpdates };
