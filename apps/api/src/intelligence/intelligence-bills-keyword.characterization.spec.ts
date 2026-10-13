import {
  BillKeywordDeadlineExceeded,
  withBillKeywordProfileDeadline,
} from './bill-keyword-deadline.js';
import { billRow, clock, harness, installHooks } from '../../test/fixtures/intelligence-bills.js';

const methods = ['findRelevantBillsByKeyword', 'findTrackedBillsByKeyword'] as const;
const compactSql = (sql?: string) => (sql ?? '').replace(/\s+/g, ' ').trim();
function assertRows(
  result: { total: number; bills: unknown[] },
  method: string,
  introduced: Date,
  latest: Date,
  subjects: string[],
  actions: string[],
) {
  const relevant = method === 'findRelevantBillsByKeyword';
  const expected = relevant
    ? [
        {
          id: '119-hr-1',
          congress: 119,
          billType: 'hr',
          billNumber: '1',
          title: 'Research Z',
          introducedDate: introduced,
          sponsorName: 'Sponsor Z',
          sponsorParty: 'I',
          sponsorState: 'VA',
          latestActionText: 'Reported',
          latestActionDate: latest,
          policyArea: 'Science',
          subjects,
        },
        {
          id: '119-s-2',
          congress: 119,
          billType: 's',
          billNumber: '2',
          title: 'Unknown A',
          introducedDate: null,
          sponsorName: null,
          sponsorParty: null,
          sponsorState: null,
          latestActionText: null,
          latestActionDate: null,
          policyArea: null,
          subjects: [],
        },
      ]
    : [
        {
          identifier: '119-hr-1',
          title: 'Research Z',
          latestActionDate: latest,
          latestActionText: 'Reported',
          status: 'reported',
          actionTexts: actions,
          sponsorName: 'Sponsor Z',
          sponsorParty: 'I',
          subjectNames: subjects,
        },
        {
          identifier: '119-s-2',
          title: 'Unknown A',
          latestActionDate: null,
          latestActionText: null,
          status: undefined,
          actionTexts: undefined,
          sponsorName: null,
          sponsorParty: null,
          subjectNames: [],
        },
      ];
  expect(result).toStrictEqual({ total: 73, bills: expected });
  const first = result.bills[0]! as Record<string, unknown>;
  expect(first.latestActionDate).toBe(latest);
  expect(first[relevant ? 'subjects' : 'subjectNames']).toBe(subjects);
  if (relevant) expect(first.introducedDate).toBe(introduced);
  else expect(first.actionTexts).toBe(actions);
}

function assertKeywordIo(h: ReturnType<typeof harness>, method: string) {
  const count = h.callsOf('keywordCount')[0]!;
  const rows = h.callsOf('keywordRows')[0]!;
  const values = [
    [' defense ', 'c++'],
    '\\m defense \\M',
    '\\mc\\+\\+\\M',
    '\\m defense \\M',
    '\\mc\\+\\+\\M',
    [' defense ', 'c++'],
    '\\m defense \\M',
    '\\mc\\+\\+\\M',
  ];
  expect(count.query!.values).toEqual(values);
  expect(rows.query!.values).toEqual(values);
  expect(compactSql(count.query!.sql)).toContain('SELECT COUNT(*)::bigint AS total FROM (');
  expect(compactSql(count.query!.sql)).toContain(
    'UNION SELECT cb.id FROM congress_bill cb JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id',
  );
  expect(count.query!.sql).not.toContain('~ ANY');
  expect(count.query!.sql).not.toContain(' defense ');
  expect(compactSql(rows.query!.sql)).toContain(
    `ORDER BY cb.latest_action_date DESC NULLS LAST, cb.id LIMIT ${method === 'findRelevantBillsByKeyword' ? 25 : 50}`,
  );
  expect([count.scope, rows.scope]).toEqual(['keyword', 'keyword']);
  expect([count.transaction, rows.transaction]).toEqual([1, 1]);
  expect(h.calls.map((call) => call.operation)).toEqual([
    'transaction',
    'statementTimeout',
    'keywordCount',
    'statementTimeout',
    'keywordRows',
  ]);
  expect(h.events).toEqual([
    'transaction',
    'keyword.begin',
    'statementTimeout',
    'keywordCount',
    'statementTimeout',
    'keywordRows',
    'keyword.commit',
  ]);
  expect(h.transactions).toEqual([
    expect.objectContaining({ outcome: 'commit', options: { maxWait: 1_000, timeout: 6_000 } }),
  ]);
  expect(h.callsOf('statementTimeout').map((call) => call.query!.values)).toEqual([
    ['5000ms'],
    ['5000ms'],
  ]);
  expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
  expect(h.prisma.withTenant).not.toHaveBeenCalled();
  expect(h.embedding).not.toHaveBeenCalled();
}

installHooks();

it.each(methods)(
  '%s preserves complete result shape, SQL bindings, count-before-rows and its distinct page limit',
  async (method) => {
    clock();
    const introduced = new Date('2026-01-02T00:00:00.000Z');
    const latest = new Date('2026-02-03T00:00:00.000Z');
    const subjects = ['Research'];
    const actions = ['Reported'];
    const first = billRow({
      title: 'Research Z',
      introduced_date: introduced,
      latest_action_date: latest,
      latest_action_text: 'Reported',
      sponsor_name: 'Sponsor Z',
      status: 'reported',
      action_texts: actions,
      subjects,
    });
    const second = billRow({
      id: '119-s-2',
      bill_type: 's',
      bill_number: '2',
      title: 'Unknown A',
      introduced_date: null,
      latest_action_date: null,
      latest_action_text: null,
      sponsor_name: null,
      sponsor_party: null,
      sponsor_state: null,
      policy_area: null,
      status: undefined,
      action_texts: undefined,
      subjects: null,
    });
    const h = harness({ rows: { keywordCount: [{ total: 73n }], keywordRows: [first, second] } });
    const result = await h.subject[method]([' Defense ', 'C++']);
    assertRows(result, method, introduced, latest, subjects, actions);
    assertKeywordIo(h, method);
  },
);

