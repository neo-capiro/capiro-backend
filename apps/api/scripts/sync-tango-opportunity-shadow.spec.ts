import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  runOpportunityShadowSync,
  type OpportunityShadowDeps,
  type ParityWrite,
} from './sync-tango-opportunity-shadow.js';
import { TangoRequestCeilingExceededError } from '../src/external/tango/tango-resilience.service.js';
import type { SamCandidate, SamParitySource } from '../src/external/tango/tango-opportunity.mapper.js';
import type { TangoGateway, TangoOpportunity, TangoPage } from '../src/external/tango/tango.types.js';

/**
 * The Tango↔SAM shadow sync (P27).
 *
 * NO NETWORK, NO POSTGRES. Every effect is behind `OpportunityShadowDeps`, so
 * the walk, the crosswalk decision and the write discipline are all provable
 * from fakes — the same seam P24's forecast sync uses.
 *
 * The load-bearing tests are the ones about what this script does NOT write.
 * Plan §4.2 is the whole point of the phase: a Tango observation may verify or
 * identify a conflict, the conflict is recorded, and no source silently
 * overwrites the other. That is checked both behaviourally (the fake would
 * notice a write) and structurally (a grep over the source), because a future
 * edit could add a write the fakes were never given a chance to see.
 */

const NOW = new Date('2026-08-07T12:00:00.000Z');

function opportunity(over: Partial<TangoOpportunity> = {}): TangoOpportunity {
  return {
    provenance: {
      provider: 'tango',
      resourceType: 'opportunity',
      externalId: 'TO-1',
      fetchedAt: NOW.toISOString(),
      providerUpdatedAt: '2026-08-06T00:00:00.000Z',
    },
    opportunityId: 'TO-1',
    solicitationNumber: 'W911QY-26-R-0012',
    title: 'Turbofan Engine Sustainment',
    firstNoticeDate: '2026-06-01',
    lastNoticeDate: '2026-07-15',
    responseDeadline: '2026-09-01T17:00:00.000Z',
    active: true,
    setAside: null,
    naicsCode: '336412',
    pscCode: null,
    sourceUrl: 'https://sam.gov/opp/abc/view',
    agency: 'DEPT OF THE ARMY',
    officeCode: 'W911QY',
    officeName: 'ACC-APG Natick',
    ...over,
  };
}

function samSource(over: Partial<SamParitySource> = {}): SamParitySource {
  return {
    title: 'Turbofan Engine Sustainment',
    solicitationNumber: 'W911QY-26-R-0012',
    responseDeadline: new Date('2026-09-01T17:00:00.000Z'),
    active: true,
    setAside: null,
    naicsCode: '336412',
    pscCode: null,
    agency: 'DEPT OF THE ARMY',
    ...over,
  };
}

function page(items: TangoOpportunity[], nextCursor: string | null = null): TangoPage<TangoOpportunity> {
  return { items, totalCount: items.length, nextCursor, rate: null };
}

interface FakeOpts {
  pages?: Array<TangoPage<TangoOpportunity>>;
  candidates?: SamCandidate[];
  samSource?: SamParitySource | null;
  checkpoint?: { cursor: string | null; windowEnd: Date | null } | null;
  throwCeilingOnCall?: number;
  writeParityThrows?: boolean;
}

