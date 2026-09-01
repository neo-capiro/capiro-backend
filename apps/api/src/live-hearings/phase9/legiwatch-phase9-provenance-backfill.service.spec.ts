/**
 * Provenance backfill — unit behavior contract.
 *
 * The backfill closes the CANONICAL_PROVENANCE gap (canonical hearings inside
 * the READINESS window whose only provenance would be a reconciled official
 * observation) by re-observing the REAL event through the EXISTING canonical
 * discovery path:
 *
 *   Congress.gov committee-meeting detail → CongressGovAdapter.toSourceEvent →
 *   HearingReconcilerService.reconcileEvent → observation row linked to the
 *   EXISTING canonical hearing (the DB trigger stamps RECONCILED; no new
 *   write path, no hand-written SQL).
 *
 * Safety contract verified here:
 *  - REPORT-ONLY mode performs zero writes and zero fetches (pure candidate report)
 *  - selection is deterministic (effective start ASC, hearing id ASC), bounded,
 *    restartable (cursor = last processed hearing id)
 *  - an ambiguous identity (ladder would answer `new` → a NEW canonical hearing)
 *    is never forced: the row is skipped and classified SKIPPED_IDENTITY_CONFLICT
 *  - a second identical run is a no-op (observed count unchanged)
 *  - the batch report carries observed/created/skipped/errors and remaining count
 */
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  LegiWatchPhase9ProvenanceBackfillService,
  type ProvenanceBackfillResult,
} from './legiwatch-phase9-provenance-backfill.service.js';

type Row = Record<string, unknown>;

function prismaStub(rows: {
  candidates?: Row[];
  congressSource?: Row | null;
  hearings?: Record<string, Row>;
  observations?: Record<string, Row[]>;
  /** COUNT(*) the stub reports for the remaining-gap query (post-write state). */
  remaining?: number;
}): PrismaService {
  const service = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM committee_hearing h') && s.includes('NOT EXISTS') && s.includes('LIMIT')) {
        // params follow selectCandidates: [lookbackDays, limit, cursorEff, cursorId]
        const limit = Number(params[1] ?? 25);
        const cursorId = (params[3] as string | null) ?? null;
        const all = rows.candidates ?? [];
        const start = cursorId ? all.findIndex((r) => r.id === cursorId) + 1 : 0;
        return all.slice(start, start + limit);
      }
      if (s.includes('COUNT(*)::int AS n')) {
        return [{ n: rows.remaining ?? (rows.candidates ?? []).length }];
      }
      if (s.includes('FROM committee_source')) {
        return rows.congressSource ? [rows.congressSource] : [];
      }
      throw new Error('unexpected $queryRawUnsafe: ' + s.slice(0, 120));
    },
    $executeRawUnsafe: async () => 0,
    committeeHearing: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (rows.hearings ?? {})[where.id] ?? null,
      update: async () => ({}),
    },
    hearingSourceObservation: {
      findUnique: async () => null,
      create: async () => {
        throw new Error('recordObservation must not run in report-only tests');
      },
    },
    committeeSource: {
      findUnique: async () => null,
      update: async () => ({}),
    },
  };
  return service as unknown as PrismaService;
}

