import type { TenantContext } from '@capiro/shared';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachUserDecisionEventService } from './outreach-user-decision-event.service.js';

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    sequence: BigInt(8),
    eventType: 'approach_approved',
    actorUserId: CTX.userId,
    source: 'user_control',
    stateVersionBefore: 7,
    stateVersionAfter: 7,
    commandBatchId: null,
    commandType: null,
    payloadHash: 'payload-hash',
    safeMetadataJsonb: { approval: { approvalHash: 'payload-hash' } },
    createdAt: new Date('2026-08-11T00:00:00.000Z'),
    ...overrides,
  };
}

function harness(
  options: {
    session?: { status: string; currentStateVersion: number };
    existing?: ReturnType<typeof event> | null;
    latest?: ReturnType<typeof event> | null;
  } = {},
) {
  const session = options.session ?? { status: 'active', currentStateVersion: 7 };
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce(options.existing ? [options.existing] : [])
      .mockResolvedValueOnce(options.latest ? [options.latest] : []),
  };
  const prisma = {
    withTenantUser: jest
      .fn()
      .mockImplementation(
        async (_tenantId: string, _userId: string, fn: (value: any) => unknown) => fn(tx),
      ),
    withTenant: jest
      .fn()
      .mockImplementation(async (_tenantId: string, fn: (value: any) => unknown) => fn(tx)),
  };
  const appended = event();
  const state = {
    lockOwnedSession: jest.fn().mockResolvedValue(session),
    getOwnedSession: jest.fn().mockResolvedValue(session),
    appendEvent: jest.fn().mockResolvedValue(appended),
  };
  const service = new OutreachUserDecisionEventService(prisma as any, state as any);
  return { service, prisma, state, tx, appended };
}

describe('Outreach V3 bounded human decision event seam', () => {
  it('appends a decision at the exact current state version without changing Campaign Spec state', async () => {
    const h = harness();
    const result = await h.service.append(CTX, SESSION_ID, {
      eventType: 'approach_approved',
      expectedStateVersion: 7,
      payloadHash: 'payload-hash',
      safeMetadata: { schemaVersion: 'outreach_v3_approach_gate_v1' },
    });

    expect(result.idempotent).toBe(false);
    expect(h.state.lockOwnedSession).toHaveBeenCalledWith(h.tx, CTX, SESSION_ID);
    expect(h.state.appendEvent).toHaveBeenCalledWith(
      h.tx,
      CTX,
      expect.objectContaining({ currentStateVersion: 7 }),
      expect.objectContaining({
        eventType: 'approach_approved',
        source: 'user_control',
        stateVersionBefore: 7,
        stateVersionAfter: 7,
        payloadHash: 'payload-hash',
      }),
    );
  });

  it('returns the existing same-hash decision idempotently instead of appending twice', async () => {
    const existing = event({ id: '55555555-5555-4555-8555-555555555555' });
    const h = harness({ existing });
    const result = await h.service.append(CTX, SESSION_ID, {
      eventType: 'approach_approved',
      expectedStateVersion: 7,
      payloadHash: 'payload-hash',
      safeMetadata: { approval: true },
    });

    expect(result).toEqual({ event: existing, idempotent: true });
    expect(h.state.appendEvent).not.toHaveBeenCalled();
  });

  it('fails before the idempotency query if Campaign Spec state advanced', async () => {
    const h = harness({ session: { status: 'active', currentStateVersion: 8 } });
    let thrown: OutreachCommandError | null = null;
    try {
      await h.service.append(CTX, SESSION_ID, {
        eventType: 'approach_approved',
        expectedStateVersion: 7,
        payloadHash: 'payload-hash',
        safeMetadata: {},
      });
    } catch (error) {
      thrown = error as OutreachCommandError;
    }
    expect(thrown?.code).toBe('OUTREACH_STATE_CONFLICT');
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
    expect(h.state.appendEvent).not.toHaveBeenCalled();
  });

  it('fails closed for archived sessions', async () => {
    const h = harness({ session: { status: 'archived', currentStateVersion: 7 } });
    await expect(
      h.service.append(CTX, SESSION_ID, {
        eventType: 'draft_version_approved',
        expectedStateVersion: 7,
        payloadHash: 'payload-hash',
        safeMetadata: {},
      }),
    ).rejects.toMatchObject({ code: 'OUTREACH_SESSION_ARCHIVED' });
    expect(h.state.appendEvent).not.toHaveBeenCalled();
  });

  it('reads only the requested latest human decision after owner authorization', async () => {
    const latest = event({ eventType: 'draft_version_approved' });
    const h = harness({ latest });
    // latest() issues exactly one query. mockResolvedValueOnce APPENDS, so
    // queueing another row here would still leave the harness's first
    // (append-oriented) slot to be consumed first and latest() would read [].
    // Reset the queue so the row under test is the one it actually reads.
    h.tx.$queryRaw.mockReset();
    h.tx.$queryRaw.mockResolvedValueOnce([latest]);
    const result = await h.service.latest(CTX, SESSION_ID, 'draft_version_approved');
    expect(h.state.getOwnedSession).toHaveBeenCalledWith(h.tx, CTX, SESSION_ID);
    expect(result).toEqual(latest);
  });
});
