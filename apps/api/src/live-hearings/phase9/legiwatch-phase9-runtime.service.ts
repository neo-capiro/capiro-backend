import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { isRuntimeJobFresh } from './legiwatch-phase9-gates.js';
import type { LegiWatchPhase9RuntimeJob } from './legiwatch-phase9.types.js';

interface RuntimeRow {
  jobKey: string;
  jobType: string;
  status: string;
  enabled: boolean;
  scheduleEnabled: boolean;
  expectedIntervalSeconds: number | null;
  maxLagSeconds: number | null;
  ruleName: string | null;
  taskFamily: string | null;
  lastStartedAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFinishedAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  metrics: unknown;
}

export interface LegiWatchRuntimeRegistration {
  jobKey: string;
  enabled: boolean;
  scheduleEnabled: boolean;
  ruleName?: string | null;
  taskFamily?: string | null;
}

@Injectable()
export class LegiWatchPhase9RuntimeService {
  constructor(private readonly prisma: PrismaService) {}

  async list(now = new Date()): Promise<LegiWatchPhase9RuntimeJob[]> {
    const rows = await this.rows();
    return rows.map((row) => mapRow(row, now));
  }

  async get(jobKey: string, now = new Date()): Promise<LegiWatchPhase9RuntimeJob> {
    const rows = await this.rows(jobKey);
    const row = rows[0];
    if (!row) throw new NotFoundException(`LegiWatch runtime job ${jobKey} not found`);
    return mapRow(row, now);
  }

