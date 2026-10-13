import type { HttpAdapterHost } from '@nestjs/core';

const TASK_SWEEP_MS = 1_500;
const SCHEDULE_SWEEP_MS = 60_000;

export interface CompletionRuntimePorts {
  requestTaskSweep(): void;
  requestScheduleSweep(): void;
  sweepOnce(): Promise<void>;
  sweepSchedulesOnce(): Promise<void>;
  log(message: string): void;
  error(message: string): void;
  safeError(error: unknown): string;
}

/** One owner for completion timer lifecycle and fire-and-forget sweep requests. */
export class ClientProfileFillCompletionRuntime {
  private taskTimer?: ReturnType<typeof setInterval>;
  private scheduleTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly workerId: string,
    private readonly ports: CompletionRuntimePorts,
  ) {}

  onModuleInit(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED === 'false' ||
      // `NestFactory.createApplicationContext(AppModule, ...)` (e.g. the
      // LegiWatch Phase 9 one-shot CLI bootstraps, and any future one-off
      // script that reuses the full AppModule) never registers an HTTP
      // adapter, so `httpAdapterHost.httpAdapter` stays unset there. Those
      // processes run their one job in ~1s and call `app.close()`, which
      // disconnects PrismaService — starting this sweep loop in that context
      // means its interval-scheduled `withSystem`/`withTenant` call races the
      // disconnect and throws "Transaction API error: Transaction not found
      // ... obtained before disconnecting" on every invocation. Only the real
      // long-running server (`apps/api/src/main.ts`, `NestFactory.create`)
      // has a populated httpAdapter. See ClientProfileFillWorkflowService's
      // identical guard for the same class of bug.
      !this.httpAdapterHost?.httpAdapter
    ) {
      return;
    }
    this.taskTimer = setInterval(() => this.ports.requestTaskSweep(), TASK_SWEEP_MS);
    this.taskTimer.unref?.();
    this.scheduleTimer = setInterval(() => this.ports.requestScheduleSweep(), SCHEDULE_SWEEP_MS);
    this.scheduleTimer.unref?.();
    queueMicrotask(() => {
      this.ports.requestTaskSweep();
      this.ports.requestScheduleSweep();
    });
    this.ports.log(`Fill with Meri completion worker started (${this.workerId})`);
  }

  onModuleDestroy(): void {
    if (this.taskTimer) clearInterval(this.taskTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
  }

  requestTaskSweep(): void {
    void this.ports
      .sweepOnce()
      .catch((error) =>
        this.ports.error(`Fill completion sweep failed: ${this.ports.safeError(error)}`),
      );
  }

  requestScheduleSweep(): void {
    void this.ports
      .sweepSchedulesOnce()
      .catch((error) =>
        this.ports.error(`Fill refresh schedule sweep failed: ${this.ports.safeError(error)}`),
      );
  }
}
