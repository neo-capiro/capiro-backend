import type { PrismaService } from '../prisma/prisma.service.js';

export class Phase9RuntimeHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly input: {
      jobKey:
        | 'capture-worker'
        | 'intelligence-worker'
        | 'hearing-media-worker'
        | 'hearing-delivery-worker';
      workerId: string;
      manual?: boolean;
      heartbeatMs?: number;
      log?: (message: string) => void;
    },
  ) {}

  async begin(): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ enabled: boolean; scheduleEnabled: boolean }>
    >(
      `SELECT enabled,
              schedule_enabled AS "scheduleEnabled"
       FROM legiwatch_runtime_heartbeat
       WHERE job_key=$1
       LIMIT 1`,
      this.input.jobKey,
    );
    const row = rows[0];
    if (!row) throw new Error(`Phase 9 runtime job ${this.input.jobKey} is not registered`);
    if (!this.input.manual && (!row.enabled || !row.scheduleEnabled)) {
      throw new Error(`Phase 9 runtime job ${this.input.jobKey} is dark/disabled`);
    }
    this.startedAt = Date.now();
    await this.prisma.$executeRawUnsafe(
      `UPDATE legiwatch_runtime_heartbeat
       SET status='running',
           last_started_at=now(),
           last_heartbeat_at=now(),
           last_error=NULL,
           metrics=COALESCE(metrics, '{}'::jsonb) || $2::jsonb,
           updated_at=now()
       WHERE job_key=$1`,
      this.input.jobKey,
      JSON.stringify({ workerId: this.input.workerId }),
    );
    const heartbeatMs = Math.max(15_000, this.input.heartbeatMs ?? 60_000);
    this.timer = setInterval(() => {
      void this.beat().catch((error) => {
        this.input.log?.(`[phase9] ${this.input.jobKey} heartbeat failed: ${boundedError(error)}`);
      });
    }, heartbeatMs);
    this.timer.unref();
  }

  async beat(metrics: Record<string, unknown> = {}): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE legiwatch_runtime_heartbeat
       SET status='running',
           last_heartbeat_at=now(),
           metrics=COALESCE(metrics, '{}'::jsonb) || $2::jsonb,
           updated_at=now()
       WHERE job_key=$1`,
      this.input.jobKey,
      JSON.stringify({
        workerId: this.input.workerId,
        elapsedMs: Math.max(0, Date.now() - this.startedAt),
        ...metrics,
      }),
    );
  }

  async succeed(metrics: Record<string, unknown> = {}): Promise<void> {
    this.stopTimer();
    await this.prisma.$executeRawUnsafe(
      `UPDATE legiwatch_runtime_heartbeat
       SET status='succeeded',
           last_heartbeat_at=now(),
           last_success_at=now(),
           last_finished_at=now(),
           consecutive_failures=0,
           last_error=NULL,
           metrics=COALESCE(metrics, '{}'::jsonb) || $2::jsonb,
           updated_at=now()
       WHERE job_key=$1`,
      this.input.jobKey,
      JSON.stringify({
        workerId: this.input.workerId,
        durationMs: Math.max(0, Date.now() - this.startedAt),
        ...metrics,
      }),
    );
  }

  async fail(error: unknown, metrics: Record<string, unknown> = {}): Promise<void> {
    this.stopTimer();
    await this.prisma.$executeRawUnsafe(
      `UPDATE legiwatch_runtime_heartbeat
       SET status='failed',
           last_heartbeat_at=now(),
           last_failure_at=now(),
           last_finished_at=now(),
           consecutive_failures=consecutive_failures+1,
           last_error=$2,
           metrics=COALESCE(metrics, '{}'::jsonb) || $3::jsonb,
           updated_at=now()
       WHERE job_key=$1`,
      this.input.jobKey,
      boundedError(error),
      JSON.stringify({
        workerId: this.input.workerId,
        durationMs: Math.max(0, Date.now() - this.startedAt),
        ...metrics,
      }),
    );
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function scalarMetrics(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      output[key] = item;
    }
  }
  return output;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}
