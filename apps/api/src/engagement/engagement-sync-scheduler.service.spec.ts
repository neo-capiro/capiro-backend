import { EngagementSyncSchedulerService } from './engagement-sync-scheduler.service.js';
import { currentDbLane } from '../prisma/db-lane.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import { harness } from './mailbox-oauth.a1-fixture.js';

function activeApiPolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'api',
    processMode: 'active',
    backgroundOwner: 'api',
    externalActions: 'enabled',
    callbacksEnabled: true,
    recallWebhookEnabled: true,
  });
}

function integrationsOnlyApiOwnerPolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'api',
    processMode: 'shadow',
    backgroundOwner: 'api',
    externalActions: 'integrations_only',
    callbacksEnabled: true,
    recallWebhookEnabled: false,
  });
}

function disabledEngagementApiPolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'engagement-api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'integrations_only',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
  });
}

/**
 * Unit tests for the auto-sync scheduler's tick: provider dispatch, the
 * subscription-renewal piggyback (best-effort — a renewal failure must never
 * fail the sync), per-connection failure isolation (one dead mailbox must not
 * block the rest of the batch), unknown-provider tolerance, and the disabled
 * kill-switch not arming the timer. Candidate SQL is inspected here; admission
 * and claim release run through the real helper with a synthetic transaction.
 * PostgreSQL locking, SQL execution and multi-process behavior remain untested.
 */

type Claimed = {
  id: string;
  tenant_id: string;
  provider: string;
  account_email: string | null;
};

function makeScheduler(opts: {
  enabled?: boolean;
  claimed?: Claimed[];
  msSyncThrows?: boolean;
  msSubsThrows?: boolean;
  subscriptionsConfigurable?: boolean;
  policy?: EngagementRuntimePolicyService;
}) {
  const claims = harness();
  const template = structuredClone(claims.rows.get('connection-A'));
  claims.rows.clear();
  for (const connection of opts.claimed ?? []) {
    claims.rows.set(connection.id, {
      ...structuredClone(template),
      id: connection.id,
      tenantId: connection.tenant_id,
      provider: connection.provider,
      createdByUserId: `owner-${connection.id}`,
      nextSyncAt: null,
    });
  }
  const queryRaw = jest
    .fn()
    .mockResolvedValueOnce(opts.claimed ?? [])
    .mockResolvedValue([]);
  const prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(claims.tx),
    withSystem: (fn: (tx: unknown) => Promise<unknown>) => fn({ $queryRaw: queryRaw }),
  };
  const microsoft = {
    subscriptionsConfigurable: opts.subscriptionsConfigurable ?? true,
    syncConnectionByTenant: opts.msSyncThrows
      ? jest.fn().mockRejectedValue(new Error('graph down'))
      : jest.fn().mockResolvedValue({ connectionId: 'x' }),
    configureSubscriptionsByTenant: opts.msSubsThrows
      ? jest.fn().mockRejectedValue(new Error('subscription refused'))
      : jest.fn().mockResolvedValue({ configured: true }),
  };
  const google = {
    syncConnectionByTenant: jest.fn().mockResolvedValue({ connectionId: 'y' }),
  };
  const config = {
    get: (key: string) => (key === 'ENGAGEMENT_AUTO_SYNC' ? (opts.enabled ?? true) : 20),
  };
  const service = new EngagementSyncSchedulerService(
    prisma as never,
    microsoft as never,
    google as never,
    config as never,
    opts.policy ?? activeApiPolicy(),
  );
  return { service, microsoft, google, queryRaw, claims };
}

function conn(overrides: Partial<Claimed> = {}): Claimed {
  return {
    id: 'conn-1',
    tenant_id: 'tenant-1',
    provider: 'microsoft_365',
    account_email: 'a@b.com',
    ...overrides,
  };
}

