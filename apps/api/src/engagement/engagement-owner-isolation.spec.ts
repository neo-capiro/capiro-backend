// Engagement trust-boundary remediation (plan §3, Phase a) — parent
// OutreachRecord drafts are tenant-scoped but not owner-scoped.
// PrismaService.withTenant() injects a tenant predicate only, and the runtime
// application role bypasses RLS, so before this phase any same-tenant caller
// who had (or guessed) a draft's id could read, edit, regenerate, delete,
// restore, or legacy-send a colleague's private outreach draft. Every read and
// mutation below now also requires createdByUserId to match the caller, and a
// foreign or legacy (createdByUserId=null) record must return the SAME 404 as
// a nonexistent one — existence is never disclosed.

import { describe, expect, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';
import { OutreachSendIntentService } from './outreach-send-intent.service.js';

const userA: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'user-a',
  clerkUserId: 'clerk-a',
  role: 'standard_user',
} as TenantContext;
const userB: TenantContext = {
  ...userA,
  userId: 'user-b',
  clerkUserId: 'clerk-b',
} as TenantContext;
const userOtherTenant: TenantContext = {
  ...userA,
  tenantId: 't2',
  userId: 'user-c',
  clerkUserId: 'clerk-c',
} as TenantContext;

const RECORD_ID = '11111111-1111-4111-8111-111111111111';

/** A draft OutreachRecord owned by user-a, in tenant t1. */
function baseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECORD_ID,
    tenantId: 't1',
    createdByUserId: 'user-a',
    clientId: null,
    meetingId: null,
    type: 'follow_up',
    status: 'draft',
    title: 'Draft to Rep. Smith',
    subject: 'Subject',
    body: 'Body',
    recipients: [] as unknown[],
    recipientCount: 0,
    stats: {},
    metadata: {},
    lastStep: 1,
    sentAt: null,
    openedInEmailAt: null,
    deletedAt: null,
    deletedByUserId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Faithful-enough Prisma `where` matcher for the predicate shapes these
 * methods actually issue against a single in-memory row: plain equality, and
 * `{ not: value }`. A predicate naming a field the row doesn't satisfy matches
 * nothing — exactly like a real `createdByUserId` column comparison.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      'not' in (value as Record<string, unknown>)
    ) {
      if (row[key] === (value as { not: unknown }).not) return false;
    } else if (row[key] !== value) {
      return false;
    }
  }
  return true;
}

interface OwnerHarness {
  service: EngagementService;
  records: Array<Record<string, unknown>>;
  findFirstWheres: Array<Record<string, unknown>>;
  findManyWheres: Array<Record<string, unknown>>;
}

function makeOwnerHarness(records: Array<Record<string, unknown>>): OwnerHarness {
  const state = records.map((r) => ({ ...r }));
  const findFirstWheres: Array<Record<string, unknown>> = [];
  const findManyWheres: Array<Record<string, unknown>> = [];

  const tx = {
    outreachRecord: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        findFirstWheres.push(where);
        return state.find((r) => matchesWhere(r, where)) ?? null;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        findManyWheres.push(where);
        return state.filter((r) => matchesWhere(r, where));
      },
      update: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = state.find((r) => r.id === where.id);
        if (!row) throw new Error('test setup bug: update() target row missing');
        Object.assign(row, data);
        return { ...row };
      },
    },
  };

  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.versionedOutreach = false;
  patch.prisma = { withTenant: (_t: string, fn: (t: unknown) => unknown) => fn(tx) };

  return { service, records: state, findFirstWheres, findManyWheres };
}

// ── listOutreachRecords ──────────────────────────────────────────────────────

describe('listOutreachRecords owner isolation (§3.a2)', () => {
  test('the owner sees their own draft', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    const rows = await h.service.listOutreachRecords(userA, {});
    expect(rows).toHaveLength(1);
  });

  test('another same-tenant user does NOT see it', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    const rows = await h.service.listOutreachRecords(userB, {});
    expect(rows).toHaveLength(0);
  });

  test('the query always carries a createdByUserId predicate alongside tenantId', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    await h.service.listOutreachRecords(userA, {});
    expect(h.findManyWheres[0]).toMatchObject({ createdByUserId: 'user-a', tenantId: 't1' });
  });
});

// ── getOutreachRecord ────────────────────────────────────────────────────────

