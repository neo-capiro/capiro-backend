import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ProgramElementReadService } from './program-element-read.service.js';

const ctx: TenantContext = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  tenantSlug: 'capiro',
  userId: '00000000-0000-0000-0000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
};

describe('ProgramElementReadService', () => {
  describe('listProgramElements markup monitor mode', () => {
    test('returns empty response when tenant context is missing', async () => {
      const prisma = makePrisma({
        queryRawQueue: [],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const result = await service.listProgramElements({ mode: 'markup-monitor' });

      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 0 });
    });

    test('returns markup monitor rows for tenant-scoped watches', async () => {
          const prisma = makePrisma({
            queryRawQueue: [
              [
                {
                  peCode: '0603270A',
                  title: 'Electronic Warfare Advanced Payloads',
                  service: 'Army',
                  request: 100,
                  hascMark: 120,
                  sascMark: 90,
                  hacDMark: null,
                  sacDMark: 130,
                  // Stale SQL could still ship a cross-track span; TS remap must repair it.
                  divergencePct: 60,
                  authDivergencePct: 30,
                  appropsDivergencePct: 30,
                  divergenceTrack: 'authorization',
                  totalCount: 1,
                },
              ],
            ],
          });
          const service = new ProgramElementReadService(
            prisma as never,
            makeConferenceProbabilityService() as never,
          );

          const result = await service.listProgramElements(
            { mode: 'markup-monitor', service: 'Army', divergenceThreshold: 10 },
            ctx,
          );

          expect(result.total).toBe(1);
          const row = result.data[0] as {
            peCode?: string;
            divergencePct?: number;
            authDivergencePct?: number;
            appropsDivergencePct?: number;
            divergenceTrack?: string | null;
          };
          expect(row?.peCode).toBe('0603270A');
          // Auth 120..90 = 30%; approps request..130 = 30%; max=30 — NOT blended 40/60 span.
          expect(row?.authDivergencePct).toBeCloseTo(30, 5);
          expect(row?.appropsDivergencePct).toBeCloseTo(30, 5);
          expect(row?.divergencePct).toBeCloseTo(30, 5);
          expect(row?.divergencePct).not.toBe(60);
          expect(prisma.__mock.queryRawCalls).toBe(1);
          expect(prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
        });

        test('B1 adversarial: hasc=120 + hacd=60 must not yield cross-track 60% headline', async () => {
          const prisma = makePrisma({
            queryRawQueue: [
              [
                {
                  peCode: 'ATTACKPE',
                  title: 'Cross-track attack fixture',
                  service: 'Army',
                  request: 100,
                  hascMark: 120,
                  sascMark: null,
                  hacDMark: 60,
                  sacDMark: null,
                  // Poisoned legacy blended value — service must recompute track-safe.
                  divergencePct: 60,
                  authDivergencePct: 99,
                  appropsDivergencePct: 99,
                  divergenceTrack: null,
                  totalCount: 1,
                },
              ],
            ],
          });
          const service = new ProgramElementReadService(
            prisma as never,
            makeConferenceProbabilityService() as never,
          );
          const result = await service.listProgramElements({ mode: 'markup-monitor' }, ctx);
          const row = result.data[0] as {
            divergencePct: number;
            authDivergencePct: number;
            appropsDivergencePct: number;
            divergenceTrack: string | null;
          };
          expect(row.authDivergencePct).toBeCloseTo(20, 5);
          expect(row.appropsDivergencePct).toBeCloseTo(40, 5);
          expect(row.divergencePct).toBeCloseTo(40, 5);
          expect(row.divergencePct).not.toBe(60);
          expect(row.divergenceTrack).toBe('appropriations');
        });

        test('B7: markup current_cycle SQL uses sqlCurrentCycleFyExpr, not bare max fy', async () => {
          const prisma = makePrisma({
            queryRawQueue: [
              [
                {
                  peCode: 'OUTYEARPE',
                  title: 'Outyear trap',
                  service: 'Army',
                  request: 100,
                  hascMark: 120,
                  sascMark: null,
                  hacDMark: null,
                  sacDMark: null,
                  divergencePct: 20,
                  authDivergencePct: 20,
                  appropsDivergencePct: 0,
                  divergenceTrack: 'authorization',
                  totalCount: 1,
                },
              ],
            ],
          });
          const service = new ProgramElementReadService(
            prisma as never,
            makeConferenceProbabilityService() as never,
          );
          const result = await service.listProgramElements({ mode: 'markup-monitor' }, ctx);
          const row = result.data[0] as {
            request: number;
            hascMark: number | null;
            divergencePct: number;
          };
          expect(row.request).toBe(100);
          expect(row.hascMark).toBe(120);
          expect(row.divergencePct).toBeCloseTo(20, 5);
          const sqlTexts = prisma.__mock.rawSqlTexts as string[];
          expect(sqlTexts.length).toBeGreaterThan(0);
          const markupSql = sqlTexts.join('\n');
          expect(markupSql).toMatch(/pe_cycle/);
          expect(markupSql).toMatch(/ndaa_conference/);
          expect(markupSql).not.toMatch(/ORDER BY pey\.pe_code, pey\.fy DESC/);
        });
      });

  describe('getProgramElement currentUserIsWatching', () => {
    test('cache hit on repeat call (live join path)', async () => {
      const prisma = makePrisma({
        queryRawQueue: [[], []],
        mvRows: [],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      await service.getProgramElement('0603270A', ctx);
      await service.getProgramElement('0603270A', ctx);

      expect(prisma.__mock.programElementFindUniqueCalls).toBe(1);
      expect(prisma.__mock.mvQueryRawCalls).toBe(1);
      expect(prisma.__mock.queryRawCalls).toBe(2);
    });

    test('cache miss after TTL (60s) reloads detail', async () => {
      const prisma = makePrisma({
        queryRawQueue: [[]],
        mvRows: [],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const cache = (
        service as unknown as {
          detailCache: {
            clear: () => void;
            set: (key: string, value: Record<string, unknown>, options?: { ttl?: number }) => void;
          };
        }
      ).detailCache;

      cache.clear();
      cache.set('0603270A', { peCode: '0603270A', title: 'STALE' }, { ttl: 1 });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const result = await service.getProgramElement('0603270A', ctx);
      const detail = result as { title?: string };

      expect(detail.title).toBe('Electronic Warfare Advanced Payloads');
      expect(prisma.__mock.programElementFindUniqueCalls).toBe(1);
    });

    test('enriches detail with billCount from the detail MV', async () => {
      // The base PE row is authoritative for header fields + the full year
      // history; the MV is queried only for the precomputed bill_count.
      const prisma = makePrisma({
        queryRawQueue: [[]],
        mvRows: [{ billCount: 9 }],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const result = await service.getProgramElement('0603270A', ctx);
      const detail = result as { title?: string; billCount?: number; appropriationType?: string };

      expect(detail.title).toBe('Electronic Warfare Advanced Payloads');
      // appropriation type comes from the base row — the old MV path dropped it.
      expect(detail.appropriationType).toBe('RDT&E');
      expect(detail.billCount).toBe(9);
      expect(prisma.__mock.mvQueryRawCalls).toBe(1);
      expect(prisma.__mock.programElementFindUniqueCalls).toBe(1);
    });

    test('billCount refresh propagates after cache clear', async () => {
      const prisma = makePrisma({
        queryRawQueue: [[], []],
        mvRows: [{ billCount: 2 }],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const first = await service.getProgramElement('0603270A', ctx);
      expect((first as { title?: string; billCount?: number }).title).toBe(
        'Electronic Warfare Advanced Payloads',
      );
      expect((first as { billCount?: number }).billCount).toBe(2);

      prisma.$queryRaw.mockResolvedValueOnce([{ billCount: 5 }]);

      const cache = (service as unknown as { detailCache: { clear: () => void } }).detailCache;
      cache.clear();

      const second = await service.getProgramElement('0603270A', ctx);
      const detail = second as { title?: string; billCount?: number };
      expect(detail.title).toBe('Electronic Warfare Advanced Payloads');
      expect(detail.billCount).toBe(5);
    });

    test('returns currentUserIsWatching=false when no watch rows', async () => {
      const prisma = makePrisma({
        queryRawQueue: [[]],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const result = await service.getProgramElement('0603270A', ctx);

      expect(result.currentUserIsWatching).toBe(false);
    });

    test('returns currentUserIsWatching=true when one watch row exists', async () => {
      const prisma = makePrisma({
        queryRawQueue: [[{ id: 'watch-1' }]],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const result = await service.getProgramElement('0603270A', ctx);

      expect(result.currentUserIsWatching).toBe(true);
    });

    test('throws NotFoundException for unknown PE', async () => {
      const prisma = makePrisma({
        missingPe: true,
        queryRawQueue: [[]],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      await expect(service.getProgramElement('BAD', ctx)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setWatching', () => {
    test('watch then unwatch toggles create/delete rows and returns state', async () => {
      const prisma = makePrisma({
        queryRawQueue: [[{ id: 'watch-created' }], [{ id: 'watch-created' }]],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const watched = await service.setWatching('0603270A', true, ctx);
      const unwatched = await service.setWatching('0603270A', false, ctx);

      expect(watched).toEqual({ peCode: '0603270A', watching: true });
      expect(unwatched).toEqual({ peCode: '0603270A', watching: false });
      expect(prisma.__mock.queryRawCalls).toBe(2);
      expect(prisma.__mock.auditLogCalls).toHaveLength(2);
    });

    test('throws NotFoundException when PE does not exist', async () => {
      const prisma = makePrisma({
        missingPe: true,
        queryRawQueue: [[]],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      await expect(service.setWatching('BAD', true, ctx)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('budget positions (Step 1.3)', () => {
    test('getBudgetPositions returns rows for an existing PE (no fy filter)', async () => {
      const prisma = makePrisma({
        queryRawQueue: [],
        budgetPositions: [
          {
            positionCycle: 'pb_fy2027',
            assertedFy: 2027,
            amount: '278.50',
            quantity: null,
            valueKind: 'total',
            sourceUrl: 'http://r1.pdf',
            pageNumber: 12,
          },
        ],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const rows = await service.getBudgetPositions('0603270A');
      expect(rows).toHaveLength(1);
      expect(prisma.programElementBudgetPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { peCode: '0603270A' } }),
      );
    });

    test('getBudgetPositions passes the fy filter through', async () => {
      const prisma = makePrisma({ queryRawQueue: [], budgetPositions: [] });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      await service.getBudgetPositions('0603270A', 2028);
      expect(prisma.programElementBudgetPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { peCode: '0603270A', assertedFy: 2028 } }),
      );
    });

    test('getBudgetPositions throws NotFound for unknown PE', async () => {
      const prisma = makePrisma({ missingPe: true, queryRawQueue: [] });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );
      await expect(service.getBudgetPositions('BAD')).rejects.toBeInstanceOf(NotFoundException);
    });

    test('getPbComparison delegates to the pure helper and shapes the response', async () => {
      const prisma = makePrisma({
        queryRawQueue: [],
        budgetPositions: [
          { positionCycle: 'pb_fy2026', assertedFy: 2027, amount: 200, valueKind: 'total' },
          { positionCycle: 'pb_fy2027', assertedFy: 2027, amount: 250, valueKind: 'total' },
        ],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const result = await service.getPbComparison('0603270A');
      expect(result.peCode).toBe('0603270A');
      expect(result.comparison).toEqual([
        {
          assertedFy: 2027,
          pbCurrent: 250,
          pbPrior: 200,
          deltaAbs: 50,
          deltaPct: 0.25,
          newInPb: false,
          droppedFromPb: false,
        },
      ]);
    });

    test('getPbComparison returns empty comparison with only one PB book loaded (DATA-PENDING)', async () => {
      const prisma = makePrisma({
        queryRawQueue: [],
        budgetPositions: [
          { positionCycle: 'pb_fy2027', assertedFy: 2027, amount: 250, valueKind: 'total' },
        ],
      });
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );

      const result = await service.getPbComparison('0603270A');
      expect(result.comparison).toEqual([]);
    });
  });

  describe('getTimeline predictedConferenceAmount wiring (GAI-28)', () => {
    test('attaches the predicted conference $ amount + CI/confidence to each year', async () => {
      const prisma = makePrisma({
        queryRawQueue: [[]],
      });
      const conferenceProbabilityService = makeConferenceProbabilityService({
        predicted: 251.2,
        ciLow: 247.0,
        ciHigh: 255.3,
        confidence: 0.66,
      });
      const service = new ProgramElementReadService(
        prisma as never,
        conferenceProbabilityService as never,
      );

      const result = await service.getTimeline('0603270A');

      expect(result.peCode).toBe('0603270A');
      expect(Array.isArray(result.years)).toBe(true);
      // GAI-28: 251.2 is a DOLLAR amount ($M), surfaced under a name that says so
      // — never as a "probability" (which would read as 251.2%).
      expect(result.years[0]?.predictedConferenceAmount).toBe(251.2);
      expect(result.years[0]?.predictedConferenceAmountCiLow).toBe(247.0);
      expect(result.years[0]?.predictedConferenceAmountCiHigh).toBe(255.3);
      expect(result.years[0]?.predictedConferenceConfidence).toBe(0.66);
      // GAI-25: the read path must call predict with persist=false so it never
      // writes to conference_probability while serving a timeline.
      expect(conferenceProbabilityService.predict).toHaveBeenCalledWith(
        '0603270A',
        expect.any(Number),
        false,
      );
    });
  });

  describe('getNeedsAttention client relevance (Step 2.3)', () => {
    const delta = (peCode: string, materialityScore: number) => ({
      id: `delta-${peCode}`,
      peCode,
      assertedFy: 2027,
      deltaType: 'mark_vs_request',
      materialityScore,
      supersededAt: null,
    });

    test('boosts + floats up a PE that is relevant ONLY via the relevance service (no watch, no capability)', async () => {
      // PE_PLAIN is more material on raw score; PE_REL is relevant only via the relevance
      // service. The +0.15 read-time boost must lift PE_REL above PE_PLAIN.
      const prisma = makePrisma({
        queryRawQueue: [],
        deltas: [delta('PE_PLAIN', 0.5), delta('PE_REL', 0.45)],
        tenantWatches: [],
        tenantCaps: [],
      });
      const relevance = makeRelevanceService(['PE_REL']);
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
        relevance as never,
      );

      const result = await service.getNeedsAttention(ctx);
      const byPe = new Map(
        (
          result.data as Array<{ peCode: string; clientRelevant: boolean; effectiveScore: number }>
        ).map((r) => [r.peCode, r]),
      );

      // PE_REL is flagged relevant and boosted (0.45 + 0.15 = 0.60); PE_PLAIN stays at 0.5.
      expect(byPe.get('PE_REL')?.clientRelevant).toBe(true);
      expect(byPe.get('PE_REL')?.effectiveScore).toBeCloseTo(0.6, 5);
      expect(byPe.get('PE_PLAIN')?.clientRelevant).toBe(false);
      expect(byPe.get('PE_PLAIN')?.effectiveScore).toBeCloseTo(0.5, 5);
      // The boosted relevance PE floats to the top despite a lower raw materiality score.
      expect((result.data[0] as { peCode: string }).peCode).toBe('PE_REL');
      // Relevance probe used the documented 0.5 floor and only the un-matched candidate PEs.
      expect(relevance.getRelevantClientsForPe).toHaveBeenCalledWith(ctx, 'PE_REL', {
        minScore: 0.5,
      });
    });

    test('a watch-relevant PE is still boosted without consulting the relevance service for it', async () => {
      const prisma = makePrisma({
        queryRawQueue: [],
        deltas: [delta('PE_WATCHED', 0.45)],
        tenantWatches: [{ peCode: 'PE_WATCHED' }],
        tenantCaps: [],
      });
      const relevance = makeRelevanceService([]); // relevance service reports nothing
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
        relevance as never,
      );

      const result = await service.getNeedsAttention(ctx);
      const row = (
        result.data as Array<{ peCode: string; clientRelevant: boolean; effectiveScore: number }>
      )[0];

      expect(row?.clientRelevant).toBe(true);
      expect(row?.effectiveScore).toBeCloseTo(0.6, 5);
      // Already matched by a watch → never probed against the relevance service.
      expect(relevance.getRelevantClientsForPe).not.toHaveBeenCalled();
    });

    test('no relevance + no watch/capability leaves the delta un-boosted', async () => {
      const prisma = makePrisma({
        queryRawQueue: [],
        deltas: [delta('PE_NONE', 0.7)],
        tenantWatches: [],
        tenantCaps: [],
      });
      const relevance = makeRelevanceService([]);
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
        relevance as never,
      );

      const result = await service.getNeedsAttention(ctx);
      const row = (result.data as Array<{ clientRelevant: boolean; effectiveScore: number }>)[0];

      expect(row?.clientRelevant).toBe(false);
      expect(row?.effectiveScore).toBeCloseTo(0.7, 5);
    });
  });

  // Regression: the Boresight PE-analysis failure. get_pe_budget_timeline used to
  // hand the model a flat array of near-identical FY rows with nothing marking the
  // live request vs. an FYDP outyear projection, so it quoted the FY2031 figure as
  // "the FY2027 request". getTimeline now labels each FY's cycle + current stage.
  describe('getTimeline current-vs-outyear labeling', () => {
    // The real Army 1242C93000 "Air Defense Targets" P-1 line, $M, from prod.
    const airDefenseTargetsPrisma = {
      programElement: {
        findUnique: jest.fn(async () => ({
          peCode: '1242C93000',
          title: 'AIR DEFENSE TARGETS',
          service: 'ARMY',
          appropriationType: 'PROC',
          budgetActivity: 'BA 05',
          lineNumber: '1242C93000',
        })),
      },
      programElementYear: {
        findMany: jest.fn(async () => [
          {
            fy: 2025,
            request: 7.03,
            hascMark: null,
            sascMark: null,
            hacDMark: null,
            sacDMark: null,
            conference: null,
            enacted: null,
          },
          {
            fy: 2026,
            request: 12.8,
            hascMark: 12.8,
            sascMark: 12.8,
            hacDMark: null,
            sacDMark: null,
            conference: 12.8,
            enacted: null,
          },
          {
            fy: 2027,
            request: 9.61,
            hascMark: 9.61,
            sascMark: 9.61,
            hacDMark: 9.61,
            sacDMark: null,
            conference: null,
            enacted: null,
          },
          {
            fy: 2028,
            request: 10.5,
            hascMark: null,
            sascMark: null,
            hacDMark: null,
            sacDMark: null,
            conference: null,
            enacted: null,
          },
          {
            fy: 2029,
            request: 10.56,
            hascMark: null,
            sascMark: null,
            hacDMark: null,
            sacDMark: null,
            conference: null,
            enacted: null,
          },
          {
            fy: 2030,
            request: 10.82,
            hascMark: null,
            sascMark: null,
            hacDMark: null,
            sacDMark: null,
            conference: null,
            enacted: null,
          },
          {
            fy: 2031,
            request: 11.53,
            hascMark: null,
            sascMark: null,
            hacDMark: null,
            sacDMark: null,
            conference: null,
            enacted: null,
          },
        ]),
      },
      programElementMilestone: { findMany: jest.fn(async () => []) },
    };

    test('labels the live request FY current and the FYDP years outyear (no FY27↔FY31 swap)', async () => {
      const service = new ProgramElementReadService(
        airDefenseTargetsPrisma as never,
        makeConferenceProbabilityService() as never,
      );
      const t = (await service.getTimeline('1242C93000')) as {
        currentCycleFy: number | null;
        appropriationType: string | null;
        years: Array<{ fy: number; cycle: string; current: number | null; currentStage: string }>;
      };

      // The current cycle is FY2027 — the latest FY carrying a congressional mark.
      expect(t.currentCycleFy).toBe(2027);
      expect(t.appropriationType).toBe('PROC');

      const byFy = new Map(t.years.map((y) => [y.fy, y]));
      // FY2027 = the live request ($9.61M via the HAC-D mark).
      expect(byFy.get(2027)?.cycle).toBe('current');
      expect(byFy.get(2027)?.current).toBe(9.61);
      // FY2031 = an OUTYEAR projection ($11.53M) — must NOT read as "the request".
      expect(byFy.get(2031)?.cycle).toBe('outyear');
      expect(byFy.get(2031)?.current).toBe(11.53);
      // FY2025 = historical.
      expect(byFy.get(2025)?.cycle).toBe('historical');
    });

    test('Phase G FundingClaim: zeros preserved; outyear flagged projection; no cross-stage mix on claim', async () => {
      const prisma = {
        ...airDefenseTargetsPrisma,
        programElementYear: {
          findMany: jest.fn(async () => [
            {
              fy: 2027,
              request: 0, // real zero request
              hascMark: 0,
              sascMark: null,
              hacDMark: null,
              sacDMark: null,
              conference: null,
              ndaaConference: null,
              enacted: null,
            },
            {
              fy: 2030,
              request: 50,
              hascMark: null,
              sascMark: null,
              hacDMark: null,
              sacDMark: null,
              conference: null,
              ndaaConference: null,
              enacted: null,
            },
          ]),
        },
      };
      const service = new ProgramElementReadService(
        prisma as never,
        makeConferenceProbabilityService() as never,
      );
      const t = (await service.getTimeline('ZEROPE')) as {
        currentCycleFy: number | null;
        years: Array<{
          fy: number;
          cycle: string;
          current: number | null;
          fundingClaim: {
            value: number | null;
            isProjection: boolean;
            cycleClass: string;
            legislativeVehicle: string;
            stage: string;
          };
          missingMarks: { hascMark: string; hacDMark: string };
        }>;
      };
      // Zero HASC mark makes 2027 the cycle FY (not latest-nonzero 2030).
      expect(t.currentCycleFy).toBe(2027);
      const cur = t.years.find((y) => y.fy === 2027)!;
      expect(cur.current).toBe(0);
      expect(cur.fundingClaim.value).toBe(0);
      expect(cur.fundingClaim.isProjection).toBe(false);
      expect(cur.fundingClaim.cycleClass).toBe('current');
      expect(cur.missingMarks.hascMark).toBe('present');
      const out = t.years.find((y) => y.fy === 2030)!;
      expect(out.cycle).toBe('outyear');
      expect(out.fundingClaim.isProjection).toBe(true);
      expect(out.fundingClaim.cycleClass).toBe('outyear');
      // Current request can never be the outyear claim.
            expect(out.fundingClaim.stage === 'request' && out.fundingClaim.cycleClass === 'current').toBe(
              false,
            );
          });

          test('B3: NDAA-only mark year is current cycle (hasMark includes ndaaConference)', async () => {
            const prisma = {
              programElement: {
                findUnique: jest.fn(async () => ({
                  peCode: 'NDAAONLY',
                  title: 'NDAA only',
                  service: 'NAVY',
                  appropriationType: 'RDT&E',
                  budgetActivity: 'BA2',
                  lineNumber: null,
                })),
              },
              programElementYear: {
                findMany: jest.fn(async () => [
                  {
                    fy: 2026,
                    request: 10,
                    hascMark: null,
                    sascMark: null,
                    hacDMark: null,
                    sacDMark: null,
                    conference: null,
                    ndaaConference: null,
                    enacted: null,
                  },
                  {
                    fy: 2027,
                    request: 12,
                    hascMark: null,
                    sascMark: null,
                    hacDMark: null,
                    sacDMark: null,
                    conference: null,
                    ndaaConference: 12.5,
                    enacted: null,
                  },
                  {
                    fy: 2028,
                    request: 14,
                    hascMark: null,
                    sascMark: null,
                    hacDMark: null,
                    sacDMark: null,
                    conference: null,
                    ndaaConference: null,
                    enacted: null,
                  },
                ]),
              },
              programElementMilestone: { findMany: jest.fn(async () => []) },
            };
            const service = new ProgramElementReadService(
              prisma as never,
              makeConferenceProbabilityService() as never,
            );
            const t = (await service.getTimeline('NDAAONLY')) as {
              currentCycleFy: number | null;
              years: Array<{ fy: number; cycle: string }>;
            };
            expect(t.currentCycleFy).toBe(2027);
            expect(t.years.find((y) => y.fy === 2027)?.cycle).toBe('current');
            expect(t.years.find((y) => y.fy === 2028)?.cycle).toBe('outyear');
          });
        });

        describe('getProgramElement B6 fundingSummary NDAA cycle', () => {
          test('NDAA-only year is current in detail fundingSummary (not request outyear)', async () => {
            const prisma = makePrisma({
              queryRawQueue: [[]],
              mvRows: [],
              peYears: [
                {
                  fy: 2027,
                  request: null,
                  hascMark: null,
                  sascMark: null,
                  hacDMark: null,
                  sacDMark: null,
                  conference: null,
                  ndaaConference: 12.5,
                  enacted: null,
                },
                {
                  fy: 2028,
                  request: 14,
                  hascMark: null,
                  sascMark: null,
                  hacDMark: null,
                  sacDMark: null,
                  conference: null,
                  ndaaConference: null,
                  enacted: null,
                },
              ],
              peFind: {
                peCode: 'NDAADET',
                title: 'NDAA detail',
                service: 'NAVY',
                budgetActivity: 'BA2',
                appropriationType: 'RDT&E',
                status: 'active',
                firstSeenFy: 2027,
                lastSyncedAt: new Date('2026-05-28T15:00:00.000Z'),
              },
            });
            const service = new ProgramElementReadService(
              prisma as never,
              makeConferenceProbabilityService() as never,
            );
            const detail = (await service.getProgramElement('NDAADET', ctx)) as unknown as {
              fundingSummary: string;
            };
            expect(detail.fundingSummary).toContain('FY27 [current budget cycle]');
            expect(detail.fundingSummary).toContain(
              'FY28 [OUTYEAR — FYDP projection, NOT the current request]',
            );
            expect(detail.fundingSummary).not.toMatch(/FY28 \[current budget cycle\]/);
          });
        });

        describe('listProgramElements B2 matched-pair deltaPct', () => {
          test('cross-FY latestRequest must not become delta base; ler pair drives %', async () => {
            const prisma = makePrisma({
              queryRawQueue: [
                [
                  {
                    peCode: 'CROSSFY',
                    title: 'Cross FY',
                    service: 'Army',
                    budgetActivity: 'BA3',
                    appropriationType: 'RDT&E',
                    status: 'active',
                    lastSyncedAt: new Date('2026-05-28T15:00:00.000Z'),
                    hasData: true,
                    watched: false,
                    billCount: 0,
                    latestRequest: 200, // FY2027 catalog-latest
                    latestRequestFy: 2027,
                    latestEnacted: 110,
                    latestEnactedFy: 2026,
                    requestAtEnactedFy: 100, // matched FY2026 request
                    latestCurrent: 200,
                    latestCurrentFy: 2027,
                    latestCurrentStage: 'request',
                    // SQL already used ler → 10%; TS must not null it because latestRequestFy differs,
                    // and must not recompute with bare latestRequest (that would be + -45%).
                    deltaPct: 10,
                    spark: null,
                    signalType: null,
                    signalScore: null,
                    signalDeltaPct: null,
                    lineType: null,
                    maturity: null,
                    appropTier: null,
                    appropScore: null,
                    actionSignalType: null,
                    actionSignalTone: null,
                    valleyOfDeath: null,
                    totalCount: 1,
                  },
                ],
              ],
            });
            const service = new ProgramElementReadService(
              prisma as never,
              makeConferenceProbabilityService() as never,
            );
            const result = await service.listProgramElements({ page: 1, limit: 25 });
            const row = result.data[0] as {
              deltaPct: number | null;
              latestRequest: number | null;
              latestRequestFy: number | null;
              latestEnactedFy: number | null;
              requestAtEnactedFy: number | null;
              comparableEnactedVsRequest: {
                fiscalYear: number;
                request: number;
                enacted: number;
                deltaPct: number | null;
              } | null;
            };
            expect(row.latestRequestFy).not.toBe(row.latestEnactedFy);
            expect(row.requestAtEnactedFy).toBe(100);
            expect(row.deltaPct).toBeCloseTo(10, 5);
            // Bare latestRequest must not be the % base: (110-200)/200 = -45.
            expect(row.deltaPct).not.toBeCloseTo(((110 - 200) / 200) * 100, 5);
            expect(row.comparableEnactedVsRequest?.fiscalYear).toBe(2026);
            expect(row.comparableEnactedVsRequest?.request).toBe(100);
            expect(row.comparableEnactedVsRequest?.deltaPct).toBeCloseTo(10, 5);
          });

          test('B5: list requestClaim outyear when latestRequestFy > pe mark-bearing cycle', async () => {
            const prisma = makePrisma({
              queryRawQueue: [
                [
                  {
                    peCode: 'OUTYEARLIST',
                    title: 'Outyear list',
                    service: 'Army',
                    budgetActivity: 'BA3',
                    appropriationType: 'RDT&E',
                    status: 'active',
                    lastSyncedAt: new Date('2026-05-28T15:00:00.000Z'),
                    hasData: true,
                    watched: false,
                    billCount: 0,
                    latestRequest: 50,
                    latestRequestFy: 2031,
                    latestEnacted: null,
                    latestEnactedFy: null,
                    requestAtEnactedFy: null,
                    latestCurrent: 50,
                    latestCurrentFy: 2031,
                    latestCurrentStage: 'request',
                    peCurrentCycleFy: 2027,
                    deltaPct: null,
                    spark: null,
                    signalType: null,
                    signalScore: null,
                    signalDeltaPct: null,
                    lineType: null,
                    maturity: null,
                    appropTier: null,
                    appropScore: null,
                    actionSignalType: null,
                    actionSignalTone: null,
                    valleyOfDeath: null,
                    totalCount: 1,
                  },
                ],
              ],
            });
            const service = new ProgramElementReadService(
              prisma as never,
              makeConferenceProbabilityService() as never,
            );
            const result = await service.listProgramElements({ page: 1, limit: 25 });
            const row = result.data[0] as {
              latestRequestFy: number;
              peCurrentCycleFy: number | null;
              requestClaim: {
                fiscalYear: number | null;
                cycleClass: string;
                isProjection: boolean;
              } | null;
              currentClaim: {
                fiscalYear: number | null;
                cycleClass: string;
                isProjection: boolean;
              } | null;
            };
            expect(row.latestRequestFy).toBe(2031);
            expect(row.peCurrentCycleFy).toBe(2027);
            expect(row.requestClaim?.fiscalYear).toBe(2031);
            expect(row.requestClaim?.cycleClass).toBe('outyear');
            expect(row.requestClaim?.isProjection).toBe(true);
            expect(row.currentClaim?.fiscalYear).toBe(2031);
            expect(row.currentClaim?.cycleClass).toBe('outyear');
            expect(row.currentClaim?.isProjection).toBe(true);
          });
        });
      });

function makeConferenceProbabilityService(
  prediction: {
    predicted: number;
    ciLow: number;
    ciHigh: number;
    confidence: number;
  } | null = null,
) {
  return {
    predict: jest.fn(async () => prediction),
  };
}

function makePrisma(options: {
  queryRawQueue: Array<Array<Record<string, unknown>>>;
  missingPe?: boolean;
  mvRows?: Array<Record<string, unknown>>;
  budgetPositions?: Array<Record<string, unknown>>;
  // Step 1.4 / 2.3 — needs-attention feed inputs.
  deltas?: Array<Record<string, unknown>>;
  tenantWatches?: Array<{ peCode: string }>;
  tenantCaps?: Array<{ peNumber: string | null }>;
  peFind?: Record<string, unknown>;
  peYears?: Array<Record<string, unknown>>;
}) {
  const queue = [...options.queryRawQueue];
  const mock = {
    queryRawCalls: 0,
    mvQueryRawCalls: 0,
    programElementFindUniqueCalls: 0,
    auditLogCalls: [] as Array<Record<string, unknown>>,
    rawSqlTexts: [] as string[],
  };

  return {
    __mock: mock,
    $queryRaw: jest.fn(async (query: unknown) => {
      const sql = query as { strings?: readonly string[] };
      const text = [...(sql.strings ?? [])].join('?');
      if (text.includes('FROM program_element_detail_mv')) {
        mock.mvQueryRawCalls += 1;
        return options.mvRows ?? [];
      }
      // Finder list path (no tenant) drains the same queue as withTenant list/markup.
      if (
        text.includes('"latestRequest"') ||
        text.includes('"requestAtEnactedFy"') ||
        text.includes('"divergencePct"') ||
        text.includes('WITH filtered AS')
      ) {
        mock.queryRawCalls += 1;
        return queue.shift() ?? [];
      }
      return [];
    }),
    programElement: {
      findUnique: jest.fn(async () => {
        mock.programElementFindUniqueCalls += 1;
        if (options.missingPe) return null;
        if (options.peFind) {
          return {
            ...options.peFind,
            years: options.peYears ?? [],
          };
        }
        return {
          peCode: '0603270A',
          title: 'Electronic Warfare Advanced Payloads',
          service: 'Army',
          budgetActivity: 'BA3',
          appropriationType: 'RDT&E',
          status: 'active',
          firstSeenFy: 2023,
          lastSyncedAt: new Date('2026-05-28T15:00:00.000Z'),
          years: options.peYears ?? [],
        };
      }),
    },
    programElementYear: {
      findMany: jest.fn(async () => [
        {
          id: 'year-1',
          peCode: '0603270A',
          fy: 2027,
          request: 278.5,
          hascMark: 290,
          sascMark: 284,
          hacDMark: 288,
          sacDMark: 281,
          conference: null,
          enacted: null,
          reprogrammed: null,
          executed: null,
          notes: 'Current cycle',
          rDocSection: 'FY2027 PB',
          raw: {},
          lastSyncedAt: new Date('2026-05-28T15:00:00.000Z'),
        },
      ]),
    },
    programElementMilestone: {
      findMany: jest.fn(async () => []),
    },
    // Step 1.2: getProgramElement now badges projectCount/sourceCount.
    programElementProject: {
      count: jest.fn(async () => 0),
    },
    programElementSource: {
      count: jest.fn(async () => 0),
    },
    // Step 1.3: budget positions (PB cycle + FYDP outyears).
    programElementBudgetPosition: {
      findMany: jest.fn(async () => options.budgetPositions ?? []),
    },
    // Step 1.4: cross-PE needs-attention feed reads live deltas globally.
    programElementDelta: {
      findMany: jest.fn(async () => options.deltas ?? []),
    },
    withTenant: jest.fn(
      async (
        _tenantId: string,
        fn: (tx: {
          $queryRaw: jest.Mock;
          auditLog: { create: jest.Mock };
          programElementWatch: { findMany: jest.Mock };
          clientCapability: { findMany: jest.Mock };
        }) => Promise<unknown>,
      ) => {
        return fn({
          $queryRaw: jest.fn(async (query: unknown) => {
            mock.queryRawCalls += 1;
            const sql = query as { strings?: readonly string[] };
            mock.rawSqlTexts.push([...(sql.strings ?? [])].join('?'));
            return queue.shift() ?? [];
          }),
          auditLog: {
            create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
              mock.auditLogCalls.push(data);
              return data;
            }),
          },
          // Tenant-scoped reads used by tenantRelevantPeCodes (Step 1.4 / 2.3).
          programElementWatch: {
            findMany: jest.fn(async () => options.tenantWatches ?? []),
          },
          clientCapability: {
            findMany: jest.fn(async () => options.tenantCaps ?? []),
          },
        });
      },
    ),
  };
}

/**
 * Step 2.3 — ClientPeRelevanceService mock. `relevantPes` is the set of PE codes the relevance
 * service reports as having at least one relevant client (≥0.5); any other PE returns [].
 */
function makeRelevanceService(relevantPes: string[] = []) {
  const set = new Set(relevantPes);
  return {
    getRelevantClientsForPe: jest.fn(async (_ctx: TenantContext, peCode: string) =>
      set.has(peCode)
        ? [{ clientId: 'relev-client', clientName: 'Relevant Co', score: 0.8, paths: [] }]
        : [],
    ),
  };
}
