import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  CHANGE_DIMENSIONS,
  CHANGE_SEVERITIES,
  UNSUPPORTED_DIMENSIONS,
  buildNoticeTimeline,
  classifyNoticeChange,
  compareNoticeOrder,
  dedupeByNoticeId,
  isSupportedDimension,
  type NoticeObservation,
} from './opportunity-change-classifier.js';
import {
  OpportunityTimelineService,
  type TimelinePort,
} from './opportunity-timeline.service.js';

/**
 * Notice history and the material-change timeline (P28).
 *
 * The four properties this phase's acceptance bar names, each with its own
 * block below:
 *
 *   out-of-order ingestion produces the SAME timeline;
 *   duplicate notices are a no-op;
 *   date-to-null AND null-to-date are both visible;
 *   an unchanged re-sync produces no material change.
 *
 * Plus the one the plan states as a rule rather than a test: the UI displays
 * source facts and WHAT CHANGED, not a generic update label — pinned here by
 * asserting on the composed summaries, since that is where the sentence is
 * built.
 */

const SAM_ID = '11111111-1111-1111-1111-111111111111';

function notice(over: Partial<NoticeObservation> = {}): NoticeObservation {
  return {
    tangoNoticeId: 'N-1',
    title: 'Turbofan Engine Sustainment',
    descriptionHash: 'd'.repeat(64),
    postedDate: new Date('2026-06-01T00:00:00.000Z'),
    providerUpdatedAt: new Date('2026-06-01T00:00:00.000Z'),
    responseDeadline: new Date('2026-09-01T17:00:00.000Z'),
    active: true,
    setAside: 'Total Small Business Set-Aside (FAR 19.5)',
    naicsCode: '336412',
    pscCode: '2840',
    attachmentCount: 3,
    sourceUrl: 'https://sam.gov/opp/n1/view',
    contentHash: 'a'.repeat(64),
    ...over,
  };
}

// ── The dimension vocabulary ─────────────────────────────────────────────────

describe('every dimension the plan names is declared, supported or not', () => {
  test('all nine plan dimensions plus cancellation and title are present', () => {
    for (const dimension of [
      'stage',
      'deadline',
      'set_aside',
      'naics',
      'psc',
      'place_of_performance',
      'contact',
      'attachments',
      'description',
      'cancellation',
    ]) {
      expect(CHANGE_DIMENSIONS as readonly string[]).toContain(dimension);
    }
  });

  test('the THREE with no provider counterpart are UNSUPPORTED, not silently absent', () => {
    // "The set-aside did not change" and "we cannot see the set-aside" are
    // different statements, and only one is a fact about the notice.
    //
    // THREE, not four. `description` was in this list when P28 shipped and
    // should not have been: NOTICE_SCHEMA declares it as a plain optional
    // `str`, and the mistake was reading TangoNotice's own field list instead
    // of the schema. See the classifier's own doc.
    expect(Object.keys(UNSUPPORTED_DIMENSIONS).sort()).toEqual([
      'contact',
      'place_of_performance',
      'stage',
    ]);
    for (const dimension of ['stage', 'contact', 'place_of_performance'] as const) {
      expect(isSupportedDimension(dimension)).toBe(false);
      // Each reason names the PROVIDER, never Capiro's own coverage.
      expect(UNSUPPORTED_DIMENSIONS[dimension]).toMatch(/provider states no/i);
    }
  });

  test('the seven comparable dimensions are supported, INCLUDING description', () => {
    for (const dimension of [
      'deadline',
      'set_aside',
      'naics',
      'psc',
      'attachments',
      'cancellation',
      'title',
      'description',
    ] as const) {
      expect(isSupportedDimension(dimension)).toBe(true);
    }
  });

  test('a description rewrite IS reported, and WITHOUT quoting either body', () => {
    // The regression this fix exists for: before it, a solicitation whose body
    // was rewritten between two notices produced an entry with no changes,
    // while the panel said description changes could not be observed at all.
    // Both statements were false.
    const changes = classifyNoticeChange(
      notice({ descriptionHash: 'd'.repeat(64) }),
      notice({ descriptionHash: 'e'.repeat(64) }),
    );
    const description = changes.find((c) => c.dimension === 'description')!;
    expect(description.summary).toMatch(/description text changed/i);
    // The before/after carry the two HASHES. A reader cannot act on a hash, and
    // that is deliberate: the actionable fact is "go read it", and an excerpt
    // would quote whichever paragraph came first rather than whichever mattered.
    expect(description.before).toBe('d'.repeat(64));
    expect(description.after).toBe('e'.repeat(64));
    expect(description.summary).toMatch(/not summarised here/i);
  });

  test('a description added and removed are two different sentences', () => {
    expect(
      classifyNoticeChange(notice({ descriptionHash: null }), notice())[0]!.summary,
    ).toMatch(/description was added/i);
    expect(
      classifyNoticeChange(notice(), notice({ descriptionHash: null }))[0]!.summary,
    ).toMatch(/description was removed/i);
  });

  test('an unchanged description is not a change', () => {
    expect(classifyNoticeChange(notice(), notice())).toEqual([]);
  });

  test('every supported dimension has a severity from the declared band', () => {
    const changes = classifyNoticeChange(
      notice(),
      notice({
        responseDeadline: new Date('2026-09-15T17:00:00.000Z'),
        setAside: null,
        naicsCode: '336413',
        pscCode: '5998',
        attachmentCount: 5,
        active: false,
        title: 'Renamed',
      }),
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(CHANGE_SEVERITIES as readonly string[]).toContain(change.severity);
    }
  });

  test('a deadline and a cancellation are CRITICAL; an attachment count is not', () => {
    // The split is about ACTION: a deadline or a cancellation changes whether
    // and when a team can respond at all.
    const critical = classifyNoticeChange(notice(), notice({ active: false }));
    expect(critical[0]!.severity).toBe('critical');
    const informational = classifyNoticeChange(notice(), notice({ attachmentCount: 4 }));
    expect(informational[0]!.severity).toBe('informational');
  });
});

