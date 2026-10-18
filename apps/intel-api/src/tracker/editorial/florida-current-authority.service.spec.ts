import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { phase8Scope, type Phase8EvidenceService } from './evidence.service.js';
import {
  FloridaCurrentAuthorityService,
  parseFloridaCurrentAuthoritySelector,
  type FloridaCurrentAuthoritySelector,
} from './florida-current-authority.service.js';

jest.mock('@capiro/shared', () => ({ PHASE8_FEATURES: { budget: 'legiwatch_florida_budget_v1' } }));
jest.mock('./evidence.service.js', () => ({
  Phase8EvidenceService: class {},
  phase8Scope: jest.fn(),
}));

const tenantId = '10000000-0000-0000-0000-000000000001';
const actorId = '10000000-0000-0000-0000-000000000002';
const membershipId = '10000000-0000-0000-0000-000000000003';
const folderId = '10000000-0000-0000-0000-000000000004';
const clientId = '10000000-0000-0000-0000-00000000000a';
const principal = { tenantId, actorId, clerkUserId: 'user_current' };
const selector: FloridaCurrentAuthoritySelector = {
  schemaVersion: 1,
  sessionKey: '',
  folderId: null,
  clientSelector: null,
};

interface State {
  feature?: Record<string, unknown> | null;
  member?: Record<string, unknown> | null;
  folder?: Record<string, unknown>;
  client?: Record<string, unknown>;
}
function fixture(states: State[] = [{}]) {
  let current: State = {};
  let transactions = 0;
  let cancelled = false;
  const control = {
    deadlineMs: 10_000,
    assertActive: jest.fn(() => {
      if (cancelled) throw new RequestTimeoutException('cancelled');
    }),
  };
  const feature = {
    id: 'flag-budget',
    feature: 'legiwatch_florida_budget_v1',
    tenantId,
    enabled: true,
  };
  const member = {
    id: membershipId,
    tenantId,
    actorId,
    clerkUserId: principal.clerkUserId,
    status: 'active',
    role: 'standard_user',
  };
  const folder = { id: folderId, tenantId, version: 1, clientId, archived: false };
  const client = {
    id: clientId,
    tenantId,
    status: 'active',
    memoryWall: true,
    grantId: '10000000-0000-0000-0000-00000000000b',
  };
  const tx = {
    featureFlag: {
      findUnique: jest.fn(async () =>
        current.feature === null ? null : { ...feature, ...current.feature },
      ),
    },
    $queryRawUnsafe: jest.fn(async (sql: string, ..._values: unknown[]) => {
      if (sql.includes('FROM tenant_memberships'))
        return current.member === null ? [] : [{ ...member, ...current.member }];
      if (sql.includes('FROM clients')) return [{ ...client, ...current.client }];
      throw new Error('Unexpected query');
    }),
  };
  const folderRead = jest.fn(async () => ({ ...folder, ...current.folder }));
  const authorize = jest.fn(async (): Promise<void> => undefined);
  const withActor = jest.fn(
    async (_ctx: unknown, fn: (transaction: typeof tx) => Promise<unknown>, _options: unknown) => {
      current = states[Math.min(transactions++, states.length - 1)]!;
      return fn(tx);
    },
  );
  const context = jest.fn(
    async (
      _tx: unknown,
      _ctx: unknown,
      scope: { folderId: string | null; clientId: string | null },
    ) => {
      if (scope.folderId) scope.clientId = (current.folder?.clientId ?? folder.clientId) as string;
    },
  );
  const reports = { authorize, folders: { withActor } };
  const phase8 = { reports, research: { keywords: { reports, folder: folderRead } }, context };
  return {
    service: new FloridaCurrentAuthorityService(phase8 as unknown as Phase8EvidenceService),
    control,
    tx,
    authorize,
    withActor,
    context,
    folderRead,
    cancel: () => {
      cancelled = true;
    },
  };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(1000);
  jest.mocked(phase8Scope).mockImplementation((input) => ({
    jurisdiction: 'FL',
    sessionKey: input.sessionKey as string,
    folderId: input.folderId as string | null,
    clientId: input.clientId as string | null,
  }));
});
afterEach(() => jest.restoreAllMocks());

