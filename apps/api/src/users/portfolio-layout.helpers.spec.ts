import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeSavedPortfolioLayout, normalizePortfolioLayoutCatalog, parsePortfolioLayoutInput,
  planPortfolioLayoutRead, planPortfolioLayoutWrite, portfolioLayoutReceipt,
  PORTFOLIO_LAYOUT_MAX_VERSION, type SavedPortfolioLayout,
} from './portfolio-layout.helpers.js';

const T = '11111111-1111-1111-1111-111111111111';
const U = '22222222-2222-2222-2222-222222222222';
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(id) as [string, string, string, string, string];
const input = (order: string[] = [A], expectedVersion = 0) =>
  ({ contractVersion: 1 as const, expectedVersion, order: order.map((value) => `client:${value}`) });
function saved(order: string[] = [A], version = 1): SavedPortfolioLayout {
  return { tenantId: T, userId: U, clientOrder: order, version, updatedAt: new Date('2026-10-14T00:00:00.123Z') };
}

describe('Portfolio layout wire parser', () => {
  it('accepts exact version zero and the empty full-catalog order', () => {
    expect(parsePortfolioLayoutInput(input([]))).toEqual(input([]));
  });

  it('accepts 2000 unique lowercase UUID tokens and the final writable version', () => {
    const request = input(Array.from({ length: 2000 }, (_, index) => id(index)), PORTFOLIO_LAYOUT_MAX_VERSION - 1);
    expect(parsePortfolioLayoutInput(request)).toEqual(request);
  });

  it('accepts generic UUID spelling as syntax without granting nil/v7 resource authority', () => {
    const ids = [id(0), '11111111-1111-7111-8111-111111111111'];
    expect(parsePortfolioLayoutInput(input(ids)).order).toEqual(ids.map((value) => `client:${value}`));
  });

  it('snapshots supplied order and primitive version instead of retaining caller data', () => {
    const request = input();
    const parsed = parsePortfolioLayoutInput(request);
    request.order.push(`client:${B}`);
    request.expectedVersion = 9;
    expect(parsed).toEqual(input());
  });

  it('accepts null-prototype ordinary own-data JSON objects', () => {
    expect(parsePortfolioLayoutInput(Object.assign(Object.create(null), input()))).toEqual(input());
  });

  it.each([
    ['null', null], ['primitive', 'input'], ['array body', []],
    ['missing field', { contractVersion: 1, order: [] }],
    ['caller actor', { ...input(), userId: U }], ['caller tenant', { ...input(), tenantId: T }],
    ['string contract', { ...input(), contractVersion: '1' }], ['future contract', { ...input(), contractVersion: 2 }],
    ['string version', { ...input(), expectedVersion: '0' }], ['fraction version', { ...input(), expectedVersion: 0.5 }],
    ['negative version', { ...input(), expectedVersion: -1 }], ['NaN version', { ...input(), expectedVersion: NaN }],
    ['infinite version', { ...input(), expectedVersion: Infinity }],
    ['exhausted wire version', { ...input(), expectedVersion: PORTFOLIO_LAYOUT_MAX_VERSION }],
    ['nonarray order', { ...input(), order: {} }], ['null order', { ...input(), order: null }],
    ['bad UUID', { ...input(), order: ['client:bad'] }], ['other kind', { ...input(), order: [`prospect:${A}`] }],
    ['uppercase UUID', { ...input(), order: ['client:aaaaaaaa-AAAA-0000-0000-000000000000'] }],
    ['terminal newline', { ...input(), order: [`client:${A}\n`] }],
    ['duplicate token', input([A, A])], ['capacity', input(Array.from({ length: 2001 }, (_, index) => id(index)))],
  ])('rejects %s without an accepted replacement', (_label, request) => {
    expect(() => parsePortfolioLayoutInput(request)).toThrow(BadRequestException);
  });

  it('refuses prototype, symbol, nonenumerable, and accessor fields without getters', () => {
    let calls = 0;
    const getter = { ...input() };
    Object.defineProperty(getter, 'order', { enumerable: true, get() { calls += 1; return []; } });
    const hidden = { ...input() };
    Object.defineProperty(hidden, 'expectedVersion', { enumerable: false, value: 0 });
    const symbol = { ...input(), [Symbol('field')]: 1 };
    const inherited = Object.create(input());
    for (const request of [getter, hidden, symbol, inherited])
      expect(() => parsePortfolioLayoutInput(request)).toThrow(BadRequestException);
    expect(calls).toBe(0);
  });

  it('refuses holes, accessor elements, and extra array properties without evaluation', () => {
    let calls = 0;
    const hole = new Array(1);
    const getter: unknown[] = [];
    Object.defineProperty(getter, '0', { enumerable: true, get() { calls += 1; return `client:${A}`; } });
    const extra = [`client:${A}`];
    Object.assign(extra, { scope: 'all' });
    for (const order of [hole, getter, extra])
      expect(() => parsePortfolioLayoutInput({ ...input(), order })).toThrow(BadRequestException);
    expect(calls).toBe(0);
  });

  it('refuses normal and revoked proxies before any trap can run', () => {
    let traps = 0;
    const proxy = new Proxy(input(), { ownKeys() { traps += 1; throw new Error('trap'); } });
    const revoked = Proxy.revocable(input(), {}); revoked.revoke();
    const order = new Proxy([], { get() { traps += 1; throw new Error('trap'); } });
    for (const request of [proxy, revoked.proxy, { ...input(), order }])
      expect(() => parsePortfolioLayoutInput(request)).toThrow(BadRequestException);
    expect(traps).toBe(0);
  });
});

