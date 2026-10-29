/**
 * Bounded mail-handoff shutdown join (SCRUM-190 approved lifecycle change).
 *
 * WHY THIS OWNS THE SIGNAL PATH: the retained Nest 10.4.22
 * `listenToShutdownSignals` cleanup callback calls `callDestroyHook()` ->
 * `callBeforeShutdownHook()` -> `dispose()` -> `callShutdownHook()` -> `process.kill`
 * DIRECTLY. It never calls `app.close()`, so neither a `beforeApplicationShutdown`
 * drain nor wrapping `close` alone runs early enough: Prisma's
 * `onModuleDestroy`/`$disconnect` has already happened.
 *
 * In a SELECTED handoff phase the bootstrap therefore installs this join INSTEAD of
 * `app.enableShutdownHooks()`, and the join is the single authoritative path:
 *
 *   SIGTERM/SIGINT --> run(signal)
 *     beginLocalShutdown()            synchronous; NEW admission stops
 *     await waitForLocalSettlement()  real promises of already-owned work
 *     log ONE final observation       content-free; skipped when off
 *     await originalClose(signal)     Nest teardown, exactly once
 *     terminate(0)
 *
 * Explicit `app.close(signal?)` shares the same completion, so repeated signals and a
 * concurrent close produce one drain, one teardown and one termination. A failing
 * drain logs an error and terminates non-zero without ever emitting a successful
 * final observation.
 *
 * Default (handoff unset) does not use this join: the bootstraps keep their previous
 * behavior (C enables Nest's hooks; the engagement bootstrap had none).
 */
import type { LoggerService } from '@nestjs/common';
import type { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

/** The only application surface this join needs. */
export interface ClosableApplication {
  close(signal?: NodeJS.Signals): Promise<unknown> | unknown;
}

/** Injected signal registration/termination seam (production binds `process`). */
export interface ShutdownSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener?(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface MailHandoffShutdownOptions {
  signals?: NodeJS.Signals[];
  signalSource?: ShutdownSignalSource;
  exit?: (code: number) => void;
}

/** What the join installed: the shared completion plus the close it wrapped. */
export interface MailHandoffShutdownJoin {
  close(signal?: NodeJS.Signals): Promise<void>;
}

export function installMailHandoffShutdownJoin(
  app: ClosableApplication,
  policy: EngagementRuntimePolicyService,
  logger: LoggerService,
  options: MailHandoffShutdownOptions = {},
): MailHandoffShutdownJoin {
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);
  const signalSource: ShutdownSignalSource = options.signalSource ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const originalClose = app.close.bind(app);

  let completion: Promise<void> | undefined;
  let terminated = false;
  const terminate = (code: number): void => {
    if (terminated) return;
    terminated = true;
    exit(code);
  };

  /** The ONE drain-then-teardown completion every entry shares. */
  const run = (signal?: NodeJS.Signals): Promise<void> => {
    completion ??= (async () => {
      // 1. Synchronously stop admitting NEW mail work on this process.
      policy.beginMailHandoffLocalShutdown();
      // 2. Wait for the real promises of work already admitted here. Nothing is
      //    reset and no unknown outcome is treated as success.
      await policy.waitForMailHandoffLocalSettlement();
      // 3. One content-free final predecessor observation through the existing log
      //    transport; absent when the handoff is off (observation() is null).
      const observation = policy.mailHandoffObservation();
      if (observation) {
        logger.log(`mail handoff final observation ${JSON.stringify(observation)}`);
      }
      // 4. Only now let Nest dispose providers and exit. The original close argument
      //    is preserved for any shutdown hook Nest still owns.
      await originalClose(signal);
    })();
    return completion;
  };

  const registered = new Map<NodeJS.Signals, () => void>();
  const onSignal = (signal: NodeJS.Signals): void => {
    void run(signal)
      .then(() => {
        for (const [sig, listener] of registered) {
          signalSource.removeListener?.(sig, listener);
        }
        terminate(0);
      })
      .catch((error: unknown) => {
        // Never claim a successful closure for a failed drain.
        logger.error(
          `mail handoff shutdown drain failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        terminate(1);
      });
  };

  for (const signal of signals) {
    const listener = (): void => onSignal(signal);
    registered.set(signal, listener);
    signalSource.on(signal, listener);
  }

  // Explicit close (and any concurrent caller) shares the same completion, so a
  // signal during a close cannot start a second drain or a second teardown.
  const close = (signal?: NodeJS.Signals): Promise<void> => run(signal);
  app.close = close;
  return { close };
}
