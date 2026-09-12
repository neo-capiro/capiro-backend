import { Prisma, type PrismaClient } from '@prisma/client';
import { contentHash, displayChamber } from './hearing-identity.js';
import {
  legislativeEventId,
  projectLegislativeObservation,
  validateCalendarObservation,
  type CalendarFacts,
  type CalendarProvenance,
  type LegislativeObservation,
} from './legislative-calendar.js';
import type { SourceDescriptor } from './hearing-discovery.types.js';
import type { ReconcileOutcome } from './hearing-reconciler.service.js';

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));

/** State extension of the canonical discovery owner. No private tables or
 * capture services participate. Observation, projection, agenda and transition
 * commit together; the transition ledger is the durable downstream checkpoint. */
export class LegislativeCalendarRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async reconcile(
    source: SourceDescriptor,
    externalEventId: string,
    observation: LegislativeObservation,
    now: Date,
  ): Promise<ReconcileOutcome> {
    validateCalendarObservation(observation);
    if (!externalEventId.trim()) throw new Error('Missing upstream event identity');
    return this.prisma.$transaction(
      async (tx) => {
        const candidateId = legislativeEventId(observation);
        // The source's qualified notice identity survives later resolution of an
        // initially unknown session/body and is shared by providers citing it.
        const identityLock = `${observation.jurisdiction}:${observation.officialIdentity}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identityLock}, 0))`;
        const priorObservation = await tx.hearingSourceObservation.findUnique({
          where: { sourceId_externalEventId: { sourceId: source.id, externalEventId } },
        });
        const aliases = priorObservation?.hearingId
          ? []
          : await tx.hearingSourceObservation.findMany({
              where: {
                hearingId: { not: null },
                AND: [
                  {
                    sourceMetadata: {
                      path: ['legislative', 'officialIdentity'],
                      equals: observation.officialIdentity,
                    },
                  },
                  {
                    sourceMetadata: {
                      path: ['legislative', 'jurisdiction'],
                      equals: observation.jurisdiction,
                    },
                  },
                ],
              },
              select: { hearingId: true },
              take: 10,
            });
        const linkedIds = [...new Set(aliases.map((alias) => alias.hearingId!))];
        if (linkedIds.length > 1)
          throw new Error('Official notice has conflicting canonical identities');
        const id = priorObservation?.hearingId ?? linkedIds[0] ?? candidateId;
        if (id !== candidateId)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
        const existing = await tx.committeeHearing.findUnique({ where: { id } });
        const qualifiedBodyRefinement =
          existing?.bodySourceKey?.includes('unresolved-body') && observation.stateCommitteeId;
        const unresolvedBody = observation.bodySourceKey.includes('unresolved-body');
        if (
          existing &&
          (existing.geographicJurisdiction !== observation.jurisdiction ||
            existing.chamber !== displayChamber(observation.chamber) ||
            (existing.legislativeSession !== null &&
              observation.session !== null &&
              existing.legislativeSession !== observation.session) ||
            (existing.bodySourceKey !== observation.bodySourceKey &&
              !qualifiedBodyRefinement &&
              !unresolvedBody))
        )
          throw new Error(
            'Source mapping conflicts with canonical geographic/session/body identity',
          );
        for (const item of observation.fields.agenda ?? []) {
          if (!item.bill) continue;
          const bill = await tx.stateBill.findUnique({
            where: { id: item.bill.id },
            select: { state: true, sessionKey: true },
          });
          if (
            !bill ||
            bill.state !== observation.jurisdiction ||
            bill.sessionKey !== observation.session
          )
            throw new Error('Agenda canonical bill mapping is not qualified');
        }
        if (observation.stateCommitteeId) {
          const body = await tx.stateCommittee.findUnique({
            where: { id: observation.stateCommitteeId },
            select: { state: true, chamber: true, legislativeSession: true },
          });
          if (
            !body ||
            body.state !== observation.jurisdiction ||
            (body.chamber && body.chamber.toLowerCase() !== observation.chamber) ||
            (body.legislativeSession && body.legislativeSession !== observation.session)
          )
            throw new Error('Unqualified state committee mapping');
        }
        const before = (existing?.calendarSnapshot ?? {}) as Partial<CalendarFacts>;
        const projection = projectLegislativeObservation(
          before,
          (existing?.calendarProvenance ?? {}) as CalendarProvenance,
          observation,
          source,
          now,
        );
        const { facts, changedFields } = projection;
        if (!facts.time) throw new Error('Cannot create event without a qualified calendar date');
        const changed = changedFields.length > 0;
        const revision = (existing?.calendarRevision ?? 0) + (changed ? 1 : 0);
        const payloadHash = contentHash(observation);
        const observationChanged = priorObservation?.rawContentHash !== payloadHash;
        const projectedColumns = {
          geographicJurisdiction: observation.jurisdiction,
          legislativeSession: observation.session ?? existing?.legislativeSession ?? null,
          bodySourceKey: unresolvedBody
            ? (existing?.bodySourceKey ?? observation.bodySourceKey)
            : observation.bodySourceKey,
          stateCommitteeId: observation.stateCommitteeId ?? existing?.stateCommitteeId ?? null,
          chamber: displayChamber(observation.chamber),
          committeeName: observation.bodyName,
          title: facts.title ?? observation.bodyName,
          type: observation.eventType,
          date: new Date(`${facts.time.date}T00:00:00Z`),
          time: facts.time.rawTime,
          timezone: facts.time.timezone,
          timePrecision: facts.time.precision,
          startsAt: facts.time.startsAt ? new Date(facts.time.startsAt) : null,
          scheduledEnd: facts.time.endsAt ? new Date(facts.time.endsAt) : null,
          location: facts.location ?? null,
          eventStatus: facts.status ?? 'unknown',
          url:
            facts.documents?.find((d) => d.kind === 'notice')?.url ??
            existing?.url ??
            observation.sourceUrl,
          calendarRevision: revision,
          calendarSnapshot: json(facts),
          calendarProvenance: json(projection.provenance),
          calendarCheckedAt: now,
          calendarCheckState: observation.completeness,
          ...(changed ? { syncedAt: now } : {}),
        };
        await tx.committeeHearing.upsert({
          where: { id },
          create: { id, ...projectedColumns, congress: null, coverageStatus: 'discovered' },
          update: projectedColumns,
        });
        await tx.hearingSourceObservation.upsert({
          where: { sourceId_externalEventId: { sourceId: source.id, externalEventId } },
          create: {
            sourceId: source.id,
            externalEventId,
            hearingId: id,
            rawContentHash: payloadHash,
            sourceMetadata: json({ legislative: observation }),
            firstSeenAt: now,
            lastSeenAt: now,
            sourceUpdatedAt: observation.publishedAt ? new Date(observation.publishedAt) : null,
          },
          update: {
            hearingId: id,
            lastSeenAt: now,
            ...(observationChanged
              ? {
                  rawContentHash: payloadHash,
                  sourceMetadata: json({ legislative: observation }),
                  sourceUpdatedAt: observation.publishedAt
                    ? new Date(observation.publishedAt)
                    : null,
                }
              : {}),
          },
        });
        if (observationChanged)
          await tx.legislativeObservationRevision.create({
            data: {
              sourceId: source.id,
              externalEventId,
              hearingId: id,
              contentHash: payloadHash,
              payload: json(observation),
              observedAt: now,
            },
          });
        if (changedFields.includes('agenda')) {
          const items = facts.agenda ?? [];
          await tx.legislativeAgendaItem.updateMany({
            where: { hearingId: id, active: true, itemKey: { notIn: items.map((i) => i.key) } },
            data: { active: false, revision, lastSeenAt: now },
          });
          for (const item of items) {
            const data = {
              position: item.position,
              kind: item.kind,
              title: item.title,
              billScope: item.bill?.scope ?? null,
              stateBillKey: item.bill?.scope === 'state' ? item.bill.id : null,
              federalBillId: item.bill?.scope === 'federal' ? item.bill.id : null,
              sourceUrl: item.sourceUrl,
              evidence: json(item.evidence),
              active: true,
              revision,
              lastSeenAt: now,
            };
            await tx.legislativeAgendaItem.upsert({
              where: { hearingId_itemKey: { hearingId: id, itemKey: item.key } },
              create: { hearingId: id, itemKey: item.key, ...data, firstSeenAt: now },
              update: data,
            });
          }
        }
        if (changed)
          await tx.legislativeCalendarTransition.create({
            data: {
              hearingId: id,
              revision,
              before: existing ? json(before) : Prisma.DbNull,
              after: json(facts),
              changedFields,
              sourceId: source.id,
              sourceUrl: observation.sourceUrl,
              observedAt: now,
            },
          });
        return {
          hearingId: id,
          match: priorObservation?.hearingId ? 'observation' : existing ? 'id' : 'new',
          observationCreated: !priorObservation,
          observationChanged,
          hearingCreated: !existing,
          changedFields,
          filledFields: [],
          siteUpdatesInserted: 0,
          streamCandidatesCreated: 0,
        };
      },
      { maxWait: 10000, timeout: 30000 },
    );
  }
}
