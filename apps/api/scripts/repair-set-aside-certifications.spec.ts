import { describe, expect, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import {
  parseRepairSetAsideArgs,
  repairCertifications,
  repairSetAsideCertifications,
} from './repair-set-aside-certifications.js';

const asPrisma = (fake: unknown): PrismaClient => fake as PrismaClient;
const TENANT = '00000000-0000-0000-0000-000000000001';

describe('argument parsing', () => {
  test('dry run is the default', () => {
    expect(parseRepairSetAsideArgs(['node', 'script'])).toEqual({
      commit: false,
      tenantId: null,
      clientId: null,
    });
  });

  test('--commit, --tenant and --client are honoured in both spellings', () => {
    expect(parseRepairSetAsideArgs(['node', 's', '--commit', '--tenant', 't1', '--client', 'c1'])).toEqual(
      { commit: true, tenantId: 't1', clientId: 'c1' },
    );
    expect(parseRepairSetAsideArgs(['node', 's', '--tenant=t2', '--client=c2'])).toEqual({
      commit: false,
      tenantId: 't2',
      clientId: 'c2',
    });
  });
});

describe('repairCertifications', () => {
  test('an already-durable array needs no repair — the pass is idempotent', () => {
    // Returning null rather than an identical array is what keeps a second run from
    // rewriting every row and churning updated_at.
    expect(repairCertifications(['8A', 'SDVOSB'])).toBeNull();
    expect(repairCertifications([])).toBeNull();
  });

  test('SBA and SBP are DROPPED, not translated', () => {
    // There is no durable certification meaning "we are a small business". The
    // honest home for that is the applicant_types self-report; inventing a
    // certification to preserve the row would recreate the defect.
    const result = repairCertifications(['SBA', 'SBP']);
    expect(result).not.toBeNull();
    expect(result!.next).toEqual([]);
    expect(result!.dropped).toEqual(['SBA', 'SBP']);
    expect(result!.renamed).toEqual([]);
  });

  test('sole-source codes are renamed to the underlying durable status', () => {
    const result = repairCertifications(['SDVOSBS', 'WOSBSS', 'EDWOSBSS', 'HZS', '8AN']);
    expect(result!.next).toEqual(['SDVOSB', 'WOSB', 'EDWOSB', 'HUBZONE', '8A']);
    expect(result!.dropped).toEqual([]);
  });

  test('competed and sole-source variants of the SAME program collapse to one value', () => {
    // 'SDVOSBC' and 'SDVOSBS' both mean the firm is an SDVOSB. A duplicated
    // certification is not a second certification.
    const result = repairCertifications(['SDVOSBC', 'SDVOSBS']);
    expect(result!.next).toEqual(['SDVOSB']);
  });

  test('a mixed array keeps what is durable and repairs the rest', () => {
    const result = repairCertifications(['8A', 'SBA', 'HZC']);
    expect(result!.next).toEqual(['8A', 'HUBZONE']);
    expect(result!.dropped).toEqual(['SBA']);
    expect(result!.renamed).toEqual([{ from: 'HZC', to: 'HUBZONE' }]);
  });

  test('punctuated and lowercase spellings are normalized', () => {
    const result = repairCertifications(['8(a)', ' sdvosbc ']);
    expect(result!.next).toEqual(['8A', 'SDVOSB']);
  });

  test('an unrecognized value is dropped AND reported', () => {
    // Reported so a real certification vocabulary nobody told set-aside.ts about
    // does not vanish into a count.
    const result = repairCertifications(['MYSTERYCERT']);
    expect(result!.next).toEqual([]);
    expect(result!.unrecognized).toEqual(['MYSTERYCERT']);
    expect(result!.dropped).toEqual(['MYSTERYCERT']);
  });

  test('empty strings and whitespace are dropped without being called unrecognized', () => {
    const result = repairCertifications(['', '   ', '8A']);
    expect(result!.next).toEqual(['8A']);
    expect(result!.unrecognized).toEqual([]);
  });

  test('the repaired output is a FIXED POINT — repairing it again is a no-op', () => {
    for (const input of [
      ['SBA', 'SBP'],
      ['SDVOSBS', 'WOSBSS'],
      ['8A', 'SBA', 'HZC'],
      ['8(a)', 'MYSTERYCERT'],
      ['SDVOSBC', 'SDVOSBS'],
    ]) {
      const first = repairCertifications(input);
      expect(first).not.toBeNull();
      expect(repairCertifications(first!.next)).toBeNull();
    }
  });
});

// ── Integration over a fake client ──────────────────────────────────────────

function repairFake(clients: Array<{ id: string; setAsideCertifications: string[] }>) {
  const updates: any[] = [];
  const audits: any[] = [];
  const pages: Array<{ cursor: string | null; where: any }> = [];
  const fake: Record<string, any> = {};
  fake.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(fake);
  fake.$executeRawUnsafe = async () => 0;
  const rows = clients.map((c) => ({ tenantId: TENANT, ...c }));
  fake.client = {
    findMany: async (args: any) => {
      const cursor: string | null = args?.where?.id?.gt ?? null;
      pages.push({ cursor, where: args?.where });
      return rows
        .filter((r) => (cursor ? r.id > cursor : true))
        .filter((r) => (args?.where?.id?.equals ? r.id === args.where.id.equals : true))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args?.take ?? rows.length);
    },
    update: async (args: any) => {
      updates.push(args);
      const row = rows.find((r) => r.id === args.where.id);
      if (row) row.setAsideCertifications = args.data.setAsideCertifications;
      return row;
    },
  };
  fake.auditLog = {
    create: async (args: any) => {
      audits.push(args);
      return args;
    },
  };
  return { fake, updates, audits, pages, rows };
}

