/**
 * LegiWatch V2 Wave 2 — contract + tenant-isolation proof against a REAL
 * Postgres with the full apps/api AND apps/intel-api migration chains
 * applied (both services share one physical database — see
 * reference_capirov2_db_backed_testing). Covers W2-1's extension, W2-4, and
 * W2-5 end to end. (W2-2 Saved Views was removed; the table is dropped by
 * migration 20280916010000_drop_legiwatch_saved_view.)
 *
 * Gate: DATABASE_URL must point at the disposable PG. Skipped cleanly
 * otherwise, matching the posture of every sibling integration suite.
 */
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsService } from './live-hearings.service.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LegiWatchLifecycleNotificationService } from './legiwatch-lifecycle-notification.service.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';
import { LegiWatchWave2WatchPresetsService } from './legiwatch-wave2-watch-presets.service.js';
import { LegiWatchWave2CoverageService } from './legiwatch-wave2-coverage.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(180_000);

const TENANT_A = '00000000-0000-0000-0000-0000000000f1';
const TENANT_B = '00000000-0000-0000-0000-0000000000f2';
const CLIENT_A1 = '00000000-0000-0000-0000-00000000cf11';
const CLIENT_A2 = '00000000-0000-0000-0000-00000000cf12';
const CLIENT_B1 = '00000000-0000-0000-0000-00000000cf21';
const USER_A1 = 'lw-w2-user-a1';
const USER_A2 = 'lw-w2-user-a2';
const USER_B1 = 'lw-w2-user-b1';

const ctxA1: TenantContext = {
  tenantId: TENANT_A,
  tenantSlug: 'lw-w2-a',
  userId: USER_A1,
  clerkUserId: USER_A1,
  role: 'standard_user',
};
const ctxA2: TenantContext = { ...ctxA1, userId: USER_A2, clerkUserId: USER_A2 };
const ctxB1: TenantContext = {
  tenantId: TENANT_B,
  tenantSlug: 'lw-w2-b',
  userId: USER_B1,
  clerkUserId: USER_B1,
  role: 'standard_user',
};

const COMMITTEE = 'hs00-lww2';
const SUBCOMMITTEE = 'hs16-lww2';
const H_PARENT = 'lw-w2-h-parent'; // full-committee hearing, no subcommittee
const H_SUB = 'lw-w2-h-sub'; // convened by the subcommittee
const H_OTHER = 'lw-w2-h-other'; // unrelated committee — must never leak in
const OTHER_COMMITTEE = 'hs99-lww2other';
const INSIGHT_PARENT = 'lw-w2-insight-parent';
const INSIGHT_SUB = 'lw-w2-insight-sub';

