import { describe, expect, test } from '@jest/globals';
import {
  GRANT_ACTIVE_SQL,
  GRANT_CLOSED_SQL,
  LOCAL_SYNC_TIMESTAMP_FIELDS,
  SAM_ACTIVE_SQL,
  SAM_CLOSED_SQL,
  SAM_INFORMATIONAL_SQL,
  SAM_PURSUABLE_KIND_SQL,
  SAM_PURSUABLE_SQL,
  grantRevisionEvidence,
  grantSourceFingerprint,
  isGrantActive,
  isGrantClosed,
  isInformationalSamNotice,
  isPursuableSamNotice,
  isSamActive,
  isSamClosed,
  isSamPursuable,
  samRevisionEvidence,
  samSourceFingerprint,
  type GrantLifecycleFacts,
  type SamLifecycleFacts,
} from './source-lifecycle.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function grant(overrides: Partial<GrantLifecycleFacts> = {}): GrantLifecycleFacts {
  return {
    status: 'posted',
    closeDate: new Date('2026-09-01T00:00:00.000Z'),
    lastUpdatedAt: new Date('2026-07-01T00:00:00.000Z'),
    revision: 1,
    amendmentCount: 0,
    title: 'Advanced Materials Research',
    agency: 'Department of Energy',
    awardCeiling: 500_000,
    awardFloor: 50_000,
    estimatedFunding: 2_000_000,
    expectedAwards: 4,
    responseDateDesc: null,
    cfdaNumbers: ['81.049'],
    eligibility: ['25'],
    ...overrides,
  };
}

function sam(overrides: Partial<SamLifecycleFacts> = {}): SamLifecycleFacts {
  return {
    noticeType: 'Solicitation',
    baseType: 'Presolicitation',
    active: true,
    responseDeadline: new Date('2026-08-15T17:00:00.000Z'),
    archiveDate: new Date('2026-09-15T00:00:00.000Z'),
    postedDate: new Date('2026-07-01T00:00:00.000Z'),
    setAside: 'Total Small Business Set-Aside (FAR 19.5)',
    setAsideCode: 'SBA',
    naicsCode: '541715',
    pscCode: 'AC12',
    title: 'Hypersonic Test Support Services',
    agency: 'DEPT OF THE NAVY',
    office: 'NAVAIR',
    solicitationNumber: 'N0001926R0001',
    description: 'The Government requires test support services.',
    ...overrides,
  };
}

// ── The core anti-spam guarantee ────────────────────────────────────────────

describe('fingerprints exclude local synchronization clocks', () => {
  // These two tests are the reason this module exists. The previous
  // implementation derived "was this amended" from `lastUpdatedAt ??
  // detailSyncedAt ?? syncedAt` (grants) and `updatedAt ?? lastSyncedAt` (SAM).
  // Both fall back to OUR clock, so an ordinary nightly sync that rewrote
  // identical values produced an "Opportunity updated" alert on every tracked
  // row it touched.

  test('an ordinary SAM re-sync does not change the fingerprint', () => {
    const before = sam();
    // What a re-sync of an unchanged notice does: rewrites the row, bumping
    // Prisma's @updatedAt and lastSyncedAt. Neither is a fingerprint input, so
    // they cannot even be expressed through SamLifecycleFacts — which is the
    // structural half of this guarantee.
    const after = sam();
    expect(samSourceFingerprint(after)).toBe(samSourceFingerprint(before));
    expect(samRevisionEvidence(before, after).changed).toBe(false);
  });

  test('Grants.gov detail enrichment alone does not change the fingerprint', () => {
    // enrich-grant-details.ts writes detailSyncedAt on every record it visits,
    // including ones whose source content is byte-identical to last time.
    const before = grant();
    const after = grant();
    expect(grantSourceFingerprint(after)).toBe(grantSourceFingerprint(before));
    expect(grantRevisionEvidence(before, after).changed).toBe(false);
  });

  test('no local synchronization field name appears in either facts type', () => {
    // A structural guard: if someone adds `lastSyncedAt` to SamLifecycleFacts and
    // hashes it, this fails. Keys are enumerated from real fixtures because the
    // types are erased at runtime.
    for (const field of LOCAL_SYNC_TIMESTAMP_FIELDS) {
      expect(Object.keys(grant())).not.toContain(field);
      expect(Object.keys(sam())).not.toContain(field);
    }
  });
});

