/**
 * Deterministic keyset pagination for the candidate producers, and the shared
 * completion vocabulary both of them report.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Both producers used a single capped read:
 *
 *     findMany({ orderBy: [...], take: OPPORTUNITY_SCAN_CAP })   // 4000
 *     findMany({ where: { tenantId }, take: CLIENT_CAP })        // 500
 *
 * and set `capped = true` when a read came back full. The flag was honest — a
 * capped run incremented the error count rather than reporting clean success —
 * but the coverage was still silently partial, and the only remedy on offer was
 * to raise a number. Measured on capiro-dev on 2026-07-29 there were 17,915
 * active in-deadline SAM notices, so a 4,000 cap evaluated 22% of them.
 *
 * Completion is now ALGORITHMIC: the walk ends when a page comes back short, not
 * when a counter is satisfied. No output tells an operator to raise a cap,
 * because there is no cap to raise.
 *
 * `maxPages` IS NOT THE OLD CAP WEARING A HAT
 * ------------------------------------------
 * It is a runaway guard, set far above any real corpus. The difference is what
 * happens when it is reached: the old cap produced a run that had evaluated a
 * subset and said so in an error counter, while reaching `maxPages` produces
 * `INCOMPLETE` plus a resume cursor, and `statusFromCounts` turns that into a
 * `partial` SyncRun. `lastSuccessfulWatermark` only reads `status='success'`, so
 * a partial run cannot advance the incremental watermark and the unseen tail
 * stays retryable.
 *
 * WHY (id > cursor, ORDER BY id) AND NOT OFFSET
 * -------------------------------------------
 * OFFSET re-scans and, worse, shifts under concurrent writes: a row inserted
 * before the cursor pushes one row past the window and it is never evaluated.
 * A keyset walk on a unique, immutable, totally-ordered column cannot skip or
 * duplicate a row, which is the property the coverage claim rests on.
 *
 * Ordering by anything else — `closeDate`, `responseDeadline` — is what the old
 * reads did, and it is exactly wrong for a walk: those columns are nullable, not
 * unique, and mutable, so the same row can appear on two pages or none.
 * Relevance ordering does not matter here because every row is evaluated.
 */

/** Rows per page. Bounded memory, and few enough queries to stay cheap. */
export const DEFAULT_PAGE_SIZE = 500;

/**
 * Runaway guard, not a coverage boundary. 400 pages x 500 rows = 200,000 rows per
 * walk, roughly 11x the largest measured active SAM corpus.
 */
export const DEFAULT_MAX_PAGES = 400;

/**
 * The completion vocabulary both producers report. P04 requires the grant and SAM
 * producers to use the same words, so it lives here rather than in either script.
 */
export const PRODUCER_COMPLETIONS = ['COMPLETE', 'INCOMPLETE'] as const;
export type ProducerCompletion = (typeof PRODUCER_COMPLETIONS)[number];

export interface KeysetWalkOutcome {
  completion: ProducerCompletion;
  pagesRead: number;
  rowsRead: number;
  /**
   * Where a resumed run must start. Null when `COMPLETE`.
   *
   * This is the id of the LAST row actually processed, and the resumed walk uses
   * `id > cursor` — so the row itself is not re-processed and nothing between it
   * and the end is skipped.
   */
  resumeCursor: string | null;
}

export interface KeysetWalkInput<T> {
  /** Read one page strictly after `cursor`, ordered by the same key, at most `take` rows. */
  read(cursor: string | null, take: number): Promise<T[]>;
  /** The ordering key. Must be unique, immutable and totally ordered. */
  key(row: T): string;
  /** Called once per page, in order. Throwing aborts the walk. */
  onPage(rows: T[], pageIndex: number): Promise<void>;
  pageSize?: number;
  maxPages?: number;
  /** Resume point from a prior INCOMPLETE run. */
  startCursor?: string | null;
  /**
   * Checked before each read. Returning true ends the walk `INCOMPLETE` at the
   * current cursor.
   *
   * Exists for the nested case: once the inner opportunity walk has gone
   * incomplete, no later client can be fully evaluated either, so continuing to
   * page the outer walk would issue hundreds of queries to produce coverage that
   * is already known to be partial.
   */
  shouldStop?: () => boolean;
}

/**
 * Walk every row strictly after `startCursor`, one bounded page at a time.
 *
 * Ends `COMPLETE` when a page returns fewer rows than requested — the only
 * signal that cannot lie, since a full page might be the last one. Ends
 * `INCOMPLETE` only on the runaway guard.
 */
export async function walkKeyset<T>(input: KeysetWalkInput<T>): Promise<KeysetWalkOutcome> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  if (pageSize < 1) throw new Error('pageSize must be at least 1');
  if (maxPages < 1) throw new Error('maxPages must be at least 1');

  let cursor: string | null = input.startCursor ?? null;
  let pagesRead = 0;
  let rowsRead = 0;

  for (;;) {
    if (pagesRead >= maxPages || input.shouldStop?.()) {
      return { completion: 'INCOMPLETE', pagesRead, rowsRead, resumeCursor: cursor };
    }

    const rows = await input.read(cursor, pageSize);
    if (rows.length === 0) {
      return { completion: 'COMPLETE', pagesRead, rowsRead, resumeCursor: null };
    }

    pagesRead += 1;
    rowsRead += rows.length;
    await input.onPage(rows, pagesRead - 1);
    cursor = input.key(rows[rows.length - 1]!);

    // A short page is the end of the data. Checked AFTER processing, so the final
    // partial page is evaluated rather than dropped.
    if (rows.length < pageSize) {
      return { completion: 'COMPLETE', pagesRead, rowsRead, resumeCursor: null };
    }
  }
}

/** Combined coverage across the two dimensions a producer walks. */
export interface ProducerCoverage {
  completion: ProducerCompletion;
  clientsRead: number;
  opportunitiesRead: number;
  /** Resume point for the CLIENT walk. Null when the run completed. */
  resumeClientCursor: string | null;
  /** Bounded operator-facing reason, persisted on the partial SyncRun. */
  incompleteReason: string | null;
}

export function completeCoverage(clientsRead: number, opportunitiesRead: number): ProducerCoverage {
  return {
    completion: 'COMPLETE',
    clientsRead,
    opportunitiesRead,
    resumeClientCursor: null,
    incompleteReason: null,
  };
}

/**
 * Describe an incomplete run in one line an operator can act on.
 *
 * Deliberately never says "raise the cap": there is no cap. It names the guard
 * that tripped and the exact flag needed to resume.
 */
export function incompleteCoverage(input: {
  clientsRead: number;
  opportunitiesRead: number;
  resumeClientCursor: string | null;
  guard: 'client_pages' | 'opportunity_pages';
  resumeFlag: string;
}): ProducerCoverage {
  const where = input.guard === 'client_pages' ? 'client' : 'opportunity';
  const resume = input.resumeClientCursor
    ? ` Resume with ${input.resumeFlag}=${input.resumeClientCursor}.`
    : '';
  return {
    completion: 'INCOMPLETE',
    clientsRead: input.clientsRead,
    opportunitiesRead: input.opportunitiesRead,
    resumeClientCursor: input.resumeClientCursor,
    incompleteReason:
      `Stopped on the ${where}-page runaway guard after ${input.clientsRead} clients ` +
      `and ${input.opportunitiesRead} opportunities.${resume}`,
  };
}
