/** Restore official-ID observations that the historical committee/day matcher
 * attached to another numbered event. Dry-run by default; apply requires the
 * exact inventory hash. Source observations and change history are retained. */
import { PrismaClient, type Prisma } from '@prisma/client';
import { contentHash } from '../src/hearing-discovery/hearing-identity.js';
import { deserializeEvent } from '../src/hearing-discovery/hearing-observation.repository.js';
import { CanonicalHearingRepository } from '../src/hearing-discovery/canonical-hearing.repository.js';
import {
  projectCanonical,
  planCanonicalWrite,
  type ProjectableObservation,
  type ProjectedHearing,
} from '../src/hearing-discovery/canonical-diff.js';
import type { SourceEvent } from '../src/hearing-discovery/hearing-discovery.types.js';
import { storedCommitteeIdentity } from '../src/hearing-discovery/hearing-committee-identity.js';

/** A reviewed identity repair must clear values borrowed from a different
 * event, including a subcommittee that the real event never had. Routine
 * ingestion's fill-only contract deliberately does not have this authority. */
export function identityRepairPatch(projected: ProjectedHearing) {
  if (!projected.title || !projected.calendarDate || !projected.officialPageUrl)
    throw new Error('Identity repair requires an independently retained title, date and URL');
  const committee = storedCommitteeIdentity(projected);
  return {
    title: projected.title,
    date: projected.calendarDate,
    startsAt: projected.startsAt,
    time: projected.displayTime,
    timezone: projected.timeZone ?? 'America/New_York',
    location: projected.location,
    url: projected.officialPageUrl,
    committeeName: projected.committeeName ?? undefined,
    committeeCode: committee.committeeSystemCode,
    ...committee,
  };
}

