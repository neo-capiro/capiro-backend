import { TrackerWatchlistService } from '../../../src/tracker/tracker-watchlist.service.js';
import type { PrismaService } from '../../../src/prisma/prisma.service.js';
import { CLIENT, IoTape, scoped, replacePrivate } from './io.js';
import type { ReadHead, ReadTerm, ReadTopic } from './read-io.js';

export interface PersistedTerm {
  topicId: string | null;
  termType: string;
  value: string;
  weight: number;
}
export function writeHarness() {
  const tape = new IoTape();
  const rows = {
    version: 7,
    role: 'user_admin' as string | null,
    client: true,
    topics: [] as Array<{ id: string; label: string }>,
    terms: [] as PersistedTerm[],
    topicId: 'topic-kept',
    viewHead: {
      issueAreas: ['Energy'],
      jurisdictions: ['CA'],
      version: 8,
      updatedBy: 'user-owner',
      updatedAt: new Date(0),
    } as ReadHead,
    viewTopics: [] as ReadTopic[],
    viewTerms: [] as ReadTerm[],
  };
  const tx = {
    watchlist: {
      findFirst: (args: { select: Record<string, unknown> }) =>
        'issueAreas' in args.select
          ? tape.run('view.head', args, rows.viewHead)
          : tape.run('write.head', args, { version: rows.version }),
      upsert: (args: unknown) => tape.run('write.head.upsert', args, {}),
    },
    watchlistTopic: {
      findMany: (args: { select: Record<string, unknown> }) =>
        'issueArea' in args.select
          ? tape.run('view.topics', args, rows.viewTopics)
          : tape.run('write.topics', args, rows.topics),
      update: (args: unknown) => tape.run('write.rename', args, { id: rows.topicId }),
      upsert: (args: unknown) => tape.run('write.topic.upsert', args, { id: rows.topicId }),
      deleteMany: (args: unknown) => tape.run('write.topics.delete', args, { count: 1 }),
    },
    watchlistTerm: {
      findMany: (args: { select: Record<string, unknown> }) =>
        'id' in args.select
          ? tape.run('view.terms', args, rows.viewTerms)
          : tape.run('write.terms', args, rows.terms),
      deleteMany: (args: { where: { topicId: string | null } }) =>
        tape.run(args.where.topicId === null ? 'write.flat.clear' : 'write.terms.delete', args, {
          count: 1,
        }),
      createMany: (args: unknown) => tape.run('write.terms.create', args, { count: 1 }),
    },
    intelWatchlistRevision: { create: (args: unknown) => tape.run('write.revision', args, {}) },
    $queryRaw: (): never => {
      throw new Error('watchlist write must not add an explicit SQL lock');
    },
  };
  const systemTx = {
    $queryRawUnsafe: (sql: string, ...bindings: unknown[]) => {
      const args = { sql, bindings };
      if (sql.includes('tenant_memberships'))
        return tape.run('system.admin', args, rows.role ? [{ role: rows.role }] : []);
      if (sql.includes('first_name'))
        return tape.run('system.name', args, [{ firstName: 'Ada', lastName: 'Lovelace' }]);
      return tape.run('system.client', args, rows.client ? [{ id: CLIENT }] : []);
    },
  };
  const prisma = {
    withTenant: scoped(tape, tx),
    withSystem: async (callback: (tx: typeof systemTx) => unknown) => callback(systemTx),
  };
  const service = new TrackerWatchlistService(prisma as unknown as PrismaService);
  const logger = {
    warn: jest.fn((message: string) => tape.note('logger.warn', message)),
    error: jest.fn((message: string) => tape.note('logger.error', message)),
  };
  replacePrivate(service, 'logger', logger);
  return { tape, rows, prisma, service, logger };
}