describe('EngagementSyncSchedulerService', () => {
  it('does not arm the timer when the kill-switch is off', () => {
    const { service } = makeScheduler({ enabled: false });
    service.onModuleInit();
    expect((service as unknown as { timer?: unknown }).timer).toBeUndefined();
    service.onModuleDestroy();
  });

  it('runs every scheduled tick in the background database lane', async () => {
    jest.useFakeTimers();
    try {
      const { service, microsoft, queryRaw } = makeScheduler({ claimed: [conn({ id: 'ms-1' })] });
      const lanes: string[] = [];
      queryRaw.mockImplementation(async () => { lanes.push(currentDbLane()); return lanes.length === 1 ? [conn({ id: 'ms-1' })] : []; });
      microsoft.syncConnectionByTenant.mockImplementation(async () => { lanes.push(currentDbLane()); return { connectionId: 'x' }; });
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      service.onModuleDestroy();
      expect(lanes.length).toBeGreaterThanOrEqual(2);
      expect(new Set(lanes)).toEqual(new Set(['background']));
      expect(currentDbLane()).toBe('request');
    } finally {
      jest.useRealTimers();
    }
  });

  it('dispatches claimed connections to the matching provider service', async () => {
    const { service, microsoft, google } = makeScheduler({
      claimed: [
        conn({ id: 'ms-1', provider: 'microsoft_365' }),
        conn({ id: 'g-1', provider: 'google_workspace', tenant_id: 'tenant-2' }),
      ],
    });
    await service.tick();
    expect(microsoft.syncConnectionByTenant).toHaveBeenCalledWith('tenant-1', 'ms-1');
    expect(google.syncConnectionByTenant).toHaveBeenCalledWith('tenant-2', 'g-1');
  });

  it('filters canonical active ownership and unexpired OAuth before the bounded candidate selection', async () => {
    const { service, queryRaw } = makeScheduler({});
    await service.tick();
    const selection = queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] };
    const sql = selection.sql.replace(/\s+/g, ' ');
    expect(sql).toMatch(/EXISTS \( SELECT 1 FROM tenant_memberships AS membership/);
    expect(sql).toContain('membership.tenant_id = connection.tenant_id');
    expect(sql).toContain('membership.user_id = connection.created_by_user_id');
    expect(sql).toContain("membership.status = 'active'");
    expect(sql).toMatch(
      /AND NOT CASE .*oauthAttempt.*expiresAt.*EXTRACT\(EPOCH FROM clock_timestamp\(\)\).*END ORDER BY/,
    );
    expect(sql).toContain('connection.next_sync_at ASC NULLS FIRST, connection.id LIMIT');
    expect(selection.values).toEqual([5]);
  });

  it('rejects a stale queued candidate after another worker has scheduled its next run', async () => {
    const { service, microsoft, claims } = makeScheduler({ claimed: [conn()] });
    const row = claims.rows.get('conn-1');
    row.nextSyncAt = new Date(Date.now() + 3_600_000);
    const scheduled = row.nextSyncAt;
    await service.tick();
    expect(microsoft.syncConnectionByTenant).not.toHaveBeenCalled();
    expect(row.nextSyncAt).toBe(scheduled);
    expect(row.syncState.syncClaim).toBeUndefined();
  });

  it.each(['inactive-owner', 'deleted-owner', 'pending-oauth'])(
    'skips a candidate which became %s after selection and still services the next mailbox',
    async (ineligible) => {
      const first = conn({ id: 'ineligible' });
      const second = conn({ id: 'eligible', provider: 'google_workspace' });
      const { service, microsoft, google, claims } = makeScheduler({ claimed: [first, second] });
      const row = claims.rows.get(first.id);
      if (ineligible === 'deleted-owner') row.createdByUserId = null;
      if (ineligible === 'pending-oauth')
        row.syncState.oauthAttempt = { expiresAt: Math.floor(Date.now() / 1000) + 600 };
      if (ineligible === 'inactive-owner') {
        const query = claims.tx.$queryRaw.getMockImplementation();
        claims.tx.$queryRaw.mockImplementation((sql: TemplateStringsArray, ...values: unknown[]) =>
          sql.join('').includes('tenant_memberships') && values[1] === row.createdByUserId
            ? Promise.resolve([])
            : query(sql, ...values),
        );
      }
      await service.tick();
      expect(microsoft.syncConnectionByTenant).not.toHaveBeenCalled();
      expect(google.syncConnectionByTenant).toHaveBeenCalledWith(second.tenant_id, second.id);
      expect(row.syncState.syncClaim).toBeUndefined();
    },
  );

  it('admits an expired OAuth candidate and keeps one claim through sync, renewal and release', async () => {
    const { service, microsoft, claims } = makeScheduler({ claimed: [conn()] });
    const row = claims.rows.get('conn-1');
    row.syncState.oauthAttempt = { expiresAt: Math.floor(Date.now() / 1000) - 1 };
    let token: string | undefined;
    microsoft.syncConnectionByTenant.mockImplementation(async () => {
      token = row.syncState.syncClaim?.token;
      expect(token).toEqual(expect.any(String));
      return { connectionId: row.id };
    });
    microsoft.configureSubscriptionsByTenant.mockImplementation(async () => {
      expect(row.syncState.syncClaim?.token).toBe(token);
      return { configured: true };
    });
    const startedAt = Date.now();
    await service.tick();
    expect(row.syncState.syncClaim).toBeUndefined();
    expect(row.nextSyncAt.getTime()).toBeGreaterThanOrEqual(startedAt + 20 * 60_000);
    expect(row.nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 25 * 60_000);
  });

  it('renews M365 subscriptions on every scheduled sync (the anti-death-spiral)', async () => {
    const { service, microsoft } = makeScheduler({ claimed: [conn()] });
    await service.tick();
    expect(microsoft.configureSubscriptionsByTenant).toHaveBeenCalledWith('tenant-1', 'conn-1');
  });

  it('skips subscription renewal when the deployment has no notification URL', async () => {
    const { service, microsoft } = makeScheduler({
      claimed: [conn()],
      subscriptionsConfigurable: false,
    });
    await service.tick();
    expect(microsoft.configureSubscriptionsByTenant).not.toHaveBeenCalled();
    expect(microsoft.syncConnectionByTenant).toHaveBeenCalled();
  });

  it('a subscription-renewal failure never fails the sync pass', async () => {
    const { service, microsoft } = makeScheduler({ claimed: [conn()], msSubsThrows: true });
    await expect(service.tick()).resolves.toBeUndefined();
    expect(microsoft.syncConnectionByTenant).toHaveBeenCalled();
  });

  it('one failing connection does not block the rest of the batch', async () => {
    const { service, google } = makeScheduler({
      claimed: [
        conn({ id: 'ms-dead', provider: 'microsoft_365' }),
        conn({ id: 'g-ok', provider: 'google_workspace' }),
      ],
      msSyncThrows: true,
    });
    await expect(service.tick()).resolves.toBeUndefined();
    expect(google.syncConnectionByTenant).toHaveBeenCalledWith('tenant-1', 'g-ok');
  });

  it('ignores unknown providers without calling either service', async () => {
    const { service, microsoft, google } = makeScheduler({
      claimed: [conn({ provider: 'imap_legacy' })],
    });
    await service.tick();
    expect(microsoft.syncConnectionByTenant).not.toHaveBeenCalled();
    expect(google.syncConnectionByTenant).not.toHaveBeenCalled();
  });

  it('starts and syncs both providers under the explicit API owner integrations_only policy', async () => {
    const clearSpy = jest.spyOn(global, 'clearInterval');
    const policy = integrationsOnlyApiOwnerPolicy();
    const { service, microsoft, google, queryRaw } = makeScheduler({
      policy,
      claimed: [
        conn({ id: 'ms-1', provider: 'microsoft_365' }),
        conn({ id: 'g-1', provider: 'google_workspace', tenant_id: 'tenant-2' }),
      ],
    });
    expect(policy.backgroundWorkersEnabled('engagement-sync-scheduler')).toBe(true);
    expect(policy.backgroundWorkersEnabled()).toBe(false);
    service.onModuleInit();
    expect((service as unknown as { timer?: unknown }).timer).toBeDefined();
    await service.tick();
    expect(queryRaw).toHaveBeenCalled();
    expect(microsoft.syncConnectionByTenant).toHaveBeenCalledWith('tenant-1', 'ms-1');
    expect(microsoft.configureSubscriptionsByTenant).toHaveBeenCalledWith('tenant-1', 'ms-1');
    expect(google.syncConnectionByTenant).toHaveBeenCalledWith('tenant-2', 'g-1');
    service.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('does not arm the timer and refuses to tick when the policy denies this worker', async () => {
    const policy = disabledEngagementApiPolicy();
    const { service, microsoft, google, queryRaw } = makeScheduler({ policy });
    service.onModuleInit();
    expect((service as unknown as { timer?: unknown }).timer).toBeUndefined();
    await expect(service.tick()).rejects.toThrow(/disabled/i);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(microsoft.syncConnectionByTenant).not.toHaveBeenCalled();
    expect(google.syncConnectionByTenant).not.toHaveBeenCalled();
  });

  it('refuses a mismatched owner even when the posture is otherwise valid', async () => {
    const policy = new EngagementRuntimePolicyService({
      serviceName: 'engagement-api',
      processMode: 'shadow',
      backgroundOwner: 'api',
      externalActions: 'integrations_only',
      callbacksEnabled: true,
      recallWebhookEnabled: false,
    });
    const { service, microsoft, queryRaw } = makeScheduler({ policy });
    await expect(service.tick()).rejects.toThrow();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(microsoft.syncConnectionByTenant).not.toHaveBeenCalled();
  });

  it('does not arm the timer when the kill switch is off under the API owner policy', () => {
    const { service } = makeScheduler({ policy: integrationsOnlyApiOwnerPolicy(), enabled: false });
    service.onModuleInit();
    expect((service as unknown as { timer?: unknown }).timer).toBeUndefined();
    service.onModuleDestroy();
  });
});
