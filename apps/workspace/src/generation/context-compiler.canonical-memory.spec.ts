import { WorkspaceContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'playbook',
  slug: 'clio:22222222-2222-4222-8222-222222222222',
  title: 'FY27 position',
  clientId: null,
  ownerUserId: null,
  visibility: 'tenant',
  status: 'active',
  sections: [{ owner: 'human', heading: 'Memory', body: 'Support the verified plus-up.' }],
  memoryClass: 'institutional_authoritative',
  governedAuthority: 'firm_approved',
  sourceType: 'user_message',
  sourceId: '33333333-3333-4333-8333-333333333333',
  sourceVersion: 'candidate:33333333-3333-4333-8333-333333333333',
  approvedByUserId: '44444444-4444-4444-8444-444444444444',
  approvedAt: '2026-07-30T00:00:00.000Z',
  sensitivity: 'normal',
  conflictStatus: 'none',
};

function sqlText(strings: unknown): string {
  if (Array.isArray(strings)) return strings.join('?');
  const sql = strings as { strings?: string[]; raw?: string[] };
  return (sql.strings ?? sql.raw ?? []).join('?');
}

describe('Workspace canonical governed memory', () => {
  function harness() {
    const sql: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async (arg: unknown) => {
        const text = sqlText(arg);
        sql.push(text);
        return text.includes('FROM memory_items') ? [ROW] : [];
      }),
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
      $queryRaw: jest.fn(async () => []),
    } as unknown as PrismaService;
    return { service: new WorkspaceContextCompilerService(prisma), sql };
  }

  it('keeps v1 free of unapplied governed columns', async () => {
    const h = harness();
    const packet = await h.service.compileForClerkOwner({
      tenantId: 't1',
      surface: 'workspace-gen',
      layers: ['firm-playbook'],
    });
    expect(packet.version).toBe(1);
    expect(h.sql[0]).not.toContain('memory_authority');
  });

  it('returns the exact canonical id and authority on v2', async () => {
    const h = harness();
    const packet = await h.service.compileForClerkOwner({
      tenantId: 't1',
      surface: 'workspace-gen',
      layers: ['firm-playbook'],
      contractVersion: 2,
    });
    expect(packet.items).toEqual([
      expect.objectContaining({
        id: ROW.id,
        authority: 'firm_approved',
        memoryClass: 'institutional_authoritative',
      }),
    ]);
  });
});
