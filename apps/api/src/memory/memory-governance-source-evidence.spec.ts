import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { readGovernedMemorySourceEvidence } from './memory-governance-source-evidence.helpers.js';
import { MemoryGovernanceReadService } from './memory-governance-read.service.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: jest.fn() }));
jest.mock('./memory-authorization.service.js', () => ({ MemoryAuthorizationService: jest.fn() }));
jest.mock('./memory-candidate-review.service.js', () => ({
  MemoryCandidateReviewService: jest.fn(),
}));
jest.mock('./memory-governance-center.switch.js', () => ({
  memoryGovernanceCenterEnabled: () => true,
}));

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'user_admin',
} as TenantContext;
const clientId = '33333333-3333-4333-8333-333333333333';
const signalId = '44444444-4444-4444-8444-444444444444';
const memory = {
  sourceType: 'learning_signal_capture',
  sourceId: signalId,
  clientId,
  memoryScope: 'client',
};
const accepted = {
  tenantId: ctx.tenantId,
  clientId,
  signalId,
  findingId: '55555555-5555-4555-8555-555555555555',
  runId: '66666666-6666-4666-8666-666666666666',
  status: 'accepted',
  proposedValue: { name: 'FortressHUMS', platforms: ['UH-72'], testAircraft: 2 },
  evidence: [
    {
      label: 'Source letter',
      url: 'https://example.test/letter',
      body: 'PRIVATE BODY NOT FOR PROJECTION',
    },
    { label: 'Unsafe', url: 'javascript:alert(1)' },
    { label: 'Credentials', url: 'https://user:secret@example.test/private' },
    { messageBody: 'PRIVATE MESSAGE' },
  ],
  reviewedAt: new Date('2026-08-25T12:00:00Z'),
};

function setup(row: unknown = accepted, allowed = true) {
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed }]),
    $queryRaw: jest.fn().mockResolvedValue(row ? [row] : []),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  };
  return { tx, read: () => readGovernedMemorySourceEvidence(tx as never, ctx, memory) };
}