// ── Absence, in both directions ──────────────────────────────────────────────

describe('a value appearing and a value disappearing are BOTH visible', () => {
  test('date-to-null is reported, with the removal called out explicitly', () => {
    // The more alarming direction, and it gets its own sentence rather than
    // being folded into a generic "the deadline changed".
    const changes = classifyNoticeChange(notice(), notice({ responseDeadline: null }));
    const deadline = changes.find((c) => c.dimension === 'deadline')!;
    expect(deadline.before).toBe('2026-09-01T17:00:00.000Z');
    expect(deadline.after).toBeNull();
    expect(deadline.summary).toMatch(/response deadline was removed/i);
  });

  test('null-to-date is reported as a deadline being SET', () => {
    const changes = classifyNoticeChange(notice({ responseDeadline: null }), notice());
    const deadline = changes.find((c) => c.dimension === 'deadline')!;
    expect(deadline.before).toBeNull();
    expect(deadline.summary).toMatch(/response deadline was set/i);
  });

  test('a deadline moving later and earlier read differently', () => {
    const later = classifyNoticeChange(
      notice(),
      notice({ responseDeadline: new Date('2026-09-15T17:00:00.000Z') }),
    );
    expect(later[0]!.summary).toMatch(/moved later/);
    const earlier = classifyNoticeChange(
      notice(),
      notice({ responseDeadline: new Date('2026-08-15T17:00:00.000Z') }),
    );
    expect(earlier[0]!.summary).toMatch(/moved earlier/);
  });

  test('a set-aside added, removed and changed are three different sentences', () => {
    const added = classifyNoticeChange(notice({ setAside: null }), notice())[0]!;
    expect(added.summary).toMatch(/set-aside was added/i);
    const removed = classifyNoticeChange(notice(), notice({ setAside: null }))[0]!;
    expect(removed.summary).toMatch(/set-aside was removed/i);
    const changed = classifyNoticeChange(notice(), notice({ setAside: 'HUBZone' }))[0]!;
    expect(changed.summary).toMatch(/set-aside changed from .* to HUBZone/i);
  });

  test('an attachment count going UP and DOWN read differently, and null is "unstated"', () => {
    const up = classifyNoticeChange(notice(), notice({ attachmentCount: 5 }))[0]!;
    expect(up.summary).toMatch(/2 attachments added \(now 5\)/);
    const down = classifyNoticeChange(notice(), notice({ attachmentCount: 1 }))[0]!;
    expect(down.summary).toMatch(/2 attachments removed \(now 1\)/);
    const unstated = classifyNoticeChange(notice(), notice({ attachmentCount: null }))[0]!;
    expect(unstated.summary).toMatch(/from 3 to unstated/);
  });

  test('a cancellation is reported, and so is a reinstatement', () => {
    const cancelled = classifyNoticeChange(notice(), notice({ active: false }))[0]!;
    expect(cancelled.dimension).toBe('cancellation');
    expect(cancelled.summary).toMatch(/no longer open for response/i);
    const reinstated = classifyNoticeChange(
      notice({ active: false }),
      notice({ active: true }),
    )[0]!;
    expect(reinstated.summary).toMatch(/reinstated/i);
  });

  test('active going to NULL is not reported as a cancellation', () => {
    // The provider ceasing to state a flag is not the agency withdrawing the
    // notice, and reporting it as one would be the single most misleading
    // entry this timeline could carry.
    const changes = classifyNoticeChange(notice({ active: true }), notice({ active: null }));
    expect(changes.map((c) => c.dimension)).not.toContain('cancellation');
  });
});