describe('Portfolio layout durable row and six-key receipt', () => {
  it('represents absence as virtual zero/null without a persistence operation', () => {
    expect(portfolioLayoutReceipt(T, U, null, [B, A])).toEqual({
      contractVersion: 1, tenantId: T, userId: U, version: 0, updatedAt: null, order: [`client:${A}`, `client:${B}`],
    });
  });

  it('preserves durable order/date/version and returns only the six contract fields', () => {
    const receipt = portfolioLayoutReceipt(T, U, saved([B, A], 7), [A, B]);
    expect(Object.keys(receipt).sort()).toEqual(['contractVersion', 'order', 'tenantId', 'updatedAt', 'userId', 'version']);
    expect(receipt).toEqual({ contractVersion: 1, tenantId: T, userId: U, version: 7,
      updatedAt: '2026-10-14T00:00:00.123Z', order: [`client:${B}`, `client:${A}`] });
  });

  it.each([
    ['foreign tenant', { ...saved(), tenantId: U }], ['foreign user', { ...saved(), userId: T }],
    ['zero persisted version', saved([A], 0)], ['fraction', saved([A], 1.5)],
    ['overflow', saved([A], PORTFOLIO_LAYOUT_MAX_VERSION + 1)],
    ['null date', { ...saved(), updatedAt: null }], ['date string', { ...saved(), updatedAt: '2026-10-14' }],
    ['invalid date', { ...saved(), updatedAt: new Date(NaN) }],
    ['duplicate stored IDs', saved([A, A])], ['missing field', { version: 1 }],
  ])('fails unavailable for %s instead of pretending no row exists', (_label, row) => {
    expect(() => decodeSavedPortfolioLayout(row, T, U)).toThrow(ServiceUnavailableException);
  });

  it('uses intrinsic Date extraction and snapshots arrays without custom serialization', () => {
    const row = saved();
    let calls = 0;
    Object.assign(row.updatedAt, { getTime() { calls += 1; throw new Error('effect'); },
      toISOString() { calls += 1; throw new Error('effect'); } });
    const decoded = decodeSavedPortfolioLayout(row, T, U);
    row.clientOrder.push(B);
    expect(decoded.clientOrder).toEqual([A]);
    expect(decoded.updatedAt.toISOString()).toBe('2026-10-14T00:00:00.123Z');
    expect(calls).toBe(0);
  });

  it('does not emit a partial, foreign, or unreconciled catalog receipt', () => {
    expect(() => portfolioLayoutReceipt(T, U, saved([A]), [A, B])).toThrow(ServiceUnavailableException);
    expect(() => portfolioLayoutReceipt(T, U, saved([A, C]), [A, B])).toThrow(ServiceUnavailableException);
  });

  it('refuses malformed native catalog, duplicate IDs, or capacity without truncation', () => {
    for (const catalog of [[A, A], [`${A}\n`], [null], ['ABC'], new Array(1)])
      expect(() => normalizePortfolioLayoutCatalog(catalog)).toThrow(ServiceUnavailableException);
    expect(() => normalizePortfolioLayoutCatalog(Array.from({ length: 2001 }, (_, index) => id(index))))
      .toThrow(ServiceUnavailableException);
    expect(normalizePortfolioLayoutCatalog(Array.from({ length: 2000 }, (_, index) => id(index))).length).toBe(2000);
  });

  it('refuses revoked and ordinary catalog proxies before traps or native Array inspection', () => {
    let traps = 0;
    const proxy = new Proxy([A], { get() { traps += 1; throw new Error('trap'); } });
    const revoked = Proxy.revocable([A], {}); revoked.revoke();
    for (const catalog of [proxy, revoked.proxy])
      expect(() => normalizePortfolioLayoutCatalog(catalog)).toThrow(ServiceUnavailableException);
    expect(traps).toBe(0);
  });
});

