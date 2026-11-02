import { describe, expect, it } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import { parseEngagementMailHandoffSelection } from './engagement-runtime-env.js';
import { EngagementMailHandoffBarrier } from './engagement-mail-handoff.js';
import {
  guardGmailSendService,
  guardGoogleTokenService,
  guardMicrosoftOAuthService,
} from './engagement-integration-runtime.boundary.js';
import type { EngagementMailHandoffPhase } from './engagement-runtime.types.js';

/**
 * Focused, injected-only coverage for the mail-handoff admission barrier.
 *
 * Every case builds its OWN policy and barrier instance. Nothing here
 * reconfigures the process singleton, and counters are read from that instance
 * alone. Nothing here starts a provider client, opens a database connection or
 * spawns a command: the provider services below are plain objects.
 */
function policyIn(phase: EngagementMailHandoffPhase, generation = 'g1') {
  // Each case gets its own barrier: a test must never reconfigure the process
  // singleton's phase, generation or counters.
  return new EngagementRuntimePolicyService(
    {
      serviceName: 'api',
      processMode: 'active',
      backgroundOwner: 'api',
      externalActions: 'enabled',
      callbacksEnabled: true,
      recallWebhookEnabled: false,
      mailHandoff:
        phase === 'off'
          ? undefined
          : { phase, generation, fenceUtc: '2026-10-29T00:00:00.000Z' },
    },
    new EngagementMailHandoffBarrier(),
  );
}

function refusal(run: () => unknown): ServiceUnavailableException {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    return error as ServiceUnavailableException;
  }
  throw new Error('expected a handoff refusal');
}

describe('mail handoff barrier — default legacy behavior', () => {
  it('admits every boundary and reports no observation when unset', () => {
    const policy = policyIn('off');
    expect(policy.mailHandoffPhase()).toBe('off');
    expect(policy.mailHandoffObservation()).toBeNull();
    expect(() => policy.assertMailHandoffInitiation('integration_create')).not.toThrow();
    expect(() => policy.assertMailHandoffInitiation('callback_notification_admit')).not.toThrow();
    // Obsolete assertMailHandoffContinuation is gone: the accepted API is the
    // boundary router, which admits everything in the legacy phase.
    expect(() => policy.assertMailHandoffBoundary('grant_refresh')).not.toThrow();
    const handle = policy.admitMailHandoffWork('grant_refresh');
    expect(() => handle.settle('settled')).not.toThrow();
  });

  it('does not treat an omitted selection as fenced config', () => {
    expect(parseEngagementMailHandoffSelection({})).toBeUndefined();
    expect(
      parseEngagementMailHandoffSelection({ ENGAGEMENT_MAIL_HANDOFF_PHASE: '   ' }),
    ).toBeUndefined();
    expect(
      parseEngagementMailHandoffSelection({ ENGAGEMENT_MAIL_HANDOFF_PHASE: 'off' }),
    ).toBeUndefined();
  });
});

describe('mail handoff barrier — initiation fence', () => {
  it('refuses new issuer, create, sync, subscription, disconnect and grant work', () => {
    const policy = policyIn('initiation_fenced');
    for (const boundary of [
      'oauth_state_issue',
      'integration_create',
      'integration_sync',
      'integration_calendar_commands',
      'integration_subscription',
      'integration_disconnect',
      'capture_initiation',
      'grant_refresh',
      'grant_persist',
    ] as const) {
      const error = refusal(() => policy.assertMailHandoffInitiation(boundary));
      expect(error.getResponse()).toMatchObject({
        statusCode: 503,
        code: 'ENGAGEMENT_MAIL_HANDOFF_FENCED',
        phase: 'initiation_fenced',
        boundary,
      });
    }
  });

  it('keeps admitted callbacks and scheduler ticks running in this phase', () => {
    const policy = policyIn('initiation_fenced');
    expect(() => policy.assertMailHandoffInitiation('callback_notification_admit')).not.toThrow();
    expect(() => policy.assertMailHandoffInitiation('scheduler_tick')).not.toThrow();
  });

  it('admits a nested grant write only inside a server-owned admitted scope', async () => {
    const policy = policyIn('initiation_fenced');
    // A new refresh with no admitted continuation is refused …
    expect(() => policy.assertMailHandoffBoundary('grant_refresh')).toThrow(/fenced|handoff/i);
    // … while the same refresh inside an admitted callback drain is allowed.
    await policy.runAdmittedMailHandoffWork('callback_notification_admit', async () => {
      expect(() => policy.assertMailHandoffBoundary('grant_refresh')).not.toThrow();
      expect(() => policy.assertMailHandoffBoundary('grant_persist')).not.toThrow();
      // A nested callback admission is still new work, not a grant write.
      return undefined;
    });
  });

  it('does not accept a forged continuation context object', () => {
    const policy = policyIn('initiation_fenced');
    expect(() =>
      policy.assertMailHandoffBoundary('grant_refresh', { boundary: 'grant_refresh' }),
    ).toThrow(/fenced|handoff/i);
  });

  it('accepts a context issued by admitWork until it settles', () => {
    // initation_fenced still admits callback reception, so a real handle exists
    // to test the live-record lifetime.
    const policy = policyIn('initiation_fenced');
    const handle = policy.admitMailHandoffWork('callback_notification_admit');
    expect(() => policy.assertMailHandoffBoundary('grant_refresh', handle.context)).not.toThrow();
    handle.settle('settled');
    expect(() => policy.assertMailHandoffBoundary('grant_refresh', handle.context)).toThrow(
      /fenced|handoff/i,
    );
  });

  it('refuses an unregistered boundary name instead of passing it through', () => {
    const policy = policyIn('initiation_fenced');
    expect(() =>
      policy.assertMailHandoffInitiation('unknown_boundary' as never),
    ).toThrow(/fenced|handoff/i);
  });
});