// ── No generic label ─────────────────────────────────────────────────────────

describe('every change states WHAT changed, never "the notice was updated"', () => {
  test('no summary is a generic update label', () => {
    const changes = classifyNoticeChange(
      notice(),
      notice({
        responseDeadline: new Date('2026-09-15T17:00:00.000Z'),
        naicsCode: '336413',
        attachmentCount: 5,
        title: 'Renamed solicitation',
      }),
    );
    expect(changes.length).toBe(4);
    for (const change of changes) {
      expect(change.summary).not.toMatch(/^the notice was updated/i);
      // Every summary names either the old value, the new value, or both.
      expect(change.summary.length).toBeGreaterThan(20);
    }
  });

  test('both the before and the after value are carried verbatim', () => {
    const changes = classifyNoticeChange(notice(), notice({ naicsCode: '336413' }));
    expect(changes[0]).toMatchObject({ before: '336412', after: '336413' });
  });

  test('a cosmetic re-casing or re-spacing is NOT a change', () => {
    const changes = classifyNoticeChange(
      notice({ title: 'Turbofan  Engine   Sustainment' }),
      notice({ title: 'TURBOFAN ENGINE SUSTAINMENT' }),
    );
    expect(changes).toEqual([]);
  });

  test('a differently-punctuated code is NOT a change', () => {
    const changes = classifyNoticeChange(
      notice({ naicsCode: '336412', pscCode: '2840' }),
      notice({ naicsCode: ' 336-412 ', pscCode: '28 40' }),
    );
    expect(changes).toEqual([]);
  });

  test('a SECONDS-level deadline difference is NOT a change', () => {
    // Same reasoning as P27's parity ledger: a rounding artefact reported as an
    // agency action is worse than not reporting it.
    const changes = classifyNoticeChange(
      notice({ responseDeadline: new Date('2026-09-01T17:00:00.000Z') }),
      notice({ responseDeadline: new Date('2026-09-01T17:00:44.000Z') }),
    );
    expect(changes).toEqual([]);
  });
});

// ── Order independence ───────────────────────────────────────────────────────

