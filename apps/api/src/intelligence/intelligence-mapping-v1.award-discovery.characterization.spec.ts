import { Prisma } from '@prisma/client';
import {
  assistanceRow,
  contractorRow,
  harness,
  installHooks,
  now,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();

describe('Contractor discovery identifier bindings', () => {
  test.each([
    { query: 'abcDEF123456', uuid: false, uei: true },
    { query: '00000000-0000-0000-0000-000000000030', uuid: true, uei: false },
    { query: 'Acme Research', uuid: false, uei: false },
  ])('retains identifier branches for $query', async ({ query, uuid, uei }) => {
    const h = harness();
    await h.service.searchContractors(` ${query} `);
    expect(h.callsOf('contractors')[0]!.query!.values).toEqual([
      query,
      uuid,
      query,
      uei,
      uei ? query.toUpperCase() : null,
      query,
      uuid,
      query,
      uei,
      uei ? query.toUpperCase() : null,
    ]);
    const sql = h.callsOf('contractors')[0]!.query!.sql;
    expect(sql).toContain('id::text = ?');
    expect(sql).toContain('uei = ?');
    expect(sql).toContain('ORDER BY similarity DESC, total_contracts DESC NULLS LAST');
    expect(sql).toContain('LIMIT 25');
  });
  test.each(['A12BC', '12345'])(
    'reports unsupported CAGE-like input %s while still performing catalog search',
    async (query) => {
      const h = harness();
      const value = await h.service.searchContractors(query);
      expect(value).toEqual({
        results: [],
        unsupportedIdentifier:
          'That looks like a CAGE code. The federal contractor catalog Capiro holds carries UEI but no CAGE code, so a CAGE cannot be looked up here — search by name or UEI instead.',
      });
      expect(h.callsOf('contractors')).toHaveLength(1);
    },
  );
  test('does not mark a five-letter name as CAGE', async () => {
    expect((await harness().service.searchContractors('ACMES')).unsupportedIdentifier).toBeNull();
  });
});

describe('Contractor discovery projection', () => {
  test('keeps exact-UEI evidence, dates and null/default scalar fields', async () => {
    const h = harness({
      rows: {
        contractors: [
          contractorRow({
            uei: 'abcdef123456',
            total_contracts: new Prisma.Decimal('12.50'),
            similarity: null,
          }),
          contractorRow({
            id: 'other',
            uei: 'ZYXWVU654321',
            last_synced_at: null,
            category: null,
            rank_by_contracts: null,
          }),
        ],
      },
    });
    const value = await h.service.searchContractors('ABCDEF123456');
    expect(value.results[0]).toEqual({
      id: '00000000-0000-0000-0000-000000000030',
      name: 'Acme Research',
      uei: 'abcdef123456',
      category: 'Research',
      totalContracts: 12.5,
      rankByContracts: 1,
      sourceSyncedAt: now.toISOString(),
      similarity: 0,
      matchedOnIdentifier: true,
    });
    expect(value.results[1]).toMatchObject({
      category: null,
      rankByContracts: null,
      sourceSyncedAt: null,
      matchedOnIdentifier: false,
    });
  });
  test('does not label an exact UUID paste as an exact UEI match', async () => {
    const row = contractorRow();
    const h = harness({ rows: { contractors: [row] } });
    expect((await h.service.searchContractors(row.id)).results[0]!.matchedOnIdentifier).toBe(false);
  });
  test.each([
    { name: 'null', input: null, expected: null },
    { name: 'undefined', input: undefined, expected: null },
    { name: 'numeric string', input: '-12.5', expected: -12.5 },
    { name: 'empty string', input: '', expected: 0 },
    { name: 'false', input: false, expected: 0 },
    { name: 'NaN', input: NaN, expected: null },
    { name: 'Infinity', input: Infinity, expected: null },
    { name: 'nonnumeric text', input: 'bad', expected: null },
    { name: 'valueOf number', input: { valueOf: () => 42 }, expected: 42 },
  ])('keeps real Decimal-helper coercion for $name', async ({ input, expected }) => {
    const h = harness({ rows: { contractors: [contractorRow({ total_contracts: input })] } });
    expect((await h.service.searchContractors('Research')).results[0]!.totalContracts).toBe(
      expected,
    );
  });
  test('propagates noncoercible totals instead of soft-catching them', async () => {
    const h = harness({
      rows: { contractors: [contractorRow({ total_contracts: Symbol('amount') })] },
    });
    await expect(h.service.searchContractors('Research')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('Assistance-recipient catalog identity', () => {
  test.each([
    { query: 'abcDEF123456', uei: true },
    { query: 'MIT', uei: false },
  ])('keeps short-name index recall and exact-UEI bindings for $query', async ({ query, uei }) => {
    const h = harness();
    await h.service.searchAssistanceRecipients(` ${query} `);
    const capture = h.callsOf('assistance')[0]!.query!;
    expect(capture.values).toEqual([query, query, uei, query, query, query, uei, query]);
    const sql = capture.sql.replace(/--[^\n]*/g, '');
    expect(sql).toContain('lower(recipient_name) % lower(?)');
    expect(sql).toContain('lower(recipient_name) %> lower(?)');
    expect(sql).toContain('recipient_uei = upper(?)');
    expect(sql).not.toContain('upper(recipient_uei)');
    expect(sql).toContain('GROUP BY COALESCE(recipient_uei, recipient_name)');
    expect(sql).toContain('ORDER BY similarity DESC, total_obligated DESC');
    expect(sql).toContain('LIMIT 25');
  });
  test('prefers the recipient UEI then name then empty ID with nullish rather than truthy fallback', async () => {
    const h = harness({
      rows: {
        assistance: [
          assistanceRow(),
          assistanceRow({ uei: null }),
          assistanceRow({ uei: null, name: null }),
          assistanceRow({ uei: '', name: 'Named' }),
        ],
      },
    });
    expect((await h.service.searchAssistanceRecipients('Research')).map((row) => row.id)).toEqual([
      'ABCDEF123456',
      'Acme Research',
      '',
      '',
    ]);
  });
  test('retains award and obligated scalar values while coercing only similarity', async () => {
    const h = harness({
      rows: {
        assistance: [
          assistanceRow({
            award_count: '4',
            total_obligated: '12.5',
            similarity: null,
            state: null,
          }),
        ],
      },
    });
    expect(await h.service.searchAssistanceRecipients('Research')).toEqual([
      {
        id: 'ABCDEF123456',
        uei: 'ABCDEF123456',
        name: 'Acme Research',
        state: null,
        awardCount: '4',
        totalObligated: '12.5',
        similarity: 0,
      },
    ]);
  });
});
