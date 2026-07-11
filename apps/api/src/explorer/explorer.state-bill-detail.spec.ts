import { ExplorerService } from './explorer.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * REGRESSION (2026-07-10 hot-fix): the web drawer/drill-in reads
 * `bill.abstract`, but stateBillDetail's returned object only ever carried
 * the raw Prisma row's `description` field — the Abstract section was dead
 * for every state bill.
 */

const BASE_ROW = {
  id: 'tx-2025-hb1234',
  state: 'TX',
  identifier: 'HB 1234',
  title: 'An act relating to a study.',
  description: 'This bill establishes a study committee.' as string | null,
  status: 'introduced',
  statusAt: null,
  latestActionDate: null,
  textDate: null,
  actions: [] as unknown[],
  versions: [] as unknown[],
  links: [] as unknown[],
};

function makePrisma(row: typeof BASE_ROW | null) {
  return {
    stateBill: { findUnique: jest.fn(async () => row) },
    stateRollCallVote: { findMany: jest.fn(async () => []) },
  } as unknown as PrismaService;
}

describe('ExplorerService.stateBillDetail — abstract field mapping', () => {
  it('maps description onto `abstract` so the web Abstract section renders', async () => {
    const svc = new ExplorerService(makePrisma(BASE_ROW));
    const r = await svc.stateBillDetail('tx-2025-hb1234');
    expect(r?.bill.abstract).toBe('This bill establishes a study committee.');
  });

  it('abstract is null (not undefined) when description is null — a defined-but-empty contract', async () => {
    const svc = new ExplorerService(makePrisma({ ...BASE_ROW, description: null }));
    const r = await svc.stateBillDetail('tx-2025-hb1234');
    expect(r?.bill.abstract).toBeNull();
  });

  it('returns null for a bill that does not exist (unchanged behavior)', async () => {
    const svc = new ExplorerService(makePrisma(null));
    const r = await svc.stateBillDetail('does-not-exist');
    expect(r).toBeNull();
  });
});
