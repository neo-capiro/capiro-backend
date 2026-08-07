import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildParityReport,
  formatParityReport,
  parseArgs,
  type ParityReaderPort,
} from './diag-tango-opportunity-parity.js';

/**
 * The crosswalk/parity diagnostic (P27).
 *
 * The only part of this command with consequences is the EXIT CODE, so that is
 * what most of these tests are about: an ordinary unlinked row must never make
 * it nonzero, and an operator-set threshold must.
 *
 * A permanently-red diagnostic is an ignored diagnostic. This repo already has
 * that scar — `funding-opportunities-ci.yml`'s own header records a drift check
 * that was red on arrival for reasons the branch did not own — so the default
 * here is "report and exit 0".
 */

const AS_OF = new Date('2026-08-07T12:00:00.000Z');

function makePort(over: Partial<ParityReaderPort> = {}): ParityReaderPort {
  return {
    countByFieldAndAgreement: async () => [
      { field: 'title', agreement: 'agree', count: 40 },
      { field: 'response_deadline', agreement: 'agree', count: 36 },
      { field: 'response_deadline', agreement: 'conflict', count: 4 },
      { field: 'psc_code', agreement: 'both_absent', count: 40 },
    ],
    countConflictsByResolution: async () => [
      { resolution: 'unreviewed', count: 3 },
      { resolution: 'local_canonical', count: 1 },
    ],
    countLinkedPairs: async () => 40,
    countActiveLinks: async () => 40,
    countObservations: async () => 55,
    readLastSync: async () => ({
      at: new Date('2026-08-07T06:00:00.000Z'),
      completeness: 'complete',
    }),
    sampleUnreviewedConflicts: async () => [
      {
        field: 'response_deadline',
        tangoOpportunityId: 'TO-1',
        samOpportunityId: '11111111-1111-1111-1111-111111111111',
        localValue: '2026-09-01T17:00:00.000Z',
        providerValue: '2026-09-15T17:00:00.000Z',
        firstObservedAt: new Date('2026-07-20T00:00:00.000Z'),
      },
    ],
    ...over,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

describe('the CLI sets thresholds; none is set by default', () => {
  test('no flags means no threshold at all', () => {
    const args = parseArgs([]);
    expect(args.maxConflicts).toBeUndefined();
    expect(args.maxAmbiguous).toBeUndefined();
    expect(args.staleHours).toBeUndefined();
  });

  test('thresholds parse in both forms, and zero is a REAL threshold', () => {
    // `--max-conflicts=0` means "any conflict is blocking", which is a
    // legitimate operational choice and must not be read as "unset".
    expect(parseArgs(['--max-conflicts=0']).maxConflicts).toBe(0);
    expect(parseArgs(['--max-conflicts', '0']).maxConflicts).toBe(0);
    expect(parseArgs(['--stale-hours=48']).staleHours).toBe(48);
  });

  test('a negative or non-integer threshold is ignored rather than coerced', () => {
    expect(parseArgs(['--max-conflicts=-1']).maxConflicts).toBeUndefined();
    expect(parseArgs(['--max-conflicts=1.5']).maxConflicts).toBeUndefined();
    expect(parseArgs(['--max-conflicts=lots']).maxConflicts).toBeUndefined();
  });

  test('an unknown --field is ignored, never guessed at', () => {
    expect(parseArgs(['--field=response_deadline']).field).toBe('response_deadline');
    expect(parseArgs(['--field=deadline']).field).toBeUndefined();
    expect(parseArgs(['--field=title']).field).toBe('title');
  });

  test('the conflict sample defaults to ten', () => {
    expect(parseArgs([]).sample).toBe(10);
    expect(parseArgs(['--sample=3']).sample).toBe(3);
  });
});

// ── The report ───────────────────────────────────────────────────────────────

describe('the report separates coverage facts from data-quality findings', () => {
  test('per-field and total counts are both reported', async () => {
    const report = await buildParityReport(makePort(), parseArgs([]), AS_OF);
    expect(report.byField['response_deadline']).toEqual({ agree: 36, conflict: 4 });
    expect(report.byAgreement).toEqual({ agree: 76, conflict: 4, both_absent: 40 });
  });

  test('unreviewed and reviewed-kept-local conflicts are counted SEPARATELY', async () => {
    // "Nobody has looked" and "we looked and kept ours" are different facts,
    // which is why `local_canonical` exists as an explicit resolution rather
    // than being left implied by the source-precedence rule.
    const report = await buildParityReport(makePort(), parseArgs([]), AS_OF);
    expect(report.unreviewedConflicts).toBe(3);
    expect(report.localCanonicalConflicts).toBe(1);
  });

  test('provider observations with no link are reported, and never as a negative number', async () => {
    const report = await buildParityReport(makePort(), parseArgs([]), AS_OF);
    expect(report.unlinkedObservations).toBe(15);

    // More links than observations should not produce a negative count — the
    // two are counted by different queries and can disagree mid-sync.
    const skewed = await buildParityReport(
      makePort({ countObservations: async () => 5, countActiveLinks: async () => 40 }),
      parseArgs([]),
      AS_OF,
    );
    expect(skewed.unlinkedObservations).toBe(0);
  });

  test('the last sync is reported with its age in hours', async () => {
    const report = await buildParityReport(makePort(), parseArgs([]), AS_OF);
    expect(report.lastSync).toEqual({
      at: '2026-08-07T06:00:00.000Z',
      completeness: 'complete',
      hoursAgo: 6,
    });
  });

  test('a never-run sync reports a null age, not zero', async () => {
    const report = await buildParityReport(
      makePort({ readLastSync: async () => ({ at: null, completeness: null }) }),
      parseArgs([]),
      AS_OF,
    );
    expect(report.lastSync.hoursAgo).toBeNull();
  });

  test('the conflict sample carries both values and how long the conflict has stood', async () => {
    const report = await buildParityReport(makePort(), parseArgs([]), AS_OF);
    expect(report.examples[0]).toEqual({
      field: 'response_deadline',
      tangoOpportunityId: 'TO-1',
      samOpportunityId: '11111111-1111-1111-1111-111111111111',
      localValue: '2026-09-01T17:00:00.000Z',
      providerValue: '2026-09-15T17:00:00.000Z',
      firstObservedAt: '2026-07-20T00:00:00.000Z',
    });
  });

  test('the --field narrowing is passed through to the sample query', async () => {
    const seen: Array<string | undefined> = [];
    await buildParityReport(
      makePort({
        sampleUnreviewedConflicts: async (_limit, field) => {
          seen.push(field);
          return [];
        },
      }),
      parseArgs(['--field=title']),
      AS_OF,
    );
    expect(seen).toEqual(['title']);
  });
});

// ── The exit code ────────────────────────────────────────────────────────────

describe('it exits nonzero ONLY for an operator-set threshold', () => {
  test('with no threshold set, even a pile of conflicts and unlinked rows is not a breach', async () => {
    const report = await buildParityReport(
      makePort({
        countConflictsByResolution: async () => [{ resolution: 'unreviewed', count: 5000 }],
        countObservations: async () => 100_000,
        countActiveLinks: async () => 1,
      }),
      parseArgs([]),
      AS_OF,
    );
    expect(report.breaches).toEqual([]);
  });

  test('an ordinary UNLINKED row is never a breach, whatever the count', async () => {
    // The provider's catalog and Capiro's own rail sync on different schedules
    // and cover slightly different windows. A steady population of provider
    // notices with no local counterpart is the expected state of a verification
    // rail, and there is no flag that makes it blocking.
    const report = await buildParityReport(
      makePort({ countObservations: async () => 9_999, countActiveLinks: async () => 3 }),
      parseArgs(['--max-conflicts=100', '--max-ambiguous=100', '--stale-hours=1000']),
      AS_OF,
    );
    expect(report.unlinkedObservations).toBe(9_996);
    expect(report.breaches).toEqual([]);
  });

  test('unreviewed conflicts over --max-conflicts is a breach, naming both numbers', async () => {
    const report = await buildParityReport(makePort(), parseArgs(['--max-conflicts=2']), AS_OF);
    expect(report.breaches).toHaveLength(1);
    expect(report.breaches[0]).toContain('3');
    expect(report.breaches[0]).toContain('--max-conflicts=2');
  });

  test('conflicts EQUAL to the threshold are not a breach', async () => {
    const report = await buildParityReport(makePort(), parseArgs(['--max-conflicts=3']), AS_OF);
    expect(report.breaches).toEqual([]);
  });

  test('a REVIEWED conflict does not count toward the threshold', async () => {
    // Otherwise reviewing a conflict and keeping the local value — the correct
    // outcome under source precedence — would leave the diagnostic red forever.
    const report = await buildParityReport(
      makePort({
        countConflictsByResolution: async () => [
          { resolution: 'unreviewed', count: 1 },
          { resolution: 'local_canonical', count: 500 },
        ],
      }),
      parseArgs(['--max-conflicts=2']),
      AS_OF,
    );
    expect(report.breaches).toEqual([]);
  });

  test('a stale sync over --stale-hours is a breach', async () => {
    const report = await buildParityReport(makePort(), parseArgs(['--stale-hours=4']), AS_OF);
    expect(report.breaches[0]).toMatch(/last completed sync was 6h ago/);
  });

  test('a NEVER-RUN sync breaches --stale-hours rather than reporting as fresh', async () => {
    // Reporting it as fresh because there is no timestamp to compare would be
    // the most misleading available answer.
    const report = await buildParityReport(
      makePort({ readLastSync: async () => ({ at: null, completeness: null }) }),
      parseArgs(['--stale-hours=4']),
      AS_OF,
    );
    expect(report.breaches[0]).toMatch(/never completed a run/);
  });

  test('a never-run sync with NO --stale-hours is not a breach', async () => {
    const report = await buildParityReport(
      makePort({ readLastSync: async () => ({ at: null, completeness: null }) }),
      parseArgs([]),
      AS_OF,
    );
    expect(report.breaches).toEqual([]);
  });

  test('several thresholds breach independently and are all reported', async () => {
    const report = await buildParityReport(
      makePort(),
      parseArgs(['--max-conflicts=1', '--stale-hours=1']),
      AS_OF,
    );
    expect(report.breaches).toHaveLength(2);
  });
});

// ── The output ───────────────────────────────────────────────────────────────

describe('the output states which side is canonical', () => {
  test('the header says the local row wins, before showing any disagreement', async () => {
    // A table of disagreements with no statement about precedence invites
    // somebody to "fix" the local value, which is the merge §4.2 forbids.
    const text = formatParityReport(await buildParityReport(makePort(), parseArgs([]), AS_OF));
    expect(text).toMatch(/SAM\.gov row stays canonical/);
    expect(text).toMatch(/evidence for review, never a value to copy over/);
  });

  test('a breach is printed loudly rather than only reflected in the exit code', async () => {
    const text = formatParityReport(
      await buildParityReport(makePort(), parseArgs(['--max-conflicts=1']), AS_OF),
    );
    expect(text).toMatch(/THRESHOLD BREACHED/);
  });

  test('a clean report says nothing about breaches', async () => {
    const text = formatParityReport(await buildParityReport(makePort(), parseArgs([]), AS_OF));
    expect(text).not.toMatch(/THRESHOLD BREACHED/);
  });
});

describe('the diagnostic is a READ', () => {
  const source = readFileSync(join(__dirname, 'diag-tango-opportunity-parity.ts'), 'utf8');

  test('it writes nothing at all', () => {
    expect(source).not.toMatch(/\.(create|update|upsert|delete|createMany|updateMany)\(/);
  });

  test('it never calls Tango and never needs a key', () => {
    expect(source).not.toMatch(/TangoGatewayService|TangoResilienceService|TANGO_API_KEY/);
  });
});