it.each(methods)(
  '%s still executes an empty-term FALSE predicate inside one deadline transaction',
  async (method) => {
    clock();
    const h = harness();
    await expect(h.subject[method]([])).resolves.toEqual({ total: 0, bills: [] });
    expect(h.callsOf('keywordCount')[0]!.query!.values).toEqual([]);
    expect(h.callsOf('keywordRows')[0]!.query!.values).toEqual([]);
    expect(compactSql(h.callsOf('keywordCount')[0]!.query!.sql)).toContain('(FALSE OR FALSE)');
    expect(h.callsOf('keywordCount')).toHaveLength(1);
    expect(h.callsOf('keywordRows')).toHaveLength(1);
    expect(h.callsOf('statementTimeout')).toHaveLength(2);
    expect(h.transactions[0]!.outcome).toBe('commit');
  },
);

it.each(methods)(
  '%s defaults missing and null count rows to zero without skipping row retrieval',
  async (method) => {
    clock();
    for (const keywordCount of [[], [{ total: null }]]) {
      const h = harness({ rows: { keywordCount } });
      await expect(h.subject[method](['Research'])).resolves.toEqual({ total: 0, bills: [] });
      expect(h.callsOf('keywordRows')).toHaveLength(1);
      expect(h.transactions[0]!.outcome).toBe('commit');
    }
  },
);

it.each(methods)(
  '%s propagates timeout/count/row errors with rollback and no false zero result',
  async (method) => {
    clock();
    for (const operation of ['statementTimeout', 'keywordCount', 'keywordRows']) {
      const error = Object.assign(new Error(`${operation} cancelled`), {
        code: 'P2010',
        meta: { code: '57014' },
      });
      const h = harness({ errors: { [operation]: error } });
      await expect(h.subject[method](['Research'])).rejects.toBe(error);
      expect(h.transactions[0]!.outcome).toBe('rollback');
      expect(h.events.at(-1)).toBe('keyword.rollback');
      expect(h.callsOf('keywordCount')).toHaveLength(operation === 'statementTimeout' ? 0 : 1);
      expect(h.callsOf('keywordRows')).toHaveLength(operation === 'keywordRows' ? 1 : 0);
      expect(h.warnings).not.toHaveBeenCalled();
    }
  },
);

it.each(methods)(
  '%s spends one server deadline across count and rows instead of resetting it',
  async (method) => {
    const time = clock();
    const h = harness({
      results: {
        keywordCount: () => {
          time.advance(400);
          return [{ total: 0n }];
        },
      },
    });
    await expect(h.subject[method](['Research'])).resolves.toEqual({ total: 0, bills: [] });
    expect(h.callsOf('statementTimeout').map((call) => call.query!.values)).toEqual([
      ['5000ms'],
      ['4600ms'],
    ]);
    expect(h.transactions[0]!.options).toEqual({ maxWait: 1_000, timeout: 6_000 });
    expect(h.transactions[0]!.outcome).toBe('commit');
  },
);

it.each(methods)(
  '%s refuses row SQL after count has exhausted its deadline and awaits rollback',
  async (method) => {
    const time = clock();
    const h = harness({
      results: {
        keywordCount: () => {
          time.advance(5_000);
          return [{ total: 1n }];
        },
      },
    });
    await expect(h.subject[method](['Research'])).rejects.toBeInstanceOf(
      BillKeywordDeadlineExceeded,
    );
    expect(h.callsOf('statementTimeout')).toHaveLength(1);
    expect(h.callsOf('keywordCount')).toHaveLength(1);
    expect(h.callsOf('keywordRows')).toHaveLength(0);
    expect(h.events.at(-1)).toBe('keyword.rollback');
    expect(h.transactions[0]!.outcome).toBe('rollback');
  },
);

it.each(methods)(
  '%s inherits an earlier profile deadline across the asynchronous count continuation',
  async (method) => {
    const time = clock();
    const h = harness({
      results: {
        keywordCount: async () => {
          await Promise.resolve();
          time.advance(400);
          return [{ total: 0n }];
        },
      },
    });
    await expect(
      withBillKeywordProfileDeadline<unknown>(() => h.subject[method](['Research']), 1_000),
    ).resolves.toEqual({ total: 0, bills: [] });
    expect(h.transactions[0]!.options).toEqual({ maxWait: 1_000, timeout: 2_000 });
    expect(h.callsOf('statementTimeout').map((call) => call.query!.values)).toEqual([
      ['1000ms'],
      ['600ms'],
    ]);
    expect(h.callsOf('keywordRows')).toHaveLength(1);
  },
);

it.each(methods)(
  '%s acquires no connection after its inherited profile deadline expires',
  async (method) => {
    const time = clock();
    const h = harness();
    await expect(
      withBillKeywordProfileDeadline(async () => {
        await Promise.resolve();
        time.set(1_000);
        return h.subject[method](['Research']);
      }, 1_000),
    ).rejects.toBeInstanceOf(BillKeywordDeadlineExceeded);
    expect(h.calls).toEqual([]);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.transactions).toEqual([]);
    expect(h.embedding).not.toHaveBeenCalled();
  },
);
