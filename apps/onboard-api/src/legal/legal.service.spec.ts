import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { LegalService } from './legal.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

interface FakeDoc {
  id: string;
  docType: 'tos' | 'sa';
  planVariant: string;
  version: string;
  html: string;
  pdfS3Key: string | null;
  active: boolean;
  effectiveAt: Date;
}

function doc(
  partial: Partial<FakeDoc> & Pick<FakeDoc, 'docType' | 'planVariant' | 'version'>,
): FakeDoc {
  return {
    id: `${partial.docType}-${partial.planVariant}-${partial.version}`,
    html: '<p>body</p>',
    pdfS3Key: null,
    active: true,
    effectiveAt: new Date('2026-07-01T00:00:00Z'),
    ...partial,
  };
}

/** Minimal prisma double: findFirst filters on docType/planVariant/active. */
function mockPrisma(docs: FakeDoc[], existingConsents: Array<Record<string, unknown>> = []) {
  const createMany = jest.fn(async (_args: { data: Array<Record<string, unknown>> }) => ({
    count: 2,
  }));
  const consentFindMany = jest.fn(async () => existingConsents);
  const findFirst = jest.fn(
    async ({ where }: { where: { docType: string; planVariant: string; active: boolean } }) =>
      docs.find(
        (d) =>
          d.docType === where.docType &&
          d.planVariant === where.planVariant &&
          d.active === where.active,
      ) ?? null,
  );
  return {
    prisma: {
      onboardLegalDoc: { findFirst },
      onboardConsent: { createMany, findMany: consentFindMany },
    } as unknown as PrismaService,
    createMany,
    consentFindMany,
    findFirst,
  };
}

const baseConsentInput = {
  sessionId: 'session-1',
  purchaserId: 'purchaser-1',
  clerkUserId: 'user_abc',
  ip: '203.0.113.7',
  userAgent: 'jest',
} as const;

describe('LegalService', () => {
  describe('getActiveDocs', () => {
    it('prefers the plan-specific SA variant', async () => {
      const { prisma } = mockPrisma([
        doc({ docType: 'tos', planVariant: 'all', version: 'v1' }),
        doc({ docType: 'sa', planVariant: 'trial', version: 'v1-trial' }),
        doc({ docType: 'sa', planVariant: 'all', version: 'v1-all' }),
      ]);
      const service = new LegalService(prisma);
      const docs = await service.getActiveDocs('trial');
      expect(docs.tos.version).toBe('v1');
      expect(docs.sa.version).toBe('v1-trial');
    });

    it("falls back to the 'all' SA variant when no plan variant exists", async () => {
      const { prisma } = mockPrisma([
        doc({ docType: 'tos', planVariant: 'all', version: 'v1' }),
        doc({ docType: 'sa', planVariant: 'all', version: 'v1-all' }),
      ]);
      const service = new LegalService(prisma);
      const docs = await service.getActiveDocs('paid');
      expect(docs.sa.version).toBe('v1-all');
    });

    it('throws 503 when documents are not seeded', async () => {
      const { prisma } = mockPrisma([]);
      const service = new LegalService(prisma);
      await expect(service.getActiveDocs('trial')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('recordConsents', () => {
    const seeded = [
      doc({ docType: 'tos', planVariant: 'all', version: 'tos-v2' }),
      doc({ docType: 'sa', planVariant: 'paid', version: 'sa-v2-paid' }),
    ];

    it('records two rows when both versions are the active ones', async () => {
      const { prisma, createMany } = mockPrisma(seeded);
      const service = new LegalService(prisma);
      await service.recordConsents({
        ...baseConsentInput,
        plan: 'paid',
        accepts: [
          { docType: 'tos', version: 'tos-v2' },
          { docType: 'sa', version: 'sa-v2-paid' },
        ],
      });
      expect(createMany).toHaveBeenCalledTimes(1);
      const rows = createMany.mock.calls[0]![0]!.data;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.docType).sort()).toEqual(['sa', 'tos']);
      for (const row of rows) {
        expect(row).toMatchObject({
          sessionId: 'session-1',
          purchaserId: 'purchaser-1',
          clerkUserId: 'user_abc',
          ip: '203.0.113.7',
          userAgent: 'jest',
        });
      }
    });

    it('rejects a stale ToS version', async () => {
      const { prisma, createMany } = mockPrisma(seeded);
      const service = new LegalService(prisma);
      await expect(
        service.recordConsents({
          ...baseConsentInput,
          plan: 'paid',
          accepts: [
            { docType: 'tos', version: 'tos-v1' },
            { docType: 'sa', version: 'sa-v2-paid' },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createMany).not.toHaveBeenCalled();
    });

    it('rejects a stale SA version', async () => {
      const { prisma, createMany } = mockPrisma(seeded);
      const service = new LegalService(prisma);
      await expect(
        service.recordConsents({
          ...baseConsentInput,
          plan: 'paid',
          accepts: [
            { docType: 'tos', version: 'tos-v2' },
            { docType: 'sa', version: 'sa-v1-paid' },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createMany).not.toHaveBeenCalled();
    });

    it('rejects when one of the two documents is missing from accepts', async () => {
      const { prisma, createMany } = mockPrisma(seeded);
      const service = new LegalService(prisma);
      await expect(
        service.recordConsents({
          ...baseConsentInput,
          plan: 'paid',
          accepts: [{ docType: 'tos', version: 'tos-v2' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createMany).not.toHaveBeenCalled();
    });

    it('is idempotent: a re-accept of already-recorded versions inserts nothing', async () => {
      const { prisma, createMany } = mockPrisma(seeded, [
        { docType: 'tos', docVersion: 'tos-v2' },
        { docType: 'sa', docVersion: 'sa-v2-paid' },
      ]);
      const service = new LegalService(prisma);
      await service.recordConsents({
        ...baseConsentInput,
        plan: 'paid',
        accepts: [
          { docType: 'tos', version: 'tos-v2' },
          { docType: 'sa', version: 'sa-v2-paid' },
        ],
      });
      expect(createMany).not.toHaveBeenCalled();
    });

    it('inserts only the missing row when one consent already exists', async () => {
      const { prisma, createMany } = mockPrisma(seeded, [{ docType: 'tos', docVersion: 'tos-v2' }]);
      const service = new LegalService(prisma);
      await service.recordConsents({
        ...baseConsentInput,
        plan: 'paid',
        accepts: [
          { docType: 'tos', version: 'tos-v2' },
          { docType: 'sa', version: 'sa-v2-paid' },
        ],
      });
      expect(createMany).toHaveBeenCalledTimes(1);
      const rows = createMany.mock.calls[0]![0]!.data;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.docType).toBe('sa');
    });
  });
});