function makeFake(opts: FakeOpts = {}) {
  const pages = opts.pages ?? [page([opportunity()])];
  const listCalls: Array<Record<string, unknown>> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const links: Array<Record<string, unknown>> = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const parityWrites: ParityWrite[] = [];
  const candidateQueries: string[] = [];
  let call = 0;

  const gateway = {
    listOpportunities: async (options?: Record<string, unknown>) => {
      call += 1;
      listCalls.push(options ?? {});
      if (opts.throwCeilingOnCall === call) {
        throw new TangoRequestCeilingExceededError('listOpportunities', 1);
      }
      return pages[call - 1] ?? page([]);
    },
  } as unknown as TangoGateway;

  const store = {
    readCheckpoint: async () => opts.checkpoint ?? null,
    writeCheckpoint: async (input: Record<string, unknown>) => {
      checkpoints.push(input);
    },
    writeSnapshot: async (input: Record<string, unknown>) => {
      snapshots.push(input);
      return { id: 's1', version: 1, contentSha256: 'x'.repeat(64), created: true };
    },
    proposeLink: async (input: Record<string, unknown>) => {
      links.push(input);
      return { id: 'l1' };
    },
  } as unknown as OpportunityShadowDeps['store'];

  const deps: OpportunityShadowDeps = {
    gateway,
    store,
    findSamCandidates: async (normalized) => {
      candidateQueries.push(normalized);
      return opts.candidates ?? [];
    },
    readSamParitySource: async () =>
      opts.samSource === undefined ? samSource() : opts.samSource,
    writeParity: async (write) => {
      if (opts.writeParityThrows) throw new Error('parity upsert failed');
      parityWrites.push(write);
    },
    now: () => NOW,
  };

  return { deps, listCalls, snapshots, links, checkpoints, parityWrites, candidateQueries };
}

const LINKED: SamCandidate[] = [
  { id: '11111111-1111-1111-1111-111111111111', noticeId: 'NOTICE-1', solicitationNumber: 'W911QY-26-R-0012' },
];

// ── CLI ──────────────────────────────────────────────────────────────────────

describe('the CLI is dry-run by default', () => {
  test('no flags means no commit and no cap', () => {
    const args = parseArgs([]);
    expect(args.commit).toBe(false);
    expect(args.limit).toBeUndefined();
    expect(args.changedSince).toBeUndefined();
  });

  test('--commit is the only thing that enables writes', () => {
    expect(parseArgs(['--commit']).commit).toBe(true);
  });

  test('--limit and --changed-since parse in both forms', () => {
    expect(parseArgs(['--limit=250']).limit).toBe(250);
    expect(parseArgs(['--limit', '250']).limit).toBe(250);
    expect(parseArgs(['--changed-since=2026-07-01']).changedSince).toBe('2026-07-01');
  });

  test('an UNPARSEABLE --changed-since is dropped, never passed through', () => {
    // Sending garbage as the provider's incremental key would either 400 or,
    // worse, be ignored server-side — turning a bounded run into a full-catalog
    // walk that still reported the bound in its summary.
    expect(parseArgs(['--changed-since=not-a-date']).changedSince).toBeUndefined();
  });

  test('a nonsense --limit is dropped rather than becoming zero', () => {
    // A limit of 0 would silently do nothing and report success.
    expect(parseArgs(['--limit=0']).limit).toBeUndefined();
    expect(parseArgs(['--limit=-5']).limit).toBeUndefined();
    expect(parseArgs(['--limit=abc']).limit).toBeUndefined();
  });
});

// ── The walk ─────────────────────────────────────────────────────────────────

