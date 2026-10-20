import { TrackerWatchlistService } from '../../../src/tracker/tracker-watchlist.service.js';
import type { PrismaService } from '../../../src/prisma/prisma.service.js';
import { CLIENT, IoTape, scoped, replacePrivate } from './io.js';

export interface ReadHead {
  issueAreas: string[];
  jurisdictions: string[];
  version: number | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}
export interface ReadTopic {
  id: string;
  label: string;
  issueArea: string | null;
  position: string;
  priority: string;
}
export interface ReadTerm {
  id: string;
  topicId: string | null;
  termType: string;
  value: string;
  weight?: number;
}
export interface RevisionRow {
  version: number;
  changedBy: string | null;
  createdAt: Date;
  summary: unknown;
}

export function readHarness() {
  const tape = new IoTape();
  const rows = {
    head: {
      issueAreas: ['Energy'],
      jurisdictions: ['CA'],
      version: 7,
      updatedBy: 'user-owner',
      updatedAt: new Date(0),
    } as ReadHead | null,
    topics: [] as ReadTopic[],
    terms: [] as ReadTerm[],
    revisions: [] as RevisionRow[],
    sector: [{ sectorTag: 'DEFENSE' as string | null }],
    facilities: [] as Array<{ state: string | null }>,
    names: [{ firstName: 'Ada' as string | null, lastName: 'Lovelace' as string | null }],
  };
  const tx = {
    watchlist: { findFirst: (args: unknown) => tape.run('read.head', args, rows.head) },
    watchlistTopic: { findMany: (args: unknown) => tape.run('read.topics', args, rows.topics) },
    watchlistTerm: { findMany: (args: unknown) => tape.run('read.terms', args, rows.terms) },
    intelWatchlistRevision: {
      findMany: (args: unknown) => tape.run('read.revisions', args, rows.revisions),
    },
  };
  const systemTx = {
    $queryRawUnsafe: (sql: string, ...bindings: unknown[]) => {
      const args = { sql, bindings };
      if (sql.includes('sector_tag')) return tape.run('system.sector', args, rows.sector);
      if (sql.includes('client_facilities'))
        return tape.run('system.facilities', args, rows.facilities);
      if (sql.includes('first_name')) return tape.run('system.names', args, rows.names);
      return tape.run('system.client', args, [{ id: CLIENT }]);
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