describe('getOutreachRecord owner isolation (§3.a3)', () => {
  test('the owner can read their own draft', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    const row = await h.service.getOutreachRecord(userA, RECORD_ID);
    expect(row.id).toBe(RECORD_ID);
  });

  test('another same-tenant user gets a 404, not the draft', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    await expect(h.service.getOutreachRecord(userB, RECORD_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('a foreign id and a nonexistent id produce the IDENTICAL 404 (no existence disclosure)', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    const foreign = await h.service
      .getOutreachRecord(userB, RECORD_ID)
      .catch((e: NotFoundException) => e.message);
    const missing = await h.service
      .getOutreachRecord(userA, '22222222-2222-4222-8222-222222222222')
      .catch((e: NotFoundException) => e.message);
    expect(foreign).toBe(missing);
  });

  test('a legacy ownerless record (createdByUserId=null) is not readable by ANY standard user', async () => {
    const h = makeOwnerHarness([baseRecord({ createdByUserId: null })]);
    await expect(h.service.getOutreachRecord(userA, RECORD_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(h.service.getOutreachRecord(userB, RECORD_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('a caller from a DIFFERENT TENANT gets the same 404 as a same-tenant stranger', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    const crossTenant = await h.service
      .getOutreachRecord(userOtherTenant, RECORD_ID)
      .catch((e: NotFoundException) => e.message);
    const crossUser = await h.service
      .getOutreachRecord(userB, RECORD_ID)
      .catch((e: NotFoundException) => e.message);
    expect(crossTenant).toBe(crossUser);
  });
});

// ── updateOutreachRecord ─────────────────────────────────────────────────────

describe('updateOutreachRecord owner isolation (§3.a4)', () => {
  test('the owner can update their own draft', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    const updated = await h.service.updateOutreachRecord(userA, RECORD_ID, { title: 'New title' });
    expect(updated.title).toBe('New title');
  });

  test('another same-tenant user CANNOT update it, and nothing is written', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    await expect(
      h.service.updateOutreachRecord(userB, RECORD_ID, { title: 'Hijacked' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.records[0]!.title).toBe('Draft to Rep. Smith');
  });
});

// ── deleteOutreachRecord / restoreOutreachRecord ─────────────────────────────

describe('deleteOutreachRecord owner isolation (§3.a4)', () => {
  test('the owner can delete their own draft', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    const deleted = await h.service.deleteOutreachRecord(userA, RECORD_ID);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
  });

  test('another same-tenant user CANNOT delete it', async () => {
    const h = makeOwnerHarness([baseRecord()]);
    await expect(h.service.deleteOutreachRecord(userB, RECORD_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.records[0]!.deletedAt).toBeNull();
  });
});

describe('restoreOutreachRecord owner isolation (§3.a4)', () => {
  function deletedRecord() {
    return baseRecord({ deletedAt: new Date('2026-01-02T00:00:00Z'), deletedByUserId: 'user-a' });
  }

  test('the owner can restore their own soft-deleted draft', async () => {
    const h = makeOwnerHarness([deletedRecord()]);
    const restored = await h.service.restoreOutreachRecord(userA, RECORD_ID);
    expect(restored.deletedAt).toBeNull();
  });

  test('another same-tenant user CANNOT restore it', async () => {
    const h = makeOwnerHarness([deletedRecord()]);
    await expect(h.service.restoreOutreachRecord(userB, RECORD_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.records[0]!.deletedAt).not.toBeNull();
  });
});

// ── generateOutreachDraft / openOutreachInConnectedEmail / sendCampaign ──────
//
// All three delegate their FIRST read to the now owner-scoped
// getOutreachRecord(). Rather than re-simulate the entire downstream
// generation/connection/send pipeline, the very next collaborator each method
// calls is stubbed to throw a distinctive sentinel: reaching it proves
// ownership let a legitimate owner proceed; a NotFoundException WITHOUT that
// sentinel proves a foreign caller was refused BEFORE that collaborator — i.e.
// before any AI or provider work — mirroring the ordering proof in
// engagement-legacy-send-gate.spec.ts.

describe('generateOutreachDraft owner isolation (§3.a4)', () => {
  function harness() {
    const h = makeOwnerHarness([baseRecord()]);
    const patch = h.service as unknown as Record<string, unknown>;
    patch.outreachContext = async () => {
      throw new Error('REACHED outreachContext');
    };
    return h;
  }

  test('the owner proceeds past the ownership gate into generation', async () => {
    const h = harness();
    const caught = await h.service
      .generateOutreachDraft(userA, RECORD_ID, {})
      .catch((e: unknown) => e);
    expect((caught as Error).message).toBe('REACHED outreachContext');
  });

  test('another same-tenant user is refused BEFORE generation, with no AI spend', async () => {
    const h = harness();
    const caught = await h.service
      .generateOutreachDraft(userB, RECORD_ID, {})
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(NotFoundException);
  });
});

describe('openOutreachInConnectedEmail owner isolation (§3.a4)', () => {
  function harness() {
    const h = makeOwnerHarness([baseRecord()]);
    const patch = h.service as unknown as Record<string, unknown>;
    patch.hasConnectedInbox = async () => {
      throw new Error('REACHED hasConnectedInbox');
    };
    return h;
  }

  test('the owner proceeds past the ownership gate', async () => {
    const h = harness();
    const caught = await h.service
      .openOutreachInConnectedEmail(userA, RECORD_ID)
      .catch((e: unknown) => e);
    expect((caught as Error).message).toBe('REACHED hasConnectedInbox');
  });

  test('another same-tenant user is refused first, before any connection check', async () => {
    const h = harness();
    const caught = await h.service
      .openOutreachInConnectedEmail(userB, RECORD_ID)
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(NotFoundException);
  });
});

describe('sendCampaign (legacy send) owner isolation (§3.a4)', () => {
  function harness() {
    const record = baseRecord({
      type: 'campaign',
      recipients: [{ email: 'target@house.gov', name: 'Target' }],
    });
    const h = makeOwnerHarness([record]);
    const patch = h.service as unknown as Record<string, unknown>;
    patch.findCampaignSendConnection = async () => {
      throw new Error('REACHED findCampaignSendConnection');
    };
    return h;
  }

  test('the owner proceeds past the ownership gate toward sending', async () => {
    const h = harness();
    const caught = await h.service.sendCampaign(userA, RECORD_ID).catch((e: unknown) => e);
    expect((caught as Error).message).toBe('REACHED findCampaignSendConnection');
  });

  test('another same-tenant user is refused BEFORE any send-connection lookup', async () => {
    const h = harness();
    const caught = await h.service.sendCampaign(userB, RECORD_ID).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(NotFoundException);
  });
});

// ── OutreachSendIntentService.rollUpIntent — worker summary isolation (§3.a5) ─
//
// rollUpIntent runs with no caller ctx (it's driven by delivery outcomes, not a
// request), so it cannot rely on withTenant()'s predicate. It must instead
// carry the intent's OWN userId into the OutreachRecord summary update, so a
// send outcome can never mutate a campaign that isn't (or is no longer) that
// user's own draft.

interface RollupHarness {
  service: OutreachSendIntentService;
  recordUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  warnings: string[];
}

function makeRollupHarness(opts: {
  recordOwner: string;
  intentUserId: string;
  testMode?: boolean;
}): RollupHarness {
  const recordUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> =
    [];
  const warnings: string[] = [];

  const tx = {
    outreachSendIntent: {
      findFirst: async () => ({
        id: 'intent-1',
        status: 'running',
        outreachRecordId: 'rec-1',
        tenantId: 't1',
        userId: opts.intentUserId,
        testMode: opts.testMode ?? false,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    outreachDelivery: {
      findMany: async () => [{ status: 'sent' }],
    },
    outreachRecord: {
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        recordUpdates.push({ where, data });
        // Faithful to Prisma: a where naming a different createdByUserId
        // matches zero rows rather than mutating the wrong campaign.
        const matches =
          where.id === 'rec-1' &&
          where.tenantId === 't1' &&
          where.createdByUserId === opts.recordOwner;
        return { count: matches ? 1 : 0 };
      },
    },
  };

  const service = Object.create(OutreachSendIntentService.prototype) as OutreachSendIntentService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = {
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
    log: () => {},
  };
  patch.prisma = { withSystem: (fn: (t: unknown) => unknown) => fn(tx) };

  return { service, recordUpdates, warnings };
}

describe('rollUpIntent worker summary isolation (§3.a5)', () => {
  test('a matching owner: the summary update carries createdByUserId and succeeds silently', async () => {
    const h = makeRollupHarness({ recordOwner: 'user-a', intentUserId: 'user-a' });
    await (h.service as unknown as { rollUpIntent(id: string): Promise<void> }).rollUpIntent(
      'intent-1',
    );
    expect(h.recordUpdates).toHaveLength(1);
    expect(h.recordUpdates[0]!.where).toMatchObject({ createdByUserId: 'user-a' });
    expect(h.warnings).toHaveLength(0);
  });

  test('a mismatched owner: the update matches zero rows and is logged by id, not silently dropped', async () => {
    const h = makeRollupHarness({ recordOwner: 'someone-else', intentUserId: 'user-a' });
    await (h.service as unknown as { rollUpIntent(id: string): Promise<void> }).rollUpIntent(
      'intent-1',
    );
    expect(h.recordUpdates[0]!.where).toMatchObject({ createdByUserId: 'user-a' });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/intent-1/);
    expect(h.warnings[0]).toMatch(/rec-1/);
  });

  test('test-mode intents never touch the OutreachRecord summary at all', async () => {
    const h = makeRollupHarness({ recordOwner: 'user-a', intentUserId: 'user-a', testMode: true });
    await (h.service as unknown as { rollUpIntent(id: string): Promise<void> }).rollUpIntent(
      'intent-1',
    );
    expect(h.recordUpdates).toHaveLength(0);
  });
});
