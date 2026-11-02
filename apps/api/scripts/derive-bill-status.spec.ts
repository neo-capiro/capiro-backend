import type { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  deriveFederalBillStatuses,
  isPassageQuestion,
  latestPassageOutcomes,
  statusEventDate,
  type PassageVoteEvidence,
} from './derive-bill-status';

jest.mock('../src/ingestion/sync-run.helper.js', () => ({
  runWithSyncRun: jest.fn(async (_database: unknown, _source: string, run: () => Promise<unknown>) => run()),
}));

function passageVote(overrides: Partial<PassageVoteEvidence> = {}): PassageVoteEvidence {
  return {
    id: 'house-119-1-1',
    billId: '119-hr-1',
    result: 'Passed',
    question: 'On Passage',
    voteDate: new Date('2026-01-01T12:00:00Z'),
    rollNumber: 1,
    ...overrides,
  };
}

describe('isPassageQuestion', () => {
  it('recognizes the House suspension-of-the-rules passage (contains "pass", not "passage")', () => {
    expect(isPassageQuestion('On Motion to Suspend the Rules and Pass')).toBe(true);
    expect(isPassageQuestion('On Motion to Suspend the Rules and Pass, as Amended')).toBe(true);
  });
  it('recognizes ordinary passage + resolution + concurrence forms', () => {
    expect(isPassageQuestion('On Passage')).toBe(true);
    expect(isPassageQuestion('On Passage of the Bill')).toBe(true);
    expect(isPassageQuestion('On Agreeing to the Resolution')).toBe(true);
    expect(isPassageQuestion('On the Third Reading')).toBe(true);
    expect(isPassageQuestion('On Motion to Concur in the Senate Amendment')).toBe(true);
  });
  it('rejects procedural questions (recommit / table / reconsider / cloture / motion to proceed)', () => {
    for (const q of [
      'On Motion to Recommit',
      'On Motion to Table',
      'On Motion to Reconsider',
      'On the Cloture Motion',
      'On the Motion to Proceed',
      'On Ordering the Previous Question',
    ]) {
      expect(isPassageQuestion(q)).toBe(false);
    }
    expect(isPassageQuestion(null)).toBe(false);
  });
});

describe('statusEventDate', () => {
  it('keeps the House passage date when a later action is Senate receipt', () => {
    const passage = new Date('2026-07-22T20:00:00.000Z');
    const senateReceipt = new Date('2026-09-14T00:00:00.000Z');
    expect(
      statusEventDate({
        status: 'passed_chamber',
        latestActionDate: senateReceipt,
        updateDate: senateReceipt,
        passageVoteDate: passage,
        actions: [
          { date: passage, text: 'On passage Passed by the Yeas and Nays: 216 - 212.' },
          { date: senateReceipt, text: 'Received in the Senate.' },
        ],
      }),
    ).toEqual(passage);
  });

  it('falls back to a strict passage action and ignores a later procedural motion', () => {
    const passage = new Date('2026-07-22T00:00:00.000Z');
    expect(
      statusEventDate({
        status: 'passed_chamber',
        latestActionDate: new Date('2026-07-23T00:00:00.000Z'),
        updateDate: null,
        passageVoteDate: null,
        actions: [
          { date: passage, text: 'Passed/agreed to in House: On passage Passed 216 - 212.' },
          {
            date: new Date('2026-07-23T00:00:00.000Z'),
            text: 'Motion to reconsider laid on the table Agreed to without objection.',
          },
        ],
      }),
    ).toEqual(passage);
  });
});

describe('latestPassageOutcomes', () => {
  it('lets a later failed final-passage vote supersede an earlier pass', () => {
    const outcomes = latestPassageOutcomes([
      passageVote({ result: 'Passed', voteDate: new Date('2026-01-01T12:00:00Z') }),
      passageVote({
        id: 'senate-119-1-2',
        result: 'Not Agreed to',
        voteDate: new Date('2026-02-01T12:00:00Z'),
        rollNumber: 2,
      }),
    ]);
    expect(outcomes.get('119-hr-1')).toMatchObject({
      outcome: 'fail',
      voteId: 'senate-119-1-2',
    });
  });

  it('lets a later successful reconsideration supersede an earlier failure', () => {
    const outcomes = latestPassageOutcomes([
      passageVote({ result: 'Failed', voteDate: new Date('2026-01-01T12:00:00Z') }),
      passageVote({
        id: 'house-119-1-2',
        result: 'Passed',
        voteDate: new Date('2026-01-02T12:00:00Z'),
        rollNumber: 2,
      }),
    ]);
    expect(outcomes.get('119-hr-1')).toMatchObject({ outcome: 'pass', voteId: 'house-119-1-2' });
  });

  it('ignores a later procedural failure', () => {
    const outcomes = latestPassageOutcomes([
      passageVote(),
      passageVote({
        id: 'house-119-1-2',
        question: 'On Motion to Recommit',
        result: 'Failed',
        voteDate: new Date('2026-01-02T12:00:00Z'),
        rollNumber: 2,
      }),
    ]);
    expect(outcomes.get('119-hr-1')).toMatchObject({ outcome: 'pass', voteId: 'house-119-1-1' });
  });
});