describeDb('LegiWatch Wave 2 (real Postgres)', () => {
  const prisma = new PrismaService();
  const hearings = new LiveHearingsService(prisma);
  const committees = new CommitteeDirectoryService(prisma, hearings);
  const phase7 = new LiveHearingsPhase7Service(prisma, hearings, committees);
  const notifications = new LegiWatchLifecycleNotificationService(prisma);
  const wave1 = new LegiWatchWave1Service(prisma, phase7, committees, notifications);
  const watchPresets = new LegiWatchWave2WatchPresetsService(prisma);
  const coverage = new LegiWatchWave2CoverageService(prisma, hearings);

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE legiwatch_watch_backtest_job, legiwatch_watch_preset,
                tenant_hearing_relevance, public_hearing_intelligence_job,
                public_hearing_insight, public_hearing_transcript_segment,
                public_hearing_capture, committee_hearing,
                congress_bill, federal_register_document, program_element_delta,
                program_element, state_bill, sync_run, committee_source_exception,
                committee_source, clients
       CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `TRUNCATE intel_watchlist_term, intel_watchlist_topic, intel_watchlist CASCADE`,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1::uuid, 'lw-w2-a', 'Wave2 Tenant A'), ($2::uuid, 'lw-w2-b', 'Wave2 Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status) VALUES
         ($1::uuid, $4::uuid, 'Aperture Defense', 'active'),
         ($2::uuid, $4::uuid, 'Northwind Maritime', 'active'),
         ($3::uuid, $5::uuid, 'Beta Advocacy', 'active')
       ON CONFLICT (id) DO NOTHING`,
      CLIENT_A1,
      CLIENT_A2,
      CLIENT_B1,
      TENANT_A,
      TENANT_B,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO congress_committee (system_code, thomas_id, name, chamber, parent_system_code, url, is_current)
       VALUES ($1, 'HSW2A', 'Armed Services (wave2 test)', 'house', NULL, 'https://x', true),
              ($2, 'HS16W2', 'Seapower Subcommittee (wave2 test)', 'house', $1, 'https://y', true),
              ($3, 'HS99W2', 'Unrelated Committee (wave2 test)', 'house', NULL, 'https://z', true)
       ON CONFLICT (system_code) DO UPDATE SET name = EXCLUDED.name, is_current = true`,
      COMMITTEE,
      SUBCOMMITTEE,
      OTHER_COMMITTEE,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, committee_system_code, subcommittee_system_code,
          title, type, date, starts_at, event_status, visibility, witnesses,
          last_official_update_at, source_revision)
       VALUES
         ($1, 'House', 'HASC', $4, NULL, 'Full committee shipbuilding hearing', 'hearing',
          CURRENT_DATE - 5, now() - interval '5 days', 'completed', 'public',
          ARRAY['Jane Whitfield'], now() - interval '2 days', 3),
         ($2, 'House', 'HASC', $4, $5, 'Seapower subcommittee hearing', 'hearing',
          CURRENT_DATE - 3, now() - interval '3 days', 'completed', 'public',
          ARRAY[]::text[], now() - interval '1 day', 1),
         ($3, 'House', 'Unrelated', $6, NULL, 'Unrelated committee hearing', 'hearing',
          CURRENT_DATE - 2, now() - interval '2 days', 'completed', 'public',
          ARRAY[]::text[], now() - interval '2 days', 1)`,
      H_PARENT,
      H_SUB,
      COMMITTEE,
      COMMITTEE,
      SUBCOMMITTEE,
      OTHER_COMMITTEE,
    );

    // public_hearing_insight.capture_id / segment_id are required FKs — a
    // real capture + segment row must exist for each hearing before an
    // insight can reference it.
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_capture (id, hearing_id) VALUES ($1, $3), ($2, $4)`,
      'lw-w2-cap-parent',
      'lw-w2-cap-sub',
      H_PARENT,
      H_SUB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment
         (id, capture_id, sequence, start_ms, end_ms, text, is_final)
       VALUES ($1, 'lw-w2-cap-parent', 1, 0, 1000, 'seed text', true),
              ($2, 'lw-w2-cap-sub', 1, 0, 1000, 'seed text', true)`,
      'lw-w2-seg-parent',
      'lw-w2-seg-sub',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_insight
         (id, hearing_id, capture_id, segment_id, sequence, start_ms, end_ms, insight_type,
          title, summary, evidence_text, speaker_name, entities, extractor, extractor_version)
       VALUES
         ($1, $3, 'lw-w2-cap-parent', 'lw-w2-seg-parent', 1, 0, 1000, 'FUNDING_AMOUNT',
          'Parent finding', 'summary', 'evidence', 'Jane Whitfield',
          '[{"entityType":"AGENCY","label":"Department of the Navy","canonicalId":null},
            {"entityType":"BILL","label":"H.R. 1234","canonicalId":"119-hr-1234"}]'::jsonb,
          'x', '1.0'),
         ($2, $4, 'lw-w2-cap-sub', 'lw-w2-seg-sub', 1, 0, 1000, 'COMMITMENT',
          'Sub finding', 'summary', 'evidence', 'CHAIR', '[]'::jsonb, 'x', '1.0')`,
      INSIGHT_PARENT,
      INSIGHT_SUB,
      H_PARENT,
      H_SUB,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenant_hearing_relevance
         (id, tenant_id, client_id, client_name, hearing_id, insight_id, score, matched_on, rationale, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'Aperture Defense', $3, $4, 0.9, '[]'::jsonb, 'r', now() - interval '1 day')`,
      TENANT_A,
      CLIENT_A1,
      H_PARENT,
      INSIGHT_PARENT,
    );
  });

  // ── W2-1 · Committee Intelligence History extension ──────────────────────

  describe('W2-1 committee intelligence history extension', () => {
    it('exact committee EXCLUDES subcommittee-convened hearings by default', async () => {
      const result = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {})) as {
        rows: Array<{ hearingId: string }>;
      };
      expect(result.rows.map((r) => r.hearingId)).toEqual([INSIGHT_PARENT_HEARING()]);
    });

    it('includeSubcommittees widens to the subcommittee’s own hearings too', async () => {
      const result = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        includeSubcommittees: true,
      })) as { rows: Array<{ hearingId: string }> };
      expect(result.rows.map((r) => r.hearingId).sort()).toEqual([H_PARENT, H_SUB].sort());
    });

    it('viewing the subcommittee directly returns its own hearing either way', async () => {
      const result = (await wave1.committeeIntelligenceHistory(ctxA1, SUBCOMMITTEE, {})) as {
        rows: Array<{ hearingId: string }>;
      };
      expect(result.rows.map((r) => r.hearingId)).toEqual([H_SUB]);
    });

    it('never leaks an unrelated committee’s intelligence', async () => {
      const result = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        includeSubcommittees: true,
      })) as { rows: Array<{ hearingId: string }> };
      expect(result.rows.map((r) => r.hearingId)).not.toContain(H_OTHER);
    });

    it('filters by date range', async () => {
      const future = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        dateFrom: '2099-01-01',
      })) as { rows: unknown[] };
      expect(future.rows).toHaveLength(0);
    });

    it('filters by speaker', async () => {
      const result = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        speaker: 'Whitfield',
      })) as { rows: Array<{ id: string }> };
      expect(result.rows.map((r) => r.id)).toEqual([INSIGHT_PARENT]);
    });

    it('filters by agency via the entities array, not entityType exactness', async () => {
      const result = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        agency: 'Navy',
      })) as { rows: Array<{ id: string }> };
      expect(result.rows.map((r) => r.id)).toEqual([INSIGHT_PARENT]);
    });

    it('filters by bill reference', async () => {
      const result = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        bill: 'H.R. 1234',
      })) as { rows: Array<{ id: string }> };
      expect(result.rows.map((r) => r.id)).toEqual([INSIGHT_PARENT]);
    });

    it('filters by client relevance and respects tenant isolation', async () => {
      const forA1 = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        clientId: CLIENT_A1,
        relevanceBand: 'HIGH',
      })) as { rows: Array<{ id: string }> };
      expect(forA1.rows.map((r) => r.id)).toEqual([INSIGHT_PARENT]);

      await expect(
        wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, { clientId: CLIENT_B1 }),
      ).rejects.toThrow(/Client not found/);
    });

    it('paginates with a stable keyset cursor across concurrent inserts', async () => {
      const page1 = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        includeSubcommittees: true,
        pageSize: 1,
      })) as { rows: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
      expect(page1.rows).toHaveLength(1);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeTruthy();

      // A new insight lands ABOVE the window while the caller holds page 1's
      // cursor — an offset page would now duplicate or skip a row; a keyset
      // cursor cannot, because it is anchored to the row already returned.
      await prisma.$executeRawUnsafe(
        `INSERT INTO public_hearing_insight
           (id, hearing_id, capture_id, segment_id, sequence, start_ms, end_ms, insight_type,
            title, summary, extractor, extractor_version)
         VALUES ('lw-w2-insight-new', $1, 'lw-w2-cap-sub', 'lw-w2-seg-sub', 2, 0, 1000, 'MENTION', 'New', 's', 'x', '1.0')`,
        H_SUB,
      );

      const page2 = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {
        includeSubcommittees: true,
        pageSize: 1,
        cursor: page1.nextCursor!,
      })) as { rows: Array<{ id: string }>; hasMore: boolean };
      // Page 2 must be the row strictly after page 1's last row by the
      // ORIGINAL ordering — never page 1's row repeated, and never the
      // newly-inserted row jumping the queue.
      expect(page2.rows.map((r) => r.id)).not.toEqual(page1.rows.map((r) => r.id));
      expect(page2.rows[0]!.id).not.toBe('lw-w2-insight-new');
    });

    it('reports pendingExtractionJobs so PROCESSING never reads as empty', async () => {
      // A DB trigger (public_hearing_transcript_segment_intelligence_enqueue)
      // auto-creates a pending public_hearing_intelligence_job row whenever a
      // final transcript segment is inserted — the beforeEach's segment
      // inserts already did this, so there is nothing further to seed here.
      const result = (await wave1.committeeIntelligenceHistory(ctxA1, COMMITTEE, {})) as {
        corpus: { pendingExtractionJobs: number };
      };
      expect(result.corpus.pendingExtractionJobs).toBeGreaterThan(0);
    });
  });

  // ── W2-4 · Watch Presets + backtest ───────────────────────────────────────

  describe('W2-4 watch presets + backtest', () => {
    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO congress_bill (id, congress, bill_type, bill_number, title, latest_action_date, status, status_at)
         VALUES ('119-hr-9001', 119, 'hr', '9001', 'Submarine Industrial Base Act',
                 CURRENT_DATE - 2, 'committee', now() - interval '2 days')`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO program_element (pe_code, title, source) VALUES ('0101110F', 'Submarine Combat System', 'test-fixture')`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO program_element_delta
           (id, pe_code, asserted_fy, delta_type, materiality_score, delta_pct, explanation, computed_at)
         VALUES (gen_random_uuid(), '0101110F', 2027, 'mark_change', 0.8, 0.15,
                 'Funding increased 15% at HASC markup', now() - interval '1 day')`,
      );
    });

    it('creates, lists, updates, and changes lifecycle status', async () => {
      const created = (await watchPresets.create(ctxA1, {
        name: 'Submarine watch',
        clientIds: [CLIENT_A1],
        signalFamilies: ['bill', 'program_element'],
        conditions: [{ type: 'KEYWORD_MATCH', family: 'bill', keyword: 'submarine' }],
      })) as { id: string; status: string };
      expect(created.status).toBe('active');

      const paused = (await watchPresets.setStatus(ctxA1, created.id, 'paused')) as {
        status: string;
      };
      expect(paused.status).toBe('paused');

      const updated = (await watchPresets.update(ctxA1, created.id, { name: 'Renamed watch' })) as {
        name: string;
      };
      expect(updated.name).toBe('Renamed watch');

      const listed = (await watchPresets.list(ctxA1)) as { rows: Array<{ id: string }> };
      expect(listed.rows.map((r) => r.id)).toContain(created.id);
    });

    it('rejects CLIENT_RELEVANCE_HIGH with no client scope', async () => {
      await expect(
        watchPresets.create(ctxA1, {
          name: 'x',
          clientIds: [],
          signalFamilies: ['hearing'],
          conditions: [{ type: 'CLIENT_RELEVANCE_HIGH' }],
        }),
      ).rejects.toThrow(/requires the preset to name at least one client/);
    });

    it('rejects a client id from another tenant', async () => {
      await expect(
        watchPresets.create(ctxA1, {
          name: 'x',
          clientIds: [CLIENT_B1],
          signalFamilies: ['hearing'],
          conditions: [],
        }),
      ).rejects.toThrow(/do not belong to this tenant/);
    });

    it('A cannot read or update B’s preset; B cannot infer it exists', async () => {
      const created = (await watchPresets.create(ctxA1, {
        name: 'A only',
        clientIds: [],
        signalFamilies: ['bill'],
        conditions: [],
      })) as { id: string };
      await expect(watchPresets.get(ctxB1, created.id)).rejects.toThrow(/not found/);
      await expect(watchPresets.update(ctxB1, created.id, { name: 'hijack' })).rejects.toThrow(
        /not found/,
      );
    });

    it('backtests a real KEYWORD_MATCH against real historical bill data', async () => {
      const result = (await watchPresets.submitBacktest(ctxA1, {
        clientIds: [],
        signalFamilies: ['bill'],
        conditions: [{ type: 'KEYWORD_MATCH', family: 'bill', keyword: 'submarine' }],
        windowDays: 30,
      })) as {
        status: string;
        result: { totalMatched: number; sampleMatches: Array<{ canonicalObject: { id: string } }> };
      };
      expect(result.status).toBe('completed');
      expect(result.result.totalMatched).toBe(1);
      expect(result.result.sampleMatches[0]!.canonicalObject.id).toBe('119-hr-9001');
    });

    it('backtests a real FUNDING_MOVEMENT using the delta timestamp, not the sync timestamp', async () => {
      const result = (await watchPresets.submitBacktest(ctxA1, {
        clientIds: [],
        signalFamilies: ['program_element'],
        conditions: [{ type: 'FUNDING_MOVEMENT', minMaterialityScore: 0.5 }],
        windowDays: 30,
      })) as {
        result: { totalMatched: number; corpusCoverage: Record<string, { evaluated: boolean }> };
      };
      expect(result.result.totalMatched).toBe(1);
      expect(result.result.corpusCoverage.program_element!.evaluated).toBe(true);
    });

    it('backtests CLIENT_RELEVANCE_HIGH scoped to the preset’s own clients only', async () => {
      const result = (await watchPresets.submitBacktest(ctxA1, {
        clientIds: [CLIENT_A1],
        signalFamilies: ['hearing'],
        conditions: [{ type: 'CLIENT_RELEVANCE_HIGH' }],
        windowDays: 30,
      })) as { result: { totalMatched: number } };
      expect(result.result.totalMatched).toBe(1);
    });

    it('reports UNSUPPORTED — never a fabricated zero — for an unevaluable condition/family pair', async () => {
      const result = (await watchPresets.submitBacktest(ctxA1, {
        clientIds: [],
        signalFamilies: ['regulation'],
        conditions: [{ type: 'STATUS_CHANGE', family: 'regulation' }],
        windowDays: 30,
      })) as {
        result: {
          totalMatched: number;
          unknownOrUnsupportedConditions: Array<{ reason: string }>;
        };
      };
      expect(result.result.unknownOrUnsupportedConditions).toHaveLength(1);
      expect(result.result.unknownOrUnsupportedConditions[0]!.reason).toMatch(/not supported/);
    });

    it('is deterministic for the same snapshot and query version', async () => {
      const input = {
        clientIds: [],
        signalFamilies: ['bill'] as const,
        conditions: [
          { type: 'KEYWORD_MATCH' as const, family: 'bill' as const, keyword: 'submarine' },
        ],
        windowDays: 30,
      };
      const first = (await watchPresets.submitBacktest(ctxA1, {
        ...input,
        signalFamilies: [...input.signalFamilies],
      })) as {
        result: { totalMatched: number; queryVersion: string };
      };
      const second = (await watchPresets.submitBacktest(ctxA1, {
        ...input,
        signalFamilies: [...input.signalFamilies],
      })) as {
        result: { totalMatched: number; queryVersion: string };
      };
      expect(second.result.totalMatched).toBe(first.result.totalMatched);
      expect(second.result.queryVersion).toBe(first.result.queryVersion);
    });

    it('produces ZERO side effects on any sensitive table', async () => {
      const sensitiveTables = [
        'hearing_follow',
        'hearing_subscription',
        'public_hearing_capture',
        'legiwatch_notification_event',
        'intel_alert',
      ];
      const before = new Map<string, number>();
      for (const t of sensitiveTables) {
        const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*)::int AS count FROM ${t}`,
        );
        before.set(t, Number(row!.count));
      }

      await watchPresets.submitBacktest(ctxA1, {
        clientIds: [CLIENT_A1],
        signalFamilies: ['bill', 'hearing', 'program_element'],
        conditions: [
          { type: 'KEYWORD_MATCH', family: 'bill', keyword: 'submarine' },
          { type: 'FUNDING_MOVEMENT' },
          { type: 'CLIENT_RELEVANCE_HIGH' },
        ],
        windowDays: 30,
      });

      for (const t of sensitiveTables) {
        const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*)::int AS count FROM ${t}`,
        );
        expect(Number(row!.count)).toBe(before.get(t));
      }
    });

    it('claims an immediate job when Prisma default timestamps use an ahead application clock', async () => {
      const [before] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
      const appNow = new Date(before!.now.getTime() + 60 * 60 * 1000);
      const clockedPrisma = new PrismaService();
      // Model the observed Prisma @default(now()) behavior at its write
      // boundary, without moving PostgreSQL's clock or bypassing claim SQL.
      clockedPrisma.$use(async (params, next) => {
        if (params.model === 'LegiWatchWatchBacktestJob' && params.action === 'create') {
          params.args.data.createdAt = appNow;
          params.args.data.dueAt ??= appNow;
        }
        return next(params);
      });
      try {
        const service = new LegiWatchWave2WatchPresetsService(clockedPrisma);
        const job = (await service.submitBacktest(ctxA1, {
          clientIds: [],
          signalFamilies: ['bill'],
          conditions: [],
          windowDays: 30,
        })) as { id: string; status: string };
        expect(job.status).toBe('completed');
        const row = await prisma.withTenant(TENANT_A, (tx) =>
          tx.legiWatchWatchBacktestJob.findUniqueOrThrow({ where: { id: job.id } }),
        );
        const [after] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
        expect(row.createdAt).toEqual(appNow);
        expect(row.dueAt.getTime()).toBeGreaterThanOrEqual(before!.now.getTime());
        expect(row.dueAt.getTime()).toBeLessThanOrEqual(after!.now.getTime());
        expect(row.attempts).toBe(1);
      } finally {
        await clockedPrisma.$disconnect();
      }
    });

    it('preserves retry deadlines, active leases and the attempt cap when claiming jobs', async () => {
      const job = (await watchPresets.submitBacktest(ctxA1, {
        clientIds: [],
        signalFamilies: ['bill'],
        conditions: [],
        windowDays: 30,
      })) as { id: string; status: string };
      expect(job.status).toBe('completed');

      await prisma.$executeRaw`
        UPDATE legiwatch_watch_backtest_job
        SET status='failed', attempts=1, due_at=now() + interval '1 day',
            result=NULL, completed_at=NULL
        WHERE id=${job.id}::uuid`;
      expect(await watchPresets.claimAndRun(TENANT_A, job.id, 'retry-worker'))
        .toMatchObject({ status: 'failed' });

      await prisma.$executeRaw`
        UPDATE legiwatch_watch_backtest_job
        SET status='leased', lease_owner='other-worker',
            lease_expires_at=now() + interval '1 day'
        WHERE id=${job.id}::uuid`;
      expect(await watchPresets.claimAndRun(TENANT_A, job.id, 'retry-worker'))
        .toMatchObject({ status: 'leased' });
      const active = await prisma.withTenant(TENANT_A, (tx) =>
        tx.legiWatchWatchBacktestJob.findUniqueOrThrow({ where: { id: job.id } }),
      );
      expect(active.leaseOwner).toBe('other-worker');
      expect(active.attempts).toBe(1);

      await prisma.$executeRaw`
        UPDATE legiwatch_watch_backtest_job
        SET lease_expires_at=now() - interval '1 second'
        WHERE id=${job.id}::uuid`;
      expect(await watchPresets.claimAndRun(TENANT_A, job.id, 'retry-worker'))
        .toMatchObject({ status: 'completed' });
      const reclaimed = await prisma.withTenant(TENANT_A, (tx) =>
        tx.legiWatchWatchBacktestJob.findUniqueOrThrow({ where: { id: job.id } }),
      );
      expect(reclaimed.attempts).toBe(2);

      await prisma.$executeRaw`
        UPDATE legiwatch_watch_backtest_job
        SET status='failed', attempts=5, due_at=now() - interval '1 day'
        WHERE id=${job.id}::uuid`;
      expect(await watchPresets.claimAndRun(TENANT_A, job.id, 'retry-worker'))
        .toMatchObject({ status: 'failed' });
    });

    it('never generates a fake preview record for zero real matches', async () => {
      const result = (await watchPresets.submitBacktest(ctxA1, {
        clientIds: [],
        signalFamilies: ['bill'],
        conditions: [{ type: 'KEYWORD_MATCH', family: 'bill', keyword: 'zzz-no-such-bill-zzz' }],
        windowDays: 30,
      })) as { result: { totalMatched: number; sampleMatches: unknown[] } };
      expect(result.result.totalMatched).toBe(0);
      expect(result.result.sampleMatches).toEqual([]);
    });

    it('bounds the window to the maximum even if a caller asks for more', async () => {
      // DTO-level Max(90) would already reject 9999; the service clamps too as
      // defense in depth for any caller that bypasses the DTO.
      const result = (await watchPresets.submitBacktest(ctxA1, {
        clientIds: [],
        signalFamilies: ['bill'],
        conditions: [{ type: 'KEYWORD_MATCH', family: 'bill', keyword: 'submarine' }],
        windowDays: 9999,
      })) as { result: { evaluatedFrom: string; evaluatedTo: string } };
      const spanDays =
        (new Date(result.result.evaluatedTo).getTime() -
          new Date(result.result.evaluatedFrom).getTime()) /
        86_400_000;
      expect(spanDays).toBeLessThanOrEqual(90.01);
    });
  });

  // ── W2-5 · watchlist coverage ─────────────────────────────────────────────

  describe('W2-5 watchlist coverage', () => {
    it('returns NOT_CONFIGURED — never 0% — with no configured concepts', async () => {
      const result = await coverage.watchlistCoverage(TENANT_A, CLIENT_A1);
      expect(result.overall.status).toBe('NOT_CONFIGURED');
      expect(result.overall.percentage).toBeNull();
      expect(result.overall.totalConcepts).toBe(0);
    });

    it('reports a covered concept with an explicit numerator/denominator', async () => {
      await seedWatchlistTopic(TENANT_A, CLIENT_A1, 'Submarine industrial base', [
        { termType: 'bill', value: 'submarine' },
      ]);
      await prisma.$executeRawUnsafe(
        `INSERT INTO sync_run (id, source, started_at, finished_at, status)
         VALUES (gen_random_uuid(), 'sync-congress', now(), now(), 'success')`,
      );
      const result = await coverage.watchlistCoverage(TENANT_A, CLIENT_A1);
      expect(result.overall.totalConcepts).toBe(1);
      expect(result.overall.coveredConcepts).toBe(1);
      expect(result.overall.percentage).toBe(100);
      expect(result.overall.status).toBe('COVERED');
      expect(result.concepts[0]!.signalFamilies).toEqual(['bill']);
    });

    it('reports STALE when the family sync is older than the freshness threshold', async () => {
      await seedWatchlistTopic(TENANT_A, CLIENT_A1, 'Old data concept', [
        { termType: 'bill', value: 'x' },
      ]);
      await prisma.$executeRawUnsafe(
        `INSERT INTO sync_run (id, source, started_at, finished_at, status)
         VALUES (gen_random_uuid(), 'sync-congress', now() - interval '30 days', now() - interval '30 days', 'success')`,
      );
      const result = await coverage.watchlistCoverage(TENANT_A, CLIENT_A1);
      expect(result.concepts[0]!.status).toBe('STALE');
      expect(result.overall.status).not.toBe('COVERED');
    });

    it('reports UNSUPPORTED for a term type with no known signal-family mapping, not a guess', async () => {
      await seedWatchlistTopic(TENANT_A, CLIENT_A1, 'Risk phrase concept', [
        { termType: 'risk_phrase', value: 'material weakness' },
      ]);
      const result = await coverage.watchlistCoverage(TENANT_A, CLIENT_A1);
      expect(result.concepts[0]!.status).toBe('UNSUPPORTED');
      expect(result.concepts[0]!.signalFamilies).toEqual([]);
    });

    it('reuses the EXISTING CommitteeSource system for hearing-family source health', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO committee_source (id, chamber, source_type, source_url, adapter_key, source_health, last_success_at)
         VALUES (gen_random_uuid(), 'house', 'CONGRESS_GOV', 'https://x', 'x', 'healthy', now())`,
      );
      await seedWatchlistTopic(TENANT_A, CLIENT_A1, 'Committee concept', [
        { termType: 'committee', value: 'Armed Services' },
      ]);
      const result = await coverage.watchlistCoverage(TENANT_A, CLIENT_A1);
      expect(result.sourceHealth.healthy).toBeGreaterThan(0);
      expect(result.concepts[0]!.status).toBe('COVERED');
    });

    it('Tenant A cannot request Tenant B client coverage', async () => {
      await expect(coverage.watchlistCoverage(TENANT_A, CLIENT_B1)).rejects.toThrow(
        /Client not found/,
      );
    });

    it('Tenant B cannot infer Tenant A’s configured concepts via its own client', async () => {
      await seedWatchlistTopic(TENANT_A, CLIENT_A1, 'Tenant A concept', [
        { termType: 'bill', value: 'x' },
      ]);
      const result = await coverage.watchlistCoverage(TENANT_B, CLIENT_B1);
      expect(result.overall.status).toBe('NOT_CONFIGURED');
      expect(JSON.stringify(result)).not.toContain('Tenant A concept');
    });
  });

  // ── shared helpers ─────────────────────────────────────────────────────────

  function INSIGHT_PARENT_HEARING(): string {
    return H_PARENT;
  }

  async function seedWatchlistTopic(
    tenantId: string,
    clientId: string,
    label: string,
    terms: Array<{ termType: string; value: string }>,
  ): Promise<void> {
    const watchlistId = `wl-${clientId}`;
    const topicId = `topic-${label.replace(/\s+/g, '-').toLowerCase()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO intel_watchlist (id, tenant_id, client_id, name, active, created_by, updated_at)
       VALUES ($1, $2::uuid, $3::uuid, 'Watchlist', true, 'system', now())
       ON CONFLICT (id) DO NOTHING`,
      watchlistId,
      tenantId,
      clientId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO intel_watchlist_topic (id, watchlist_id, tenant_id, label)
       VALUES ($1, $2, $3::uuid, $4)`,
      topicId,
      watchlistId,
      tenantId,
      label,
    );
    for (const [i, term] of terms.entries()) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO intel_watchlist_term (id, watchlist_id, tenant_id, term_type, value, topic_id)
         VALUES ($1, $2, $3::uuid, $4, $5, $6)`,
        `${topicId}-term-${i}`,
        watchlistId,
        tenantId,
        term.termType,
        term.value,
        topicId,
      );
    }
  }
});
