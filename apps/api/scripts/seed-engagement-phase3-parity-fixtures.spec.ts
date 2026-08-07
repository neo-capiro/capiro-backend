/**
 * Engagement Phase 3 parity fixtures — contract suite (micro-session 3.2).
 *
 * Every test here is DB-free: it exercises the pure plan module, the committed
 * contract artifact, and the seed's own source text. The database half of 3.2 is
 * proved by running the seed against a disposable PostgreSQL instance
 * (`--apply --verify`), which is recorded in the fixture catalog.
 *
 * The three negative controls the plan asks for (duplicate key, missing required
 * status, non-allowlisted external email) are implemented by CORRUPTING a real
 * plan and asserting the matching rule fires. A test that only asserted the
 * healthy plan passes would still pass if every rule were deleted.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildFixtureContract,
  buildFixturePlan,
  collectEmails,
  collectKeys,
  isAllowedFixtureEmail,
  PHASE3_MARKER,
  REQUIRED_FIXTURE_STATES,
  RESERVED_IDENTIFIERS,
  resolveTemporal,
  validateFixturePlan,
  type FixturePlan,
} from './engagement-phase3-fixture-plan.js';
import { CONTRACT_PATH, REMOTE_DB_ACK, assertDisposableDatabase } from './seed-engagement-phase3-parity-fixtures.js';

const SEED_SOURCE = readFileSync(
  path.join(__dirname, 'seed-engagement-phase3-parity-fixtures.ts'),
  'utf8',
);

const clone = (plan: FixturePlan): FixturePlan => structuredClone(plan);
const rulesOf = (plan: FixturePlan): string[] => validateFixturePlan(plan).map((issue) => issue.rule);

describe('Phase 3 parity fixture plan', () => {
  const plan = buildFixturePlan();

  it('is valid', () => {
    expect(validateFixturePlan(plan)).toEqual([]);
  });

  it('is deterministic across builds', () => {
    expect(JSON.stringify(buildFixturePlan())).toBe(JSON.stringify(buildFixturePlan()));
  });

  it('covers every fixture the plan requires, with no state left uncited', () => {
    const covered = new Set(plan.states.map((state) => `${state.planSection}|${state.requirement}`));
    const missing = REQUIRED_FIXTURE_STATES.filter(
      (required) => !covered.has(`${required.planSection}|${required.requirement}`),
    );
    expect(missing).toEqual([]);
    expect(plan.states.length).toBeGreaterThanOrEqual(REQUIRED_FIXTURE_STATES.length);
  });

  it('gives every state either covering rows or a declared absence', () => {
    const thin = plan.states.filter((state) => !state.coveredBy.length && !state.absence);
    expect(thin).toEqual([]);
  });

  it('resolves every cited fixture key to a real row', () => {
    const keys = collectKeys(plan);
    const dangling = plan.states.flatMap((state) =>
      [...state.coveredBy, ...(state.absence ? [state.absence] : [])]
        .filter((key) => !keys.has(key))
        .map((key) => `${state.id} -> ${key}`),
    );
    expect(dangling).toEqual([]);
  });

  it('marks every row with the Phase 3 marker', () => {
    expect(rulesOf(plan)).not.toContain('marker-on-every-row');
    expect(plan.tenants.every((tenant) => tenant.name.includes(PHASE3_MARKER))).toBe(true);
  });

  it('keeps every address inside a reserved example domain', () => {
    const emails = collectEmails(plan);
    expect(emails.length).toBeGreaterThan(20);
    expect(emails.filter((entry) => !isAllowedFixtureEmail(entry.email))).toEqual([]);
  });

  it('declares a reason for every non-marker identifier', () => {
    expect(RESERVED_IDENTIFIERS.length).toBeGreaterThan(0);
    for (const entry of RESERVED_IDENTIFIERS) {
      expect(entry.reason.trim().length).toBeGreaterThan(40);
      expect(entry.field).toMatch(/^[A-Z]\w+\.\w+$/);
    }
    // The reserved slug is load-bearing: capiro_admin resolves only on it.
    expect(plan.tenants.map((tenant) => tenant.slug)).toContain('capiro-internal');
  });

  it('uses one unique id per row, all inside the fixture id space', () => {
    const rules = rulesOf(plan);
    expect(rules).not.toContain('unique-fixture-id');
    expect(rules).not.toContain('fixture-id-space');
  });

  it('carries no provider credential', () => {
    expect(rulesOf(plan)).not.toContain('no-provider-credential');
  });

  it('explains every state that needs input beyond the database', () => {
    const conditional = plan.states.filter((state) => state.requires);
    expect(conditional.length).toBeGreaterThan(0);
    for (const state of conditional) expect(state.note?.length ?? 0).toBeGreaterThan(80);
    // Reports' meetings/pendingActions is the known one; if it ever stops being
    // conditional, this test should be updated deliberately rather than drift.
    expect(conditional.map((state) => state.id)).toContain('reports.meetingsAndPendingActions');
  });

  it('declares the pre-existing send intent so 3.7 can assert a delta, not a zero', () => {
    expect(plan.sendIntents).toHaveLength(1);
    expect(plan.deliveries).toHaveLength(1);
    const state = plan.states.find((entry) => entry.id === 'outreach.deliveryUnknown');
    expect(state?.note).toContain('DELTA');
  });

  it('leaves an unknown delivery without a provider message id', () => {
    for (const delivery of plan.deliveries.filter((row) => row.status === 'unknown')) {
      expect(delivery.providerMessageId).toBeNull();
    }
  });

  it('keeps the nullable-client outreach record truthful', () => {
    const record = plan.outreachRecords.find((row) => row.key === 'outreach.nullableClient');
    expect(record).toBeDefined();
    expect(record?.clientKey).toBeNull();
  });

  it('covers every current Outreach v2 type and status', () => {
    expect(new Set(plan.outreachRecords.map((row) => row.type))).toEqual(
      new Set(['campaign', 'follow_up', 'prep', 'outbound_campaign']),
    );
    expect(new Set(plan.outreachRecords.map((row) => row.status))).toEqual(
      new Set(['draft', 'sent', 'opened_in_email', 'failed']),
    );
  });

  it('covers every report status on a stored target', () => {
    const statuses = new Set(
      plan.reportTargets.flatMap((row) => [row.prepStatus, row.outreachStatus, row.submissionStatus]),
    );
    expect(statuses).toEqual(new Set(['auto', 'not_started', 'in_progress', 'complete']));
  });

  it('covers every integration connection status the current UI renders', () => {
    expect(new Set(plan.connections.map((row) => row.status))).toEqual(
      new Set(['connected', 'disabled', 'error']),
    );
  });

  it('keeps the second tenant free of outreach records and connections', () => {
    const secondary = 'tenant.secondary';
    expect(plan.outreachRecords.filter((row) => row.tenantKey === secondary)).toEqual([]);
    expect(plan.connections.filter((row) => row.tenantKey === secondary)).toEqual([]);
  });

  it('walls one client and denies exactly one actor', () => {
    const walled = plan.clients.filter((row) => row.memoryWall);
    expect(walled).toHaveLength(1);
    const granted = new Set(plan.clientMemoryAccess.map((row) => row.userKey));
    expect(granted.has('actor.admin')).toBe(true);
    expect(granted.has('actor.wallDenied')).toBe(false);
  });

  it('provides both an active and an expired impersonation session', () => {
    expect(plan.impersonations.filter((row) => row.endedAt === null)).toHaveLength(1);
    expect(plan.impersonations.filter((row) => row.endedAt !== null)).toHaveLength(1);
  });
});

describe('Phase 3 parity fixture temporal descriptors', () => {
  const plan = buildFixturePlan();

  it('places cycle-relative meetings in the right calendar year from any anchor', () => {
    for (const anchorIso of ['2026-01-01T00:05:00.000Z', '2026-08-06T12:00:00.000Z', '2026-12-31T23:55:00.000Z']) {
      const anchor = new Date(anchorIso);
      const current = plan.meetings.find((row) => row.key === 'meeting.reportCurrentCycle')!;
      const previous = plan.meetings.find((row) => row.key === 'meeting.reportPreviousCycle')!;
      expect(resolveTemporal(current.startsAt, anchor).getUTCFullYear()).toBe(anchor.getUTCFullYear());
      expect(resolveTemporal(previous.startsAt, anchor).getUTCFullYear()).toBe(anchor.getUTCFullYear() - 1);
    }
  });

  it('keeps upcoming meetings ahead of the anchor and past meetings behind it', () => {
    const anchor = new Date('2026-08-06T12:00:00.000Z');
    const after = (key: string) => resolveTemporal(plan.meetings.find((r) => r.key === key)!.startsAt, anchor);
    expect(after('meeting.upcomingWithClient').getTime()).toBeGreaterThan(anchor.getTime());
    expect(after('meeting.upcomingNoClient').getTime()).toBeGreaterThan(anchor.getTime());
    expect(after('meeting.past').getTime()).toBeLessThan(anchor.getTime());
  });

  it('puts the deep-link meeting far outside any plausible calendar window', () => {
    const anchor = new Date('2026-08-06T12:00:00.000Z');
    const meeting = plan.meetings.find((row) => row.key === 'meeting.deepLinkOutsideRange')!;
    const days = (resolveTemporal(meeting.startsAt, anchor).getTime() - anchor.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(365);
  });

  it('lands the timezone-boundary meeting on different UTC and local dates, from any anchor', () => {
    const meeting = plan.meetings.find((row) => row.key === 'meeting.timezoneBoundary')!;
    // Several anchor times of day AND both DST halves of the year: an
    // anchor-relative offset would only diverge for some of these, which is how
    // the first version of this fixture was wrong.
    for (const anchorIso of [
      '2026-01-15T00:00:00.000Z',
      '2026-06-30T09:15:00.000Z',
      '2026-08-06T12:00:00.000Z',
      '2026-11-02T23:45:00.000Z',
    ]) {
      const startsAt = resolveTemporal(meeting.startsAt, new Date(anchorIso));
      const utcDay = startsAt.toISOString().slice(0, 10);
      const localDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: meeting.timeZone ?? 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(startsAt);
      expect(localDay).not.toBe(utcDay);
    }
  });

  it('spans midnight to midnight UTC for the all-day meeting', () => {
    const meeting = plan.meetings.find((row) => row.key === 'meeting.allDay')!;
    for (const anchorIso of ['2026-01-15T13:07:00.000Z', '2026-08-06T00:00:00.000Z']) {
      const anchor = new Date(anchorIso);
      const startsAt = resolveTemporal(meeting.startsAt, anchor);
      const endsAt = resolveTemporal(meeting.endsAt, anchor);
      expect(startsAt.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(endsAt.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(endsAt.getTime() - startsAt.getTime()).toBe(86_400_000);
    }
  });
});

describe('Phase 3 parity fixture contract artifact', () => {
  const plan = buildFixturePlan();

  it('matches the committed file byte for byte', () => {
    const expected = `${JSON.stringify(buildFixtureContract(plan), null, 2)}\n`;
    expect(readFileSync(CONTRACT_PATH, 'utf8')).toBe(expected);
  });

  it('contains no absolute timestamp, so it cannot churn day to day', () => {
    const serialized = JSON.stringify(buildFixtureContract(plan));
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('records a row count for every seeded collection', () => {
    const contract = buildFixtureContract(plan) as {
      counts: Record<string, number>;
      totals: { rows: number };
    };
    expect(Object.keys(contract.counts).length).toBeGreaterThan(20);
    expect(contract.totals.rows).toBe(
      Object.values(contract.counts).reduce((sum, count) => sum + count, 0),
    );
  });
});

describe('Phase 3 parity fixture seed containment', () => {
  it('imports no provider adapter, S3 client, or AWS SDK', () => {
    const imports = [...SEED_SOURCE.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';$/gm)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(4);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(
        /aws-sdk|@aws-sdk|\/microsoft\/|\/google\/|notetaker|recall|s3|mail-sender|graph/i,
      );
    }
  });

  it('names no live host, bucket, or account id', () => {
    expect(SEED_SOURCE).not.toMatch(/amazonaws\.com|\.rds\.|967807252336|capiro-(dev|prod)/);
  });

  it('creates no migration and issues no DDL', () => {
    expect(SEED_SOURCE).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE|migrate deploy/i);
  });

  it('refuses a non-loopback database by default', () => {
    const previousUrl = process.env.DATABASE_URL;
    const previousAck = process.env.ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB;
    try {
      process.env.DATABASE_URL = 'postgresql://u:p@db.example.invalid:5432/capiro';
      delete process.env.ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB;
      expect(() => assertDisposableDatabase()).toThrow(/non-loopback/);

      process.env.ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB = REMOTE_DB_ACK;
      expect(() => assertDisposableDatabase()).not.toThrow();

      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:55474/capiro?schema=public';
      delete process.env.ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB;
      expect(() => assertDisposableDatabase()).not.toThrow();

      delete process.env.DATABASE_URL;
      expect(() => assertDisposableDatabase()).toThrow(/DATABASE_URL is required/);
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousAck === undefined) delete process.env.ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB;
      else process.env.ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB = previousAck;
    }
  });

  it('deletes every table it seeds, children before parents', () => {
    const order = buildFixturePlan().cleanupOrder;
    // Every deleter in the seed appears in cleanupOrder and vice versa — the
    // seed asserts this at runtime too, but proving it here means a new table
    // cannot be seeded without a cleanup entry even if the seed never runs.
    const deleterTables = [...SEED_SOURCE.matchAll(/^\s{4}([a-z_]+): \(tx\) =>/gm)].map((m) => m[1]!);
    const multiline = [...SEED_SOURCE.matchAll(/^\s{4}([a-z_]+): \(tx\) =>\s*$/gm)].map((m) => m[1]!);
    const tables = new Set([...deleterTables, ...multiline]);
    expect([...tables].sort()).toEqual([...order].sort());

    expect(order.indexOf('outreach_deliveries')).toBeLessThan(order.indexOf('outreach_send_intents'));
    expect(order.indexOf('outreach_draft_versions')).toBeLessThan(order.indexOf('users'));
    expect(order.indexOf('meeting_attendees')).toBeLessThan(order.indexOf('meetings'));
    expect(order.indexOf('meetings')).toBeLessThan(order.indexOf('tenants'));
    expect(order.indexOf('users')).toBeLessThan(order.indexOf('tenants'));
  });
});

// ─── negative controls ──────────────────────────────────────────────────────

describe('Phase 3 parity fixture negative controls', () => {
  it('rejects a duplicate key', () => {
    const broken = clone(buildFixturePlan());
    // Same id AND same key as an existing meeting — the duplicate-insert defect
    // the plan's "duplicate key" control names.
    broken.meetings.push({ ...broken.meetings[0]! });
    const rules = rulesOf(broken);
    expect(rules).toContain('unique-fixture-id');
  });

  it('rejects a missing required status', () => {
    const broken = clone(buildFixturePlan());
    broken.states = broken.states.filter((state) => state.id !== 'outreach.failed');
    const issues = validateFixturePlan(broken);
    expect(issues.map((issue) => issue.rule)).toContain('required-state-covered');
    expect(issues.some((issue) => issue.detail.includes('"failed"'))).toBe(true);
  });

  it('rejects a non-allowlisted external email', () => {
    const broken = clone(buildFixturePlan());
    broken.contacts[0]!.email = 'real.staffer@mail.house.gov';
    const issues = validateFixturePlan(broken);
    expect(issues.map((issue) => issue.rule)).toContain('reserved-email-domains-only');
    expect(issues.some((issue) => issue.detail.includes('mail.house.gov'))).toBe(true);
  });

  it('rejects an id outside the fixture id space', () => {
    const broken = clone(buildFixturePlan());
    broken.clients[0]!.id = '11111111-2222-4333-8444-555555555555';
    expect(rulesOf(broken)).toContain('fixture-id-space');
  });

  it('rejects a row whose label lost the marker', () => {
    const broken = clone(buildFixturePlan());
    broken.meetings[0]!.subject = 'Quarterly briefing';
    expect(rulesOf(broken)).toContain('marker-on-every-row');
  });

  it('rejects a dangling foreign key', () => {
    const broken = clone(buildFixturePlan());
    broken.outreachRecords[0]!.clientKey = 'client.doesNotExist';
    expect(rulesOf(broken)).toContain('foreign-keys-resolve');
  });

  it('rejects a state that cites a row nobody defines', () => {
    const broken = clone(buildFixturePlan());
    broken.states.find((state) => state.id === 'outreach.sent')!.coveredBy = ['outreach.ghost'];
    expect(rulesOf(broken)).toContain('required-state-covered');
  });

  it('rejects a credential-shaped value', () => {
    const broken = clone(buildFixturePlan());
    broken.connections[0]!.syncState.refreshToken = 'ya29.fixture-should-never-hold-this';
    expect(rulesOf(broken)).toContain('no-provider-credential');
  });

  it('rejects an undeclared non-marker tenant slug', () => {
    const broken = clone(buildFixturePlan());
    broken.tenants[0]!.slug = 'acme-production';
    expect(rulesOf(broken)).toContain('reserved-identifier-declared');
  });

  it('rejects a conditional state with no explanation', () => {
    const broken = clone(buildFixturePlan());
    const state = broken.states.find((entry) => entry.requires)!;
    state.note = undefined;
    expect(rulesOf(broken)).toContain('conditional-state-explained');
  });
});