describe('the walk is incremental and bounded by the provider’s own key', () => {
  test('a first run uses the --changed-since FLOOR, not an unbounded read', async () => {
    // Unlike P24's forecast sync, an unbounded first read here would report
    // notices predating Capiro's own SAM.gov ingestion as coverage gaps.
    const { deps, listCalls } = makeFake();
    const summary = await runOpportunityShadowSync(deps, { commit: false, changedSince: '2026-05-01' });
    expect(summary.isFirstRun).toBe(true);
    expect(summary.modifiedAfter).toBe('2026-05-01');
    expect(listCalls[0]!.changedSince).toBe('2026-05-01');
  });

  test('with no floor supplied the default lookback comes off the caller’s clock', async () => {
    const { deps } = makeFake();
    const summary = await runOpportunityShadowSync(deps, { commit: false, changedSinceDays: 30 });
    expect(summary.changedSinceFloor).toBe('2026-07-08');
  });

  test('a later run uses its own high-water mark MINUS the overlap', async () => {
    const { deps, listCalls } = makeFake({
      checkpoint: { cursor: null, windowEnd: new Date('2026-08-06T00:00:00.000Z') },
    });
    const summary = await runOpportunityShadowSync(deps, { commit: false, overlapHours: 4 });
    expect(summary.isFirstRun).toBe(false);
    expect(listCalls[0]!.changedSince).toBe('2026-08-05T20:00:00.000Z');
  });

  test('a resumed run continues from the checkpoint cursor', async () => {
    const { deps, listCalls } = makeFake({
      checkpoint: { cursor: 'page-3', windowEnd: new Date('2026-08-06T00:00:00.000Z') },
    });
    await runOpportunityShadowSync(deps, { commit: false });
    expect(listCalls[0]!.cursor).toBe('page-3');
  });

  test('pages to exhaustion when no limit is set', async () => {
    const { deps, listCalls } = makeFake({
      pages: [page([opportunity()], 'p2'), page([opportunity({ opportunityId: 'TO-2' })], null)],
    });
    const summary = await runOpportunityShadowSync(deps, { commit: false });
    expect(listCalls).toHaveLength(2);
    expect(summary.processed).toBe(2);
    expect(summary.completeness).toBe('complete');
  });

  test('the requested page size is capped to what is LEFT of the limit', async () => {
    // D-43's own finding, avoided from the start: a page longer than what this
    // run should consume forces a mid-page stop that skips the checkpoint
    // update and wrongly reports 'complete'.
    const { deps, listCalls } = makeFake({ pages: [page([opportunity()], 'p2')] });
    await runOpportunityShadowSync(deps, { commit: false, limit: 30, batchSize: 100 });
    expect(listCalls[0]!.limit).toBe(30);
  });

  test('the high-water mark advances ONLY on a fully-exhausted walk', async () => {
    const exhausted = makeFake({ pages: [page([opportunity()], null)] });
    await runOpportunityShadowSync(exhausted.deps, { commit: true });
    expect(exhausted.checkpoints.at(-1)).toMatchObject({
      completeness: 'complete',
      windowEnd: NOW.toISOString(),
    });

    const interrupted = makeFake({ pages: [page([opportunity()], 'p2')] });
    await runOpportunityShadowSync(interrupted.deps, { commit: true, limit: 1 });
    const last = interrupted.checkpoints.at(-1)!;
    expect(last).toMatchObject({ completeness: 'in_progress' });
    expect(last).not.toHaveProperty('windowEnd');
  });

  test('a request-ceiling error stops the run cleanly, preserving progress', async () => {
    const { deps, checkpoints } = makeFake({
      pages: [page([opportunity()], 'p2')],
      throwCeilingOnCall: 2,
    });
    const summary = await runOpportunityShadowSync(deps, { commit: true });
    expect(summary.ceilingReached).toBe(true);
    expect(summary.completeness).toBe('in_progress');
    // The first page's own checkpoint survived.
    expect(checkpoints).toHaveLength(1);
  });

  test('the filter fingerprint is derived from the FLOOR, so two windows never share a cursor', async () => {
    const a = makeFake();
    await runOpportunityShadowSync(a.deps, { commit: true, changedSince: '2026-05-01' });
    const b = makeFake();
    await runOpportunityShadowSync(b.deps, { commit: true, changedSince: '2026-06-01' });
    expect(a.checkpoints[0]!.filterFingerprint).not.toBe(b.checkpoints[0]!.filterFingerprint);
  });

  test('dry-run walks the provider but writes NO checkpoint, snapshot, link or ledger row', async () => {
    const fake = makeFake({ candidates: LINKED });
    const summary = await runOpportunityShadowSync(fake.deps, { commit: false });
    expect(summary.processed).toBe(1);
    expect(summary.linked).toBe(1);
    // The counts are real; the writes are not.
    expect(fake.checkpoints).toHaveLength(0);
    expect(fake.snapshots).toHaveLength(0);
    expect(fake.links).toHaveLength(0);
    expect(fake.parityWrites).toHaveLength(0);
  });
});

// ── Crosswalk outcomes ───────────────────────────────────────────────────────

