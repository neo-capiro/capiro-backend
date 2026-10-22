import { resolve } from 'node:path';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NativeMailFlow, createNativeMailScenario } from './mailbox-collision.postgres-fixture.js';

interface NativeSchema {
  url: string;
  schema: string;
  cleanup(): Promise<void>;
}
interface DisposablePostgres {
  nativePostgresReadiness(input: { repoRoot: string }): { available: boolean; reason: string };
  createDisposableSchema(input: {
    repoRoot: string;
    coreSchemaPath: string;
  }): Promise<NativeSchema>;
}
const repoRoot = resolve(__dirname, '../../../..');
const native = require(resolve(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs')) as DisposablePostgres;
const readiness = native.nativePostgresReadiness({ repoRoot });
const flows: readonly NativeMailFlow[] = ['graph', 'gmail-backfill', 'gmail-incremental'];
const suite = readiness.available ? describe : describe.skip;
const suffix = readiness.available ? '' : ` [SKIPPED: ${readiness.reason}; Fable-run]`;

/** Native storage proof, not provider/RLS qualification: db push creates the
 * Prisma schema, not migration-owned RLS policies. All test URLs are explicit
 * disposable-only; DATABASE_URL and any live database are never consulted. */
suite(`A1 ML-09 real PostgreSQL disconnect / re-add / continue${suffix}`, () => {
  let database: NativeSchema | undefined;
  let prisma: PrismaService | undefined;
  let createScenario: typeof createNativeMailScenario;

  beforeAll(async () => {
    database = await native.createDisposableSchema({
      repoRoot, coreSchemaPath: resolve(repoRoot, 'apps/api/prisma/schema.prisma'),
    });
    // Runtime service imports happen only for the opted-in native run. A missing
    // database reports six explicit skips, not a passing synthetic substitute.
    const { PrismaService: Client } = await import('../prisma/prisma.service.js');
    ({ createNativeMailScenario: createScenario } = await import('./mailbox-collision.postgres-fixture.js'));
    prisma = new Client({ datasources: { db: { url: database.url } }, log: [] });
    await prisma.$connect();
  }, 240_000);

  afterAll(async () => {
    try { await prisma?.$disconnect(); } finally { await database?.cleanup(); }
  }, 60_000);

  describe.each(flows)('%s', (flow) => {
    test.each([false, true])('holds disconnected lineage (removal=%s), commits later mail and the cursor', async (removal) => {
      if (!prisma) throw new Error('Native PostgreSQL fixture was not initialized');
      const h = await createScenario(prisma, flow, removal);
      expect(h.connectionId).not.toBe(h.oldConnectionId);
      // These NULLs are actual ON DELETE SET NULL effects of production
      // disconnect(), not rows originally inserted with NULL connection IDs.
      expect(h.afterDisconnect).toEqual({
        thread: { ...h.old.thread, connectionId: null },
        message: { ...h.old.message, connectionId: null },
      });

      const result = await h.run();
      const key = flow === 'graph' ? 'inbox' : flow === 'gmail-backfill' ? 'ALL' : 'incremental';
      expect(result.mail?.[key]).toEqual(expect.objectContaining({
        held: 1, matched: 1, removed: 0, scanned: 2, hasMore: false,
      }));
      expect(await h.readOld()).toEqual(h.afterDisconnect);
      const stored = await h.readResult();
      expect(stored.deletedConnection).toBeNull();
      expect(stored.connection).toEqual(expect.objectContaining({
        status: 'connected', lastError: null,
        token: expect.objectContaining({ homeAccountId: 'same-provider-account' }),
      }));
      expect(stored.connection.lastSyncAt).toBeInstanceOf(Date);
      expect(stored.fresh).toEqual(expect.objectContaining({
        connectionId: h.connectionId, source: h.source, removedAt: null,
        thread: expect.objectContaining({ connectionId: h.connectionId }),
      }));
      expect(stored.messages).toBe(2);
      expect(stored.threads).toBe(2);
      expect(h.logger.warn.mock.calls).toEqual([[flow === 'graph'
        ? 'Graph mail message held: mailbox identity mismatch'
        : 'Gmail mail message held: mailbox identity mismatch']]);

      const cursor = flow === 'graph' ? {
        folders: expect.objectContaining({ inbox: expect.objectContaining({
          cursor: 'inbox-after', deltaLink: 'inbox-after', nextLink: null,
        }) }),
      } : flow === 'gmail-incremental' ? {
        historyId: 'history-after', incrementalPageToken: null,
      } : {
        historyId: 'history-after', labels: expect.objectContaining({ ALL: expect.objectContaining({
          backfillDone: true, backfillPageToken: null, backfillPendingRefs: [],
        }) }),
      };
      // Assert the committed connection row, not only the service's local state.
      expect(stored.connection.syncState).toEqual(expect.objectContaining({
        mail: expect.objectContaining({ ...cursor, lastStats: expect.objectContaining({ held: 1 }) }),
      }));
    }, 60_000);
  });
});
