import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  runNoticeSync,
  toNoticeRow,
  type NoticeRow,
  type NoticeSyncDeps,
} from './sync-tango-opportunity-notices.js';
import { TangoRequestCeilingExceededError } from '../src/external/tango/tango-resilience.service.js';
import type { SamCandidate } from '../src/external/tango/tango-opportunity.mapper.js';
import type { TangoGateway, TangoNotice, TangoPage } from '../src/external/tango/tango.types.js';

/**
 * The notice-history sync (P28). NO NETWORK, NO POSTGRES.
 *
 * The load-bearing properties: the content hash must not move when only the
 * fetch time did (or every re-sync looks like an amendment), and a notice is
 * stamped with a local id only under P27's exact-identifier rule (or an
 * ambiguous solicitation number attaches an amendment's deadline to the wrong
 * notice).
 */

const NOW = new Date('2026-08-07T12:00:00.000Z');
const SAM_ID = '11111111-1111-1111-1111-111111111111';

function notice(over: Partial<TangoNotice> = {}): TangoNotice {
  return {
    provenance: {
      provider: 'tango',
      resourceType: 'notice',
      externalId: 'N-1',
      fetchedAt: NOW.toISOString(),
      providerUpdatedAt: '2026-07-01T00:00:00.000Z',
    },
    noticeId: 'N-1',
    solicitationNumber: 'W911QY-26-R-0012',
    title: 'Turbofan Engine Sustainment',
    postedDate: '2026-06-01T00:00:00.000Z',
    responseDeadline: '2026-09-01T17:00:00.000Z',
    active: true,
    setAside: 'Total Small Business Set-Aside (FAR 19.5)',
    naicsCode: '336412',
    pscCode: '2840',
    attachmentCount: 3,
    sourceUrl: 'https://sam.gov/opp/n1/view',
    ...over,
  };
}

function page(items: TangoNotice[], nextCursor: string | null = null): TangoPage<TangoNotice> {
  return { items, totalCount: items.length, nextCursor, rate: null };
}

const LINKED: SamCandidate[] = [
  { id: SAM_ID, noticeId: 'NOTICE-1', solicitationNumber: 'W911QY-26-R-0012' },
];

function makeFake(
  opts: {
    pages?: Array<TangoPage<TangoNotice>>;
    candidates?: SamCandidate[];
    unchanged?: boolean;
    checkpoint?: { cursor: string | null; windowEnd: Date | null } | null;
    throwCeilingOnCall?: number;
    upsertThrows?: boolean;
  } = {},
) {
  const pages = opts.pages ?? [page([notice()])];
  const listCalls: Array<Record<string, unknown>> = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const rows: NoticeRow[] = [];
  let call = 0;

  const gateway = {
    listNotices: async (options?: Record<string, unknown>) => {
      call += 1;
      listCalls.push(options ?? {});
      if (opts.throwCeilingOnCall === call) throw new TangoRequestCeilingExceededError('listNotices', 1);
      return pages[call - 1] ?? page([]);
    },
  } as unknown as TangoGateway;

  const store = {
    readCheckpoint: async () => opts.checkpoint ?? null,
    writeCheckpoint: async (input: Record<string, unknown>) => {
      checkpoints.push(input);
    },
  } as unknown as NoticeSyncDeps['store'];

  const deps: NoticeSyncDeps = {
    gateway,
    store,
    findSamCandidates: async () => opts.candidates ?? [],
    upsertNotice: async (row) => {
      if (opts.upsertThrows) throw new Error('upsert failed');
      rows.push(row);
      return { unchanged: opts.unchanged ?? false };
    },
    now: () => NOW,
  };

  return { deps, listCalls, checkpoints, rows };
}

// ── The row mapping ──────────────────────────────────────────────────────────