describe('LegiWatchPhase9ProvenanceBackfillService', () => {
  const CANDIDATE = {
    id: 'cm-119-338649',
    chamber: 'Senate',
    congress: 119,
    committee_system_code: 'hsag00',
    title: 'Hearings to examine the nomination of Todd Blanche, of Florida, to be Attorney General.',
    url: 'https://www.congress.gov/event/119th-Congress/senate-event/338649',
    starts_at: new Date('2026-07-15T13:00:00Z'),
    date: new Date('2026-07-15'),
  };

  it('report-only run returns the exact candidate list and performs no writes', async () => {
    const prisma = prismaStub({ candidates: [CANDIDATE] });
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    const result: ProvenanceBackfillResult = await service.run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      reportOnly: true,
    });
    expect(result.mode).toBe('REPORT_ONLY');
    expect(result.scanned).toBe(1);
    expect(result.observed).toBe(0);
    expect(result.observationCreated).toBe(0);
    expect(result.newHearingsCreated).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      hearingId: 'cm-119-338649',
      likelyAdapter: 'congress-gov',
      externalEventId: '338649',
    });
    expect(result.nextCursor).toBeNull();
  });

  it('routes CHRG transcript-record rows to the govinfo-chrg adapter via URL package id', async () => {
    const chrg = {
      ...CANDIDATE,
      id: '119-64224-2026-07-14',
      url: 'https://congress.gov/119/chrg/CHRG-119hhrg64224/generated/CHRG-119hhrg64224.htm',
    };
    const prisma = prismaStub({ candidates: [chrg], congressSource: { id: 'src-gov' } });
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    const result = await service.run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      observeEvent: async () => ({
        externalEventId: 'CHRG-119-64224',
        chamber: 'house' as const,
        calendarDate: new Date('2026-07-14'),
      }),
      reconcilerFactory: () => ({
        reconcileEvent: async () => ({
          hearingId: chrg.id,
          match: 'day' as const,
          observationCreated: true,
          observationChanged: false,
          hearingCreated: false,
          changedFields: [],
          filledFields: [],
          siteUpdatesInserted: 0,
          streamCandidatesCreated: 0,
        }),
      }),
      identityProbe: async () => 'day' as const,
    });
    expect(result.skippedUnfetchable).toBe(0);
    expect(result.observed).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      hearingId: chrg.id,
      likelyAdapter: 'govinfo-chrg',
      classification: 'OBSERVED',
    });
  });

  it('skips rows whose external event id cannot be derived at all', async () => {
    const unknown = {
      ...CANDIDATE,
      id: 'unknown-shape-row',
      url: 'https://example.invalid/no-known-adapter',
    };
    const prisma = prismaStub({ candidates: [unknown] });
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    const result = await service.run({ manual: true, lookbackDays: 60, limit: 25 });
    expect(result.scanned).toBe(1);
    expect(result.observablesFetched).toBe(0);
    expect(result.skippedUnfetchable).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      hearingId: unknown.id,
      classification: 'UNFETCHABLE',
    });
  });

  it('observes a real event through the reconciler and links to the EXISTING hearing', async () => {
    const created: Row[] = [];
    const prisma = prismaStub({ candidates: [CANDIDATE] });
    // observeEvent hook replaces the network: returns the adapter-shaped event
    const observe = async (hearingId: string) => {
      expect(hearingId).toBe('cm-119-338649');
      return {
        externalEventId: '338649',
        congress: 119,
        chamber: 'senate' as const,
        committeeSystemCode: 'hsag00',
        title: CANDIDATE.title as string,
        eventStatus: 'completed' as const,
        visibility: 'public' as const,
        startsAt: new Date('2026-07-15T13:00:00Z'),
        calendarDate: new Date('2026-07-15'),
        officialPageUrl: CANDIDATE.url as string,
        streamCandidates: [],
        witnesses: [],
        agendaBillIds: [],
      };
    };
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    // the reconciler is replaced at the seam the service defines
    const result = await service.run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      observeEvent: observe,
      reconcilerFactory: () => ({
        reconcileEvent: async () => {
          created.push({ linked: true });
          return {
            hearingId: 'cm-119-338649',
            match: 'id' as const,
            observationCreated: true,
            observationChanged: false,
            hearingCreated: false,
            changedFields: [],
            filledFields: [],
            siteUpdatesInserted: 0,
            streamCandidatesCreated: 0,
          };
        },
      }),
      identityProbe: async () => 'id' as const,
    });
    expect(result.mode).toBe('APPLY');
    expect(result.observed).toBe(1);
    expect(result.observationCreated).toBe(1);
    expect(result.newHearingsCreated).toBe(0);
    expect(result.identityConflicts).toBe(0);
    expect(result.errors).toBe(0);
    expect(created).toHaveLength(1);
  });

  it('skips + classifies an identity conflict instead of creating a new canonical hearing', async () => {
    const prisma = prismaStub({ candidates: [CANDIDATE] });
    const observe = async () => ({
      externalEventId: '338649',
      congress: 119,
      chamber: 'senate' as const,
      committeeSystemCode: 'hsag00',
      title: 'A DIFFERENT EVENT ENTIRELY',
      calendarDate: new Date('2026-07-15'),
    });
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    const result = await service.run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      observeEvent: observe,
      reconcilerFactory: () => ({
        reconcileEvent: async () => {
          throw new Error('must not reconcile when identity is ambiguous');
        },
      }),
      identityProbe: async () => 'new' as const,
    });
    expect(result.identityConflicts).toBe(1);
    expect(result.observed).toBe(0);
    expect(result.newHearingsCreated).toBe(0);
    expect(result.candidates[0]).toMatchObject({
      hearingId: 'cm-119-338649',
      classification: 'SKIPPED_IDENTITY_CONFLICT',
    });
  });

  it('counts fetch failures as errors without aborting the batch', async () => {
    const prisma = prismaStub({ candidates: [CANDIDATE] });
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    const result = await service.run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      observeEvent: async () => {
        throw new Error('upstream 503');
      },
    });
    expect(result.errors).toBe(1);
    expect(result.observed).toBe(0);
    expect(result.candidates[0]).toMatchObject({
      hearingId: 'cm-119-338649',
      classification: 'ERROR',
    });
  });

  it('a second identical run observes nothing new (idempotent ledger)', async () => {
    const prisma = prismaStub({ candidates: [CANDIDATE] });
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    let calls = 0;
    const observe = async () => {
      calls += 1;
      return {
        externalEventId: '338649',
        congress: 119,
        chamber: 'senate' as const,
        title: CANDIDATE.title as string,
        calendarDate: new Date('2026-07-15'),
      };
    };
    const reconcilerFactory = () => ({
      reconcileEvent: async () => ({
        hearingId: 'cm-119-338649',
        match: (calls === 1 ? 'id' : 'observation') as 'id' | 'observation',
        observationCreated: calls === 1,
        observationChanged: false,
        hearingCreated: false,
        changedFields: [],
        filledFields: [],
        siteUpdatesInserted: 0,
        streamCandidatesCreated: 0,
      }),
    });
    const identityProbe = async () => 'id' as const;
    const first = await service.run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      observeEvent: observe,
      reconcilerFactory,
      identityProbe,
    });
    const second = await service.run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      observeEvent: observe,
      reconcilerFactory,
      identityProbe,
    });
    expect(first.observationCreated).toBe(1);
    expect(second.observationCreated).toBe(0);
    expect(second.observed).toBe(1);
  });

  it('is DI-injectable: PrismaService param metadata is emitted for Nest', async () => {
    // Regression: without @Injectable(), emitDecoratorMetadata skips the class and Nest injects
    // undefined for prisma (live failure 2026-09-01: prisma undefined at selectCandidates).
    const designParamtypes = 'design:paramtypes';
    expect(
      Reflect.hasOwnMetadata(designParamtypes, LegiWatchPhase9ProvenanceBackfillService),
    ).toBe(true);
    expect(Reflect.getMetadata(designParamtypes, LegiWatchPhase9ProvenanceBackfillService)[0]).toBe(
      PrismaService,
    );
  });

  it('refuses to run when not explicitly manual', async () => {
    const prisma = prismaStub({ candidates: [] });
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    await expect(
      service.run({ manual: false, lookbackDays: 60, limit: 25 }),
    ).rejects.toThrow(/manual/i);
  });

  it('bounds the batch and reports the remaining gap for restartability', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...CANDIDATE,
      id: `cm-119-9000${i}`,
      url: `https://www.congress.gov/event/119th-Congress/house-event/9000${i}`,
    }));
    const prisma = prismaStub({ candidates: many, remaining: 15 });
    const service = new LegiWatchPhase9ProvenanceBackfillService(prisma);
    const result = await service.run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      observeEvent: async (hearingId: string) => ({
        externalEventId: hearingId.replace(/^cm-119-/, ''),
        congress: 119,
        chamber: 'house' as const,
        title: 'x',
        calendarDate: new Date('2026-07-15'),
      }),
    });
    expect(result.scanned).toBe(25);
    expect(result.nextCursor).toContain(`|${many[24]!.id}`);
    expect(result.remaining).toBe(15);
  });
});
