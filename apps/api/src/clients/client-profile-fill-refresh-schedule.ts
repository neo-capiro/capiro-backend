import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  CLIENT_PROFILE_FILL_SOURCES,
  type ClientProfileFillSource,
} from './client-profile-fill.helpers.js';
import type {
  ClientProfileFillCompletionService,
  RefreshScheduleRow,
  UpdateClientProfileFillScheduleInput,
} from './client-profile-fill-completion.service.js';
import type { StartClientProfileFillWorkflowInput } from './client-profile-fill-workflow.service.js';

export interface RefreshSchedulePorts {
  assertClient(ctx: TenantContext, clientId: string): Promise<void>;
  startRun(
    ctx: TenantContext,
    clientId: string,
    input: StartClientProfileFillWorkflowInput,
  ): ReturnType<ClientProfileFillCompletionService['startRun']>;
  warn(message: string): void;
  safeError(error: unknown): string;
}

/** Complete authorized schedule configuration, claiming, refresh and rearming. */
export class ClientProfileFillRefreshSchedule {
  private scheduleSweepRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: RefreshSchedulePorts,
  ) {}

  async getSchedule(ctx: TenantContext, clientId: string) {
    await this.ports.assertClient(ctx, clientId);
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<RefreshScheduleRow[]>(
        `SELECT enabled,
                cadence_hours AS "cadenceHours",
                sources,
                next_run_at AS "nextRunAt",
                last_enqueued_at AS "lastEnqueuedAt",
                updated_by_user_id AS "updatedByUserId",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
           FROM client_profile_fill_schedule
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid`,
        ctx.tenantId,
        clientId,
      ),
    );
    return (
      rows[0] ?? {
        enabled: false,
        cadenceHours: 168,
        sources: [...CLIENT_PROFILE_FILL_SOURCES],
        nextRunAt: null,
        lastEnqueuedAt: null,
        updatedByUserId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
    );
  }

  async updateSchedule(
    ctx: TenantContext,
    clientId: string,
    input: UpdateClientProfileFillScheduleInput,
  ) {
    await this.ports.assertClient(ctx, clientId);
    const cadenceHours = input.cadenceHours ?? 168;
    if (!Number.isInteger(cadenceHours) || cadenceHours < 6 || cadenceHours > 720) {
      throw new BadRequestException('Refresh cadence must be between 6 and 720 hours');
    }
    const allowed = new Set<ClientProfileFillSource>(CLIENT_PROFILE_FILL_SOURCES);
    const sources = [
      ...new Set(input.sources?.length ? input.sources : CLIENT_PROFILE_FILL_SOURCES),
    ].filter((source): source is ClientProfileFillSource => allowed.has(source));
    if (!sources.length) throw new BadRequestException('Choose at least one refresh source');

    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_schedule
           (tenant_id, client_id, enabled, cadence_hours, sources, next_run_at,
            updated_by_user_id, updated_at)
         VALUES (
           $1::uuid, $2::uuid, $3, $4,
           ARRAY(SELECT jsonb_array_elements_text($5::jsonb)),
           CASE WHEN $3 THEN now() + make_interval(hours => $4) ELSE NULL END,
           $6::uuid, now()
         )
         ON CONFLICT (tenant_id, client_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               cadence_hours = EXCLUDED.cadence_hours,
               sources = EXCLUDED.sources,
               next_run_at = CASE
                 WHEN EXCLUDED.enabled THEN now() + make_interval(hours => EXCLUDED.cadence_hours)
                 ELSE NULL
               END,
               updated_by_user_id = EXCLUDED.updated_by_user_id,
               updated_at = now()`,
        ctx.tenantId,
        clientId,
        input.enabled,
        cadenceHours,
        JSON.stringify(sources),
        ctx.userId,
      ),
    );
    return this.getSchedule(ctx, clientId);
  }

  async refreshNow(ctx: TenantContext, clientId: string) {
    const schedule = await this.getSchedule(ctx, clientId);
    return this.ports.startRun(ctx, clientId, { sources: schedule.sources });
  }

  async sweepSchedulesOnce(): Promise<void> {
    if (this.scheduleSweepRunning) return;
    this.scheduleSweepRunning = true;
    try {
      const due = await this.prisma.withSystem((tx) =>
        tx.$queryRawUnsafe<
          Array<{
            tenantId: string;
            clientId: string;
            userId: string | null;
            sources: ClientProfileFillSource[];
            cadenceHours: number;
          }>
        >(
          `WITH due AS (
             SELECT tenant_id, client_id
               FROM client_profile_fill_schedule
              WHERE enabled = true AND next_run_at <= now()
              ORDER BY next_run_at ASC
              LIMIT 5
              FOR UPDATE SKIP LOCKED
           )
           UPDATE client_profile_fill_schedule schedule
              SET next_run_at = now() + make_interval(hours => schedule.cadence_hours),
                  updated_at = now()
             FROM due
            WHERE schedule.tenant_id = due.tenant_id AND schedule.client_id = due.client_id
           RETURNING schedule.tenant_id AS "tenantId",
                     schedule.client_id AS "clientId",
                     schedule.updated_by_user_id AS "userId",
                     schedule.sources,
                     schedule.cadence_hours AS "cadenceHours"`,
        ),
      );
      for (const row of due) await this.runScheduledRefresh(row);
    } finally {
      this.scheduleSweepRunning = false;
    }
  }

  async runScheduledRefresh(row: {
    tenantId: string;
    clientId: string;
    userId: string | null;
    sources: ClientProfileFillSource[];
    cadenceHours: number;
  }) {
    if (!row.userId) {
      await this.bumpSchedule(row.tenantId, row.clientId, row.cadenceHours, false);
      return;
    }
    const ctx: TenantContext = {
      tenantId: row.tenantId,
      tenantSlug: '',
      userId: row.userId,
      clerkUserId: '',
      role: 'standard_user',
    };
    try {
      await this.ports.startRun(ctx, row.clientId, { sources: row.sources });
      await this.bumpSchedule(row.tenantId, row.clientId, row.cadenceHours, true);
    } catch (error) {
      this.ports.warn(
        `Scheduled Fill with Meri refresh failed for ${row.clientId}: ${this.ports.safeError(error)}`,
      );
      await this.bumpSchedule(row.tenantId, row.clientId, Math.min(24, row.cadenceHours), false);
    }
  }

  async bumpSchedule(tenantId: string, clientId: string, cadenceHours: number, enqueued: boolean) {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_schedule
            SET next_run_at = now() + make_interval(hours => $3),
                last_enqueued_at = CASE WHEN $4 THEN now() ELSE last_enqueued_at END,
                updated_at = now()
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND enabled = true`,
        tenantId,
        clientId,
        cadenceHours,
        enqueued,
      ),
    );
  }
}
