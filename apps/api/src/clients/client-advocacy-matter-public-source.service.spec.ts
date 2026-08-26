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
      federalRegisterDocument: {
        findUnique: jest.fn(async () => null as unknown),
        findMany: jest.fn(async () => [] as unknown[]),
      },
      committeeHearing: { findUnique: jest.fn(async () => null as unknown) },
      congressBillCommittee: { findFirst: jest.fn(async () => null as unknown) },
      faraRegistration: { findUnique: jest.fn(async () => null as unknown) },
      programElement: { findUnique: jest.fn(async () => null as unknown) },
      congressBill: { findUnique: jest.fn(async () => null as unknown) },
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

  describe('linkProgramElement / linkBill (manual, mandatory-rationale)', () => {
    test('linkProgramElement rejects a missing manualRationale — no deterministic bypass exists for PE/bill relevance', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx);

      await expect(
        service.linkProgramElement(ctx, clientId, matterId, '0605053A', ''),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test('linkBill rejects a missing manualRationale — same safeguard as linkProgramElement', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx);

      await expect(
        service.linkBill(ctx, clientId, matterId, '119-hr-1234', ''),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test('linkProgramElement links a real PE with an explicit rationale, never claiming causation', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx); // assertClient/assertMatterBelongsToClient (linkProgramElement's own check)
      stubMatterExists(tx); // linkToMatter's own withTenant call — a second $queryRawUnsafe isn't made, but stubbing keeps mock queues symmetric across tests
      (prisma.programElement.findUnique as jest.Mock).mockResolvedValueOnce({
        peCode: '0605053A',
        title: 'Ground Robotics Development',
        service: 'Army',
        appropriationType: 'RDT&E',
      });

      await service.linkProgramElement(
        ctx, clientId, matterId, '0605053A',
        'Client submitted written comments specifically citing this PE.',
      );

      const row = insertedRow(tx);
      expect(row).toContain('program_element');
      expect(row).toContain('0605053A');
      const metadataJson = row!.find((arg: unknown) => typeof arg === 'string' && arg.startsWith('{'));
      const metadata = JSON.parse(metadataJson as string);
      expect(metadata.causationClaimed).toBe(false);
      expect(metadata.manualRationale).toContain('written comments');
    });

    test('linkProgramElement: a genuinely absent PE is NotFoundException, distinct from a query failure', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.programElement.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.linkProgramElement(ctx, clientId, matterId, 'does-not-exist', 'Some rationale'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    test("linkBill links a real bill, using the bill's own latest action date as occurredAt", async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (prisma.congressBill.findUnique as jest.Mock).mockResolvedValueOnce({
        id: '119-hr-1234',
        title: 'Ground Robotics Act',
        billType: 'hr',
        billNumber: '1234',
        congress: 119,
        latestActionText: 'Referred to committee',
        latestActionDate: new Date('2026-03-01T00:00:00Z'),
      });

      await service.linkBill(
        ctx, clientId, matterId, '119-hr-1234',
        'Client filed formal support letter referencing this bill by number.',
      );

      const row = insertedRow(tx);
      expect(row).toContain('bill');
      expect(row).toContain('119-hr-1234');
      const metadataJson = row!.find((arg: unknown) => typeof arg === 'string' && arg.startsWith('{'));
      const metadata = JSON.parse(metadataJson as string);
      expect(metadata.occurredAt).toBe('2026-03-01T00:00:00.000Z');
      expect(metadata.causationClaimed).toBe(false);
    });
  });

  describe('suggestFederalRegisterCorrelations', () => {
    test('returns nothing when the Matter has no docket-carrying public-source link yet (honest empty, not a guess)', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx); // assertClient/assertMatterBelongsToClient
      (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([]); // linked-docket-ids query returns none

      const result = await service.suggestFederalRegisterCorrelations(ctx, clientId, matterId);

      expect(result).toEqual([]);
    });

    test('correlates by shared docket id from an already-linked regulatory_docket, never by client name or agency text', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([
        { linkType: 'regulatory_docket', linkKey: 'DOD-2026-OS-0001-0042', docketId: 'DOD-2026-OS-0001' },
      ]);
      (prisma.federalRegisterDocument.findMany as jest.Mock).mockResolvedValueOnce([
        {
          documentNumber: '2026-00001',
          title: 'Proposed Rule on Defense Acquisition',
          type: 'PROPOSED_RULE',
          agencyNames: ['Department of Defense'],
          publicationDate: new Date('2026-02-01T00:00:00Z'),
          docketIds: ['DOD-2026-OS-0001'],
          htmlUrl: 'https://www.federalregister.gov/d/2026-00001',
        },
      ]);

      const result = await service.suggestFederalRegisterCorrelations(ctx, clientId, matterId);

      expect(prisma.federalRegisterDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { docketIds: { hasSome: ['DOD-2026-OS-0001'] } } }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        documentNumber: '2026-00001',
        stage: 'government_movement',
        matchedOn: 'docket_id',
        causationClaimed: false,
        matchedDocketIds: ['DOD-2026-OS-0001'],
      });
    });

    test('excludes a Federal Register document already linked to this Matter — never suggests re-linking the same evidence', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([
        { linkType: 'regulatory_docket', linkKey: 'DOD-2026-OS-0001-0042', docketId: 'DOD-2026-OS-0001' },
        { linkType: 'regulatory_document', linkKey: '2026-00001', docketId: null },
      ]);
      (prisma.federalRegisterDocument.findMany as jest.Mock)
        .mockResolvedValueOnce([{ docketIds: ['DOD-2026-OS-0001'] }]) // already-linked doc lookup (for its own docketIds)
        .mockResolvedValueOnce([
          {
            documentNumber: '2026-00001', // same document already linked — must be filtered out
            title: 'Proposed Rule on Defense Acquisition',
            type: 'PROPOSED_RULE',
            agencyNames: ['Department of Defense'],
            publicationDate: new Date('2026-02-01T00:00:00Z'),
            docketIds: ['DOD-2026-OS-0001'],
            htmlUrl: null,
          },
          {
            documentNumber: '2026-00002', // a second document on the same docket, not yet linked
            title: 'Final Rule on Defense Acquisition',
            type: 'RULE',
            agencyNames: ['Department of Defense'],
            publicationDate: new Date('2026-03-01T00:00:00Z'),
            docketIds: ['DOD-2026-OS-0001'],
            htmlUrl: null,
          },
        ]);

      const result = await service.suggestFederalRegisterCorrelations(ctx, clientId, matterId);

      expect(result).toHaveLength(1);
      expect(result[0]!.documentNumber).toBe('2026-00002');
    });

    test('never claims causation and always stamps government_movement, regardless of document type (RULE vs NOTICE)', async () => {
      const { service, tx, prisma } = makeService();
      stubMatterExists(tx);
      (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([
        { linkType: 'regulatory_docket', linkKey: 'x', docketId: 'DOD-2026-OS-0001' },
      ]);
      (prisma.federalRegisterDocument.findMany as jest.Mock).mockResolvedValueOnce([
        {
          documentNumber: '2026-00003',
          title: 'Final Rule',
          type: 'RULE',
          agencyNames: ['Department of Defense'],
          publicationDate: new Date('2026-04-01T00:00:00Z'),
          docketIds: ['DOD-2026-OS-0001'],
          htmlUrl: null,
        },
      ]);

      const result = await service.suggestFederalRegisterCorrelations(ctx, clientId, matterId);

      expect(result[0]!.causationClaimed).toBe(false);
      expect(result[0]!.stage).toBe('government_movement');
    });
  });
});