describe('governed memory original CRM source recovery', () => {
  it('recovers exact structured facts with only bounded safe links and no mutation', async () => {
    const m = setup();
    const result = await m.read();
    expect(result).toMatchObject({
      status: 'available',
      findingId: accepted.findingId,
      runId: accepted.runId,
      factText: 'name: FortressHUMS; platforms: ["UH-72"]; testAircraft: 2',
      acceptedAt: '2026-08-25T12:00:00.000Z',
      links: [{ label: 'Source letter', url: 'https://example.test/letter' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|secret|javascript/);
    expect(result?.explanation).toContain('until a correction is approved');
    const query = m.tx.$queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(query.text).toContain('f.tenant_id = ls.tenant_id');
    expect(query.text).toContain('f.client_id = ls.client_id');
    expect(query.text).toContain("ls.signal_type = 'crm_finding_accepted'");
    expect(query.text).toContain("f.status = 'accepted'");
    expect(query.values).toEqual([signalId, ctx.tenantId, clientId, ctx.tenantId, clientId]);
    expect(m.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      ctx.tenantId,
      clientId,
      ctx.userId,
    );
    expect(m.tx.$executeRaw).not.toHaveBeenCalled();
    expect(m.tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['different tenant', { ...accepted, tenantId: 'other-tenant' }],
    ['different client', { ...accepted, clientId: 'other-client' }],
    ['different signal', { ...accepted, signalId: 'other-signal' }],
    ['pending finding', { ...accepted, status: 'pending' }],
    ['rejected finding', { ...accepted, status: 'rejected' }],
    ['empty fact', { ...accepted, proposedValue: {} }],
  ])('discloses unavailable for %s without source details', async (_name, row) => {
    const result = await setup(row).read();
    expect(result).toEqual({ status: 'unavailable', explanation: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('FortressHUMS');
  });

  it('rechecks the client wall before resolving any source row', async () => {
    const m = setup(accepted, false);
    expect(await m.read()).toMatchObject({ status: 'unavailable' });
    expect(m.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    { ...memory, sourceType: 'user_message' },
    { ...memory, sourceType: 'unknown' },
    { ...memory, sourceType: 'unknown', sourceRef: 'learning_signal' },
    { ...memory, sourceType: 'unknown', originSurface: 'learning_signal' },
    { ...memory, memoryScope: 'user_private', clientId: null },
  ])('never reads private chat sources or unrelated memory %j', async (input) => {
    const m = setup();
    expect(await readGovernedMemorySourceEvidence(m.tx as never, ctx, input)).toBeNull();
    expect(m.tx.$queryRaw).not.toHaveBeenCalled();
    expect(m.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('recovers verified legacy captures whose source type is unknown but both provenance fields identify learning', async () => {
    const m = setup();
    const result = await readGovernedMemorySourceEvidence(m.tx as never, ctx, {
      ...memory,
      sourceType: 'unknown',
      sourceRef: 'learning_signal',
      originSurface: 'learning_signal',
    });
    expect(result).toMatchObject({ status: 'available', findingId: accepted.findingId });
    expect(m.tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('does not parse a finding ID from a title when the durable signal is absent', async () => {
    const m = setup();
    expect(
      await readGovernedMemorySourceEvidence(m.tx as never, ctx, { ...memory, sourceId: null }),
    ).toMatchObject({ status: 'unavailable' });
    expect(m.tx.$queryRaw).not.toHaveBeenCalled();
  });
});

function detailSetup(readAllowed = true) {
  const sections = [
    { key: 'memory', body: '{"summary":"crm_finding_accepted on crm.fill_with_meri"}' },
  ];
  const row = {
    ...memory,
    sourceType: 'unknown',
    originSurface: 'learning_signal',
    id: '77777777-7777-4777-8777-777777777777',
    title: 'Historical learning event',
    sections,
    source: 'learning_signal',
    sourceRef: 'learning_signal',
    updatedAt: new Date(),
    createdAt: new Date(),
    governedStatus: 'active',
    legacyStatus: 'active',
  };
  const tx = {
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      if (sql.text.includes('mi.sections_jsonb AS sections')) return [row];
      if (sql.text.includes('FROM learning_signal ls')) return [accepted];
      return [];
    }),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const authorization = {
    loadItemInTx: jest.fn().mockResolvedValue({ clientId }),
    evaluateInTx: jest.fn().mockResolvedValue({ allowed: readAllowed, reason: 'ethical_wall' }),
  };
  const prisma = { withTenantUser: jest.fn(async (_tenant, _user, fn) => fn(tx)) };
  const service = new MemoryGovernanceReadService(
    prisma as never,
    authorization as never,
    {} as never,
  );
  return { service, tx, row, sections };
}

describe('governed item detail preserves approved historical content', () => {
  it('adds recoverable evidence separately while retaining the original metadata sections and status', async () => {
    const m = detailSetup();
    const before = JSON.stringify(m.row);
    const result = await m.service.getItem(ctx, m.row.id);
    expect(result.item?.sections).toEqual(m.sections);
    expect(result.item?.sourceEvidence).toMatchObject({
      status: 'available',
      findingId: accepted.findingId,
    });
    expect(result.item?.governedStatus).toBe('active');
    expect(JSON.stringify(m.row)).toBe(before);
    expect(m.tx.$executeRaw).not.toHaveBeenCalled();
    expect(m.tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('requires canonical memory read authorization before resolving the original finding', async () => {
    const m = detailSetup(false);
    await expect(m.service.getItem(ctx, m.row.id)).rejects.toThrow('ethical_wall');
    expect(
      m.tx.$queryRaw.mock.calls.some(([sql]) => sql.text.includes('FROM learning_signal ls')),
    ).toBe(false);
    expect(m.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
