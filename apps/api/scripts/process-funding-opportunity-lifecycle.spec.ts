import { describe, expect, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import {
  deriveLifecycleEvents,
  processLifecycle,
  type LifecycleSnapshot,
} from './process-funding-opportunity-lifecycle.js';

/**
 * `lifecycleFake` implements only the handful of Prisma calls processLifecycle
 * actually makes, which is the point of the fake — so it is asserted into the
 * PrismaClient parameter rather than the whole client being stubbed out.
 */
const asPrisma = (fake: unknown): PrismaClient => fake as PrismaClient;

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const now = new Date('2026-07-29T12:00:00Z');

function snapshot(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    status: 'active',
    deadline: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-07-20T00:00:00Z'),
    active: true,
    fingerprint: 'fp-previous',
    ...overrides,
  };
}

const base = {
  title: 'Autonomy solicitation',
  workflowStatus: 'saved',
  previous: snapshot(),
  current: snapshot({ fingerprint: 'fp-previous' }),
  revisionReasons: [] as string[],
  now,
};

function types(input: Parameters<typeof deriveLifecycleEvents>[0]): string[] {
  return deriveLifecycleEvents(input).events.map((event) => event.type);
}

// ── Baseline ────────────────────────────────────────────────────────────────

describe('first observation establishes a SILENT baseline', () => {
  test('a row with no stored fingerprint produces no events at all', () => {
    // Without this rule the first run after deployment alerts on every tracked
    // row in every tenant, because "no previous value" compares unequal to every
    // present value.
    const decision = deriveLifecycleEvents({
      ...base,
      previous: snapshot({ fingerprint: null, status: null, deadline: null, active: null }),
      current: snapshot({ fingerprint: 'fp-new', active: false, status: 'archived' }),
      revisionReasons: ['Revision advanced from 1 to 2.'],
    });
    expect(decision.baseline).toBe(true);
    expect(decision.events).toEqual([]);
  });

  test('a legacy row whose source is ALREADY closed does not fire a closure alert', () => {
    // The specific old defect: previousActive was reconstructed by testing the
    // stored status string against a closed-word list, and an EMPTY status is not
    // in that list — so it reconstructed to `true` and an already-dead
    // opportunity announced itself as newly closed.
    const decision = deriveLifecycleEvents({
      ...base,
      previous: snapshot({ fingerprint: null, status: null, active: null }),
      current: snapshot({ active: false, status: 'archived', fingerprint: 'fp-new' }),
    });
    expect(decision.events).toEqual([]);
  });

  test('once a baseline exists, changes ARE detected', () => {
    expect(
      types({
        ...base,
        previous: snapshot({ active: true }),
        current: snapshot({ active: false, status: 'archived' }),
      }),
    ).toContain('cancelled_or_closed');
  });
});

// ── Which statuses may be alerted ───────────────────────────────────────────

describe('alerts go only to saved and pursuing', () => {
  const changed = {
    ...base,
    current: snapshot({
      deadline: new Date('2026-08-25T00:00:00Z'),
      active: false,
      status: 'archived',
      // A moved fingerprint is what makes `amended` eligible at all.
      fingerprint: 'fp-current',
    }),
    revisionReasons: ['The source reports a modification on 2026-07-28.'],
  };

  test.each(['saved', 'pursuing'])('%s receives alerts', (workflowStatus) => {
    const emitted = types({ ...changed, workflowStatus });
    expect(emitted).toContain('deadline_changed');
    expect(emitted).toContain('amended');
    expect(emitted).toContain('cancelled_or_closed');
  });

  test.each(['suggested', 'dismissed', 'won', 'lost', 'expired'])(
    '%s receives NO alerts, even with every change present',
    (workflowStatus) => {
      // The old code gated only `closing_soon` on human tracking, so
      // deadline_changed / amended / cancelled_or_closed fired for dismissed and
      // expired rows too — "the deadline moved" on something dismissed three
      // months ago is not information.
      expect(types({ ...changed, workflowStatus })).toEqual([]);
    },
  );

  test('closing_soon also respects the status gate', () => {
    const closingSoon = { ...base, current: snapshot({ deadline: new Date('2026-08-05T00:00:00Z') }) };
    expect(types({ ...closingSoon, workflowStatus: 'saved' })).toContain('closing_soon');
    expect(types({ ...closingSoon, workflowStatus: 'suggested' })).not.toContain('closing_soon');
  });
});

// ── Deadline transitions ────────────────────────────────────────────────────