describe('THE ACCEPTANCE BAR: out-of-order ingestion produces the same timeline', () => {
  const first = notice({
    tangoNoticeId: 'N-1',
    postedDate: new Date('2026-06-01T00:00:00.000Z'),
    responseDeadline: new Date('2026-09-01T17:00:00.000Z'),
    contentHash: 'a'.repeat(64),
  });
  const second = notice({
    tangoNoticeId: 'N-2',
    postedDate: new Date('2026-07-01T00:00:00.000Z'),
    responseDeadline: new Date('2026-09-15T17:00:00.000Z'),
    contentHash: 'b'.repeat(64),
  });
  const third = notice({
    tangoNoticeId: 'N-3',
    postedDate: new Date('2026-08-01T00:00:00.000Z'),
    active: false,
    responseDeadline: new Date('2026-09-15T17:00:00.000Z'),
    contentHash: 'c'.repeat(64),
  });

  test('every input permutation produces a byte-identical timeline', () => {
    const canonical = JSON.stringify(buildNoticeTimeline([first, second, third]));
    const permutations = [
      [third, second, first],
      [second, first, third],
      [third, first, second],
      [second, third, first],
      [first, third, second],
    ];
    for (const permutation of permutations) {
      expect(JSON.stringify(buildNoticeTimeline(permutation))).toBe(canonical);
    }
  });

  test('the order is TOTAL, so two notices posted the same instant still sort deterministically', () => {
    // Without the id tiebreaker the same set could produce two timelines
    // depending on which page the provider handed back first.
    const at = new Date('2026-06-01T00:00:00.000Z');
    const a = notice({ tangoNoticeId: 'N-b', postedDate: at, providerUpdatedAt: null });
    const b = notice({ tangoNoticeId: 'N-a', postedDate: at, providerUpdatedAt: null });
    expect(compareNoticeOrder(a, b)).toBeGreaterThan(0);
    expect(buildNoticeTimeline([a, b]).entries.map((e) => e.tangoNoticeId)).toEqual([
      'N-a',
      'N-b',
    ]);
  });

  test('an UNDATED notice sorts LAST, never as the baseline', () => {
    // Placing an undated observation at the head would make it the baseline
    // every later notice is compared against, inventing a change on the second.
    const undated = notice({ tangoNoticeId: 'N-undated', postedDate: null });
    const timeline = buildNoticeTimeline([undated, first, second]);
    expect(timeline.entries.map((e) => e.tangoNoticeId)).toEqual(['N-1', 'N-2', 'N-undated']);
    expect(timeline.entries[0]!.isFirstObservation).toBe(true);
  });

  test('the first entry has no changes — there is nothing before it', () => {
    const timeline = buildNoticeTimeline([first, second]);
    expect(timeline.entries[0]!.changes).toEqual([]);
    expect(timeline.entries[0]!.isFirstObservation).toBe(true);
    expect(timeline.entries[1]!.isFirstObservation).toBe(false);
  });

  test('severity counts are aggregated across the whole timeline', () => {
    const timeline = buildNoticeTimeline([first, second, third]);
    // N-1 -> N-2: deadline (critical). N-2 -> N-3: cancellation (critical).
    expect(timeline.bySeverity.critical).toBe(2);
    expect(timeline.changeCount).toBe(2);
  });

  test('the unsupported dimensions are reported on every timeline', () => {
    const timeline = buildNoticeTimeline([first]);
    expect(timeline.unsupported.map((u) => u.dimension).sort()).toEqual([
      'contact',
      'place_of_performance',
      'stage',
    ]);
  });
});

// ── Duplicates ───────────────────────────────────────────────────────────────

describe('THE ACCEPTANCE BAR: duplicate notices are a no-op', () => {
  test('two observations of the same notice id collapse to one entry', () => {
    const a = notice({ tangoNoticeId: 'N-1' });
    const timeline = buildNoticeTimeline([a, { ...a }]);
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.changeCount).toBe(0);
  });

  test('the LATER providerUpdatedAt wins, whichever order they arrive in', () => {
    const older = notice({
      tangoNoticeId: 'N-1',
      providerUpdatedAt: new Date('2026-06-01T00:00:00.000Z'),
      attachmentCount: 3,
    });
    const newer = notice({
      tangoNoticeId: 'N-1',
      providerUpdatedAt: new Date('2026-07-01T00:00:00.000Z'),
      attachmentCount: 7,
    });
    expect(dedupeByNoticeId([older, newer])[0]!.attachmentCount).toBe(7);
    expect(dedupeByNoticeId([newer, older])[0]!.attachmentCount).toBe(7);
  });

  test('a tie keeps the FIRST — deterministic, not input-order dependent', () => {
    const at = new Date('2026-06-01T00:00:00.000Z');
    const a = notice({ tangoNoticeId: 'N-1', providerUpdatedAt: at, attachmentCount: 3 });
    const b = notice({ tangoNoticeId: 'N-1', providerUpdatedAt: at, attachmentCount: 9 });
    expect(dedupeByNoticeId([a, b])[0]!.attachmentCount).toBe(3);
  });

  test('an overlapping incremental window is FREE — the duplicates it re-fetches change nothing', () => {
    // The overlap re-fetches notices the previous run already stored, by
    // design. Phantom changes from that would make the overlap unusable.
    const run1 = [notice({ tangoNoticeId: 'N-1' }), notice({ tangoNoticeId: 'N-2', postedDate: new Date('2026-07-01T00:00:00.000Z') })];
    const run2Overlap = [...run1, ...run1];
    expect(JSON.stringify(buildNoticeTimeline(run2Overlap))).toBe(
      JSON.stringify(buildNoticeTimeline(run1)),
    );
  });
});

