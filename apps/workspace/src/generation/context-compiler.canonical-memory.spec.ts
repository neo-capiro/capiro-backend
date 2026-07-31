import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WorkspaceContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'playbook',
  slug: 'firm',
  title: 'FY27 position',
  clientId: null,
  ownerUserId: null,
  visibility: 'tenant',
  status: 'active',
  legacyStatus: 'active',
  governedStatus: 'active',
  sections: [{ owner: 'human', heading: 'Memory', body: 'Support the verified plus-up.' }],
  memoryClass: 'institutional_authoritative',
  governedAuthority: 'firm_approved',
  sourceType: 'user_message',
  sourceId: '33333333-3333-4333-8333-333333333333',
  sourceVersion: 'candidate:33333333-3333-4333-8333-333333333333',
  approvedByUserId: '44444444-4444-4444-8444-444444444444',
  approvedAt: '2026-07-30T00:00:00.000Z',
  asOf: '2026-07-30T00:00:00.000Z',
  sensitivity: 'normal',
  conflictStatus: 'none',
};

function sqlText(strings: unknown): string {
  if (Array.isArray(strings)) return strings.join('?');
  const sql = strings as { strings?: string[]; raw?: string[] };
  return (sql.strings ?? sql.raw ?? []).join('?');
}

describe('Workspace canonical governed memory — Phase 8', () => {
  function harness(options: { canary?: boolean; surfaceCanary?: boolean } = {}) {
    const sql: string[] = [];
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const executions: Array<{ sql: string; values: unknown[] }> = [];
    const tx = {
      $executeRaw: jest.fn(async (arg: unknown, ...values: unknown[]) => {
        executions.push({ sql: sqlText(arg), values });
        return 1;
      }),
      $queryRaw: jest.fn(async (arg: unknown, ...values: unknown[]) => {
        const text = sqlText(arg);
        sql.push(text);
        queries.push({ sql: text, values });
        if (text.includes('FROM memory_items')) return [ROW];
        if (text.includes('FROM context_packet')) return [{ id: String(values[0]) }];
        return [];
      }),
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
      $queryRaw: jest.fn(async (arg: unknown) => {
        const text = sqlText(arg);
        if (text.includes('FROM tenants')) {
          return [
            {
              settings: {
                clioFeatureFlags: {
                  'meriv2.contextPacketV2': options.canary !== false,
                  'meriv2.contextPacketV2.workspace-gen': options.surfaceCanary !== false,
                },
              },
            },
          ];
        }
        return [];
      }),
    } as unknown as PrismaService;
    return {
      service: new WorkspaceContextCompilerService(prisma),
      sql,
      queries,
      executions,
    };
  }

  const original = process.env.MERIV2_CONTEXT_PACKET_V2;
  beforeEach(() => {
    delete process.env.MERIV2_CONTEXT_PACKET_V2;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MERIV2_CONTEXT_PACKET_V2;
    else process.env.MERIV2_CONTEXT_PACKET_V2 = original;
  });

  it('off keeps v1 free of unapplied governed columns', async () => {
    const h = harness();
    const packet = await h.service.compileForClerkOwner({
      tenantId: 't1',
      surface: 'workspace-gen',
      layers: ['firm-playbook'],
      contractVersion: 2,
    });
    expect(packet.version).toBe(1);
    expect(packet).not.toHaveProperty('rolloutMode');
    expect(h.sql.find((text) => text.includes('FROM memory_items'))).not.toContain('memory_authority');
  });

  it('enforce returns the exact canonical id and authority', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const h = harness();
    const packet = await h.service.compileForClerkOwner({
      tenantId: 't1',
      surface: 'workspace-gen',
      layers: ['firm-playbook'],
    });
    expect(packet.version).toBe(2);
    const memoryQuery = h.queries.find((entry) => entry.sql.includes('FROM memory_items'));
    expect(memoryQuery).toBeDefined();
    expect(memoryQuery!.values).toContainEqual(
      expect.stringContaining('governed_status AS "governedStatus"'),
    );
    expect(packet.items).toEqual([
      expect.objectContaining({
        id: ROW.id,
        authority: 'firm_approved',
        memoryClass: 'institutional_authoritative',
      }),
    ]);
  });

  it('Workspace excludes a governed terminal row when legacy status is active', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const h = harness();
    const original = ROW.governedStatus;
    ROW.governedStatus = 'expired';
    try {
      const packet = await h.service.compileForClerkOwner({
        tenantId: 't1',
        surface: 'workspace-gen',
        layers: ['firm-playbook'],
      });
      expect(packet.version).toBe(2);
      if (packet.version !== 2) throw new Error('expected v2');
      expect(packet.items).toEqual([]);
      expect(packet.exclusions).toEqual([
        expect.objectContaining({ id: ROW.id, reason: 'expired' }),
      ]);
    } finally {
      ROW.governedStatus = original;
    }
  });

  it('a tenant umbrella without the exact Workspace surface canary remains on v1', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const packet = await harness({ surfaceCanary: false }).service.compileForClerkOwner({
      tenantId: 't1',
      surface: 'workspace-gen',
      layers: ['firm-playbook'],
    });
    expect(packet.version).toBe(1);
  });

  it('persists the server-resolved effective tenant rather than replacing it with tenantId', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const h = harness();
    const packet = await h.service.compileForClerkOwner({
      tenantId: 'tenant-1',
      effectiveTenantId: 'effective-tenant-1',
      surface: 'workspace-gen',
      layers: ['firm-playbook'],
    });
    const insert = h.executions.find((entry) => entry.sql.includes('INSERT INTO context_packet'));
    expect(insert).toBeDefined();
    expect(insert!.values[1]).toBe('tenant-1');
    expect(insert!.values[2]).toBe('effective-tenant-1');
    expect(packet.effectiveTenantId).toBe('effective-tenant-1');
    expect(packet.persisted).toBe(true);
  });

  it('shadow persists both packets but returns unchanged v1', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'shadow';
    const h = harness();
    const packet = await h.service.compileForClerkOwner({
      tenantId: 't1',
      surface: 'workspace-gen',
      layers: ['firm-playbook'],
    });
    expect(packet.version).toBe(1);
    expect(packet).not.toHaveProperty('rolloutMode');
    expect(packet).not.toHaveProperty('shadowComparison');
    expect(h.executions.filter((entry) => entry.sql.includes('INSERT INTO context_packet'))).toHaveLength(2);
  });
});