describe('mail handoff barrier — callback fence and writer closure', () => {
  it('refuses new callback reception and new scheduler ticks once callbacks close', () => {
    const policy = policyIn('callback_fenced');
    expect(() => policy.assertMailHandoffInitiation('callback_notification_admit')).toThrow(
      /fenced|handoff/i,
    );
    expect(() => policy.assertMailHandoffInitiation('scheduler_tick')).toThrow(/fenced|handoff/i);
    expect(() => policy.assertMailHandoffInitiation('integration_create')).toThrow(/fenced|handoff/i);
  });

  it('closes locally only after the work it actually owns settles', async () => {
    const policy = policyIn('initiation_fenced');
    const handle = policy.admitMailHandoffWork('callback_notification_admit');
    policy.beginMailHandoffLocalShutdown();
    const opened = policy.mailHandoffObservation()!;
    expect(opened.admissionClosedLocally).toBe(true);
    expect(opened.activeTotal).toBe(1);
    expect(opened.localClosure).toBe(false);
    // Shutdown closes new admissions synchronously, including nested new work.
    expect(() => policy.assertMailHandoffBoundary('integration_create')).toThrow(/fenced|handoff/i);

    let settledNow = false;
    const waiting = policy.waitForMailHandoffLocalSettlement().then(() => {
      settledNow = true;
    });
    await Promise.resolve();
    expect(settledNow).toBe(false);

    // The unknown provider outcome is retained, not converted to success.
    handle.settle('unknown');
    await waiting;
    const drained = policy.mailHandoffObservation()!;
    expect(drained.activeTotal).toBe(0);
    expect(drained.localClosure).toBe(true);
    expect(drained.unknownTotal).toBe(1);
    expect(drained.outcomeReconciled).toBe(false);
  });

  it('lets a zero-work process close and refuses to borrow another task proof', () => {
    const empty = policyIn('initiation_fenced');
    empty.beginMailHandoffLocalShutdown();
    const closed = empty.mailHandoffObservation()!;
    expect(closed.admittedTotal).toBe(0);
    expect(closed.localClosure).toBe(true);

    // A different process/owner starts empty and inherits nothing.
    const fresh = policyIn('initiation_fenced');
    const other = fresh.mailHandoffObservation()!;
    expect(other.localClosure).toBe(false);
    expect(other.activeTotal).toBe(0);
    expect(other.admittedTotal).toBe(0);
  });

  it('refuses nested NEW work inside a live continuation and does not run its body', async () => {
    const policy = policyIn('initiation_fenced');
    let nestedBodyRan = false;
    await policy.runAdmittedMailHandoffWork('callback_notification_admit', async () => {
      // Local shutdown inside the live scope closes NEW callbacks/ticks while the
      // already-admitted callback is still allowed to finish.
      policy.beginMailHandoffLocalShutdown();
      await expect(
        policy.runAdmittedMailHandoffWork('integration_sync', async () => {
          nestedBodyRan = true;
        }),
      ).rejects.toThrow(/fenced|handoff/i);
    });
    expect(nestedBodyRan).toBe(false);
  });

  it('refuses a deferred continuation that inherited a settled record', async () => {
    const policy = policyIn('initiation_fenced');
    let release: (() => void) | undefined;
    let continuation: Promise<void> | undefined;
    await policy.runAdmittedMailHandoffWork('callback_notification_admit', async () => {
      // Registered INSIDE the admission scope: this .then inherits that record.
      continuation = new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        policy.assertMailHandoffBoundary('grant_refresh');
      });
    });
    // The parent has settled before the continuation runs; microtasks only.
    release!();
    await expect(continuation!).rejects.toThrow(/fenced|handoff/i);
  });

  it('lets a live explicit queue handle outrank a stale inherited record', async () => {
    const policy = policyIn('initiation_fenced');
    // B: the real deferred queue handle, admitted while the fence still allows it.
    const queued = policy.admitMailHandoffWork('callback_notification_admit');
    let release: (() => void) | undefined;
    let drain: Promise<void> | undefined;
    await policy.runAdmittedMailHandoffWork('callback_notification_admit', async () => {
      // This .then inherits A, which settles before the continuation runs.
      drain = new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        // Stale ambient A is dead, but presented B is live, so B authorises.
        policy.assertMailHandoffBoundary('grant_refresh', queued.context);
      });
    });
    release!();
    await expect(drain!).resolves.toBeUndefined();
    queued.settle('settled');
    expect(() => policy.assertMailHandoffBoundary('grant_refresh', queued.context)).toThrow(
      /fenced|handoff/i,
    );
  });

  it('never clears counters on a double settle', () => {
    const policy = policyIn('initiation_fenced');
    const handle = policy.admitMailHandoffWork('callback_notification_admit');
    const opened = policy.mailHandoffObservation()!;
    handle.settle('settled');
    handle.settle('settled');
    const after = policy.mailHandoffObservation()!;
    expect(after.settledTotal).toBe(opened.settledTotal + 1);
    expect(after.activeTotal).toBe(opened.activeTotal - 1);
    expect(after.liveAdmissionCount).toBe(0);
  });

  it('keeps the readback content-free', () => {
    const policy = policyIn('initiation_fenced');
    const observation = policy.mailHandoffObservation()!;
    expect(Object.keys(observation)).not.toContain('tenantId');
    expect(JSON.stringify(observation)).not.toMatch(
      /token|secret|bearer|password|@|tenant-|client-/i,
    );
  });
});

