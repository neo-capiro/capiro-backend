import { BadRequestException } from '@nestjs/common';
import { ProgramContinuityService } from './program-continuity.service.js';

function edge(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    programId: '00000000-0000-4000-8000-000000000101',
    canonicalName: 'Program A',
    identityKind: 'pe',
    sourceSystem: 'dod-jbook',
    sourceIdentifier: '0207134N',
    relationshipKind: 'same_as',
    validFromFy: 2024,
    validToFy: null,
    recordedAt: new Date('2026-09-01T00:00:00.000Z'),
    supersedesId: null,
    source: 'official exhibit',
    sourceUrl: 'https://example.test/r2.pdf',
    sourceDocumentId: '00000000-0000-4000-8000-000000000201',
    evidence: { page: 12, excerpt: 'Program A' },
    confidence: 0.99,
    reviewStatus: 'accepted',
    reviewedAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  };
}

function makeService(rows: unknown[] = []) {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue(rows) };
  return { service: new ProgramContinuityService(prisma as never), prisma };
}

describe('ProgramContinuityService', () => {
  it('returns a multi-year identity path with source evidence and the validity interval', async () => {
    const { service, prisma } = makeService([edge()]);
    const result = await service.list({ asOfFy: 2025, knownAt: '2026-09-10T00:00:00.000Z' });
    expect(result.data[0]).toMatchObject({
      sourceIdentity: { kind: 'pe', identifier: '0207134N' },
      validTime: { fromFy: 2024, toFy: null },
      provenance: { source: 'official exhibit', sourceDocumentId: '00000000-0000-4000-8000-000000000201' },
      review: { status: 'accepted' },
    });
    expect(result.data[0]!.path).toHaveLength(2);
    expect(prisma.$queryRaw.mock.calls[0][0].sql).toContain('valid_from_fy');
    expect(prisma.$queryRaw.mock.calls[0][0].sql).toContain('NOT EXISTS');
  });

  it('resolves a source alias transition by fiscal year', async () => {
    const early = edge({ sourceIdentifier: 'PE-OLD', validFromFy: 2020, validToFy: 2025 });
    const late = edge({
      id: '00000000-0000-4000-8000-000000000002',
      sourceIdentifier: 'PE-NEW',
      validFromFy: 2026,
      validToFy: null,
    });
    const prisma = {
      $queryRaw: jest.fn(async (statement: { values: unknown[] }) => {
        const fy = statement.values.find((value) => typeof value === 'number');
        return [fy && fy <= 2025 ? early : late];
      }),
    };
    const service = new ProgramContinuityService(prisma as never);
    const fy2025 = await service.list({ asOfFy: 2025, knownAt: '2026-09-10T00:00:00.000Z' });
    const fy2026 = await service.list({ asOfFy: 2026, knownAt: '2026-09-10T00:00:00.000Z' });
    expect(fy2025.data[0]!.sourceIdentity.identifier).toBe('PE-OLD');
    expect(fy2026.data[0]!.sourceIdentity.identifier).toBe('PE-NEW');
  });

  it('preserves split fanout as separate edges to multiple programs', async () => {
    const { service } = makeService([
      edge({ relationshipKind: 'split_from', validToFy: 2025 }),
      edge({
        id: '00000000-0000-4000-8000-000000000002',
        programId: '00000000-0000-4000-8000-000000000102',
        canonicalName: 'Program B',
        relationshipKind: 'split_from',
        validFromFy: 2026,
      }),
    ]);
    const result = await service.list({ asOfFy: 2026 });
    expect(result.data.map((row) => row.program.canonicalName)).toEqual(['Program A', 'Program B']);
    expect(result.data.map((row) => row.sourceIdentity.identifier)).toEqual(['0207134N', '0207134N']);
  });

  it('queries revisions as known at the requested system time', async () => {
    const old = edge({
      recordedAt: new Date('2026-09-01T00:00:00.000Z'),
      evidence: { page: 12, excerpt: 'first published mapping' },
    });
    const corrected = edge({
      id: '00000000-0000-4000-8000-000000000002',
      recordedAt: new Date('2026-09-20T00:00:00.000Z'),
      supersedesId: old.id,
      evidence: { page: 13, excerpt: 'corrected mapping' },
    });
    const prisma = {
      $queryRaw: jest.fn(async (statement: { values: unknown[] }) => {
        const knownAt = statement.values.find((value) => value instanceof Date) as Date;
        const head = knownAt < corrected.recordedAt ? old : corrected;
        return [head];
      }),
    };
    const service = new ProgramContinuityService(prisma as never);
    const before = await service.list({ asOfFy: 2026, knownAt: '2026-09-10T00:00:00.000Z' });
    const after = await service.list({ asOfFy: 2026, knownAt: '2026-09-25T00:00:00.000Z' });
    expect(before.data[0]!.evidence).toMatchObject({ excerpt: 'first published mapping' });
    expect(after.data[0]!.evidence).toMatchObject({ excerpt: 'corrected mapping' });
    expect((prisma.$queryRaw.mock.calls[1]![0] as unknown as { sql: string }).sql).toContain('newer.recorded_at <=');
  });

  it('keeps candidates hidden by default and only exposes them with explicit opt-in', async () => {
    const { service, prisma } = makeService([]);
    await service.list({ asOfFy: 2026 });
    expect(prisma.$queryRaw.mock.calls[0][0].sql).toContain("review_status = 'accepted'");
    await service.list({ asOfFy: 2026, includeCandidates: true });
    expect(prisma.$queryRaw.mock.calls[1][0].sql).toContain("review_status IN ('accepted', 'candidate')");
  });

  it('rejects malformed and query-mismatched cursors', async () => {
    const { service, prisma } = makeService();
    await expect(service.list({ asOfFy: 2026, cursor: 'not-base64-json' })).rejects.toBeInstanceOf(BadRequestException);
    const cursor = Buffer.from(JSON.stringify({
      v: 1,
      asOfFy: 2025,
      knownAt: new Date().toISOString(),
      includeCandidates: false,
      recordedAt: new Date().toISOString(),
      id: '00000000-0000-4000-8000-000000000001',
    })).toString('base64url');
    await expect(service.list({ asOfFy: 2026, cursor })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns no dollar or funding allocation semantics', async () => {
    const { service } = makeService([edge()]);
    const result = await service.list({ asOfFy: 2026 });
    expect(result.attribution).toBe('identity_relationship_only');
    expect(JSON.stringify(result)).not.toMatch(/amount|dollar|funding|allocation/i);
  });

  it('limits results and emits a cursor scoped to the temporal query', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => edge({
      id: `00000000-0000-4000-8000-00000000000${i + 1}`,
      recordedAt: new Date(`2026-09-0${i + 1}T00:00:00.000Z`),
    }));
    const { service } = makeService(rows);
    const result = await service.list({ asOfFy: 2026, limit: 2 });
    expect(result.data).toHaveLength(2);
    expect(result.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(decoded.asOfFy).toBe(2026);
  });

  it('pins default knownAt from a cursor so the following page uses the same snapshot', async () => {
    const firstRows = Array.from({ length: 2 }, (_, i) => edge({
      id: `00000000-0000-4000-8000-00000000000${i + 1}`,
      recordedAt: new Date(`2026-09-0${i + 1}T00:00:00.000Z`),
    }));
    const { service, prisma } = makeService(firstRows);
    const first = await service.list({ asOfFy: 2026, limit: 1 });
    await service.list({ asOfFy: 2026, limit: 1, cursor: first.nextCursor! });
    const firstSql = prisma.$queryRaw.mock.calls[0][0];
    const secondSql = prisma.$queryRaw.mock.calls[1][0];
    expect(firstSql.values[0]).toEqual(secondSql.values[0]);
    expect(secondSql.sql).toContain('x.recorded_at <');
  });
});
