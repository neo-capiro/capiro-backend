import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlannerService } from './planner.service.js';

@Injectable()
export class PlannerSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlannerSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tenantCursor = '00000000-0000-0000-0000-000000000000';
  private readonly taskCursors = new Map<string, string>();
  private readonly goalCursors = new Map<string, string>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly planner: PlannerService,
  ) {}
  onModuleInit() {
    if (process.env.PLANNER_SCHEDULER_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
    this.logger.log('Planner configured date rules and goal reminders armed (60-second polling)');
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch {
      this.logger.error('Planner tenant discovery failed; next cycle will retry');
    } finally {
      this.running = false;
    }
  }
  async tickOnce(now = new Date()) {
    // The canonical membership table requires its existing system lookup policy.
    // Discover IDs only, then leave this transaction. NEVER read Planner withSystem:
    // tenant scoping is required, including for the new append-only tables
    // whose policies deliberately have no bypass branch.
    const tenants = await this.prisma.withSystem(
      (tx) => tx.$queryRaw<{ tenantId: string }[]>`
      SELECT DISTINCT tenant_id::text AS "tenantId" FROM tenant_memberships
      WHERE status = 'active' AND tenant_id > ${this.tenantCursor}::uuid
      ORDER BY "tenantId" LIMIT 20`,
    );
    if (!tenants.length) {
      this.tenantCursor = '00000000-0000-0000-0000-000000000000';
      return;
    }
    for (const { tenantId } of tenants) {
      try {
        const result = await this.planner.runScheduledWork(
          tenantId,
          now,
          this.taskCursors.get(tenantId),
        );
        if (result.nextCursor) this.taskCursors.set(tenantId, result.nextCursor);
        else this.taskCursors.delete(tenantId);
      } catch {
        this.logger.warn(`Planner tenant ${tenantId} scheduled work failed; next cycle will retry`);
      }
      try {
        const result = await this.planner.runScheduledGoalWork(
          tenantId,
          now,
          this.goalCursors.get(tenantId),
        );
        if (result.nextCursor) this.goalCursors.set(tenantId, result.nextCursor);
        else this.goalCursors.delete(tenantId);
      } catch {
        this.logger.warn(`Planner tenant ${tenantId} goal reminders failed; next cycle will retry`);
      }
    }
    this.tenantCursor =
      tenants.length < 20
        ? '00000000-0000-0000-0000-000000000000'
        : tenants[tenants.length - 1]!.tenantId;
    // Cursors are an optimization; durable tenant-scoped receipts are the authority.
    if (this.taskCursors.size > 10000) this.taskCursors.clear();
    if (this.goalCursors.size > 10000) this.goalCursors.clear();
  }
}
