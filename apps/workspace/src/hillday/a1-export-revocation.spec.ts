import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { HillDayDocumentService } from './hillday-document.service.js';
import { HillDayExportService } from './hillday-export.service.js';
import { HillDaySourceService } from './hillday-source.service.js';

// These tests serve already-rendered bytes. No renderer, provider or database
// executes; the document admission and membership/client guards remain real.
jest.mock('pdfkit', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });

/** Export signing is configured here (synthetic); what is under test is current access. */
const SIGNING_KEY = 'synthetic-export-signing-key';
let previousSigningKey: string | undefined;
beforeAll(() => {
  previousSigningKey = process.env.WORKSPACE_EXPORT_SIGNING_SECRET;
  process.env.WORKSPACE_EXPORT_SIGNING_SECRET = SIGNING_KEY;
});
afterAll(() => {
  if (previousSigningKey === undefined) delete process.env.WORKSPACE_EXPORT_SIGNING_SECRET;
  else process.env.WORKSPACE_EXPORT_SIGNING_SECRET = previousSigningKey;
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const DOCUMENT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const ACTOR = 'clerk-owner';

function fixture() {
  const state = { wallAllowed: true, activeMember: true, ownerId: ACTOR };
  const file = Buffer.from('%PDF-1.7 private packet');
  const membershipRead = jest.fn(async () => (state.activeMember ? [{ id: USER }] : []));
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => [{ id: CLIENT, wallAllowed: state.wallAllowed }]),
  };
  const db = {
    withSystem: async (read: (value: { $queryRaw: typeof membershipRead }) => Promise<unknown>) =>
      read({ $queryRaw: membershipRead }),
    $transaction: async (read: (value: typeof tx) => Promise<unknown>) => read(tx),
    wsHillDayDocument: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) =>
        where.id === DOCUMENT && where.tenantId === TENANT
          ? { id: DOCUMENT, tenantId: TENANT, ownerId: state.ownerId, clientId: CLIENT }
          : null,
      ),
    },
    wsHillDayExport: {
      findFirst: jest.fn(async () => ({
        id: 'export',
        documentId: DOCUMENT,
        tenantId: TENANT,
        actorId: ACTOR,
        status: 'ready',
        file,
        filename: 'private-packet.pdf',
        pageSize: 'letter',
        sizeBytes: file.length,
        error: null,
        createdAt: new Date('2026-10-21T12:00:00Z'),
      })),
    },
  };
  const source = new HillDaySourceService(db as never);
  const documents = new HillDayDocumentService(db as never, source, {} as never, {} as never);
  const exports = new HillDayExportService(db as never, documents, {} as never);
  return { state, file, exports };
}

describe('A1 Hill Day signed file revocation', () => {
  it.each(['client wall', 'membership', 'ownership'] as const)(
    'refuses the same signed URL after %s is revoked',
    async (revoked) => {
      const h = fixture();
      // Issue the URL through the ordinary authenticated status path, then
      // prove the exact token serves its bytes before access changes.
      const issued = await h.exports.get(TENANT, DOCUMENT, 'export', ACTOR);
      const url = new URL(issued.url!, 'https://workspace.invalid');
      const read = () =>
        h.exports.file(
          DOCUMENT,
          'export',
          url.searchParams.get('exp')!,
          url.searchParams.get('sig')!,
        );
      await expect(read()).resolves.toEqual({ buffer: h.file, filename: 'private-packet.pdf' });

      if (revoked === 'client wall') h.state.wallAllowed = false;
      if (revoked === 'membership') h.state.activeMember = false;
      if (revoked === 'ownership') h.state.ownerId = 'different-owner';

      await expect(read()).rejects.toMatchObject({ status: 404 });
    },
  );
});
