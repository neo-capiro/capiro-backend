/**
 * Focused injected checks for the mail-handoff shutdown join (SCRUM-190 approved
 * lifecycle change). Real policy/barrier, fake application close and deferred owned
 * work only: no Nest bootstrap, no real process signal, no Prisma/provider/DB.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { installMailHandoffShutdownJoin } from './engagement-mail-handoff-shutdown.js';
import { EngagementMailHandoffBarrier } from './engagement-mail-handoff.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

type Phase = 'off' | 'initiation_fenced' | 'callback_fenced' | 'writers_closed';

function policy(phase: Phase) {
  const barrier = new EngagementMailHandoffBarrier();
  barrier.bind({
    serviceName: 'api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'enabled',
    callbacksEnabled: true,
    recallWebhookEnabled: false,
    mailHandoff: { phase, generation: 'g1', fenceUtc: '2026-10-29T00:00:00.000Z' },
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

function fakeSignalSource() {
  const listeners = new Map<string, () => void>();
  const removed: string[] = [];
  return {
    listeners,
    removed,
    source: {
      on: (signal: string, listener: () => void) => {
        listeners.set(signal, listener);
        return undefined;
      },
      removeListener: (signal: string) => {
        removed.push(signal);
        return undefined;
      },
    },
  };
}

function fakeApp(order: string[], logger: { log: jest.Mock }) {
  const state = {
    closed: 0,
    closeArgs: [] as unknown[],
    loggedBeforeClose: -1,
    exitCodes: [] as number[],
  };
  const app = {
    close: jest.fn(async (signal?: string) => {
      state.closed += 1;
      state.closeArgs.push(signal);
      state.loggedBeforeClose = logger.log.mock.calls.length;
      order.push('app-close');
    }),
  };
  const signals = fakeSignalSource();
  const exit = (code: number): void => {
    state.exitCodes.push(code);
  };
  // Every test installs through the injected signal/termination seam: no real
  // process listener is ever registered by this suite.
  const install = (policyArg: unknown, loggerArg: unknown) =>
    installMailHandoffShutdownJoin(app, policyArg as never, loggerArg as never, {
      signalSource: signals.source as never,
      exit,
    });
  return { app, state, signals, exit, install };
}

function fakeLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function parseObservation(message: string) {
  return JSON.parse(message.slice('mail handoff final observation '.length));
}

describe('mail handoff shutdown join', () => {
  it('closes new admission synchronously and delays teardown until owned work settles', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const order: string[] = [];
    const logger = fakeLogger();
    const { app, state, install } = fakeApp(order, logger);
    install(runtimePolicy, logger);

    const gate = deferred();
    const owned = barrier.runAdmitted('callback_notification_admit', () => gate.promise);
    await flush();

    const closing = app.close();
    await flush();

    // New admission is closed, but teardown has NOT run while the child is live.
    expect(barrier.observation()?.admissionClosedLocally).toBe(true);
    expect(state.closed).toBe(0);
    expect(order).toEqual([]);

    gate.resolve();
    await owned;
    await closing;

    expect(state.closed).toBe(1);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(state.loggedBeforeClose).toBe(1);
    const message = logger.log.mock.calls[0]?.[0] as string;
    expect(message.startsWith('mail handoff final observation ')).toBe(true);
    const observation = JSON.parse(message.slice('mail handoff final observation '.length));
    expect(observation.configuredPhase).toBe('initiation_fenced');
    expect(observation.localClosure).toBe(true);
    expect(observation.activeTotal).toBe(0);
  });

  it('shares one completion across repeated close/signal entry', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const order: string[] = [];
    const logger = fakeLogger();
    const { app, state, install } = fakeApp(order, logger);
    install(runtimePolicy, logger);

    const gate = deferred();
    const owned = barrier.runAdmitted('callback_notification_admit', () => gate.promise);
    await flush();

    const first = app.close();
    const second = app.close();
    expect(second).toBe(first);

    gate.resolve();
    await owned;
    await Promise.all([first, second]);

    expect(state.closed).toBe(1);
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it('retains an unknown outcome in the final observation', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const order: string[] = [];
    const logger = fakeLogger();
    const { app, install } = fakeApp(order, logger);
    install(runtimePolicy, logger);

    const handle = barrier.admitWork('callback_notification_admit');
    handle.disposition.unknown();
    handle.settle();

    await app.close();

    const message = logger.log.mock.calls[0]?.[0] as string;
    const observation = JSON.parse(message.slice('mail handoff final observation '.length));
    expect(observation.localClosure).toBe(true);
    expect(observation.unknownTotal).toBe(1);
    expect(observation.outcomeReconciled).toBe(false);
  });

  it('keeps default off behavior: no drain, no observation, direct teardown', async () => {
    const { runtimePolicy } = policy('off');
    const order: string[] = [];
    const logger = fakeLogger();
    const { app, state, install } = fakeApp(order, logger);
    install(runtimePolicy, logger);

    await app.close();

    expect(state.closed).toBe(1);
    expect(logger.log).not.toHaveBeenCalled();
    expect(runtimePolicy.mailHandoffObservation()).toBeNull();
  });

  it('still tears down when the owned work rejects, without inventing success', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const order: string[] = [];
    const logger = fakeLogger();
    const { app, state, install } = fakeApp(order, logger);
    install(runtimePolicy, logger);

    const failing = barrier.runAdmitted('callback_notification_admit', async () => {
      throw new Error('owned work failed');
    });
    await expect(failing).rejects.toThrow('owned work failed');

    await app.close();

    expect(state.closed).toBe(1);
    const message = logger.log.mock.calls[0]?.[0] as string;
    const observation = JSON.parse(message.slice('mail handoff final observation '.length));
    expect(observation.failedTotal).toBe(1);
    expect(observation.unknownTotal).toBe(0);
  });

  it('drains before teardown when the registered SIGTERM listener fires', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const order: string[] = [];
    const logger = fakeLogger();
    const { app, state, signals, install } = fakeApp(order, logger);
    install(runtimePolicy, logger);

    const gate = deferred();
    const owned = barrier.runAdmitted('callback_notification_admit', () => gate.promise);
    await flush();

    const onTerm = signals.listeners.get('SIGTERM');
    expect(typeof onTerm).toBe('function');
    onTerm?.();
    await flush();

    // The exact registered callback closed admission and is still draining.
    expect(barrier.observation()?.admissionClosedLocally).toBe(true);
    expect(state.closed).toBe(0);
    expect(state.exitCodes).toEqual([]);
    expect(logger.log).not.toHaveBeenCalled();

    gate.resolve();
    await owned;
    await flush();

    expect(state.closed).toBe(1);
    expect(state.loggedBeforeClose).toBe(1);
    expect(parseObservation(logger.log.mock.calls[0]?.[0] as string).localClosure).toBe(true);
    expect(state.exitCodes).toEqual([0]);
    expect(signals.removed).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT']));
  });

  it('shares one completion across repeated signals and an explicit close during the drain', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const order: string[] = [];
    const logger = fakeLogger();
    const { app, state, signals, install } = fakeApp(order, logger);
    install(runtimePolicy, logger);

    const gate = deferred();
    const owned = barrier.runAdmitted('callback_notification_admit', () => gate.promise);
    await flush();

    signals.listeners.get('SIGTERM')?.();
    signals.listeners.get('SIGINT')?.();
    void app.close();
    await flush();

    gate.resolve();
    await owned;
    await flush();

    expect(state.closed).toBe(1);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(state.exitCodes).toEqual([0]);
  });

  it('preserves the explicit close argument through to the original close', async () => {
    const { runtimePolicy } = policy('initiation_fenced');
    const order: string[] = [];
    const logger = fakeLogger();
    const { app, state, install } = fakeApp(order, logger);
    install(runtimePolicy, logger);

    await app.close('SIGTERM');
    expect(state.closeArgs).toEqual(['SIGTERM']);
  });

  it('terminates non-zero with no successful observation when the drain itself fails', async () => {
    const logger = fakeLogger();
    const order: string[] = [];
    const { app, state, signals, exit } = fakeApp(order, logger);
    const failingPolicy = {
      beginMailHandoffLocalShutdown: jest.fn(),
      waitForMailHandoffLocalSettlement: async () => {
        throw new Error('drain failed');
      },
      mailHandoffObservation: () => ({ configuredPhase: 'initiation_fenced' }),
    };
    installMailHandoffShutdownJoin(app, failingPolicy as never, logger as never, {
      signalSource: signals.source as never,
      exit,
    });

    signals.listeners.get('SIGTERM')?.();
    await flush();

    expect(state.closed).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(state.exitCodes).toEqual([1]);
  });
});