describe('mail handoff barrier — existing provider boundary wiring', () => {
  const tokenService = {
    loadConnection: (_id: string) => ({ connection: 'synthetic' }),
    getValidAccessToken: (_id: string) => 'synthetic-token',
  };
  const gmailSend = { sendMail: (_a: string, _b: string, _c: unknown) => ({ queued: true }) };
  const oauth = {
    start: (_id: string) => 'started',
    handleCallback: (_id: string, _payload: unknown) => 'continued',
    disconnect: (_id: string) => 'disconnected',
  };
  const guardedTokenFor = (policy: EngagementRuntimePolicyService) =>
    guardGoogleTokenService(tokenService as never, policy) as unknown as typeof tokenService;
  const guardedOauthFor = (policy: EngagementRuntimePolicyService) =>
    guardMicrosoftOAuthService(oauth as never, policy) as unknown as typeof oauth;
  const guardedSendFor = (policy: EngagementRuntimePolicyService) =>
    guardGmailSendService(gmailSend as never, policy) as unknown as typeof gmailSend;

  it('keeps a cached token read ungated and refuses OAuth start while initiation is fenced', () => {
    const policy = policyIn('initiation_fenced');
    const guardedToken = guardedTokenFor(policy);
    const guardedOauth = guardedOauthFor(policy);
    // The getter is a plain read: the raw refresh guards itself at its real owner,
    // so a valid cached token must NOT be refused by the proxy.
    expect(guardedToken.getValidAccessToken('synthetic')).toBe('synthetic-token');
    expect(() => guardedOauth.start('synthetic')).toThrow(/fenced|handoff/i);
    // A plain read is not an effect and stays available.
    expect(guardedToken.loadConnection('synthetic')).toEqual({ connection: 'synthetic' });
  });

  it('runs an admitted callback inside its own record and refuses it once callbacks close', async () => {
    const policy = policyIn('initiation_fenced');
    const guardedSend = guardedSendFor(policy);
    const guardedOauth = guardedOauthFor(policy);
    expect(guardedSend.sendMail('synthetic', 'synthetic', {})).toEqual({ queued: true });
    // Initiation is admitted, so the proxy owns the whole promise.
    await expect(guardedOauth.handleCallback('synthetic', {})).resolves.toBe('continued');

    const closed = policyIn('callback_fenced');
    expect(() => guardedOauthFor(closed).handleCallback('synthetic', {})).toThrow(/fenced|handoff/i);
  });

  it('does not treat a forged trusted hint on the request as continuation', () => {
    const policy = policyIn('callback_fenced');
    const guardedOauth = guardedOauthFor(policy);
    expect(() => guardedOauth.handleCallback('synthetic', { trustedContinuation: true })).toThrow(
      /fenced|handoff/i,
    );
  });

  it('refuses a direct Microsoft calendar command in a selected phase before its delegate', async () => {
    const { guardMicrosoftGraphSyncService } = await import(
      './engagement-integration-runtime.boundary.js'
    );
    const policy = policyIn('initiation_fenced');
    const delegate = jest.fn(async () => 'ran');
    const guarded = guardMicrosoftGraphSyncService(
      { runCalendarCommand: delegate } as never,
      policy,
    ) as never as { runCalendarCommand: (...args: unknown[]) => Promise<unknown> };

    // The NEW gate is synchronous, so the refusal happens at the call.
    expect(() => guarded.runCalendarCommand('synthetic')).toThrow(/fenced|handoff/i);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('refuses a direct Google calendar command in a selected phase before its delegate', async () => {
    const { guardGoogleSyncService } = await import('./engagement-integration-runtime.boundary.js');
    const policy = policyIn('initiation_fenced');
    const delegate = jest.fn(async () => 'ran');
    const guarded = guardGoogleSyncService({ runCalendarCommand: delegate } as never, policy) as never as {
      runCalendarCommand: (...args: unknown[]) => Promise<unknown>;
    };

    expect(() => guarded.runCalendarCommand('synthetic')).toThrow(/fenced|handoff/i);
    expect(delegate).not.toHaveBeenCalled();
  });
});

describe('mail handoff selection parsing', () => {
  it('accepts an explicit phase with an ISO-8601 instant and normalizes it', () => {
    expect(
      parseEngagementMailHandoffSelection({
        ENGAGEMENT_MAIL_HANDOFF_PHASE: ' Initiation_Fenced ',
        ENGAGEMENT_MAIL_HANDOFF_GENERATION: ' gen-7 ',
        ENGAGEMENT_MAIL_HANDOFF_FENCE_UTC: '2026-10-29T01:02:03Z',
      }),
    ).toEqual({
      phase: 'initiation_fenced',
      generation: 'gen-7',
      fenceUtc: '2026-10-29T01:02:03.000Z',
    });
  });

  it('treats an omitted instant as unproven rather than the epoch', () => {
    expect(
      parseEngagementMailHandoffSelection({ ENGAGEMENT_MAIL_HANDOFF_PHASE: 'callback_fenced' }),
    ).toEqual({ phase: 'callback_fenced', generation: null, fenceUtc: null });
  });

  it('fails closed on an unknown phase, an orphan companion or a bad instant', () => {
    expect(() =>
      parseEngagementMailHandoffSelection({ ENGAGEMENT_MAIL_HANDOFF_PHASE: 'hold' }),
    ).toThrow(/ENGAGEMENT_MAIL_HANDOFF_PHASE/);
    expect(() =>
      parseEngagementMailHandoffSelection({ ENGAGEMENT_MAIL_HANDOFF_GENERATION: 'g1' }),
    ).toThrow(/require ENGAGEMENT_MAIL_HANDOFF_PHASE/);
    expect(() =>
      parseEngagementMailHandoffSelection({
        ENGAGEMENT_MAIL_HANDOFF_PHASE: 'initiation_fenced',
        ENGAGEMENT_MAIL_HANDOFF_FENCE_UTC: 'yesterday',
      }),
    ).toThrow(/ISO-8601/);
    expect(() =>
      parseEngagementMailHandoffSelection({
        ENGAGEMENT_MAIL_HANDOFF_PHASE: 'off',
        ENGAGEMENT_MAIL_HANDOFF_GENERATION: 'g1',
      }),
    ).toThrow(/must not carry/);
  });

  it('cannot reset another owner: a second construction with no selection changes nothing', () => {
    const fencedBarrier = new EngagementMailHandoffBarrier();
    const fenced = new EngagementRuntimePolicyService(
      {
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: false,
        mailHandoff: { phase: 'initiation_fenced', generation: 'g1', fenceUtc: null },
      },
      fencedBarrier,
    );
    expect(fenced.mailHandoffPhase()).toBe('initiation_fenced');

    // A helper owner that starts without a selection must not clear the fence.
    new EngagementRuntimePolicyService(
      {
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: false,
      },
      fencedBarrier,
    );
    expect(fenced.mailHandoffPhase()).toBe('initiation_fenced');
    expect(fenced.mailHandoffObservation()!.generation).toBe('g1');
    expect(() => fenced.assertMailHandoffBoundary('integration_create')).toThrow(/fenced|handoff/i);
  });
});

describe('runAdmitted disposition ownership', () => {
  it('settles ONCE with the owner-returned unknown outcome', async () => {
    const policy = policyIn('initiation_fenced');
    let calls = 0;
    const disposition = () => {
      calls += 1;
      return 'unknown' as const;
    };
    await policy.runAdmittedMailHandoffWork(
      'callback_notification_admit',
      async () => 'done',
      disposition,
    );
    expect(calls).toBe(1);
    const observation = policy.mailHandoffObservation()!;
    expect(observation.unknownTotal).toBe(1);
    expect(observation.activeTotal).toBe(0);
    expect(observation.liveAdmissionCount).toBe(0);
    expect(observation.outcomeReconciled).toBe(false);
  });

  it('retains unknown for a thrown work result and preserves the original error', async () => {
    const policy = policyIn('initiation_fenced');
    let calls = 0;
    const workError = new Error('provider response indeterminate');
    const disposition = () => {
      calls += 1;
      return 'unknown' as const;
    };
    await expect(
      policy.runAdmittedMailHandoffWork(
        'callback_notification_admit',
        async () => {
          throw workError;
        },
        disposition,
      ),
    ).rejects.toBe(workError);
    expect(calls).toBe(1);
    const observation = policy.mailHandoffObservation()!;
    expect(observation.unknownTotal).toBe(1);
    expect(observation.failedTotal).toBe(0);
    expect(observation.activeTotal).toBe(0);
    expect(observation.liveAdmissionCount).toBe(0);
  });

  it('retains unknown when the classifier itself throws, leaving no live authority', async () => {
    const policy = policyIn('initiation_fenced');
    let calls = 0;
    const disposition = () => {
      calls += 1;
      throw new Error('classifier exploded');
    };
    await expect(
      policy.runAdmittedMailHandoffWork(
        'callback_notification_admit',
        async () => 'done',
        disposition,
      ),
    ).resolves.toBe('done');
    expect(calls).toBe(1);
    const observation = policy.mailHandoffObservation()!;
    expect(observation.unknownTotal).toBe(1);
    expect(observation.settledTotal).toBe(0);
    expect(observation.activeTotal).toBe(0);
    expect(observation.liveAdmissionCount).toBe(0);
  });
});

describe('mail handoff binding conflicts', () => {
  const legacyPosture = {
    serviceName: 'api' as const,
    processMode: 'active' as const,
    backgroundOwner: 'api' as const,
    externalActions: 'enabled' as const,
    callbacksEnabled: true,
    recallWebhookEnabled: false,
  };

  it('rejects an explicit fence when the process is already bound off', () => {
    const barrier = new EngagementMailHandoffBarrier();
    new EngagementRuntimePolicyService({ ...legacyPosture }, barrier);
    expect(
      () =>
        new EngagementRuntimePolicyService(
          {
            ...legacyPosture,
            mailHandoff: { phase: 'initiation_fenced', generation: 'g1', fenceUtc: null },
          },
          barrier,
        ),
    ).toThrow(/conflict/i);
    // The prior owner is untouched, not silently fenced and not silently off.
    const stillLegacy = new EngagementRuntimePolicyService({ ...legacyPosture }, barrier);
    expect(stillLegacy.mailHandoffPhase()).toBe('off');
    expect(stillLegacy.mailHandoffObservation()).toBeNull();
  });

  it('rejects a conflicting generation on an already fenced process', () => {
    const barrier = new EngagementMailHandoffBarrier();
    const first = new EngagementRuntimePolicyService(
      {
        ...legacyPosture,
        mailHandoff: { phase: 'initiation_fenced', generation: 'g1', fenceUtc: null },
      },
      barrier,
    );
    expect(() =>
      new EngagementRuntimePolicyService(
        {
          ...legacyPosture,
          mailHandoff: { phase: 'initiation_fenced', generation: 'g2', fenceUtc: null },
        },
        barrier,
      ),
    ).toThrow(/conflict/i);
    expect(first.mailHandoffPhase()).toBe('initiation_fenced');
    expect(first.mailHandoffObservation()!.generation).toBe('g1');
    // An agreeing bind stays a no-op.
    expect(
      () =>
        new EngagementRuntimePolicyService(
          {
            ...legacyPosture,
            mailHandoff: { phase: 'initiation_fenced', generation: 'g1', fenceUtc: null },
          },
          barrier,
        ),
    ).not.toThrow();
  });
});