describe('each crosswalk outcome is counted, and only one of them links', () => {
  test('exactly one candidate links, proposes an exact_identifier link, and writes the ledger', async () => {
    const fake = makeFake({ candidates: LINKED });
    const summary = await runOpportunityShadowSync(fake.deps, { commit: true });
    expect(summary).toMatchObject({ linked: 1, ambiguous: 0, unlinked: 0 });
    expect(fake.links[0]).toMatchObject({
      localResourceType: 'sam_opportunity',
      localResourceId: '11111111-1111-1111-1111-111111111111',
      tangoResourceType: 'opportunity',
      tangoExternalId: 'TO-1',
      basis: 'exact_identifier',
      confidenceBand: 'medium',
    });
    expect(fake.parityWrites).toHaveLength(1);
    expect(fake.parityWrites[0]!.rows).toHaveLength(8);
  });

  test('the link basis is NEVER anything but exact_identifier', async () => {
    // `reviewed_manual` needs a human and no fuzzy basis exists in the column's
    // own CHECK. This script has exactly one basis available to it.
    const fake = makeFake({ candidates: LINKED });
    await runOpportunityShadowSync(fake.deps, { commit: true });
    for (const link of fake.links) expect(link.basis).toBe('exact_identifier');
  });

  test('AMBIGUOUS links nothing and writes no ledger row', async () => {
    const fake = makeFake({
      candidates: [
        { id: 'a', noticeId: 'N-PRESOL', solicitationNumber: 'W911QY-26-R-0012' },
        { id: 'b', noticeId: 'N-SOL', solicitationNumber: 'W911QY-26-R-0012' },
      ],
    });
    const summary = await runOpportunityShadowSync(fake.deps, { commit: true });
    expect(summary).toMatchObject({ linked: 0, ambiguous: 1 });
    expect(fake.links).toHaveLength(0);
    expect(fake.parityWrites).toHaveLength(0);
  });

  test('UNLINKED still writes the provider observation — that IS the finding', async () => {
    // "The provider has a notice Capiro's own rail does not" is exactly what a
    // verification rail exists to surface. Discarding the observation because
    // it did not match would hide it.
    const fake = makeFake({ candidates: [] });
    const summary = await runOpportunityShadowSync(fake.deps, { commit: true });
    expect(summary).toMatchObject({ unlinked: 1, snapshots: 1 });
    expect(fake.snapshots).toHaveLength(1);
    expect(fake.links).toHaveLength(0);
  });

  test('a provider record with no solicitation number never issues a candidate query', async () => {
    const fake = makeFake({ pages: [page([opportunity({ solicitationNumber: null })])] });
    const summary = await runOpportunityShadowSync(fake.deps, { commit: true });
    expect(fake.candidateQueries).toHaveLength(0);
    expect(summary.unlinked).toBe(1);
  });

  test('the candidate query is issued with the NORMALIZED number', async () => {
    const fake = makeFake({ candidates: LINKED });
    await runOpportunityShadowSync(fake.deps, { commit: true });
    expect(fake.candidateQueries).toEqual(['W911QY26R0012']);
  });

  test('a local row that vanished between the query and the read is counted, not linked', async () => {
    const fake = makeFake({ candidates: LINKED, samSource: null });
    const summary = await runOpportunityShadowSync(fake.deps, { commit: true });
    expect(summary).toMatchObject({ vanished: 1, linked: 0 });
    expect(fake.links).toHaveLength(0);
    expect(fake.parityWrites).toHaveLength(0);
  });

  test('conflicts are counted per FIELD, across the whole run', async () => {
    const fake = makeFake({
      pages: [
        page([
          opportunity({ responseDeadline: '2026-09-15T17:00:00.000Z', title: 'Different title' }),
        ]),
      ],
      candidates: LINKED,
    });
    const summary = await runOpportunityShadowSync(fake.deps, { commit: true });
    expect(summary.conflicts).toBe(2);
    const rows = fake.parityWrites[0]!.rows;
    expect(rows.filter((r) => r.agreement === 'conflict').map((r) => r.field).sort()).toEqual([
      'response_deadline',
      'title',
    ]);
  });

  test('a ledger write failure is counted and the walk continues', async () => {
    const fake = makeFake({
      pages: [page([opportunity(), opportunity({ opportunityId: 'TO-2' })])],
      candidates: LINKED,
      writeParityThrows: true,
    });
    const summary = await runOpportunityShadowSync(fake.deps, { commit: true });
    expect(summary.processed).toBe(2);
    expect(summary.errored).toBe(2);
  });

  test('re-running with unchanged data produces the SAME decisions — idempotent by construction', async () => {
    const first = makeFake({ candidates: LINKED });
    const a = await runOpportunityShadowSync(first.deps, { commit: true, changedSince: '2026-05-01' });
    const second = makeFake({ candidates: LINKED });
    const b = await runOpportunityShadowSync(second.deps, { commit: true, changedSince: '2026-05-01' });
    expect(a.linked).toBe(b.linked);
    expect(a.conflicts).toBe(b.conflicts);
    expect(first.parityWrites[0]!.rows).toEqual(second.parityWrites[0]!.rows);
    expect(first.links[0]).toEqual(second.links[0]);
  });
});