export async function repairOfficialObservations(prisma: PrismaClient, expectedHash?: string) {
  return prisma.$transaction(
    async (tx) => {
      if (!expectedHash) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
      await tx.$executeRawUnsafe("SET LOCAL app.bypass_rls='on'");
      if (expectedHash) {
        // Short, atomic writer fence. Failure to acquire it aborts the repair.
        await tx.$executeRawUnsafe(
          'LOCK TABLE committee_hearing, hearing_source_observation IN SHARE ROW EXCLUSIVE MODE',
        );
      }
      const conflicts = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT o.id FROM hearing_source_observation o JOIN committee_source s ON s.id=o.source_id
      WHERE s.adapter_key IN ('congress-gov','senate-schedule','house-repository')
        AND o.external_event_id ~ '^[0-9]+$' AND o.hearing_id ~ '^(cm|sen)-[0-9]+-[0-9]+$'
        AND split_part(o.hearing_id,'-',3)<>o.external_event_id ORDER BY o.id`;
      if (conflicts.length > 100)
        throw new Error('More than 100 conflicts require a separate review');
      const rows = await tx.hearingSourceObservation.findMany({
        where: { id: { in: conflicts.map((x) => x.id) } },
        include: { source: true },
        orderBy: { id: 'asc' },
      });
      const scoped = new Proxy(tx, {
        get(target, key) {
          if (key === '$transaction')
            return (fn: (inner: Prisma.TransactionClient) => unknown) => fn(tx);
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as unknown as PrismaClient;
      const repository = new CanonicalHearingRepository(scoped);
      const moves: Array<{ id: string; from: string; to: string }> = [];
      for (const row of rows) {
        const raw = (row.sourceMetadata as { event?: Parameters<typeof deserializeEvent>[0] })
          .event;
        const event = deserializeEvent(raw);
        if (raw?.externalEventId !== row.externalEventId || !event.congress || !event.chamber)
          throw new Error(`Unqualified retained identity: ${row.id}`);
        const typed = { ...event, externalEventId: row.externalEventId } as SourceEvent;
        const target = await repository.resolveHearingId(typed, row.source.adapterKey);
        const targetParts = /^(cm|sen)-(\d+)-(\d+)$/.exec(target.hearingId);
        if (
          !targetParts ||
          targetParts[2] !== String(event.congress) ||
          targetParts[3] !== row.externalEventId
        )
          throw new Error(`Unqualified target: ${row.id}`);
        if (!row.hearingId || row.hearingId === target.hearingId)
          throw new Error('Conflict inventory changed');
        moves.push({ id: row.id, from: row.hearingId, to: target.hearingId });
      }
      const ids = [...new Set(moves.flatMap((m) => [m.from, m.to]))].sort();
      const observations = await tx.hearingSourceObservation.findMany({
        where: { hearingId: { in: ids } },
        include: { source: true },
        orderBy: { id: 'asc' },
      });
      const existing = await tx.committeeHearing.findMany({
        where: { id: { in: ids } },
        orderBy: { id: 'asc' },
      });
      const planHash = contentHash({ moves, observations, existing });
      if (expectedHash && expectedHash !== planHash)
        throw new Error('Inventory changed; review a new dry run');
      const now = new Date();
      const projections = [];
      for (const id of ids) {
        const selected = observations.filter(
          (o) => (moves.find((m) => m.id === o.id)?.to ?? o.hearingId) === id,
        );
        if (!selected.length) throw new Error(`No independent source remains for ${id}`);
        const facts = selected.map((o) => {
          const event = deserializeEvent(
            (o.sourceMetadata as { event?: Parameters<typeof deserializeEvent>[0] }).event,
          );
          return {
            ...event,
            sourceId: o.sourceId,
            adapterKey: o.source.adapterKey,
            sourcePriority: o.source.priority,
            lastSeenAt: o.lastSeenAt,
            sourceUpdatedAt: o.sourceUpdatedAt,
          } as ProjectableObservation;
        });
        const projected = projectCanonical(facts);
        Object.assign(projected, storedCommitteeIdentity(projected));
        const prior = await repository.loadExisting(id);
        // Completion can be recorded by the lifecycle owner after the retained
        // schedule notice. Moving a source identity is not a new announcement.
        if (prior?.eventStatus === 'completed' && projected.eventStatus === 'scheduled')
          projected.eventStatus = 'completed';
        const repairPatch = identityRepairPatch(projected);
        const opts = {
          now,
          sourceUrl: projected.officialPageUrl ?? selected[0]!.source.sourceUrl,
          parserVersion: 'official-id-repair-20261005',
        };
        const plan = planCanonicalWrite(prior, projected, opts);
        projections.push({
          id,
          projected,
          opts,
          patch: plan.patch,
          changedFields: plan.changedFields,
          repairPatch,
          before: prior,
        });
      }
      if (expectedHash) {
        for (const move of moves)
          await tx.hearingSourceObservation.update({
            where: { id: move.id },
            data: { hearingId: move.to },
          });
        for (const item of projections) {
          await repository.applyProjection(item.id, item.projected, item.opts);
          await tx.committeeHearing.update({
            where: { id: item.id },
            data: item.repairPatch,
          });
        }
      }
      return {
        mode: expectedHash ? 'applied' : 'dry-run',
        planHash,
        moves,
        projections: projections.map(({ id, patch, changedFields, repairPatch, before }) => ({
          id,
          patch,
          changedFields,
          repairPatch,
          before,
        })),
      };
    },
    { timeout: 120000, isolationLevel: 'Serializable' },
  );
}
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/repair-official-hearing-observations.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }

const args = process.argv.slice(2),
    apply = args.includes('--apply'),
    i = args.indexOf('--plan-hash');
const expected = i >= 0 ? args[i + 1] : undefined;
if (apply && !/^[a-f0-9]{64}$/.test(expected ?? ''))
    throw new Error('Apply requires --plan-hash');
  const prisma = new PrismaClient();
  try {
    const result = await repairOfficialObservations(prisma, apply ? expected : undefined);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
if (require.main === module) {
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
