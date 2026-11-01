/**
 * Focused N checks for notification-queue retained ownership (SCRUM-190).
 * Real MicrosoftGraphSyncService queue methods + real barrier; inert task functions.
 * No provider, DB, socket, network, bootstrap or real signal.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { EngagementMailHandoffBarrier } from '../runtime/engagement-mail-handoff.js';
import { EngagementRuntimePolicyService } from '../runtime/engagement-runtime-policy.service.js';

jest.mock('../mailbox-sync-claim.js', () => ({
  assertMailboxSyncCurrent: jest.fn(async () => undefined),
  mailboxState: jest.fn(() => ({})),
  mergeMailboxSyncState: jest.fn((state: unknown) => state),
  withMailboxSyncClaim: jest.fn(),
}));
jest.mock('../mailbox-oauth-authority.js', () => ({
  admitMailboxRefresh: jest.fn(async () => ({ syncState: 'in-sync' })),
  lockMailboxConnection: jest.fn(async () => undefined),
}));

function policy(phase: 'off' | 'initiation_fenced') {
  const barrier = new EngagementMailHandoffBarrier();
  barrier.bind({
    serviceName: 'api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'enabled',
    callbacksEnabled: true,
    recallWebhookEnabled: false,
    mailHandoff: phase === 'off' ? undefined : { phase, generation: 'g1', fenceUtc: null },
  } as never);
  const runtimePolicy = new EngagementRuntimePolicyService(
    {
      serviceName: 'api',
      processMode: 'shadow',
      backgroundOwner: 'disabled',
      externalActions: 'enabled',
      callbacksEnabled: true,
      recallWebhookEnabled: false,
    } as never,
    barrier,
  );
  return { barrier, runtimePolicy };
}

interface QueueFacade {
  enqueueNotificationSync(key: string, connectionId: string, run: () => Promise<unknown>): boolean;
}

function queueable(runtimePolicy: EngagementRuntimePolicyService): QueueFacade {
  const svc = Object.create(MicrosoftGraphSyncService.prototype) as Record<string, unknown>;
  svc.runtimePolicy = runtimePolicy;
  svc.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  return svc as unknown as QueueFacade;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('MicrosoftGraphSyncService notification queue ownership (N)', () => {
  it('refuses a selected-phase enqueue with no live parent before touching the queue', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const queue = queueable(runtimePolicy);
    const run = jest.fn(async () => undefined);

    expect(() => queue.enqueueNotificationSync('k1', 'conn-1', run)).toThrow(
      ServiceUnavailableException,
    );
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(barrier.observation()?.admittedTotal).toBe(0);
    expect(barrier.observation()?.activeTotal).toBe(0);
  });

  it('keeps the retained child live after the HTTP parent settles, then drains once', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const queue = queueable(runtimePolicy);
    const gate = deferred();

    await barrier.runAdmitted('oauth_callback_continue', async () => {
      expect(queue.enqueueNotificationSync('k2', 'conn-1', () => gate.promise)).toBe(true);
    });

    // Parent settled; the queued item still owns a live child record.
    expect(barrier.observation()?.activeTotal).toBe(1);
    expect(barrier.observation()?.liveAdmissionCount).toBe(1);

    gate.resolve();
    await flush();

    const observation = barrier.observation();
    expect(observation?.activeTotal).toBe(0);
    expect(observation?.liveAdmissionCount).toBe(0);
    expect(observation?.settledWork.callback_notification_admit).toBe(1);
  });

  it('coalesces a duplicate queued key without minting a second child', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const queue = queueable(runtimePolicy);
    const busy1 = deferred();
    const busy2 = deferred();
    const gate = deferred();

    await barrier.runAdmitted('oauth_callback_continue', async () => {
      // Saturate the real concurrency bound so the next key stays QUEUED.
      queue.enqueueNotificationSync('busy-1', 'conn-1', () => busy1.promise);
      queue.enqueueNotificationSync('busy-2', 'conn-1', () => busy2.promise);
      expect(queue.enqueueNotificationSync('k3', 'conn-1', () => gate.promise)).toBe(true);
      expect(queue.enqueueNotificationSync('k3', 'conn-1', () => gate.promise)).toBe(false);
    });

    expect(barrier.observation()?.admittedWork.callback_notification_admit).toBe(3);

    busy1.resolve();
    busy2.resolve();
    gate.resolve();
    await flush();

    expect(barrier.observation()?.activeTotal).toBe(0);
    expect(barrier.observation()?.settledWork.callback_notification_admit).toBe(3);
  });

  it('keeps a reported unknown from the task instead of forcing success', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const queue = queueable(runtimePolicy);

    await barrier.runAdmitted('oauth_callback_continue', async () => {
      queue.enqueueNotificationSync('k4', 'conn-1', async () => {
        runtimePolicy.mailHandoffDisposition()?.unknown();
        return undefined;
      });
    });
    await flush();

    const observation = barrier.observation();
    expect(observation?.unknownTotal).toBe(1);
    expect(observation?.settledWork.callback_notification_admit).toBeUndefined();
    expect(observation?.activeTotal).toBe(0);
  });
});