describe('the content hash tracks CONTENT, not the fetch', () => {
  test('two fetches of identical content produce the same hash', () => {
    // `fetchedAt` changes on every single fetch. Hashing it in would make every
    // re-sync look like a content change and defeat the whole no-op path.
    const a = toNoticeRow(notice(), { tangoOpportunityId: null, samOpportunityId: null });
    const b = toNoticeRow(
      notice({
        provenance: { ...notice().provenance, fetchedAt: '2027-01-01T00:00:00.000Z' },
      }),
      { tangoOpportunityId: null, samOpportunityId: null },
    );
    expect(a.contentHash).toBe(b.contentHash);
  });

  test('a real content change moves the hash', () => {
    const a = toNoticeRow(notice(), { tangoOpportunityId: null, samOpportunityId: null });
    const b = toNoticeRow(notice({ responseDeadline: '2026-09-15T17:00:00.000Z' }), {
      tangoOpportunityId: null,
      samOpportunityId: null,
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  test('the hash is 64 lowercase hex, matching the column CHECK', () => {
    const row = toNoticeRow(notice(), { tangoOpportunityId: null, samOpportunityId: null });
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('provenance never reaches the stored snapshot', () => {
    const row = toNoticeRow(notice(), { tangoOpportunityId: null, samOpportunityId: null });
    expect(row.snapshot).not.toHaveProperty('provenance');
    expect(row.snapshot).toMatchObject({ noticeId: 'N-1', attachmentCount: 3 });
  });

  test('an unparseable date becomes null, not an epoch', () => {
    const row = toNoticeRow(notice({ postedDate: 'not-a-date', responseDeadline: null }), {
      tangoOpportunityId: null,
      samOpportunityId: null,
    });
    expect(row.postedDate).toBeNull();
    expect(row.responseDeadline).toBeNull();
  });

  test('a NEGATIVE attachment count is dropped to null rather than stored', () => {
    // A negative count is a mapping bug, not fewer attachments. Refused here so
    // the CHECK constraint never has to be the thing that catches it.
    const row = toNoticeRow(notice({ attachmentCount: -1 }), {
      tangoOpportunityId: null,
      samOpportunityId: null,
    });
    expect(row.attachmentCount).toBeNull();
  });

  test('a count of zero is kept — zero attachments is a real fact', () => {
    const row = toNoticeRow(notice({ attachmentCount: 0 }), {
      tangoOpportunityId: null,
      samOpportunityId: null,
    });
    expect(row.attachmentCount).toBe(0);
  });

  test('the provider updated stamp comes from provenance, not from the body', () => {
    const row = toNoticeRow(notice(), { tangoOpportunityId: null, samOpportunityId: null });
    expect(row.providerUpdatedAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
});

// ── CLI ──────────────────────────────────────────────────────────────────────

describe('the CLI is dry-run by default', () => {
  test('no flags means no commit, no cap, no explicit floor', () => {
    expect(parseArgs([])).toMatchObject({ commit: false, limit: undefined, postedSince: undefined });
  });

  test('an unparseable --posted-since is dropped rather than passed through', () => {
    expect(parseArgs(['--posted-since=whenever']).postedSince).toBeUndefined();
    expect(parseArgs(['--posted-since=2026-05-01']).postedSince).toBe('2026-05-01');
  });
});

// ── The walk ─────────────────────────────────────────────────────────────────

describe('the walk is incremental, resumable and bounded', () => {
  test('a first run uses the posted-since FLOOR', async () => {
    const { deps, listCalls } = makeFake();
    const summary = await runNoticeSync(deps, { commit: false, postedSince: '2026-05-01' });
    expect(summary.isFirstRun).toBe(true);
    expect(listCalls[0]!.postedSince).toBe('2026-05-01');
  });

  test('a later run uses its own high-water mark minus the overlap', async () => {
    const { deps, listCalls } = makeFake({
      checkpoint: { cursor: null, windowEnd: new Date('2026-08-06T00:00:00.000Z') },
    });
    await runNoticeSync(deps, { commit: false, overlapHours: 4 });
    expect(listCalls[0]!.postedSince).toBe('2026-08-05T20:00:00.000Z');
  });

  test('the high-water mark advances only on a fully-exhausted walk', async () => {
    const exhausted = makeFake({ pages: [page([notice()], null)] });
    await runNoticeSync(exhausted.deps, { commit: true });
    expect(exhausted.checkpoints.at(-1)).toMatchObject({ completeness: 'complete' });

    const interrupted = makeFake({ pages: [page([notice()], 'p2')] });
    await runNoticeSync(interrupted.deps, { commit: true, limit: 1 });
    expect(interrupted.checkpoints.at(-1)).not.toHaveProperty('windowEnd');
  });

  test('a request-ceiling error stops cleanly and preserves progress', async () => {
    const { deps, checkpoints } = makeFake({
      pages: [page([notice()], 'p2')],
      throwCeilingOnCall: 2,
    });
    const summary = await runNoticeSync(deps, { commit: true });
    expect(summary.ceilingReached).toBe(true);
    expect(summary.completeness).toBe('in_progress');
    expect(checkpoints).toHaveLength(1);
  });

  test('dry-run walks the provider and writes nothing', async () => {
    const fake = makeFake({ candidates: LINKED });
    const summary = await runNoticeSync(fake.deps, { commit: false });
    expect(summary.processed).toBe(1);
    expect(fake.rows).toHaveLength(0);
    expect(fake.checkpoints).toHaveLength(0);
  });

  test('an upsert failure is counted and the walk continues', async () => {
    const fake = makeFake({ pages: [page([notice(), notice({ noticeId: 'N-2' })])], upsertThrows: true });
    const summary = await runNoticeSync(fake.deps, { commit: true });
    expect(summary.processed).toBe(2);
    expect(summary.errored).toBe(2);
  });

  test('an UNCHANGED upsert is counted separately from a written one', async () => {
    const fake = makeFake({ unchanged: true });
    const summary = await runNoticeSync(fake.deps, { commit: true });
    expect(summary).toMatchObject({ unchanged: 1, written: 0 });
  });
});

// ── The crosswalk ────────────────────────────────────────────────────────────

describe('a notice is stamped with a local id only under the exact-identifier rule', () => {
  test('exactly one local candidate stamps the sam_opportunity id', async () => {
    const fake = makeFake({ candidates: LINKED });
    const summary = await runNoticeSync(fake.deps, { commit: true });
    expect(summary.crosswalked).toBe(1);
    expect(fake.rows[0]!.samOpportunityId).toBe(SAM_ID);
  });

  test('an AMBIGUOUS number stamps NOTHING, and the notice is still stored', async () => {
    // Attaching an amendment's deadline to whichever notice sorted first is the
    // exact failure P27's own ambiguity rule exists to prevent.
    const fake = makeFake({
      candidates: [
        { id: 'a', noticeId: 'N-PRESOL', solicitationNumber: 'W911QY-26-R-0012' },
        { id: 'b', noticeId: 'N-SOL', solicitationNumber: 'W911QY-26-R-0012' },
      ],
    });
    const summary = await runNoticeSync(fake.deps, { commit: true });
    expect(summary).toMatchObject({ crosswalked: 0, uncrosswalked: 1 });
    expect(fake.rows[0]!.samOpportunityId).toBeNull();
    // Stored, not discarded: it becomes reachable the moment the ambiguity
    // resolves, and the timeline API reports `not_crosswalked` meanwhile.
    expect(fake.rows[0]!.tangoNoticeId).toBe('N-1');
  });

  test('no local candidate leaves it unstamped and stored', async () => {
    const fake = makeFake({ candidates: [] });
    const summary = await runNoticeSync(fake.deps, { commit: true });
    expect(summary.uncrosswalked).toBe(1);
    expect(fake.rows[0]!.samOpportunityId).toBeNull();
  });

  test('the parent opportunity id is NEVER derived from the solicitation number', async () => {
    // The provider's notice resource states no parent id. Deriving one from a
    // shared solicitation number would be an identity claim the provider never
    // made — the same rule that makes an ambiguous crosswalk link nothing.
    const fake = makeFake({ candidates: LINKED });
    await runNoticeSync(fake.deps, { commit: true });
    expect(fake.rows[0]!.tangoOpportunityId).toBeNull();
  });
});

// ── Structural ───────────────────────────────────────────────────────────────

describe('the notice sync writes one table and emits nothing', () => {
  const source = readFileSync(join(__dirname, 'sync-tango-opportunity-notices.ts'), 'utf8');

  test('no write to sam_opportunity or to the P27 parity ledger', () => {
    expect(source).not.toMatch(/samOpportunity\.(create|update|upsert|delete)/);
    expect(source).not.toMatch(/tangoOpportunityParity\./);
  });

  test('the only model it writes is tango_opportunity_notice', () => {
    const writes = source.match(/prisma\.([A-Za-z]+)\.(create|update|upsert)/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write).toMatch(/prisma\.tangoOpportunityNotice\./);
  });

  test('it sends no alert of any kind', () => {
    const imports = (source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? []).join('\n');
    expect(imports).not.toMatch(/alert|notification|engagement|mail/i);
  });

  test('it reuses P27’s crosswalk rule rather than reimplementing it', () => {
    expect(source).toMatch(/import \{[\s\S]*resolveCrosswalk[\s\S]*\} from '\.\.\/src\/external\/tango\/tango-opportunity\.mapper\.js'/);
  });
});