describe('source-backed revision evidence DOES fire', () => {
  test('a vendor-published grant revision is amendment evidence', () => {
    const before = grant({ revision: 1, lastUpdatedAt: new Date('2026-07-01T00:00:00.000Z') });
    const after = grant({ revision: 2, lastUpdatedAt: new Date('2026-07-20T00:00:00.000Z') });
    const evidence = grantRevisionEvidence(before, after);
    expect(evidence.changed).toBe(true);
    expect(evidence.reasons.join(' ')).toMatch(/Revision advanced from 1 to 2/);
    expect(grantSourceFingerprint(after)).not.toBe(grantSourceFingerprint(before));
  });

  test('a higher amendment count is amendment evidence', () => {
    const evidence = grantRevisionEvidence(grant({ amendmentCount: 0 }), grant({ amendmentCount: 1 }));
    expect(evidence.changed).toBe(true);
    expect(evidence.reasons.join(' ')).toMatch(/Amendment count/);
  });

  test('a changed material term is amendment evidence even with no revision bump', () => {
    // Grants.gov does not reliably bump `revision`. A halved award ceiling is a
    // real amendment whether or not the counter moved.
    const evidence = grantRevisionEvidence(grant({ awardCeiling: 500_000 }), grant({ awardCeiling: 250_000 }));
    expect(evidence.changed).toBe(true);
    expect(evidence.reasons.join(' ')).toMatch(/Award ceiling changed from 500000 to 250000/);
  });

  test('a SAM notice-type transition is amendment evidence', () => {
    const evidence = samRevisionEvidence(
      sam({ noticeType: 'Presolicitation' }),
      sam({ noticeType: 'Solicitation' }),
    );
    expect(evidence.changed).toBe(true);
    expect(evidence.reasons.join(' ')).toMatch(/Notice type changed from Presolicitation to Solicitation/);
  });

  test('a rewritten SAM statement of work is amendment evidence', () => {
    const evidence = samRevisionEvidence(
      sam({ description: 'Original scope.' }),
      sam({ description: 'Wholly different scope.' }),
    );
    expect(evidence.changed).toBe(true);
    expect(samSourceFingerprint(sam({ description: 'a' }))).not.toBe(
      samSourceFingerprint(sam({ description: 'b' })),
    );
  });
});

// ── Lifecycle predicates ───────────────────────────────────────────────────

describe('Grants.gov lifecycle', () => {
  test('posted with a future close date is active', () => {
    expect(isGrantActive({ status: 'posted', closeDate: new Date('2026-09-01') }, NOW)).toBe(true);
  });

  test('forecasted with no close date is active', () => {
    expect(isGrantActive({ status: 'forecasted', closeDate: null }, NOW)).toBe(true);
  });

  test('posted with a PAST close date is NOT active', () => {
    // The defect this pins: Grants.gov leaves oppStatus at 'posted' long after
    // the close date passes. Filtering on status alone admitted a large tail of
    // dead notices which, ordered by soonest deadline, sorted first and consumed
    // the read path's row cap ahead of everything genuinely open.
    expect(isGrantActive({ status: 'posted', closeDate: new Date('2024-01-01') }, NOW)).toBe(false);
    expect(isGrantClosed({ status: 'posted', closeDate: new Date('2024-01-01') }, NOW)).toBe(true);
  });

  test('closed and archived statuses are never active', () => {
    for (const status of ['closed', 'archived', 'CLOSED', null]) {
      expect(isGrantActive({ status, closeDate: null }, NOW)).toBe(false);
    }
  });

  test('active and closed are exact complements', () => {
    for (const status of ['posted', 'forecasted', 'closed', 'archived', null]) {
      for (const closeDate of [null, new Date('2024-01-01'), new Date('2026-09-01')]) {
        const facts = { status, closeDate };
        expect(isGrantActive(facts, NOW)).toBe(!isGrantClosed(facts, NOW));
      }
    }
  });
});

