import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { assertDisposableDatabase } from './disposable-database.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FirmPhasesService } from '../src/firm-phases/firm-phases.service.js';
import { ReferenceService } from '../src/reference/reference.service.js';

/**
 * DB-backed G4: firm-phase full-replace round-trip + reference fork-on-edit.
 * Self-skips without DATABASE_URL (ci-pr); runs in the DB-backed path. Requires
 * the sp_* migrations. Creates and removes its own baseline fixture in an
 * explicitly disposable local database; no global seed is required.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const suite = hasDb ? describe : describe.skip;

const TENANT = randomUUID();
const BASELINE_ID = randomUUID();
const USER = 'user_g4';

suite('G4 firm phases + reference fork (integration)', () => {
  let prisma: PrismaService;
  let firm: FirmPhasesService;
  let reference: ReferenceService;

  beforeAll(async () => {
    assertDisposableDatabase();
    prisma = new PrismaService();
    await prisma.onModuleInit();
    firm = new FirmPhasesService(prisma);
    reference = new ReferenceService(prisma);
    await prisma.withSystem(async (tx) => {
      await tx.spReferenceEntry.create({
        data: {
          id: BASELINE_ID,
          kind: 'congress_milestone',
          label: 'Owned integration baseline',
          startsOn: new Date('2027-01-01'),
          endsOn: new Date('2027-04-01'),
          tone: 'info',
          position: 0,
        },
      });
    });
  });

  beforeEach(async () => {
    await prisma.withSystem(async (tx) => {
      await tx.spFirmPhase.deleteMany({ where: { tenantId: TENANT } });
      await tx.spReferenceOverride.deleteMany({ where: { tenantId: TENANT } });
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.withSystem(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL app.allow_audit_purge = 'on'");
        await tx.spFirmPhase.deleteMany({ where: { tenantId: TENANT } });
        await tx.spReferenceOverride.deleteMany({ where: { tenantId: TENANT } });
        await tx.spActivityLog.deleteMany({ where: { tenantId: TENANT } });
        await tx.spReferenceEntry.deleteMany({ where: { id: BASELINE_ID } });
      });
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it('replaces the firm phase set atomically and re-orders by position', async () => {
    const out = await firm.replace(TENANT, USER, {
      rows: [
        { label: 'Strategy refresh', startFy: 2027, startQ: 1, endFy: 2027, endQ: 2 },
        { label: 'Submit asks', startFy: 2027, startQ: 2, endFy: 2028, endQ: 1 },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.label)).toEqual(['Strategy refresh', 'Submit asks']);
    expect(out.map((p) => p.position)).toEqual([0, 1]);

    // Replace again with fewer rows — old set is fully cleared, not merged.
    const out2 = await firm.replace(TENANT, USER, {
      rows: [{ label: 'Only phase', startFy: 2028, startQ: 1, endFy: 2028, endQ: 4 }],
    });
    expect(out2).toHaveLength(1);
    expect(out2[0]!.label).toBe('Only phase');

    // Empty clears entirely (LIB-3 unconfigured state).
    const out3 = await firm.replace(TENANT, USER, { rows: [] });
    expect(out3).toHaveLength(0);
  });

  it('forks a congress override that wins over the baseline, per-kind', async () => {
    const base = await reference.getCalendars(TENANT);
    expect(base.source.congress).toBe('baseline');
    expect(base.congress.length).toBeGreaterThan(0);

    const forked = await reference.fork(TENANT, USER, 'congress', {
      rows: [
        { label: 'Test markup', startsOn: '2027-06-01', endsOn: '2027-09-01', tone: 'success' },
      ],
    });
    expect(forked.source.congress).toBe('override');
    expect(forked.congress).toHaveLength(1);
    expect(forked.congress[0]!.label).toBe('Test markup');
    // PPBE lanes are a different kind — still baseline (fork is per-kind).
    expect(forked.source.ppbeLanes).toBe('baseline');
  });

  it('forks a PPBE current-phase override independently', async () => {
    await reference.fork(TENANT, USER, 'congress', {
      rows: [{ label: 'Independent congress fork', startsOn: '2027-06-01', endsOn: '2027-09-01' }],
    });
    const forked = await reference.fork(TENANT, USER, 'ppbe', {
      rows: [{ label: 'OSD review', fy: 2027 }],
    });
    expect(forked.source.ppbeCurrentPhases).toBe('override');
    expect(forked.ppbeCurrentPhases).toHaveLength(1);
    expect(forked.ppbeCurrentPhases[0]!.label).toBe('OSD review');
    expect(forked.ppbeCurrentPhases[0]!.fy).toBe(2027);
    // The earlier congress fork is untouched.
    expect(forked.source.congress).toBe('override');
  });
});