// ── What this script must never write ────────────────────────────────────────

describe('SHADOW means it never writes to a canonical or tenant table', () => {
  const source = readFileSync(join(__dirname, 'sync-tango-opportunity-shadow.ts'), 'utf8');

  test('no write to sam_opportunity — first-party ingestion stays canonical', () => {
    // Plan §4.2. The behavioural half is covered by the fakes above (there is
    // no dependency through which a write could reach it); this is the
    // structural half, which a future edit cannot slip past.
    expect(source).not.toMatch(/samOpportunity\.(create|update|upsert|delete|updateMany|createMany)/);
    expect(source).not.toMatch(/UPDATE\s+sam_opportunity/i);
    expect(source).not.toMatch(/INSERT\s+INTO\s+sam_opportunity/i);
  });

  test('no write to federal_grant or client_funding_opportunity either', () => {
    expect(source).not.toMatch(/federalGrant\.(create|update|upsert|delete)/);
    expect(source).not.toMatch(/clientFundingOpportunity\./);
  });

  test('the only models it writes are the three provider-owned ones', () => {
    const writes = source.match(/prisma\.([A-Za-z]+)\.(create|update|upsert)/g) ?? [];
    // The parity ledger is the only model written via a direct prisma call; the
    // snapshot and the link go through TangoStoreService.
    for (const write of writes) {
      expect(write).toMatch(/prisma\.tangoOpportunityParity\./);
    }
    expect(source).toMatch(/store\.writeSnapshot\(/);
    expect(source).toMatch(/store\.proposeLink\(/);
  });

  test('it never resolves a conflict — resolution moves only through a human review', () => {
    // A conflict resolved by whichever job ran last is exactly the "last write
    // wins" merge §4.2 forbids.
    //
    // A PROPERTY, not a mention: this script's own doc explains that a re-run
    // keeps a reviewed row's resolution, so a bare substring search matches the
    // explanation and proves nothing. What must not exist is either column
    // being SET, which in a Prisma `data` object is a line-leading key.
    expect(source).not.toMatch(/^\s*resolution:/m);
    expect(source).not.toMatch(/^\s*reviewedBy:/m);
    expect(source).not.toMatch(/^\s*reviewedAt:/m);
  });

  test('a re-run keeps first_observed_at unless the OUTCOME changed', () => {
    // Otherwise every conflict reads as "seen five minutes ago" after every
    // run, which is true of all of them and therefore useless.
    expect(source).toMatch(/changed \? \{ firstObservedAt: observedAt \} : \{\}/);
  });

  test('the SQL normalizer matches normalizeSolicitationNumber exactly', () => {
    // The candidate query normalizes in Postgres to avoid loading every notice.
    // If the two expressions drift, a link silently stops being found.
    expect(source).toContain("regexp_replace(upper(coalesce(solicitation_number, '')), '[^A-Z0-9]', '', 'g')");
    const mapper = readFileSync(
      join(__dirname, '..', 'src', 'external', 'tango', 'tango-opportunity.mapper.ts'),
      'utf8',
    );
    expect(mapper).toContain("toUpperCase().replace(/[^A-Z0-9]/g, '')");
  });
});
