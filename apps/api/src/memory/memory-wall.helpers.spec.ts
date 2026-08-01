import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import {
  clientMemoryAllowed,
  fetchDeniedClientIds,
  toUuidArrayLiteral,
  wallExclusionSql,
} from './memory-wall.helpers.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLIENT_A = '33333333-3333-3333-3333-333333333333';
const CLIENT_B = '44444444-4444-4444-4444-444444444444';

/** Minimal tx double: $queryRawUnsafe resolves the given rows. */
function txReturning(rows: unknown[]): Prisma.TransactionClient {
  return {
    $queryRawUnsafe: jest.fn<() => Promise<unknown[]>>().mockResolvedValue(rows),
  } as unknown as Prisma.TransactionClient;
}

describe('toUuidArrayLiteral', () => {
  it('renders a validated uuid[] literal', () => {
    expect(toUuidArrayLiteral([CLIENT_A, CLIENT_B])).toBe(`'{${CLIENT_A},${CLIENT_B}}'::uuid[]`);
  });

  it('throws on anything that is not a canonical uuid (injection guard)', () => {
    expect(() => toUuidArrayLiteral(["'; DROP TABLE clients; --"])).toThrow(/not a uuid/);
    expect(() => toUuidArrayLiteral([`${CLIENT_A}'`])).toThrow(/not a uuid/);
    expect(() => toUuidArrayLiteral([''])).toThrow(/not a uuid/);
  });
});

describe('wallExclusionSql', () => {
  it('is a no-op (empty string) for an empty denied set — the unwalled common case', () => {
    expect(wallExclusionSql([], 'mi.client_id')).toBe('');
  });

  it('excludes denied clients but keeps client-less rows (explicit IS NULL arm)', () => {
    const sql = wallExclusionSql([CLIENT_A], 'mi.client_id');
    expect(sql).toContain('mi.client_id IS NULL');
    expect(sql).toContain(`NOT (mi.client_id = ANY('{${CLIENT_A}}'::uuid[]))`);
    expect(sql.startsWith(' AND (')).toBe(true);
  });
});

describe('fetchDeniedClientIds', () => {
  it('returns the walled-without-grant client ids', async () => {
    const tx = txReturning([{ id: CLIENT_A }, { id: CLIENT_B }]);
    await expect(fetchDeniedClientIds(tx, TENANT, USER)).resolves.toEqual([CLIENT_A, CLIENT_B]);
  });

  it('passes a NULL user through to SQL (fail-closed: every walled client denied)', async () => {
    const tx = txReturning([{ id: CLIENT_A }]);
    await fetchDeniedClientIds(tx, TENANT, null);
    const call = (tx.$queryRawUnsafe as jest.Mock).mock.calls[0] as unknown[];
    expect(call?.[1]).toBe(TENANT);
    expect(call?.[2]).toBeNull();
  });
});

describe('clientMemoryAllowed', () => {
  it('true when SQL resolves allowed=true (not walled, or granted)', async () => {
    const tx = txReturning([{ allowed: true }]);
    await expect(clientMemoryAllowed(tx, TENANT, USER, CLIENT_A)).resolves.toBe(true);
  });

  it('false when walled without a grant', async () => {
    const tx = txReturning([{ allowed: false }]);
    await expect(clientMemoryAllowed(tx, TENANT, USER, CLIENT_A)).resolves.toBe(false);
  });

  it('false when the client does not resolve in this tenant (fail-closed)', async () => {
    const tx = txReturning([]);
    await expect(clientMemoryAllowed(tx, TENANT, USER, CLIENT_A)).resolves.toBe(false);
  });
});