describe('deadline changes include the null transitions', () => {
  test('date → date', () => {
    expect(
      types({ ...base, current: snapshot({ deadline: new Date('2026-08-25T00:00:00Z') }) }),
    ).toContain('deadline_changed');
  });

  test('date → null (a withdrawn deadline) is detected', () => {
    // Old predicate required BOTH deadlines non-null, so this was silently
    // ignored — and a deadline being withdrawn ("responses accepted
    // continuously") changes what a bid team does this week.
    const decision = deriveLifecycleEvents({ ...base, current: snapshot({ deadline: null }) });
    expect(decision.events.map((e) => e.type)).toContain('deadline_changed');
    expect(decision.events.find((e) => e.type === 'deadline_changed')?.body).toContain(
      'no stated deadline',
    );
  });

  test('null → date (a newly published deadline) is detected', () => {
    const decision = deriveLifecycleEvents({
      ...base,
      previous: snapshot({ deadline: null }),
      current: snapshot({ deadline: new Date('2026-08-20T00:00:00Z') }),
    });
    expect(decision.events.map((e) => e.type)).toContain('deadline_changed');
  });

  test('null → null is not a change', () => {
    expect(
      types({ ...base, previous: snapshot({ deadline: null }), current: snapshot({ deadline: null }) }),
    ).not.toContain('deadline_changed');
  });

  test('an identical deadline is not a change', () => {
    expect(types(base)).not.toContain('deadline_changed');
  });
});

// ── Amendment evidence ─────────────────────────────────────────────────────

describe('amendment alerts are gated on the FINGERPRINT, not on narration', () => {
  test('an identical fingerprint means no amendment alert, whatever else is passed', () => {
    // The anti-spam guarantee at the processor level. An ordinary sync leaves the
    // source content — and therefore the fingerprint — untouched, so it cannot
    // produce an `amended` event however many times it rewrites the row.
    expect(types({ ...base, revisionReasons: [] })).not.toContain('amended');
    expect(
      types({ ...base, revisionReasons: ['Status changed from none to posted.'] }),
    ).not.toContain('amended');
  });

  test('a changed fingerprint with NO nameable reason still alerts, honestly', () => {
    // Only four columns are snapshotted, so a rewritten statement of work moves
    // the fingerprint while nothing nameable explains it. Saying "a field we do
    // not snapshot changed" is the honest report; inventing a field name is not,
    // and staying silent would drop a real amendment.
    const decision = deriveLifecycleEvents({
      ...base,
      current: snapshot({ fingerprint: 'fp-new' }),
      revisionReasons: [],
    });
    expect(decision.events.map((e) => e.type)).toContain('amended');
    expect(decision.events.find((e) => e.type === 'amended')?.body).toContain(
      'not one Capiro snapshots',
    );
  });

  test('the alert body NAMES what changed when it can', () => {
    const decision = deriveLifecycleEvents({
      ...base,
      current: snapshot({ fingerprint: 'fp-new' }),
      revisionReasons: ['The source reports a modification on 2026-07-28.'],
    });
    const amended = decision.events.find((e) => e.type === 'amended');
    expect(amended?.body).toContain('The source reports a modification on 2026-07-28.');
    expect(amended?.body).toContain('Review the source notice');
  });

  test('two different amendments produce different dedup fingerprints', () => {
    const first = deriveLifecycleEvents({ ...base, current: snapshot({ fingerprint: 'fp-a' }) });
    const second = deriveLifecycleEvents({ ...base, current: snapshot({ fingerprint: 'fp-b' }) });
    expect(first.events.find((e) => e.type === 'amended')?.fingerprint).toBe('fp-a');
    expect(second.events.find((e) => e.type === 'amended')?.fingerprint).toBe('fp-b');
  });

  test('a bare deadline move is not ALSO announced as a generic amendment', () => {
    // Both facts are the same fact. deadline_changed is the actionable one.
    const emitted = types({
      ...base,
      current: snapshot({ fingerprint: 'fp-new', deadline: new Date('2026-08-25T00:00:00Z') }),
      revisionReasons: [],
    });
    expect(emitted).toContain('deadline_changed');
    expect(emitted).not.toContain('amended');
  });

  test('a deadline move WITH a named source revision reports both', () => {
    const emitted = types({
      ...base,
      current: snapshot({ fingerprint: 'fp-new', deadline: new Date('2026-08-25T00:00:00Z') }),
      revisionReasons: ['The source reports a modification on 2026-07-28.'],
    });
    expect(emitted).toContain('deadline_changed');
    expect(emitted).toContain('amended');
  });

  test('a closure is not ALSO announced as a generic amendment', () => {
    const emitted = types({
      ...base,
      current: snapshot({ fingerprint: 'fp-new', active: false, status: 'archived' }),
      revisionReasons: [],
    });
    expect(emitted).toContain('cancelled_or_closed');
    expect(emitted).not.toContain('amended');
  });
});