// ── Unchanged re-sync ────────────────────────────────────────────────────────

describe('THE ACCEPTANCE BAR: an unchanged re-sync produces no material change', () => {
  test('identical facts between two DIFFERENT notices produce no change', () => {
    // A real amendment that changed nothing this classifier can see: the entry
    // exists (the notice is real) but carries no changes.
    const a = notice({ tangoNoticeId: 'N-1' });
    const b = notice({
      tangoNoticeId: 'N-2',
      postedDate: new Date('2026-07-01T00:00:00.000Z'),
    });
    const timeline = buildNoticeTimeline([a, b]);
    expect(timeline.entries).toHaveLength(2);
    expect(timeline.entries[1]!.changes).toEqual([]);
    expect(timeline.changeCount).toBe(0);
  });

  test('comparing an observation to itself yields nothing', () => {
    expect(classifyNoticeChange(notice(), notice())).toEqual([]);
  });
});

// ── The read service ─────────────────────────────────────────────────────────

function makeService(over: Partial<TimelinePort> = {}) {
  const port: TimelinePort = {
    readNoticesForSamOpportunity: async () => [notice()],
    countAllNotices: async () => 1,
    ...over,
  };
  return new OpportunityTimelineService({} as never).withPort(port);
}

describe('the timeline read distinguishes the three kinds of empty', () => {
  test('a grant is REFUSED rather than given an empty timeline', () => {
    // An empty grant timeline reads as "this grant was never amended", which
    // nothing here can support: Grants.gov publishes no notice history at all.
    return expect(
      makeService().getTimeline('grants_gov', 'DE-FOA-0001'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('a non-uuid SAM id is a 400, not a 500 from the driver', async () => {
    await expect(makeService().getTimeline('sam_gov', 'not-a-uuid')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test('notices found means coverage `available`', async () => {
    const out = await makeService().getTimeline('sam_gov', SAM_ID);
    expect(out.coverage).toBe('available');
    expect(out.entries).toHaveLength(1);
  });

  test('NO notices anywhere means `no_notices_synced`, and says so', async () => {
    const out = await makeService({
      readNoticesForSamOpportunity: async () => [],
      countAllNotices: async () => 0,
    }).getTimeline('sam_gov', SAM_ID);
    expect(out.coverage).toBe('no_notices_synced');
    expect(out.coverageExplanation).toMatch(/not a statement that the solicitation was never amended/i);
  });

  test('notices exist but none linked means `not_crosswalked` — a different fact', async () => {
    const out = await makeService({
      readNoticesForSamOpportunity: async () => [],
      countAllNotices: async () => 4_000,
    }).getTimeline('sam_gov', SAM_ID);
    expect(out.coverage).toBe('not_crosswalked');
    expect(out.coverageExplanation).toMatch(/has not been crosswalked/i);
  });

  test('the source and record id are echoed, so a caller can key a cache on them', async () => {
    const out = await makeService().getTimeline('sam_gov', SAM_ID, new Date('2026-08-07T12:00:00.000Z'));
    expect(out).toMatchObject({ source: 'sam_gov', sourceRecordId: SAM_ID, generatedAt: '2026-08-07T12:00:00.000Z' });
  });
});

// ── Structural guarantees ────────────────────────────────────────────────────

describe('P28 emits nothing', () => {
  const classifier = readFileSync(join(__dirname, 'opportunity-change-classifier.ts'), 'utf8');
  const service = readFileSync(join(__dirname, 'opportunity-timeline.service.ts'), 'utf8');

  test('neither file writes anything', () => {
    for (const source of [classifier, service]) {
      expect(source).not.toMatch(/\.(create|update|upsert|delete|createMany|updateMany)\(/);
    }
  });

  test('neither file can send an alert, a task or an email', () => {
    // Alerting on a material change is P48's. Holding no dependency through
    // which one could be sent is how that stays true rather than being
    // remembered — so the check is on IMPORTS and CALLS, not on the word
    // "alert", which both files' own docs use to say they do not send any.
    for (const source of [classifier, service]) {
      const imports = (source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? []).join('\n');
      expect(imports).not.toMatch(/alert|notification|engagement|mail|meri/i);
      expect(source).not.toMatch(/\b(AlertService|NotificationService|EngagementService)\b/);
      expect(source).not.toMatch(/\.(sendMail|notify|emit|publish|enqueue)\(/);
    }
  });

  test('the classifier is pure — no clock, no database, no network', () => {
    expect(classifier).not.toMatch(/new Date\(\)/);
    expect(classifier).not.toMatch(/prisma|Prisma/);
    expect(classifier).not.toMatch(/fetch\(|axios|TangoGateway/);
  });

  test('the timeline is DERIVED, never stored — no model holds one', () => {
    const schema = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    );
    expect(schema).not.toMatch(/model TangoOpportunityTimeline/);
    expect(schema).toMatch(/model TangoOpportunityNotice/);
  });
});

describe('the migration and the model agree', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260827010000_tango_opportunity_notice_history',
      'migration.sql',
    ),
    'utf8',
  );

  test('the table is global: no tenant_id, no RLS, no policies', () => {
    const create =
      sql.match(/CREATE TABLE IF NOT EXISTS "tango_opportunity_notice"[\s\S]*?\);/)?.[0] ?? '';
    expect(create).not.toBe('');
    expect(create).not.toMatch(/tenant_id/);
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/CREATE POLICY/);
  });

  test('no foreign key — the history must outlive either catalog’s row lifecycle', () => {
    expect(sql).not.toMatch(/REFERENCES/i);
  });

  test('the content hash is format-checked, so a truncated one cannot defeat the no-op path', () => {
    expect(sql).toMatch(/content_hash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  });

  test('the description columns are an all-or-nothing PAIR, added additively', () => {
    // A hash with no body, or a body with no hash, is a half-written row.
    const fix = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'prisma',
        'migrations',
        '20260828010000_tango_notice_description_hash',
        'migration.sql',
      ),
      'utf8',
    );
    expect(fix).toMatch(/ADD COLUMN IF NOT EXISTS "description" TEXT/);
    expect(fix).toMatch(/ADD COLUMN IF NOT EXISTS "description_sha256" TEXT/);
    expect(fix).toMatch(/description_sha256" IS NULL OR "description_sha256" ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(fix).toMatch(/description_pair_chk/);
    // Additive and nullable: every pre-existing row has neither, and "we did
    // not request this field when we observed this notice" is a different fact
    // from "the provider stated none".
    // The DDL forms specifically — the pair CHECK legitimately contains
    // `IS NOT NULL`, so a bare `NOT NULL` search matches the constraint that
    // makes this safe rather than a column that would make it unsafe.
    expect(fix).not.toMatch(/ADD COLUMN[^;]*\bNOT NULL\b/);
    expect(fix).not.toMatch(/SET NOT NULL/);
    expect(fix).not.toMatch(/DROP COLUMN/);
  });

  test('a negative attachment count is refused', () => {
    expect(sql).toMatch(/attachment_count" IS NULL OR "attachment_count" >= 0/);
  });

  test('the notice id is unique, and both timeline queries are indexed', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "tango_opportunity_notice_notice_id_uniq"/);
    expect(sql).toMatch(/"tango_opportunity_notice_parent_idx"/);
    expect(sql).toMatch(/"tango_opportunity_notice_sam_idx"/);
  });

  test('every statement is retry-safe', () => {
    expect(sql.match(/CREATE (TABLE|UNIQUE INDEX|INDEX)(?! IF NOT EXISTS)/g) ?? []).toEqual([]);
    for (const guard of ['hash_chk', 'attachment_count_chk']) {
      expect(sql).toContain(`WHERE conname = 'tango_opportunity_notice_${guard}'`);
    }
  });
});