describe('repairSetAsideCertifications', () => {
  test('a dry run writes nothing but reports what it would do', async () => {
    const { fake, updates, audits } = repairFake([
      { id: 'c1', setAsideCertifications: ['SBA', 'HZC'] },
    ]);
    const result = await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: false,
    });
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(result.repaired).toBe(1);
    expect(result.droppedValues).toBe(1);
    expect(result.renamedValues).toBe(1);
  });

  test('--commit writes the repaired array and an audit row in one transaction', async () => {
    const { fake, updates, audits } = repairFake([
      { id: 'c1', setAsideCertifications: ['SBA', 'HZC'] },
    ]);
    await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(updates[0].data.setAsideCertifications).toEqual(['HUBZONE']);
    expect(audits).toHaveLength(1);
    expect(audits[0].data.action).toBe('client.set_aside_certifications.repaired');
    expect(audits[0].data.entityType).toBe('clients');
    // The ORIGINAL array is in the ledger, so every dropped value is recoverable.
    expect(audits[0].data.before.setAsideCertifications).toEqual(['SBA', 'HZC']);
    expect(audits[0].data.after.dropped).toEqual(['SBA']);
  });

  test('a client already on the durable vocabulary is skipped, not rewritten', async () => {
    const { fake, updates } = repairFake([{ id: 'c1', setAsideCertifications: ['8A'] }]);
    const result = await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(updates).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.repaired).toBe(0);
  });

  test('running it twice is idempotent', async () => {
    const { fake, updates, rows } = repairFake([
      { id: 'c1', setAsideCertifications: ['SDVOSBS', 'SBA'] },
    ]);
    const first = await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(first.repaired).toBe(1);
    expect(rows[0]!.setAsideCertifications).toEqual(['SDVOSB']);

    const second = await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(second.repaired).toBe(0);
    expect(second.skipped).toBe(1);
    expect(updates).toHaveLength(1);
  });

  test('every row is visited by keyset pagination, not one capped window', async () => {
    const clients = Array.from({ length: 1_200 }, (_, i) => ({
      id: `c-${String(i).padStart(5, '0')}`,
      setAsideCertifications: ['SBA'],
    }));
    const { fake, pages } = repairFake(clients);
    const result = await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(result.evaluated).toBe(1_200);
    expect(result.repaired).toBe(1_200);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.cursor).toBeNull();
    expect(pages[1]!.cursor).toBe('c-00499');
  });

  test('--tenant and --client narrow the walk', async () => {
    const { fake, pages } = repairFake([{ id: 'c1', setAsideCertifications: ['SBA'] }]);
    await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: TENANT,
      clientId: 'c1',
      commit: false,
    });
    expect(pages[0]!.where.tenantId).toBe(TENANT);
    expect(pages[0]!.where.id).toBe('c1');
  });

  test('unrecognized values are reported, not silently binned', async () => {
    const { fake } = repairFake([
      { id: 'c1', setAsideCertifications: ['MYSTERYCERT'] },
      { id: 'c2', setAsideCertifications: ['ANOTHERONE'] },
    ]);
    const result = await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: false,
    });
    expect(result.unrecognizedValues.sort()).toEqual(['ANOTHERONE', 'MYSTERYCERT']);
  });

  test('one failing client does not abort the pass', async () => {
    const { fake } = repairFake([
      { id: 'c1', setAsideCertifications: ['SBA'] },
      { id: 'c2', setAsideCertifications: ['HZC'] },
    ]);
    const realUpdate = fake.client.update;
    fake.client.update = async (args: any) => {
      if (args.where.id === 'c1') throw new Error('row locked');
      return realUpdate(args);
    };
    const result = await repairSetAsideCertifications(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(result.errors).toBe(1);
    expect(result.updated).toBe(1);
  });
});
