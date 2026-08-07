import { describe, expect, jest, test } from '@jest/globals';
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_SIZE,
  PRODUCER_COMPLETIONS,
  completeCoverage,
  incompleteCoverage,
  walkKeyset,
} from './producer-pagination.js';

/**
 * The property every one of these tests is really about: a keyset walk never
 * skips a row and never processes one twice.
 *
 * That is the whole claim P03 and P04 rest on when they say coverage is complete,
 * so it is asserted by reconstructing the visited set and comparing it to the
 * corpus — not by trusting a page count.
 */

interface Row {
  id: string;
}

/** Zero-padded so lexicographic order matches numeric order, as real ids must. */
const pad = (n: number) => String(n).padStart(5, '0');

function corpus(size: number): Row[] {
  return Array.from({ length: size }, (_, i) => ({ id: `row-${pad(i)}` }));
}

/** A source that behaves like `WHERE id > cursor ORDER BY id LIMIT take`. */
function source(rows: Row[]) {
  const reads: Array<{ cursor: string | null; take: number }> = [];
  const read = jest.fn(async (cursor: string | null, take: number) => {
    reads.push({ cursor, take });
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const after = cursor ? sorted.filter((r) => r.id > cursor) : sorted;
    return after.slice(0, take);
  });
  return { read, reads };
}

async function collect(rows: Row[], pageSize: number, startCursor?: string | null) {
  const seen: string[] = [];
  const { read, reads } = source(rows);
  const outcome = await walkKeyset<Row>({
    read,
    key: (row) => row.id,
    pageSize,
    startCursor,
    onPage: async (page) => {
      for (const row of page) seen.push(row.id);
    },
  });
  return { outcome, seen, reads };
}

describe('walkKeyset visits every row exactly once', () => {
  test.each([0, 1, 2, 9, 10, 11, 99, 100, 101, 1000])(
    'a corpus of %i rows, page size 10',
    async (size) => {
      const rows = corpus(size);
      const { outcome, seen } = await collect(rows, 10);
      expect(outcome.completion).toBe('COMPLETE');
      expect(seen).toEqual(rows.map((r) => r.id));
      expect(new Set(seen).size).toBe(size);
      expect(outcome.rowsRead).toBe(size);
      expect(outcome.resumeCursor).toBeNull();
    },
  );

  test('a corpus that is an EXACT multiple of the page size still completes', async () => {
    // The boundary a naive walk gets wrong. A full page might be the last one, so
    // the walk has to ask once more and get zero — it cannot infer "there is more"
    // from a full page, nor "there is nothing more" from having read N pages.
    const { outcome, seen, reads } = await collect(corpus(30), 10);
    expect(outcome.completion).toBe('COMPLETE');
    expect(seen).toHaveLength(30);
    expect(reads).toHaveLength(4);
    expect(reads[3]!.cursor).toBe(`row-${pad(29)}`);
  });

  test('a short final page is processed, not dropped', async () => {
    const { outcome, seen } = await collect(corpus(25), 10);
    expect(outcome.completion).toBe('COMPLETE');
    expect(seen).toHaveLength(25);
    expect(seen[24]).toBe(`row-${pad(24)}`);
  });

  test('the cursor advances to the LAST row of each page', async () => {
    const { reads } = await collect(corpus(25), 10);
    expect(reads.map((r) => r.cursor)).toEqual([
      null,
      `row-${pad(9)}`,
      `row-${pad(19)}`,
    ]);
  });

  test('page size is passed through as the read limit', async () => {
    const { reads } = await collect(corpus(5), 3);
    for (const read of reads) expect(read.take).toBe(3);
  });

  test('a page size of 1 still terminates and covers everything', async () => {
    const { outcome, seen } = await collect(corpus(4), 1);
    expect(outcome.completion).toBe('COMPLETE');
    expect(seen).toHaveLength(4);
  });
});

describe('resume', () => {
  test('starts STRICTLY after the cursor', async () => {
    // `id > cursor`, not `>=`. A `>=` resume re-processes the boundary row, which
    // for a producer means re-evaluating and re-writing it.
    const { outcome, seen } = await collect(corpus(10), 3, `row-${pad(4)}`);
    expect(seen).toEqual([5, 6, 7, 8, 9].map((n) => `row-${pad(n)}`));
    expect(outcome.completion).toBe('COMPLETE');
  });

  test('a cursor past the end completes without processing anything', async () => {
    const { outcome, seen } = await collect(corpus(10), 3, 'row-99999');
    expect(seen).toEqual([]);
    expect(outcome.completion).toBe('COMPLETE');
  });

  test('an interrupted walk resumed from its own cursor covers the corpus exactly once', async () => {
    // The acceptance criterion in prose: forced interruption, then resume, with no
    // row skipped and no row duplicated across the two halves.
    const rows = corpus(50);
    const first = await collect(rows, 10);
    // Simulate a stop after two pages by resuming from the 20th row.
    const firstHalf = first.seen.slice(0, 20);
    const second = await collect(rows, 10, firstHalf[firstHalf.length - 1]!);
    const combined = [...firstHalf, ...second.seen];
    expect(combined).toEqual(rows.map((r) => r.id));
    expect(new Set(combined).size).toBe(50);
  });

  test('a row inserted BEFORE the cursor cannot push a later row out of the walk', async () => {
    // This is why the walk is keyset and not OFFSET. With OFFSET, inserting a row
    // before the window shifts everything by one and the row at the boundary is
    // never visited.
    const rows = corpus(20);
    const seenFirstHalf = (await collect(rows, 10)).seen.slice(0, 10);
    const withInsert = [...rows, { id: `row-${pad(3)}a` }];
    const resumed = await collect(withInsert, 10, seenFirstHalf[9]!);
    // Every original row after the cursor is still visited.
    expect(resumed.seen).toEqual(rows.slice(10).map((r) => r.id));
  });
});

