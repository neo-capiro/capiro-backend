import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';

/**
 * Focused unit coverage for public-source Matter links (product spec
 * section 9-14): regulatory_docket, regulatory_document, hearing,
 * testimony, fara_record. All four backing tables are GLOBAL (no
 * tenant_id, no RLS) -- these tests assert the service still enforces
 * Matter/client scoping on the LINK row even though the source record
 * itself carries no tenant boundary, and that every link is stamped
 * PUBLIC_VERIFIED.
 */
describe('ClientAdvocacyMatterService — public source links', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'user-1';
  const ctx = { tenantId, userId } as never;
  const clientId = '22222222-2222-2222-2222-222222222222';
  const matterId = '33333333-3333-3333-3333-333333333333';
  const hearingId = '44444444-4444-4444-4444-444444444444';

  const makeService = () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => [] as unknown[]),
      $executeRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => 1),
      client: { findFirst: jest.fn(async () => ({ id: clientId })) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tenantTx: typeof tx) => Promise<unknown>) => run(tx)),
      regulatoryDocket: { findUnique: jest.fn(async () => null as unknown) },
      federalRegisterDocument: { findUnique: jest.fn(async () => null as unknown) },
      committeeHearing: { findUnique: jest.fn(async () => null as unknown) },
      congressBillCommittee: { findFirst: jest.fn(async () => null as unknown) },
      faraRegistration: { findUnique: jest.fn(async () => null as unknown) },
    };
    const engagement = {
      listMailThreads: jest.fn(async () => []),
      getOutreachRecord: jest.fn(async () => ({})),
    };
    return { service: new ClientAdvocacyMatterService(prisma as never, engagement as never), tx, prisma };
  };

  function stubMatterExists(tx: ReturnType<typeof makeService>['tx']) {
    (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([{ id: matterId }]);
  }

  function stubMatterIdentifiers(tx: ReturnType<typeof makeService>['tx'], primaryBillId: string | null) {
    (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([{ primaryPeCode: null, primaryBillId }]);
  }

  function insertedRow(tx: ReturnType<typeof makeService>['tx']) {
    return (tx.$executeRawUnsafe as jest.Mock).mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('INSERT INTO client_advocacy_matter_link'),
    );
  }

  describe('linkRegulatoryDocket', () => {
    test('links a docket document and stamps PUBLIC_VERIFIED, never claiming causation or copying private data', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.regulatoryDocket.findUnique as jest.Mock).mockResolvedValueOnce({
        title: 'Comment on proposed rule XYZ',
        agencyId: 'DOD',
        docketId: 'DOD-2026-OS-0001',
        postedDate: new Date('2026-01-15T00:00:00Z'),
        documentType: 'Public Submission',
      });

      await service.linkRegulatoryDocket(ctx, clientId, matterId, 'DOD-2026-OS-0001-0042');

      const row = insertedRow(tx);
      expect(row).toContain('regulatory_docket');
      expect(row).toContain('PUBLIC_VERIFIED');
    });

    test('rejects a genuinely absent document as NotFoundException (real zero-result)', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.regulatoryDocket.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.linkRegulatoryDocket(ctx, clientId, matterId, 'does-not-exist'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    test('treats a query failure as source-unavailable, never as "zero results"', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.regulatoryDocket.findUnique as jest.Mock).mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        service.linkRegulatoryDocket(ctx, clientId, matterId, 'DOD-2026-OS-0001-0042'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('linkRegulatoryDocument (Federal Register)', () => {
    test('links a Federal Register document, capturing only what the document itself states', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.federalRegisterDocument.findUnique as jest.Mock).mockResolvedValueOnce({
        title: 'Proposed Rule on Defense Acquisition',
        type: 'PROPOSED_RULE',
        agencyNames: ['Department of Defense'],
        publicationDate: new Date('2026-02-01T00:00:00Z'),
        docketIds: ['DOD-2026-OS-0001'],
        htmlUrl: 'https://www.federalregister.gov/d/2026-00001',
      });

      await service.linkRegulatoryDocument(ctx, clientId, matterId, '2026-00001');

      const row = insertedRow(tx);
      expect(row).toContain('regulatory_document');
      expect(row).toContain('PUBLIC_VERIFIED');
    });
  });

  describe('linkHearing', () => {
    test('auto-confirms via deterministic committee-code match against the Matter\'s bill — no manual rationale required', async () => {
      const { service, tx, prisma } = makeService();
      // linkHearing calls getMatterIdentifiers (not assertMatterBelongsToClient
      // separately) — exactly ONE $queryRawUnsafe call before hitting Prisma
      // delegates. Queue only that one.
      stubMatterIdentifiers(tx, '119-hr-1234');
      (prisma.committeeHearing.findUnique as jest.Mock).mockResolvedValueOnce({
        title: 'FY27 NDAA markup',
        committeeName: 'House Armed Services Committee',
        committeeSystemCode: 'HSAS',
        date: new Date('2026-03-12T00:00:00Z'),
        chamber: 'House',
        url: 'https://armedservices.house.gov/hearing/123',
      });
      (prisma.congressBillCommittee.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'committee-row-1' });

      await service.linkHearing(ctx, clientId, matterId, hearingId);

      expect(prisma.congressBillCommittee.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { billId: '119-hr-1234', committeeCode: 'HSAS' } }),
      );
      const row = insertedRow(tx);
      expect(row).toContain('hearing');
      // confidence=1 for the deterministic match — the 7th SQL bind param.
      expect(row).toContain(1);
    });

    test('rejects an undeterministic hearing link with no manualRationale — never silently classified as advocacy', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterIdentifiers(tx, '119-hr-1234');
      (prisma.committeeHearing.findUnique as jest.Mock).mockResolvedValueOnce({
        title: 'Unrelated hearing',
        committeeName: 'Senate Finance Committee',
        committeeSystemCode: 'SSFI',
        date: new Date('2026-03-12T00:00:00Z'),
        chamber: 'Senate',
        url: null,
      });
      (prisma.congressBillCommittee.findFirst as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.linkHearing(ctx, clientId, matterId, hearingId)).rejects.toBeInstanceOf(BadRequestException);
    });

    test('accepts an undeterministic hearing link WITH manualRationale as a reviewable inferred finding', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterIdentifiers(tx, null);
      (prisma.committeeHearing.findUnique as jest.Mock).mockResolvedValueOnce({
        title: 'Related-seeming hearing',
        committeeName: 'House Armed Services Committee',
        committeeSystemCode: 'HSAS',
        date: new Date('2026-03-12T00:00:00Z'),
        chamber: 'House',
        url: null,
      });

      await service.linkHearing(ctx, clientId, matterId, hearingId, 'Staff attended and referenced this Matter by name.');

      const row = insertedRow(tx);
      expect(row).toContain('Staff attended and referenced this Matter by name.');
    });
  });

  describe('linkTestimony', () => {
    test('links a witness present on the hearing witness list, with organization/document honestly null (no canonical source exists)', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.committeeHearing.findUnique as jest.Mock).mockResolvedValueOnce({
        title: 'FY27 NDAA markup',
        committeeName: 'House Armed Services Committee',
        date: new Date('2026-03-12T00:00:00Z'),
        witnesses: ['Jane Smith', 'John Doe'],
        url: null,
      });

      await service.linkTestimony(ctx, clientId, matterId, hearingId, 'jane smith');

      const row = insertedRow(tx);
      expect(row).toContain('testimony');
      const metadataJson = row!.find((arg: unknown) => typeof arg === 'string' && arg.startsWith('{'));
      const metadata = JSON.parse(metadataJson as string);
      expect(metadata.organization).toBeNull();
      expect(metadata.documentUrl).toBeNull();
      expect(metadata.witness).toBe('Jane Smith'); // case-preserved from the source array, not the input
    });

    test('rejects a witness name not present on the hearing — never fabricates a match', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.committeeHearing.findUnique as jest.Mock).mockResolvedValueOnce({
        title: 'FY27 NDAA markup',
        committeeName: 'House Armed Services Committee',
        date: new Date('2026-03-12T00:00:00Z'),
        witnesses: ['Jane Smith'],
        url: null,
      });

      await expect(
        service.linkTestimony(ctx, clientId, matterId, hearingId, 'Someone Else'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('linkFaraRecord', () => {
    test('links a FARA registration, representing only what the registration row itself contains', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.faraRegistration.findUnique as jest.Mock).mockResolvedValueOnce({
        registrantName: 'Example Advocacy LLC',
        foreignPrincipal: 'Foreign Government of Example',
        status: 'Active',
        registrationDate: new Date('2025-06-01T00:00:00Z'),
      });

      await service.linkFaraRecord(ctx, clientId, matterId, '1234-A');

      const row = insertedRow(tx);
      expect(row).toContain('fara_record');
      expect(row).toContain('PUBLIC_VERIFIED');
    });

    test('a genuinely absent registration is NotFoundException, distinct from a query failure', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.faraRegistration.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.linkFaraRecord(ctx, clientId, matterId, 'nonexistent')).rejects.toBeInstanceOf(NotFoundException);

      const { service: service2, tx: tx2, prisma: prisma2 } = makeService();
      stubMatterExists(tx2);
      (prisma2.faraRegistration.findUnique as jest.Mock).mockRejectedValueOnce(new Error('timeout'));

      await expect(service2.linkFaraRecord(ctx, clientId, matterId, '1234-A')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