describe('deriveFederalBillStatuses writer ownership', () => {
  function fixture() {
    const lease = { available: true, current: true };
    const events: string[] = [];
    const actionDate = new Date('2026-02-01T00:00:00Z');
    const bills = ['119-hr-1', '119-hr-2'].map((id) => ({
      id,
      latestActionText: 'Introduced in House',
      latestActionDate: actionDate,
      updateDate: actionDate,
      actions: [],
    }));
    const database = {
      $queryRawUnsafe: jest.fn(async (sql: string, ..._args: unknown[]) => {
        if (sql.startsWith('INSERT INTO federal_evidence_checkpoint')) {
          events.push('acquire');
          return lease.available ? [{ source: 'congress-bills' }] : [];
        }
        if (sql.startsWith('SELECT source FROM federal_evidence_checkpoint')) {
          events.push('fence');
          return lease.current ? [{ source: 'congress-bills' }] : [];
        }
        throw Error('UNEXPECTED_TEST_QUERY');
      }),
      $executeRawUnsafe: jest.fn(async (sql: string, ..._args: unknown[]) => {
        events.push(sql.includes("status='idle'") ? 'release' : 'renew');
        return 1;
      }),
      $transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(database)),
      billRuleLink: { findMany: jest.fn(async () => []) },
      rollCallVote: { findMany: jest.fn(async () => [passageVote()]) },
      congressBill: {
        findMany: jest.fn(async () => bills),
        findUnique: jest.fn(),
        update: jest.fn(async (_args: unknown) => {
          events.push('update');
          return {};
        }),
      },
    };
    return { database, lease, events, actionDate };
  }

  beforeEach(() => {
    jest.mocked(runWithSyncRun).mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('acquires congress-bills before starting and fences every unchanged status update', async () => {
    const { database, events, actionDate } = fixture();
    await expect(deriveFederalBillStatuses(database as unknown as PrismaClient)).resolves.toEqual({
      inserted: 0, updated: 2, skipped: 0, errors: 0,
    });
    expect(database.$queryRawUnsafe.mock.calls[0]).toEqual([
      expect.stringContaining('INSERT INTO federal_evidence_checkpoint'),
      'congress-bills', expect.any(String),
    ]);
    expect(runWithSyncRun).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['acquire', 'fence', 'renew', 'update', 'fence', 'renew', 'update', 'release']);
    expect(database.congressBill.update.mock.calls).toEqual([
      [{ where: { id: '119-hr-1' }, data: { status: 'passed_chamber', statusAt: passageVote().voteDate } }],
      [{ where: { id: '119-hr-2' }, data: { status: 'introduced', statusAt: actionDate } }],
    ]);
    expect(database.$executeRawUnsafe).toHaveBeenLastCalledWith(
      expect.stringContaining("status='idle'"), ['congress-bills'], database.$queryRawUnsafe.mock.calls[0]?.[2],
    );
  });

  it('refuses a competing federal writer before lifecycle, reads, or status mutations', async () => {
    const { database, lease, events } = fixture();
    lease.available = false;
    await expect(deriveFederalBillStatuses(database as unknown as PrismaClient)).rejects.toThrow('FEDERAL_WRITER_ALREADY_RUNNING');
    expect(runWithSyncRun).not.toHaveBeenCalled();
    expect(database.billRuleLink.findMany).not.toHaveBeenCalled();
    expect(database.rollCallVote.findMany).not.toHaveBeenCalled();
    expect(database.congressBill.findMany).not.toHaveBeenCalled();
    expect(database.congressBill.update).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(events).toEqual(['acquire']);
  });

  it('propagates lease loss instead of reporting a per-bill failure and continuing', async () => {
    const { database, lease, events } = fixture();
    database.congressBill.update.mockImplementationOnce(async () => {
      events.push('update');
      lease.current = false;
      return {};
    });
    await expect(deriveFederalBillStatuses(database as unknown as PrismaClient)).rejects.toThrow('FEDERAL_WRITER_LEASE_LOST');
    expect(database.congressBill.update).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['acquire', 'fence', 'renew', 'update', 'fence', 'release']);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('preserves ordinary per-bill failure counts and continues under the lease', async () => {
    const { database, events } = fixture();
    database.congressBill.update.mockRejectedValueOnce(Error('SYNTHETIC_STATUS_WRITE_FAILURE'));
    await expect(deriveFederalBillStatuses(database as unknown as PrismaClient)).resolves.toEqual({
      inserted: 0, updated: 1, skipped: 0, errors: 1,
    });
    expect(database.congressBill.update).toHaveBeenCalledTimes(2);
    expect(database.$transaction).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe('release');
  });
});