describe('Portfolio layout reconciliation and write plans', () => {
  it('retains relative survivor order, removes old cards, and appends new cards deterministically', () => {
    const row = saved([B, C, A], 4);
    expect(planPortfolioLayoutRead(row, [E, A, D, B])).toEqual({ changed: true, clientOrder: [B, A, D, E], version: 5 });
    expect(row.clientOrder).toEqual([B, C, A]);
  });

  it('does not increment a durable GET twice once reconciliation has persisted', () => {
    const first = planPortfolioLayoutRead(saved([B, C, A], 4), [E, A, D, B]);
    expect(planPortfolioLayoutRead(saved(first.clientOrder, first.version), [B, D, A, E]))
      .toEqual({ changed: false, clientOrder: first.clientOrder, version: 5 });
  });

  it('handles empty churn without manufacturing an initial state', () => {
    expect(planPortfolioLayoutRead(saved([A], 7), [])).toEqual({ changed: true, clientOrder: [], version: 8 });
    expect(planPortfolioLayoutRead(null, [])).toEqual({ changed: false, clientOrder: [], version: 0 });
  });

  it('permits unchanged GET at MAX_INT but refuses an overflowing reconciliation', () => {
    expect(planPortfolioLayoutRead(saved([A], PORTFOLIO_LAYOUT_MAX_VERSION), [A]).version).toBe(PORTFOLIO_LAYOUT_MAX_VERSION);
    expect(() => planPortfolioLayoutRead(saved([A], PORTFOLIO_LAYOUT_MAX_VERSION), [A, B]))
      .toThrow(ServiceUnavailableException);
  });

  it('initial save accepts zero and returns exactly submitted order at version one', () => {
    expect(planPortfolioLayoutWrite(null, input([B, A]), [A, B])).toEqual({ clientOrder: [B, A], version: 1 });
  });

  it('increments even an identical submitted order by exactly one', () => {
    expect(planPortfolioLayoutWrite(saved([B, A], 7), input([B, A], 7), [A, B])).toEqual({ clientOrder: [B, A], version: 8 });
  });

  it('refuses stale/missing-row expected versions without accepting a replacement', () => {
    expect(() => planPortfolioLayoutWrite(saved([A], 4), input([A], 3), [A])).toThrow(ConflictException);
    expect(() => planPortfolioLayoutWrite(null, input([A], 1), [A])).toThrow(ConflictException);
  });

  it('refuses full-catalog omissions, foreign/archived tokens and duplicate direct-helper requests', () => {
    for (const order of [[A], [A, C], []])
      expect(() => planPortfolioLayoutWrite(saved([A, B], 1), input(order, 1), [A, B])).toThrow(ConflictException);
    expect(() => planPortfolioLayoutWrite(null, input([A, A]), [A])).toThrow(BadRequestException);
  });

  it('fails exhausted persistence without mutating or wrapping its version', () => {
    const row = saved([A], PORTFOLIO_LAYOUT_MAX_VERSION);
    expect(() => planPortfolioLayoutWrite(row, input([A], PORTFOLIO_LAYOUT_MAX_VERSION - 1), [A]))
      .toThrow(ServiceUnavailableException);
    expect(row.version).toBe(PORTFOLIO_LAYOUT_MAX_VERSION);
  });

  it('lost-reply recovery can match only the actual expected+1 durable order', () => {
    const attempt = input([B, A], 3);
    const matches = (row: SavedPortfolioLayout, catalog: string[]) => {
      const receipt = portfolioLayoutReceipt(T, U, row, catalog);
      return receipt.version === attempt.expectedVersion + 1 && JSON.stringify(receipt.order) === JSON.stringify(attempt.order);
    };
    expect(matches(saved([B, A], 4), [A, B])).toBe(true);
    expect(matches(saved([B, A], 5), [A, B])).toBe(false);
    expect(matches(saved([A, B], 4), [A, B])).toBe(false);
    expect(matches(saved([B, A, C], 5), [A, B, C])).toBe(false);
  });
});

describe('Portfolio layout additive schema source', () => {
  it('isolates actor preferences outside membership and reuses tenant/user RLS without role changes', () => {
    const prisma = resolve(__dirname, '../../prisma');
    const schema = readFileSync(resolve(prisma, 'schema.prisma'), 'utf8');
    const sql = readFileSync(resolve(prisma, 'migrations/20261014050000_user_portfolio_layout/migration.sql'), 'utf8');
    const model = schema.match(/model UserPortfolioLayout \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(model).toContain('@@id([tenantId, userId]');
    expect(model).toContain('clientOrder String[]');
    expect(model).toContain('onDelete: Cascade');
    expect(model).not.toContain('TenantMembership');
    expect(sql).toContain('count(DISTINCT id)');
    expect(sql).toContain('cardinality(order_ids) > 2000');
    expect(sql).toContain('"version" BETWEEN 1 AND 2147483647');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql.match(/current_user_id\(\)/g)).toHaveLength(2);
    expect(sql.match(/current_tenant_id\(\)/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\b(?:GRANT|REVOKE|CREATE ROLE|ALTER ROLE)\b/);
  });
});