// ── Integration over the fake client ───────────────────────────────────────

interface FakeRow {
  id: string;
  workflowStatus: string;
  userCreated: boolean;
  sourceFingerprint: string | null;
  sourceActiveSnapshot: boolean | null;
  sourceStatusSnapshot?: string | null;
  responseDeadlineSnapshot?: Date | null;
  sourceUpdatedAtSnapshot?: Date | null;
}

function lifecycleFake(options: {
  rows: FakeRow[];
  samActive?: boolean;
  samResponseDeadline?: Date | null;
  samDescription?: string;
  existingAlert?: boolean;
}) {
  const updates: any[] = [];
  const alerts: any[] = [];
  const audits: any[] = [];
  const pages: Array<{ cursor: string | null; take: number }> = [];
  const fake: Record<string, any> = {};
  fake.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(fake);
  fake.$executeRawUnsafe = async () => 0;

  const allRows = options.rows.map((row) => ({
    tenantId: TENANT,
    clientId: CLIENT,
    source: 'sam_gov',
    grantOpportunityId: null,
    samOpportunityId: '00000000-0000-0000-0000-0000000003aa',
    sourceStatusSnapshot: 'active',
    responseDeadlineSnapshot: new Date('2026-08-20T00:00:00Z'),
    sourceUpdatedAtSnapshot: new Date('2026-07-20T00:00:00Z'),
    ...row,
  }));

  fake.clientFundingOpportunity = {
    // Honours the keyset contract: `id > cursor ORDER BY id LIMIT take`.
    findMany: async (args: any) => {
      const cursor: string | null = args?.where?.id?.gt ?? null;
      pages.push({ cursor, take: args?.take });
      return allRows
        .filter((row) => (cursor ? row.id > cursor : true))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args?.take ?? allRows.length);
    },
    update: async (args: unknown) => {
      updates.push(args);
      return args;
    },
  };
  fake.federalGrant = { findMany: async () => [] };
  fake.samOpportunity = {
    findMany: async () => [
      {
        id: '00000000-0000-0000-0000-0000000003aa',
        title: 'Autonomy solicitation',
        noticeType: 'Solicitation',
        baseType: 'Presolicitation',
        active: options.samActive ?? false,
        responseDeadline:
          options.samResponseDeadline === undefined
            ? new Date('2026-08-20T00:00:00Z')
            : options.samResponseDeadline,
        archiveDate: options.samActive === true ? new Date('2026-09-01T00:00:00Z') : now,
        postedDate: new Date('2026-07-01T00:00:00Z'),
        setAside: null,
        setAsideCode: null,
        naicsCode: '541715',
        pscCode: 'AC12',
        agency: 'DEPT OF THE NAVY',
        office: 'NAVAIR',
        solicitationNumber: 'N0001926R0001',
        description: options.samDescription ?? 'Original scope.',
      },
    ],
  };
  fake.clioProactiveAlert = {
    findFirst: async () => (options.existingAlert ? { id: 'alert-1' } : null),
    create: async (args: any) => {
      alerts.push(args);
      return args;
    },
  };
  fake.auditLog = {
    create: async (args: any) => {
      audits.push(args);
      return args;
    },
  };
  return { fake, updates, alerts, audits, pages };
}

function row(overrides: Partial<FakeRow> & { id: string }): FakeRow {
  return {
    workflowStatus: 'saved',
    userCreated: true,
    sourceFingerprint: 'fp-previous',
    sourceActiveSnapshot: true,
    ...overrides,
  };
}

const run = (fake: unknown, commit = true) =>
  processLifecycle(asPrisma(fake), { tenantIds: [TENANT], commit, now });

