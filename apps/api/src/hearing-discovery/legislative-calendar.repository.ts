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
import { insertSiteUpdates } from './canonical-hearing.repository.js';
import { stateCalendarCommitteeUpdates } from './florida-committee-alerts.js';

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));

/** State roster tables use upper/lower while canonical hearings use
 * senate/house. Keep the qualification check strict after translating that
 * vocabulary; an unknown non-empty chamber remains unqualified. */
export function normalizeStateCommitteeChamber(
  chamber: string | null | undefined,
): LegislativeObservation['chamber'] | null {
  const value = (chamber ?? '').trim().toLowerCase();
  if (value === 'upper' || value === 'senate') return 'senate';
  if (value === 'lower' || value === 'house') return 'house';
  if (value === 'joint') return 'joint';
  return null;
}

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
    canonicalHearingId: string | null = null,
  ): Promise<ReconcileOutcome> {
    validateCalendarObservation(observation);
    if (!externalEventId.trim()) throw new Error('Missing upstream event identity');
    return this.prisma.$transaction(
      async (tx) => {
        // A strong-proof canonical attachment (exact publisher page / shared
        // media entry, resolved by the Florida adapters BEFORE reconcile) is
        // the only override of the derived candidate id. The target row is
        // still validated below against jurisdiction/chamber/session/body, so
        // a wrong attachment fails loudly instead of merging two proceedings.
        // NO network runs here: this transaction must stay bounded.
        const candidateId = canonicalHearingId ?? legislativeEventId(observation);
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
        // Narrow attach-consistency guard: when the caller supplies a strong-
        // proof canonical id but this source's OWN observation ledger (or the
        // official-identity alias) already resolves the event to a DIFFERENT
        // row, the mapping is conflicting — reject before any mutation rather
        // than lock the canonical target and mutate another id.
        if (canonicalHearingId !== null && id !== canonicalHearingId)
          throw new Error(
            `Conflicting canonical mapping: observation ledger resolves ${id}, proof supplied ${canonicalHearingId}`,
          );
        // An explicit canonical attachment (strong proof resolved BEFORE
        // reconcile) MUST serialize against every other source attaching the
        // same target, even when the override made id === candidateId (the
        // identity lock above is per source identity and cannot cover it).
        if (canonicalHearingId !== null) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${canonicalHearingId}, 0))`;
        } else if (id !== candidateId) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
        }
        const existing = await tx.committeeHearing.findUnique({ where: { id } });
        // The first OpenStates events release wrote six provisional body
        // keys as `openstates:*` before the explicit unresolved marker was
        // added. Treat only those rows that still lack a canonical committee
        // as transitional unresolved bodies so the corrected rerun can refine
        // them without deleting provenance or weakening qualified mappings.
        const legacyUnresolvedOpenstatesBody =
          existing?.stateCommitteeId === null &&
          existing.bodySourceKey?.startsWith('openstates:') === true;
        const retainedNotice = (
          priorObservation?.sourceMetadata as { legislative?: LegislativeObservation } | null
        )?.legislative;
        const retainedNoticeRefinement =
          existing?.stateCommitteeId === null &&
          /^fl:(?:house|senate):tfc:/.test(existing.bodySourceKey ?? '') &&
          retainedNotice?.officialIdentity === observation.officialIdentity &&
          retainedNotice?.bodySourceKey.includes('unresolved-body') &&
          retainedNotice?.jurisdiction === observation.jurisdiction &&
          retainedNotice?.chamber === observation.chamber &&
          retainedNotice?.session === observation.session;
        const qualifiedBodyRefinement =
          (existing?.bodySourceKey?.includes('unresolved-body') ||
            legacyUnresolvedOpenstatesBody ||
            retainedNoticeRefinement) &&
          observation.stateCommitteeId;
        const unresolvedBody =
          observation.bodySourceKey.includes('unresolved-body') ||
          (observation.stateCommitteeId === null &&
            observation.bodySourceKey.startsWith('openstates:'));
        // Narrow FL archive bridge: a TFC archive observation (fl:{ch}:tfc:*)
        // and a chamber notice's official roster key NEVER match, and only a
        // proven cross-source attachment (canonicalHearingId = the proof) may
        // span them. The mismatch is permitted ONLY when the existing or
        // incoming body is the archive bridge — never arbitrary
        // notice→notice. Geography, chamber and session are never relaxed.
        const TFC_BODY = /^fl:(?:house|senate|joint):tfc:/;
        const archiveBridge =
          TFC_BODY.test(existing?.bodySourceKey ?? '') || TFC_BODY.test(observation.bodySourceKey);
        const provenAttachment =
          canonicalHearingId !== null && existing?.id === canonicalHearingId && archiveBridge;
        if (
          existing &&
          (existing.geographicJurisdiction !== observation.jurisdiction ||
            existing.chamber !== displayChamber(observation.chamber) ||
            (existing.legislativeSession !== null &&
              observation.session !== null &&
              existing.legislativeSession !== observation.session) ||
            (existing.bodySourceKey !== observation.bodySourceKey &&
              !qualifiedBodyRefinement &&
              !unresolvedBody &&
              !provenAttachment))
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
          const bodyChamber = normalizeStateCommitteeChamber(body?.chamber);
          if (
            !body ||
            body.state !== observation.jurisdiction ||
            bodyChamber !== observation.chamber ||
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
        const projectedStateCommitteeId =
          observation.stateCommitteeId ?? existing?.stateCommitteeId ?? null;
        const firstCommitteeAttribution = Boolean(
          existing && !existing.stateCommitteeId && projectedStateCommitteeId,
        );
        const projectedColumns = {
          geographicJurisdiction: observation.jurisdiction,
          legislativeSession: observation.session ?? existing?.legislativeSession ?? null,
          // Body/roster identity projection, exactly one of:
          //  • unresolved incoming body → keep the existing (possibly refined) key.
          //  • original qualifiedBodyRefinement (existing unresolved + incoming
          //    mapped committee) → take the incoming roster key. Unchanged.
          //  • proven archive bridge: archive→notice UPGRADES the TFC key to
          //    the official roster key; notice→archive reimport PRESERVES the
          //    qualified key and its committee name (a later archive run must
          //    never revert qualified canonical metadata).
          //  • everything else: keys matched above — take the incoming value.
          bodySourceKey: unresolvedBody
            ? (existing?.bodySourceKey ?? observation.bodySourceKey)
            : qualifiedBodyRefinement
              ? observation.bodySourceKey
              : provenAttachment
                ? TFC_BODY.test(observation.bodySourceKey)
                  ? (existing?.bodySourceKey ?? observation.bodySourceKey)
                  : observation.bodySourceKey
                : observation.bodySourceKey,
          stateCommitteeId: projectedStateCommitteeId,
          chamber: displayChamber(observation.chamber),
          committeeName:
            provenAttachment && TFC_BODY.test(observation.bodySourceKey) && existing
              ? existing.committeeName
              : observation.bodyName,
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
          // An incomplete refresh cannot reopen an explicitly closed proceeding.
          ...(facts.visibility !== undefined ? { visibility: facts.visibility } : {}),
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
        let siteUpdatesInserted = 0;
        if ((changed || firstCommitteeAttribution) && projectedStateCommitteeId) {
          siteUpdatesInserted = await insertSiteUpdates(
            tx,
            stateCalendarCommitteeUpdates({
              jurisdiction: observation.jurisdiction,
              stateCommitteeId: projectedStateCommitteeId,
              hearingId: id,
              revision,
              existed: Boolean(existing),
              firstCommitteeAttribution,
              before,
              after: facts,
              changedFields,
              sourceUrl: observation.sourceUrl,
              publishedAt: observation.publishedAt,
              parserVersion: source.parserVersion,
            }),
            now,
            source.id,
          );
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
          siteUpdatesInserted,
          streamCandidatesCreated: 0,
        };
      },
      { maxWait: 10000, timeout: 30000 },
    );
  }
}
