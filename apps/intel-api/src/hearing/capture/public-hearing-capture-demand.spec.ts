import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES,
  PublicHearingCaptureStore,
} from './public-hearing-capture.store.js';

/**
 * Native PostgreSQL regression for the two demand/source mapping defects
 * proven by .orchestration/legiwatch-v4/federal-capture-demand-native.json:
 *   1. browser-only attendance must NOT count as server automatic demand
 *      (mixed automatic+browser counts only the automatic row);
 *   2. the official Senate types `Open Hearing` / `Open Business Meeting`
 *      must be due-scan eligible while closed/executive, private, canceled
 *      and unknown types stay excluded.
 *
 * Behavior over SQL strings: real rows are inserted through the same shapes
 * the shipped writers use (Wave 1 browser INSERT: attendance_mode='browser',
 * scheduled_by_user=false; Phase 7 automatic INSERT: 'automatic' +
 * scheduled_by_user=true; rule rows keep scheduled_by_rule_id after
 * cancelSchedule clears scheduled_by_user), then the store's actual
 * getDemand/listDueHearingIds run against the isolated disposable database.
 * Random tenant/users are seeded first (the hearing-state-audio-postgres
 * pattern) and removed child-rows-first in afterAll; the canonical
 * Judiciary338740 QA hearing is never touched. captureAll env is restored to
 * its prior value rather than deleted globally.
 */

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);

const TENANT = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const RULE = randomUUID();
const PREFIX = `lw-demand-${randomUUID().slice(0, 8)}`;

interface CaseDef {
  key: string;
  type: string;
  visibility?: string;
  eventStatus?: string;
  subs: Array<{ user: string; mode: string; byUser: boolean; byRule: string | null }>;
  expectedDemand: number;
  expectedDue: boolean;
}

const CASES: CaseDef[] = [
  {
    key: 'browser-only',
    type: 'hearing',
    subs: [{ user: USER_A, mode: 'browser', byUser: false, byRule: null }],
    expectedDemand: 0,
    expectedDue: false,
  },
  {
    key: 'automatic-user',
    type: 'hearing',
    subs: [{ user: USER_A, mode: 'automatic', byUser: true, byRule: null }],
    expectedDemand: 1,
    expectedDue: true,
  },
  {
    key: 'automatic-rule',
    type: 'hearing',
    subs: [{ user: USER_A, mode: 'automatic', byUser: false, byRule: RULE }],
    expectedDemand: 1,
    expectedDue: true,
  },
  {
    // Phase 7 cancelSchedule semantics: user flag cleared, rule survives.
    key: 'rule-after-manual-cancel',
    type: 'hearing',
    subs: [{ user: USER_A, mode: 'automatic', byUser: false, byRule: RULE }],
    expectedDemand: 1,
    expectedDue: true,
  },
  {
    key: 'notification-only',
    type: 'hearing',
    subs: [{ user: USER_A, mode: 'automatic', byUser: false, byRule: null }],
    expectedDemand: 0,
    expectedDue: false,
  },
  {
    key: 'mixed-browser-automatic',
    type: 'hearing',
    subs: [
      { user: USER_A, mode: 'automatic', byUser: true, byRule: null },
      { user: USER_B, mode: 'browser', byUser: false, byRule: null },
    ],
    expectedDemand: 1,
    expectedDue: true,
  },
  {
    key: 'official-open-hearing',
    type: 'Open Hearing',
    subs: [{ user: USER_A, mode: 'automatic', byUser: true, byRule: null }],
    expectedDemand: 1,
    expectedDue: true,
  },
  {
    key: 'official-open-business-meeting',
    type: 'Open Business Meeting',
    subs: [{ user: USER_A, mode: 'automatic', byUser: true, byRule: null }],
    expectedDemand: 1,
    expectedDue: true,
  },
  {
    key: 'closed-hearing',
    type: 'Closed Hearing',
    subs: [{ user: USER_A, mode: 'automatic', byUser: true, byRule: null }],
    expectedDemand: 1,
    expectedDue: false,
  },
  {
    key: 'executive-session',
    type: 'Executive Session',
    subs: [{ user: USER_A, mode: 'automatic', byUser: true, byRule: null }],
    expectedDemand: 1,
    expectedDue: false,
  },
  {
    key: 'unknown-type',
    type: 'Listening Session',
    subs: [{ user: USER_A, mode: 'automatic', byUser: true, byRule: null }],
    expectedDemand: 1,
    expectedDue: false,
  },
  {
    // The scan's demand branch intentionally does NOT filter visibility; a
    // private hearing with real automatic demand is refused at the
    // assertCaptureAllowed boundary instead (asserted separately below).
    key: 'private-open-hearing',
    type: 'Open Hearing',
    visibility: 'private',
    subs: [{ user: USER_A, mode: 'automatic', byUser: true, byRule: null }],
    expectedDemand: 1,
    expectedDue: true,
  },
  {
    key: 'canceled-open-hearing',
    type: 'Open Hearing',
    eventStatus: 'canceled',
    subs: [{ user: USER_A, mode: 'automatic', byUser: true, byRule: null }],
    expectedDemand: 1,
    expectedDue: false,
  },
];

