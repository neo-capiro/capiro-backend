import { ClientProfileFillService } from './client-profile-fill.service.js';
import { acceptOfficialProfileFact, readOfficialProfileIdentities } from './profile-official-facts.js';
import type { TenantContext } from '@capiro/shared';
jest.mock('./profile-subject.js', () => ({
  ...jest.requireActual('./profile-subject.js'),
  requireProfileSubject: jest.fn(async () => undefined),
}));
jest.mock('./profile-official-facts.js', () => ({
  ...jest.requireActual('./profile-official-facts.js'),
  readOfficialProfileIdentities: jest.fn(),
}));
const ctx = { tenantId: 'tenant-fixture', userId: 'actor-fixture' } as TenantContext;
const uei = 'ABCDEFGHIJKL';
const record = {
  uei,
  cageCode: '1AB23',
  legalBusinessName: 'Official Company',
  registrationStatus: 'ACTIVE',
  naicsCodes: ['541330'],
  pscCodes: ['R425'],
};
function fixture() {
  const service = Object.create(ClientProfileFillService.prototype) as any;
  Object.assign(service, {
    getClientSnapshot: jest.fn(async () => ({
      name: 'Company',
      uei: null,
      cageCode: null,
      naicsCodes: [],
      pscCodes: [],
      intakeData: {},
    })),
    clientState: jest.fn(async () => null),
    sam: {
      lookupGovIds: jest.fn(async () => ({ ...record, matchedName: record.legalBusinessName })),
    },
    officialSam: {
      lookupByUei: jest.fn(async () => ({ ok: true, entities: [record] })),
      lookupByCage: jest.fn(async () => ({ ok: true, entities: [record] })),
    },
    prisma: {
      withTenantUser: jest.fn(async (_t, _u, cb) => cb({})),
      withTenant: jest.fn(async (_t, cb) =>
        cb({ clientIntelMapping: { findMany: async () => [] } }),
      ),
      federalAward: { findMany: jest.fn(async () => []) },
      federalAssistanceAward: { findMany: jest.fn(async () => []) },
      $queryRawUnsafe: jest.fn(async () => []),
    },
    addFinding: jest.fn(async () => true),
    addLdaHistory: jest.fn(async () => true),
  });
  return service;
}
beforeEach(() => jest.mocked(readOfficialProfileIdentities).mockReset());
it('an LDA identity recommendation cannot be automatically accepted even with an official filings proof', async () => {
  const project = jest.fn();
  const tx = {$queryRawUnsafe: jest.fn()};
  const outcome = await acceptOfficialProfileFact({tx: tx as any, afterCommit: []}, ctx,
    {kind: 'client', id: 'client-fixture'},
    {id: 'finding-fixture', runId: 'run-fixture', kind: 'lda_identity', targetKey: 'lda:73', source: 'lda',
      proposedValue: {externalId: '73', externalName: 'Synthetic candidate'}, evidence: []},
    {kind: 'lda_filings', identity: {type: 'lda_client_id', value: '73'}, sourceRecordId: '73',
      sourceUrl: 'https://lda.gov/api/v1/clients/73/', observedAt: '2026-11-07T00:00:00Z'}, project);
  expect(outcome).toBe('pending');
  expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  expect(project).not.toHaveBeenCalled();
});
it('uses the existing exact SAM client and autoaccept proof only for UEI, CAGE and status, not classification suggestions', async () => {
  jest.mocked(readOfficialProfileIdentities).mockResolvedValue([{ type: 'uei', value: uei }]);
  const service = fixture();
  await service.gatherSam(ctx, 'client-fixture', 'run-fixture');
  expect(service.officialSam.lookupByUei).toHaveBeenCalledWith(uei);
  expect(service.sam.lookupGovIds).not.toHaveBeenCalled();
  const inputs = service.addFinding.mock.calls.map((call: any[]) => call[3]);
  expect(inputs.filter((row: any) => row.officialProof).map((row: any) => row.targetKey)).toEqual([
    'uei',
    'cageCode',
    'samStatus',
  ]);
  expect(inputs.filter((row: any) => !row.officialProof).map((row: any) => row.targetKey)).toEqual([
    'naicsCodes',
    'pscCodes',
  ]);
});
it('a name-only result remains review-only even with high provider confidence', async () => {
  jest.mocked(readOfficialProfileIdentities).mockResolvedValue([]);
  const service = fixture();
  await service.gatherSam(ctx, 'client-fixture', 'run-fixture');
  expect(service.sam.lookupGovIds).toHaveBeenCalled();
  expect(
    service.addFinding.mock.calls.every((call: any[]) => call[3].officialProof === undefined),
  ).toBe(true);
});
it.each([
  { entities: [{ ...record, uei: 'ZZZZZZZZZZZZ' }] },
  { entities: [record, { ...record }] },
])(
  'rejects mismatched or ambiguous exact lookup response without a name fallback',
  async ({ entities }) => {
    jest.mocked(readOfficialProfileIdentities).mockResolvedValue([{ type: 'uei', value: uei }]);
    const service = fixture();
    service.officialSam.lookupByUei.mockResolvedValue({ ok: true, entities });
    await service.gatherSam(ctx, 'client-fixture', 'run-fixture');
    expect(service.addFinding).not.toHaveBeenCalled();
    expect(service.sam.lookupGovIds).not.toHaveBeenCalled();
  },
);
it('reads awards by the exact recipient UEI and excludes any contradictory returned record', async () => {
  jest.mocked(readOfficialProfileIdentities).mockResolvedValue([{ type: 'uei', value: uei }]);
  const service = fixture();
  service.officialSam.lookupByUei.mockResolvedValue({ ok: false, reason: 'disabled' });
  service.prisma.federalAward.findMany.mockResolvedValue([
    {
      awardUniqueId: 'award-fixture',
      recipientUei: uei,
      awardingAgency: 'Agency',
      description: 'Official award description',
      amount: { toString: () => '123.45' },
      actionDate: new Date('2026-10-01'),
      lastSyncedAt: new Date('2026-11-01'),
    },
    {
      awardUniqueId: 'different-recipient',
      recipientUei: 'ZZZZZZZZZZZZ',
      lastSyncedAt: new Date('2026-11-01'),
    },
  ]);
  await expect(service.gatherSam(ctx, 'client-fixture', 'run-fixture')).rejects.toThrow('registration source unavailable');
  expect(service.prisma.federalAward.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { recipientUei: uei } }),
  );
  expect(service.addFinding).toHaveBeenCalledTimes(1);
  expect(service.addFinding.mock.calls[0][3]).toMatchObject({
    targetKey: 'federal_footprint.federal_award:award-fixture',
    officialProof: { kind: 'federal_award', identity: { type: 'uei', value: uei } },
    proposedValue: { obligatedAmount: '123.45' },
  });
});
it('uses confirmed canonical LDA IDs for an unseeded source task', async () => {
  jest
    .mocked(readOfficialProfileIdentities)
    .mockResolvedValue([{ type: 'lda_client_id', value: '12' }]);
  const service = fixture();
  service.prisma.$queryRawUnsafe.mockResolvedValue([{ id: 12, name: 'Official LDA company' }]);
  await service.gatherLda(ctx, 'client-fixture', 'run-fixture');
  expect(service.addLdaHistory).toHaveBeenCalledWith(
    ctx.tenantId,
    'client-fixture',
    'run-fixture',
    '12',
    'Official LDA company',
    1,
    { kind: 'client', id: 'client-fixture' },
  );
  expect(service.addFinding).not.toHaveBeenCalled();
});
it('automatic discovery retains confirmed history without widening its frozen IDs or proposing the confirmed identity again', async () => {
  jest.mocked(readOfficialProfileIdentities).mockResolvedValue([
    {type: 'lda_client_id', value: '12'}, {type: 'lda_client_id', value: '99'},
  ]);
  const service = fixture();
  service.prisma.$queryRawUnsafe.mockResolvedValue([
    {id: 12, name: 'Confirmed synthetic company'}, {id: 99, name: 'Later confirmed identity'},
  ]);
  await service.gatherLda(ctx, 'client-fixture', 'run-fixture', [{id: 12, name: 'Confirmed synthetic company', confidence: 1}], undefined, []);
  expect(service.addLdaHistory).toHaveBeenCalledTimes(1);
  expect(service.addLdaHistory).toHaveBeenCalledWith(ctx.tenantId, 'client-fixture', 'run-fixture', '12', 'Confirmed synthetic company', 1,
    {kind: 'client', id: 'client-fixture'});
  expect(service.addFinding).not.toHaveBeenCalled();
});