describe('processLifecycle', () => {
  test('machine suggestions become expired when the source closes', async () => {
    const { fake, updates } = lifecycleFake({
      rows: [row({ id: 'wf-1', workflowStatus: 'suggested', userCreated: false })],
    });
    const result = await run(fake);
    expect(result.expired).toBe(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({ data: expect.objectContaining({ workflowStatus: 'expired' }) }),
    );
  });

  test('machine suggestions expire SILENTLY — no alert, but an audit record', async () => {
    const { fake, alerts, audits } = lifecycleFake({
      rows: [row({ id: 'wf-1', workflowStatus: 'suggested', userCreated: false })],
    });
    const result = await run(fake);
    expect(result.alerts).toBe(0);
    expect(alerts).toHaveLength(0);
    // Silent to the USER, never silent to the audit log: a suggestion vanishing
    // without a trace is indistinguishable from a bug.
    expect(audits).toHaveLength(1);
    expect(audits[0].data.action).toBe('funding_opportunity.lifecycle.expired');
    expect(audits[0].data.after.reason).toBe('source_no_longer_active');
  });

  test.each(['saved', 'pursuing'])('%s decisions are preserved when the source closes', async (status) => {
    const { fake, updates } = lifecycleFake({
      rows: [row({ id: 'wf-1', workflowStatus: status, userCreated: true })],
    });
    const result = await run(fake);
    expect(result.expired).toBe(0);
    expect(updates[0]).toEqual(
      expect.objectContaining({ data: expect.not.objectContaining({ workflowStatus: 'expired' }) }),
    );
  });

  test('a human-created row is never expired by the machine, whatever its status', async () => {
    const { fake } = lifecycleFake({
      rows: [row({ id: 'wf-1', workflowStatus: 'suggested', userCreated: true })],
    });
    expect((await run(fake)).expired).toBe(0);
  });

  test('alert fingerprints make lifecycle notifications idempotent', async () => {
    const { fake, alerts } = lifecycleFake({
      rows: [row({ id: 'wf-1' })],
      existingAlert: true,
    });
    const result = await run(fake);
    expect(result.alerts).toBe(0);
    expect(alerts).toHaveLength(0);
  });

  test('every alert is accompanied by an audit record in the same transaction', async () => {
    const { fake, alerts, audits } = lifecycleFake({ rows: [row({ id: 'wf-1' })] });
    await run(fake);
    expect(alerts.length).toBeGreaterThan(0);
    const lifecycleAudits = audits.filter((a) =>
      String(a.data.action).startsWith('funding_opportunity.lifecycle.'),
    );
    expect(lifecycleAudits.length).toBe(alerts.length);
    expect(lifecycleAudits[0].data.entityType).toBe('client_funding_opportunity');
    expect(lifecycleAudits[0].data.actorRole).toBe('system');
  });

  test('an ordinary re-sync of an UNCHANGED notice creates NO alert at all', async () => {
    // The end-to-end form of the anti-spam guarantee, and the test that caught the
    // reconstruction defect: an earlier draft rebuilt the previous source facts
    // from the four snapshot columns and diffed them field-by-field, so every
    // unstored field (noticeType, naicsCode, description, …) compared null
    // against a real value and reported "changed" on EVERY run forever.
    //
    // Pass 1 baselines. Pass 2 replays the identical notice with pass 1's own
    // fingerprint stored, which is what a nightly re-sync of an unchanged notice
    // looks like — a real one would also have moved updatedAt and lastSyncedAt,
    // neither of which is a fingerprint input.
    const first = lifecycleFake({
      rows: [row({ id: 'wf-1', sourceFingerprint: null, sourceActiveSnapshot: null })],
      samActive: true,
    });
    await run(first.fake);
    const written = first.updates[0].data.sourceFingerprint as string;
    const activeWritten = first.updates[0].data.sourceActiveSnapshot as boolean;
    const statusWritten = first.updates[0].data.sourceStatusSnapshot as string;
    const deadlineWritten = first.updates[0].data.responseDeadlineSnapshot as Date;
    expect(written).toBeTruthy();
    expect(first.alerts).toHaveLength(0);

    const second = lifecycleFake({
      rows: [
        row({
          id: 'wf-1',
          sourceFingerprint: written,
          sourceActiveSnapshot: activeWritten,
          sourceStatusSnapshot: statusWritten,
          responseDeadlineSnapshot: deadlineWritten,
        }),
      ],
      samActive: true,
    });
    const result = await run(second.fake);
    expect(second.alerts).toHaveLength(0);
    expect(result.alerts).toBe(0);
  });

  test('a THIRD identical pass is still silent — the pass is idempotent', async () => {
    // Guards the specific failure mode of a per-run drift: an alert that appears
    // every night is worse than one that never appears, because it trains users
    // to ignore the channel.
    let rows = [row({ id: 'wf-1', sourceFingerprint: null, sourceActiveSnapshot: null })];
    let totalAlerts = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      const fixture = lifecycleFake({ rows, samActive: true });
      await run(fixture.fake);
      totalAlerts += fixture.alerts.length;
      const data = fixture.updates[0].data;
      rows = [
        row({
          id: 'wf-1',
          sourceFingerprint: data.sourceFingerprint,
          sourceActiveSnapshot: data.sourceActiveSnapshot,
          sourceStatusSnapshot: data.sourceStatusSnapshot,
          responseDeadlineSnapshot: data.responseDeadlineSnapshot,
        }),
      ];
    }
    expect(totalAlerts).toBe(0);
  });

  test('a rewritten statement of work IS reported, even though no column names it', async () => {
    const first = lifecycleFake({
      rows: [row({ id: 'wf-1', sourceFingerprint: null, sourceActiveSnapshot: null })],
      samActive: true,
      samDescription: 'Original scope.',
    });
    await run(first.fake);
    const data = first.updates[0].data;

    const second = lifecycleFake({
      rows: [
        row({
          id: 'wf-1',
          sourceFingerprint: data.sourceFingerprint,
          sourceActiveSnapshot: data.sourceActiveSnapshot,
          sourceStatusSnapshot: data.sourceStatusSnapshot,
          responseDeadlineSnapshot: data.responseDeadlineSnapshot,
        }),
      ],
      samActive: true,
      samDescription: 'Wholly different scope of work.',
    });
    await run(second.fake);
    expect(second.alerts.map((a) => a.data.metadata.eventType)).toEqual(['amended']);
  });

  test('a materially changed notice DOES alert', async () => {
    const { fake, alerts } = lifecycleFake({
      rows: [row({ id: 'wf-1', sourceActiveSnapshot: true })],
      samActive: true,
      // A moved response deadline relative to the stored snapshot.
      samResponseDeadline: new Date('2026-09-30T00:00:00Z'),
    });
    await run(fake);
    expect(alerts.map((a) => a.data.metadata.eventType)).toContain('deadline_changed');
  });

  test('a dry run writes nothing', async () => {
    const { fake, updates, alerts, audits } = lifecycleFake({ rows: [row({ id: 'wf-1' })] });
    const result = await run(fake, false);
    expect(updates).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(audits).toHaveLength(0);
    // …but still reports what a commit WOULD create.
    expect(result.alerts).toBeGreaterThan(0);
  });

  test('a dry run does not double-count alerts that already exist', async () => {
    const { fake } = lifecycleFake({ rows: [row({ id: 'wf-1' })], existingAlert: true });
    expect((await run(fake, false)).alerts).toBe(0);
  });

  test('the baseline pass reports what it baselined', async () => {
    const { fake, alerts } = lifecycleFake({
      rows: [row({ id: 'wf-1', sourceFingerprint: null, sourceActiveSnapshot: null })],
    });
    const result = await run(fake);
    expect(result.baselined).toBe(1);
    expect(alerts).toHaveLength(0);
  });
});