describeDb('PublicHearingCaptureStore automatic demand on PostgreSQL (hearing-demand-08)', () => {
  const prisma = new PrismaService();
  const hearingId = (key: string) => `${PREFIX}-${key}`;
  let store: PublicHearingCaptureStore;
  const priorCaptureAll = process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS;

  beforeAll(async () => {
    // captureAll stays off for this suite; restored in afterAll (the store
    // reads the flag at construction, so build it after the env settles).
    delete process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS;
    store = new PublicHearingCaptureStore(prisma);
    await prisma.withSystem(async (tx) => {
      // Seed the random parents the subscription rows reference
      // (hearing-state-audio-postgres.spec.ts pattern).
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants(id, slug, name) VALUES ($1::uuid, $2, 'Demand contract fixture')`,
        TENANT,
        `lw-demand-${TENANT}`,
      );
      for (const user of [USER_A, USER_B]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO users(id, clerk_user_id, email)
           VALUES ($1::uuid, $2, $3)`,
          user,
          `lw-demand-${user}`,
          `lw-demand-${user}@example.invalid`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO tenant_memberships(tenant_id, user_id, role, status)
           VALUES ($1::uuid, $2::uuid, 'standard_user', 'active')`,
          TENANT,
          user,
        );
      }
      for (const c of CASES) {
        await tx.$executeRawUnsafe(
          `INSERT INTO committee_hearing
             (id, chamber, committee_name, title, date, starts_at, type, url,
              visibility, event_status)
           VALUES ($1, 'senate', 'Synthetic demand QA', 'Demand contract case',
                   CURRENT_DATE, now() + interval '2 hours', $2,
                   'https://example.invalid/' || $1, $3, $4)`,
          hearingId(c.key),
          c.type,
          c.visibility ?? 'public',
          c.eventStatus ?? 'scheduled',
        );
        for (const sub of c.subs) {
          await tx.$executeRawUnsafe(
            `INSERT INTO hearing_subscription
               (tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
                scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
                attendance_mode, consent_acknowledged_at, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3, true, false, $4, $5::uuid, ARRAY[]::text[],
                     NULL, $6, now(), now(), now())`,
            TENANT,
            sub.user,
            hearingId(c.key),
            sub.byUser,
            sub.byRule,
            sub.mode,
          );
        }
      }
    });
  });

  afterAll(async () => {
    // Child rows before parents; only rows under the random prefix/tenant are
    // removed — existing real QA fixtures (Judiciary338740) are preserved.
    await prisma.withSystem(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM hearing_subscription WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenant_memberships WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE id = ANY(ARRAY[$1::uuid, $2::uuid])`,
        USER_A,
        USER_B,
      );
      await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM committee_hearing WHERE id LIKE '${PREFIX}-%'`,
      );
    });
    await prisma.$disconnect();
    if (priorCaptureAll === undefined) delete process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS;
    else process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS = priorCaptureAll;
  });

  it.each(CASES.map((c) => [c.key, c] as const))(
    '%s: getDemand counts only automatic+scheduled rows and due scan agrees',
    async (_key, c) => {
      const demand = await store.getDemand(hearingId(c.key));
      expect(demand.activeSubscriptionCount).toBe(c.expectedDemand);
      expect(demand.globalCoverageRequested).toBe(false);
      const due = await store.listDueHearingIds(new Date());
      expect(due.includes(hearingId(c.key))).toBe(c.expectedDue);
    },
  );

  it('private/canceled hearings are refused at the capture boundary, not only the scan', async () => {
    // The private and canceled open-hearing cases carry real automatic
    // demand; the due scan alone would not stop a direct worker invocation,
    // so assertCaptureAllowed must refuse them through the existing
    // permission boundary while the eligible official type passes.
    await expect(
      store.assertCaptureAllowed(hearingId('private-open-hearing')),
    ).rejects.toThrow();
    await expect(
      store.assertCaptureAllowed(hearingId('canceled-open-hearing')),
    ).rejects.toThrow();
    await expect(
      store.assertCaptureAllowed(hearingId('official-open-hearing')),
    ).resolves.toBeUndefined();
  });
});

describe('ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES', () => {
  it('keeps the official Senate parser types and pre-existing generics; closed/unknown stay out', () => {
    for (const t of [
      'open hearing',
      'open business meeting',
      'hearing',
      'markup',
      'meeting',
      'business meeting',
      'roundtable',
      'forum',
    ])
      expect(ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES).toContain(t);
    for (const t of ['closed hearing', 'executive session', 'listening session'])
      expect(ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES).not.toContain(t);
  });
});