describe('SAM.gov lifecycle', () => {
  test('active with future dates is active', () => {
    expect(isSamActive(sam(), NOW)).toBe(true);
  });

  test('active=true but a PASSED response deadline is NOT active', () => {
    // `active` is derived from the ARCHIVE date, which commonly sits weeks after
    // the response deadline. A notice can be active while the window to respond
    // has already shut.
    expect(isSamActive(sam({ responseDeadline: new Date('2026-07-01') }), NOW)).toBe(false);
  });

  test('active=false is never active', () => {
    expect(isSamActive(sam({ active: false }), NOW)).toBe(false);
  });

  test('a passed archive date is not active', () => {
    expect(isSamActive(sam({ archiveDate: new Date('2026-07-01') }), NOW)).toBe(false);
  });

  test('award and special notices are not pursuable at any date', () => {
    for (const noticeType of [
      'Award Notice',
      'Special Notice',
      'Justification and Approval (J&A)',
      'Intent to Bundle Requirements (DoD-Funded)',
      'Sale of Surplus Property',
    ]) {
      expect(isPursuableSamNotice(noticeType)).toBe(false);
      expect(isInformationalSamNotice(noticeType)).toBe(true);
      // Live dates do not rescue them: a finished award is not a bid.
      expect(isSamPursuable(sam({ noticeType }), NOW)).toBe(false);
      // Nor do they fall into closed HISTORY, which means "you could have bid".
      expect(isSamClosed(sam({ noticeType, active: false }), NOW)).toBe(false);
    }
  });

  test('solicitation family is pursuable', () => {
    for (const noticeType of [
      'Solicitation',
      'Combined Synopsis/Solicitation',
      'Presolicitation',
      'Sources Sought',
    ]) {
      expect(isPursuableSamNotice(noticeType)).toBe(true);
      expect(isSamPursuable(sam({ noticeType }), NOW)).toBe(true);
    }
  });

  test('a pursuable notice past its deadline is closed history', () => {
    const closed = sam({ responseDeadline: new Date('2026-07-01') });
    expect(isSamPursuable(closed, NOW)).toBe(false);
    expect(isSamClosed(closed, NOW)).toBe(true);
  });

  test('pursuable and closed partition the pursuable-kind set exactly', () => {
    for (const active of [true, false]) {
      for (const responseDeadline of [null, new Date('2026-07-01'), new Date('2026-08-15')]) {
        const facts = sam({ active, responseDeadline });
        // Every pursuable-kind notice is in exactly one of the two buckets.
        expect(isSamPursuable(facts, NOW) !== isSamClosed(facts, NOW)).toBe(true);
      }
    }
  });
});

// ── SQL / TypeScript agreement ─────────────────────────────────────────────

describe('SQL predicates mirror the TypeScript predicates', () => {
  // The SQL cannot be executed here (no database in a unit suite), so what is
  // pinned is that every fact the TS predicates consult is also consulted by the
  // SQL. A SQL fragment that forgets `close_date` is precisely the bug that made
  // the read path return expired grants, and it is invisible to a type checker.

  test('grant active SQL tests both status and close date', () => {
    expect(GRANT_ACTIVE_SQL).toMatch(/status/);
    expect(GRANT_ACTIVE_SQL).toMatch(/close_date/);
    expect(GRANT_ACTIVE_SQL).toMatch(/'posted'/);
    expect(GRANT_ACTIVE_SQL).toMatch(/'forecasted'/);
    expect(GRANT_CLOSED_SQL).toBe(`NOT ${GRANT_ACTIVE_SQL}`);
  });

  test('SAM active SQL tests the flag AND both dates', () => {
    expect(SAM_ACTIVE_SQL).toMatch(/active = true/);
    expect(SAM_ACTIVE_SQL).toMatch(/response_deadline/);
    expect(SAM_ACTIVE_SQL).toMatch(/archive_date/);
  });

  test('pursuable SQL excludes every non-pursuable family the normalizer excludes', () => {
    for (const fragment of ['award', 'special notice', 'justification', 'intent to bundle', 'fair opportunity', 'sale of surplus']) {
      expect(SAM_PURSUABLE_KIND_SQL).toContain(fragment);
    }
  });

  test('pursuable SQL is active AND pursuable-kind; closed is its date-inverse', () => {
    expect(SAM_PURSUABLE_SQL).toContain(SAM_ACTIVE_SQL);
    expect(SAM_PURSUABLE_SQL).toContain(SAM_PURSUABLE_KIND_SQL);
    expect(SAM_CLOSED_SQL).toContain(`NOT ${SAM_ACTIVE_SQL}`);
    // Closed history stays restricted to pursuable kinds — award notices are a
    // different record, not a closed solicitation.
    expect(SAM_CLOSED_SQL).toContain(SAM_PURSUABLE_KIND_SQL);
    expect(SAM_INFORMATIONAL_SQL).toBe(`(NOT ${SAM_PURSUABLE_KIND_SQL})`);
  });
});