describe('coverage is keyset-paginated, not capped', () => {
  test('all rows are visited across multiple pages', async () => {
    // 1,200 rows against a 500-row page size. The old implementation took ONE
    // `take: 5000` window per tenant and, on filling it, incremented the run's
    // ERROR COUNT — so past the cap the pass was silently partial.
    const rows = Array.from({ length: 1_200 }, (_, index) =>
      row({ id: `wf-${String(index).padStart(5, '0')}`, workflowStatus: 'suggested', userCreated: false }),
    );
    const { fake, pages } = lifecycleFake({ rows });
    const result = await run(fake);

    expect(result.evaluated).toBe(1_200);
    expect(result.expired).toBe(1_200);
    expect(result.errors).toBe(0);
    // 500 + 500 + 200 → the third page short-circuits the loop.
    expect(pages.map((page) => page.take)).toEqual([500, 500, 500]);
    expect(pages[0]!.cursor).toBeNull();
    expect(pages[1]!.cursor).toBe('wf-00499');
    expect(pages[2]!.cursor).toBe('wf-00999');
  });

  test('a page-sized total still terminates', async () => {
    // Exactly PAGE_SIZE rows: the loop must ask once more and stop on the empty
    // page rather than spinning on the same cursor.
    const rows = Array.from({ length: 500 }, (_, index) =>
      row({ id: `wf-${String(index).padStart(5, '0')}` }),
    );
    const { fake, pages } = lifecycleFake({ rows });
    const result = await run(fake);
    expect(result.evaluated).toBe(500);
    expect(pages).toHaveLength(2);
  });

  test('an empty tenant does one query and stops', async () => {
    const { fake, pages } = lifecycleFake({ rows: [] });
    const result = await run(fake);
    expect(result.evaluated).toBe(0);
    expect(pages).toHaveLength(1);
  });

  test('a missing source record is an error, not a silent expiry', async () => {
    const { fake } = lifecycleFake({ rows: [row({ id: 'wf-1' })] });
    fake.samOpportunity = { findMany: async () => [] };
    const result = await run(fake);
    expect(result.errors).toBe(1);
    expect(result.expired).toBe(0);
  });
});
