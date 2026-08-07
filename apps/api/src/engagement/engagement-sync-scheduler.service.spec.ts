import { EngagementSyncSchedulerService } from './engagement-sync-scheduler.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

const runtimePolicy = {
  backgroundWorkersEnabled: () => true,
  assertBackgroundOwner: () => {},
  assertExternalAction: () => {},
  assertCallbacksEnabled: () => {},
  externalActionAllowed: () => true,
  snapshot: () => ({ serviceName: 'api', processMode: 'active', backgroundOwner: 'api', externalActions: 'enabled', callbacksEnabled: true, recallWebhookEnabled: true }),
  isRecallWebhookEnabled: () => true,
} as unknown as EngagementRuntimePolicyService;

/**
 * Unit tests for the auto-sync scheduler's tick: provider dispatch, the
 * subscription-renewal piggyback (best-effort — a renewal failure must never
 * fail the sync), per-connection failure isolation (one dead mailbox must not
 * block the rest of the batch), unknown-provider tolerance, and the disabled
 * kill-switch not arming the timer. The claim SQL itself is exercised against
 * real Postgres by the prod smoke after deploy; here it is stubbed.
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
}) {
  const queryRaw = jest
    .fn()
    .mockResolvedValueOnce(opts.claimed ?? [])
    .mockResolvedValue([]);
  const prisma = {
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
    runtimePolicy,
  );
  return { service, microsoft, google, queryRaw };
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
});