  async begin(input: {
    jobKey: string;
    workerId: string;
    manual?: boolean;
  }): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ enabled: boolean; scheduleEnabled: boolean }>>(
      `SELECT enabled,
              schedule_enabled AS "scheduleEnabled"
       FROM legiwatch_runtime_heartbeat
       WHERE job_key=$1
       LIMIT 1`,
      input.jobKey,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(`LegiWatch runtime job ${input.jobKey} not found`);
    if (!input.manual && (!row.enabled || !row.scheduleEnabled)) {
      throw new Error(`LegiWatch runtime job ${input.jobKey} is dark/disabled`);
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE legiwatch_runtime_heartbeat
       SET status='running',
           last_started_at=now(),
           last_heartbeat_at=now(),
           last_error=NULL,
           metrics=jsonb_set(
             COALESCE(metrics, '{}'::jsonb),
             '{workerId}',
             to_jsonb($2::text),
             true
           ),
           updated_at=now()
       WHERE job_key=$1`,
      input.jobKey,
      bounded(input.workerId, 200),
    );
  }

  async heartbeat(input: {
    jobKey: string;
    workerId?: string;
    metrics?: Record<string, unknown>;
  }): Promise<void> {
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE legiwatch_runtime_heartbeat
       SET last_heartbeat_at=now(),
           status=CASE WHEN status='disabled' THEN status ELSE 'running' END,
           metrics=COALESCE(metrics, '{}'::jsonb) || $2::jsonb,
           updated_at=now()
       WHERE job_key=$1`,
      input.jobKey,
      JSON.stringify({
        ...(input.metrics ?? {}),
        ...(input.workerId ? { workerId: bounded(input.workerId, 200) } : {}),
      }),
    );
    if (count === 0) throw new NotFoundException(`LegiWatch runtime job ${input.jobKey} not found`);
  }

  async succeed(input: {
    jobKey: string;
    metrics?: Record<string, unknown>;
  }): Promise<void> {
    const count = await this.prisma.$executeRawUnsafe(
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
      input.jobKey,
      JSON.stringify(input.metrics ?? {}),
    );
    if (count === 0) throw new NotFoundException(`LegiWatch runtime job ${input.jobKey} not found`);
  }

  async fail(input: {
    jobKey: string;
    error: unknown;
    metrics?: Record<string, unknown>;
  }): Promise<void> {
    const count = await this.prisma.$executeRawUnsafe(
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
      input.jobKey,
      boundedError(input.error),
      JSON.stringify(input.metrics ?? {}),
    );
    if (count === 0) throw new NotFoundException(`LegiWatch runtime job ${input.jobKey} not found`);
  }

  async run<T>(input: {
    jobKey: string;
    workerId: string;
    manual?: boolean;
    execute: () => Promise<T>;
    metrics?: (result: T) => Record<string, unknown>;
  }): Promise<T> {
    await this.begin({
      jobKey: input.jobKey,
      workerId: input.workerId,
      manual: input.manual,
    });
    const started = Date.now();
    try {
      const result = await input.execute();
      await this.succeed({
        jobKey: input.jobKey,
        metrics: {
          durationMs: Date.now() - started,
          ...(input.metrics?.(result) ?? {}),
        },
      });
      return result;
    } catch (error) {
      await this.fail({
        jobKey: input.jobKey,
        error,
        metrics: { durationMs: Date.now() - started },
      });
      throw error;
    }
  }

  async registerSchedules(input: {
    registrations: LegiWatchRuntimeRegistration[];
    actor: string;
    confirmation: string;
  }): Promise<LegiWatchPhase9RuntimeJob[]> {
    const expected = input.registrations.some((row) => row.scheduleEnabled)
      ? 'ENABLE LEGIWATCH SCHEDULES'
      : 'DISABLE LEGIWATCH SCHEDULES';
    if (input.confirmation !== expected) {
      throw new Error(`Exact confirmation required: ${expected}`);
    }
    if (!input.registrations.length) throw new Error('At least one runtime registration is required');
    const actor = bounded(input.actor, 200);
    await this.prisma.withSystem(async (tx) => {
      for (const registration of input.registrations) {
        const count = await tx.$executeRawUnsafe(
          `UPDATE legiwatch_runtime_heartbeat
           SET enabled=$2,
               schedule_enabled=$3,
               status=CASE WHEN $2 AND $3 THEN 'idle' ELSE 'disabled' END,
               rule_name=$4,
               task_family=$5,
               last_error=NULL,
               metrics=COALESCE(metrics, '{}'::jsonb) || $6::jsonb,
               updated_at=now()
           WHERE job_key=$1`,
          registration.jobKey,
          registration.enabled,
          registration.scheduleEnabled,
          registration.ruleName ? bounded(registration.ruleName, 300) : null,
          registration.taskFamily ? bounded(registration.taskFamily, 300) : null,
          JSON.stringify({ registeredBy: actor, registeredAt: new Date().toISOString() }),
        );
        if (count === 0) {
          throw new NotFoundException(`LegiWatch runtime job ${registration.jobKey} not found`);
        }
      }
      const allEnabled = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*) FILTER (WHERE enabled AND schedule_enabled)::int AS count
         FROM legiwatch_runtime_heartbeat`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE legiwatch_cutover_state
         SET schedules_enabled=($1 > 0),
             updated_by=$2,
             updated_at=now()
         WHERE id='global'`,
        allEnabled[0]?.count ?? 0,
        actor,
      );
    });
    return this.list();
  }

  private async rows(jobKey?: string): Promise<RuntimeRow[]> {
    return this.prisma.$queryRawUnsafe<RuntimeRow[]>(
      `SELECT job_key AS "jobKey",
              job_type AS "jobType",
              status,
              enabled,
              schedule_enabled AS "scheduleEnabled",
              expected_interval_seconds AS "expectedIntervalSeconds",
              max_lag_seconds AS "maxLagSeconds",
              rule_name AS "ruleName",
              task_family AS "taskFamily",
              last_started_at AS "lastStartedAt",
              last_heartbeat_at AS "lastHeartbeatAt",
              last_success_at AS "lastSuccessAt",
              last_failure_at AS "lastFailureAt",
              last_finished_at AS "lastFinishedAt",
              consecutive_failures AS "consecutiveFailures",
              last_error AS "lastError",
              metrics
       FROM legiwatch_runtime_heartbeat
       WHERE ($1::text IS NULL OR job_key=$1)
       ORDER BY job_key`,
      jobKey ?? null,
    );
  }
}

function mapRow(row: RuntimeRow, now: Date): LegiWatchPhase9RuntimeJob {
  const stale = !isRuntimeJobFresh({
    enabled: row.enabled,
    scheduleEnabled: row.scheduleEnabled,
    status: row.status,
    maxLagSeconds: row.maxLagSeconds,
    lastHeartbeatAt: row.lastHeartbeatAt,
    now,
  });
  return {
    jobKey: row.jobKey,
    jobType: row.jobType,
    status: row.status,
    enabled: row.enabled,
    scheduleEnabled: row.scheduleEnabled,
    expectedIntervalSeconds: row.expectedIntervalSeconds,
    maxLagSeconds: row.maxLagSeconds,
    lastStartedAt: row.lastStartedAt?.toISOString() ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastFinishedAt: row.lastFinishedAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastError: row.lastError,
    metrics: safeRecord(row.metrics),
    stale,
  };
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bounded(value: string, maximum: number): string {
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximum);
  if (!clean) throw new Error('A non-empty value is required');
  return clean;
}

function boundedError(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), 1_000);
}