describe('the runaway guard is not a coverage cap', () => {
  test('reaching maxPages ends INCOMPLETE with a resumable cursor', async () => {
    const rows = corpus(100);
    const { read } = source(rows);
    const seen: string[] = [];
    const outcome = await walkKeyset<Row>({
      read,
      key: (row) => row.id,
      pageSize: 10,
      maxPages: 3,
      onPage: async (page) => {
        for (const row of page) seen.push(row.id);
      },
    });
    expect(outcome.completion).toBe('INCOMPLETE');
    expect(outcome.pagesRead).toBe(3);
    expect(seen).toHaveLength(30);
    // The cursor is the last row actually processed, so a resumed walk picks up
    // exactly where this one stopped.
    expect(outcome.resumeCursor).toBe(`row-${pad(29)}`);
  });

  test('an INCOMPLETE walk resumed from its cursor finishes the corpus', async () => {
    const rows = corpus(100);
    const { read } = source(rows);
    const seen: string[] = [];
    const first = await walkKeyset<Row>({
      read,
      key: (row) => row.id,
      pageSize: 10,
      maxPages: 3,
      onPage: async (page) => {
        for (const row of page) seen.push(row.id);
      },
    });
    const second = await collect(rows, 10, first.resumeCursor);
    expect([...seen, ...second.seen]).toEqual(rows.map((r) => r.id));
    expect(second.outcome.completion).toBe('COMPLETE');
  });

  test('the default guard sits far above any real corpus', () => {
    // If this ever needs raising to cover real data, the guard has become a
    // coverage boundary and the walk needs rethinking rather than a bigger number.
    expect(DEFAULT_PAGE_SIZE * DEFAULT_MAX_PAGES).toBeGreaterThan(100_000);
  });

  test('shouldStop ends the walk INCOMPLETE before the next read', async () => {
    const rows = corpus(100);
    const { read, reads } = source(rows);
    let pages = 0;
    const outcome = await walkKeyset<Row>({
      read,
      key: (row) => row.id,
      pageSize: 10,
      onPage: async () => {
        pages += 1;
      },
      shouldStop: () => pages >= 2,
    });
    expect(outcome.completion).toBe('INCOMPLETE');
    expect(pages).toBe(2);
    // Stopped BEFORE issuing a third read, which is the point: the nested case
    // must not keep querying for coverage already known to be partial.
    expect(reads).toHaveLength(2);
    expect(outcome.resumeCursor).toBe(`row-${pad(19)}`);
  });

  test('an invalid page size or guard is rejected rather than looping', async () => {
    const { read } = source(corpus(1));
    const base = { read, key: (row: Row) => row.id, onPage: async () => {} };
    await expect(walkKeyset<Row>({ ...base, pageSize: 0 })).rejects.toThrow('pageSize');
    await expect(walkKeyset<Row>({ ...base, maxPages: 0 })).rejects.toThrow('maxPages');
  });
});

describe('onPage errors abort the walk', () => {
  test('a throwing onPage propagates instead of silently skipping the page', async () => {
    // A producer that swallowed a page failure would report complete coverage it
    // did not achieve, which is the exact claim this module exists to make true.
    const { read } = source(corpus(30));
    await expect(
      walkKeyset<Row>({
        read,
        key: (row) => row.id,
        pageSize: 10,
        onPage: async (page) => {
          if (page[0]!.id === `row-${pad(10)}`) throw new Error('page 2 failed');
        },
      }),
    ).rejects.toThrow('page 2 failed');
  });
});

describe('the shared completion vocabulary', () => {
  test('is exactly two words, used by both producers', () => {
    expect([...PRODUCER_COMPLETIONS]).toEqual(['COMPLETE', 'INCOMPLETE']);
  });

  test('a complete coverage report carries no resume cursor and no reason', () => {
    const coverage = completeCoverage(10, 20);
    expect(coverage).toEqual({
      completion: 'COMPLETE',
      clientsRead: 10,
      opportunitiesRead: 20,
      resumeClientCursor: null,
      incompleteReason: null,
    });
  });

  test('an incomplete report names the guard and the exact resume flag', () => {
    const coverage = incompleteCoverage({
      clientsRead: 500,
      opportunitiesRead: 200_000,
      resumeClientCursor: 'client-00500',
      guard: 'client_pages',
      resumeFlag: '--resume-client',
    });
    expect(coverage.completion).toBe('INCOMPLETE');
    expect(coverage.incompleteReason).toContain('--resume-client=client-00500');
    expect(coverage.incompleteReason).toContain('500 clients');
  });

  test('the incomplete reason never tells an operator to raise a cap', () => {
    // There is no cap. Suggesting one was the old producer's only remedy for
    // partial coverage and it is the message this phase removes.
    for (const guard of ['client_pages', 'opportunity_pages'] as const) {
      const coverage = incompleteCoverage({
        clientsRead: 1,
        opportunitiesRead: 1,
        resumeClientCursor: null,
        guard,
        resumeFlag: '--resume-client',
      });
      expect(coverage.incompleteReason).not.toMatch(/cap/i);
      expect(coverage.incompleteReason).not.toMatch(/raise/i);
    }
  });

  test('an incomplete report with no cursor still explains itself', () => {
    const coverage = incompleteCoverage({
      clientsRead: 0,
      opportunitiesRead: 0,
      resumeClientCursor: null,
      guard: 'opportunity_pages',
      resumeFlag: '--resume-client',
    });
    expect(coverage.incompleteReason).toContain('opportunity-page runaway guard');
    expect(coverage.resumeClientCursor).toBeNull();
  });
});