describe('Florida current authority facts', () => {
  it('uses canonical gates with explicit budget feature and exact empty-session scope', async () => {
    const f = fixture();
    const result = await f.service.read(principal, selector, f.control);
    expect(result).toEqual({
      effectiveScope: { jurisdiction: 'FL', sessionKey: '', folderId: null, clientId: null },
      clientResolution: null,
      resourceRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(f.authorize).toHaveBeenCalledWith(
      { tenantId, clerkUserId: 'user_current', role: null },
      'legiwatch_florida_budget_v1',
    );
    expect(f.withActor).toHaveBeenCalledTimes(2);
    expect(
      f.withActor.mock.calls.every((call) => (call[2] as { timeoutMs: number }).timeoutMs === 5000),
    ).toBe(true);
    expect(f.tx.featureFlag.findUnique).toHaveBeenCalledWith({
      where: { feature_tenantId: { feature: 'legiwatch_florida_budget_v1', tenantId } },
      select: { id: true, feature: true, tenantId: true, enabled: true },
    });
  });

  it('keeps session bytes and resolves a UUID selector without fabricating a name resolution', async () => {
    const f = fixture();
    const result = await f.service.read(
      principal,
      { ...selector, sessionKey: '  FL session  ', clientSelector: clientId.toUpperCase() },
      f.control,
    );
    expect(result.effectiveScope).toEqual({
      jurisdiction: 'FL',
      sessionKey: '  FL session  ',
      folderId: null,
      clientId,
    });
    expect(result.clientResolution).toEqual({ selector: clientId.toUpperCase(), clientId });
    expect(f.context).toHaveBeenCalledWith(
      f.tx,
      { tenantId, clerkUserId: 'user_current', role: null },
      result.effectiveScope,
    );
    const values = f.tx.$queryRawUnsafe.mock.calls.find((call) =>
      call[0].includes('FROM clients'),
    )!;
    expect(values.slice(1)).toEqual([tenantId, clientId, actorId]);
  });

  it('uses the existing folder read with write=false and admits archived folders', async () => {
    const f = fixture([{ folder: { archived: true } }]);
    const result = await f.service.read(principal, { ...selector, folderId }, f.control);
    expect(result.effectiveScope.clientId).toBe(clientId);
    expect(result.clientResolution).toBeNull();
    expect(f.folderRead).toHaveBeenCalledWith(
      f.tx,
      { tenantId, clerkUserId: 'user_current', role: null },
      folderId,
      false,
    );
  });

  it('fails a valid name selector unavailable without using it as a UUID or dropping it', async () => {
    const f = fixture();
    await expect(
      f.service.read(principal, { ...selector, clientSelector: 'Current Client' }, f.control),
    ).rejects.toThrow('Florida client selector resolver unavailable');
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.withActor).not.toHaveBeenCalled();
  });

  it.each([
    { ...selector, schemaVersion: 2 },
    { ...selector, sessionKey: 'x'.repeat(257) },
    { ...selector, folderId: folderId.toUpperCase().replace('0004', '000A') },
    { ...selector, clientSelector: '' },
    { ...selector, clientSelector: ' current ' },
    { ...selector, tenantId },
    { ...selector, actorId },
  ])('rejects malformed or authority-bearing selectors before owners: %j', async (raw) => {
    const f = fixture();
    await expect(f.service.read(principal, raw, f.control)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it('rejects an accessor without reading it and accepts the exact 256-character session boundary', () => {
    const getter = jest.fn(() => '');
    const raw = Object.defineProperty({ ...selector }, 'sessionKey', {
      get: getter,
      enumerable: true,
    });
    expect(() => parseFloridaCurrentAuthoritySelector(raw)).toThrow(BadRequestException);
    expect(getter).not.toHaveBeenCalled();
    expect(
      parseFloridaCurrentAuthoritySelector({ ...selector, sessionKey: 'x'.repeat(256) }).sessionKey,
    ).toHaveLength(256);
  });

  it('preserves canonical feature and resource denials', async () => {
    const f = fixture();
    f.authorize.mockRejectedValueOnce(new NotFoundException());
    await expect(f.service.read(principal, selector, f.control)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.withActor).not.toHaveBeenCalled();
    const denied = fixture();
    denied.context.mockRejectedValueOnce(new NotFoundException('FOLDER_CLIENT_SCOPE_MISMATCH'));
    await expect(
      denied.service.read(
        principal,
        { ...selector, folderId, clientSelector: clientId },
        denied.control,
      ),
    ).rejects.toThrow('FOLDER_CLIENT_SCOPE_MISMATCH');
  });

  it('corroborates the current Core UUID and Clerk mapping, not just an active Clerk member', async () => {
    const f = fixture([{ member: null }]);
    await expect(f.service.read(principal, selector, f.control)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.tx.$queryRawUnsafe.mock.calls[0]!.slice(1)).toEqual([
      tenantId,
      actorId,
      'user_current',
    ]);
  });

  it('refuses a removed membership even if an earlier owner observation passed', async () => {
    const f = fixture([{ member: { status: 'suspended' } }]);
    await expect(f.service.read(principal, selector, f.control)).rejects.toThrow(
      'ACTIVE_MEMBERSHIP_REQUIRED',
    );
  });

  it.each([
    { states: [{}, { feature: { id: 'replacement-flag' } }] },
    { states: [{}, { member: { role: 'user_admin' } }] },
    { states: [{}, { folder: { version: 2 } }] },
    { states: [{}, { client: { memoryWall: false, grantId: null } }] },
    { states: [{}, { client: { grantId: '10000000-0000-0000-0000-00000000000c' } }] },
  ] as Array<{ states: State[] }>)(
    'rejects allowed-to-allowed resource drift between snapshots: %j',
    async ({ states }) => {
      const f = fixture(states);
      await expect(
        f.service.read(principal, { ...selector, folderId }, f.control),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );

  it('does not put clocks or unknown identity fields into the deterministic resource revision', async () => {
    const first = fixture([
      { member: { checkedAtMs: 1, identityRevision: 'old' }, client: { updatedAt: new Date(1) } },
    ]);
    const before = await first.service.read(
      principal,
      { ...selector, clientSelector: clientId },
      first.control,
    );
    jest.mocked(Date.now).mockReturnValue(2000);
    const second = fixture([
      { member: { checkedAtMs: 2, identityRevision: 'new' }, client: { updatedAt: new Date(2) } },
    ]);
    const after = await second.service.read(
      principal,
      { ...selector, clientSelector: clientId },
      second.control,
    );
    expect(after.resourceRevision).toBe(before.resourceRevision);
  });

  it('refuses a late result after cancellation during an owner await', async () => {
    const f = fixture();
    f.authorize.mockImplementationOnce(async () => {
      f.cancel();
    });
    await expect(f.service.read(principal, selector, f.control)).rejects.toBeInstanceOf(
      RequestTimeoutException,
    );
    expect(f.withActor).not.toHaveBeenCalled();
  });

  it('checks the finite deadline before I/O and bounds a transaction by remaining time', async () => {
    const expired = fixture();
    expired.control.deadlineMs = 1000;
    await expect(expired.service.read(principal, selector, expired.control)).rejects.toBeInstanceOf(
      RequestTimeoutException,
    );
    expect(expired.authorize).not.toHaveBeenCalled();
    const f = fixture();
    f.control.deadlineMs = 1250;
    await f.service.read(principal, selector, f.control);
    expect(f.withActor.mock.calls[0]![2]).toEqual({ timeoutMs: 250 });
  });

  it('fails malformed source facts and unknown database errors unavailable', async () => {
    const malformed = fixture([{ feature: { enabled: 'true' } }]);
    await expect(
      malformed.service.read(principal, selector, malformed.control),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const failed = fixture();
    failed.tx.featureFlag.findUnique.mockRejectedValueOnce(new Error('internal diagnostic'));
    await expect(failed.service.read(principal, selector, failed.control)).rejects.toThrow(
      'Florida authority source unavailable',
    );
  });
});
