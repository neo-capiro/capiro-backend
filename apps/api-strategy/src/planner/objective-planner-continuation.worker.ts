import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ObjectivePlannerContinuationRuntime } from './objective-planner-continuation.runtime.js';

/** Separate opt-in owner. The legacy draft worker continues to exclude canonical
 * work. Durable producer/operation rows survive browser and process closure. */
@Injectable()
export class ObjectivePlannerContinuationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObjectivePlannerContinuationWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private tenantCursor = '00000000-0000-0000-0000-000000000000';
  constructor(private readonly prisma: PrismaService, private readonly runtime: ObjectivePlannerContinuationRuntime) {}
  onModuleInit() {
    if (!this.runtime.enabled) return;
    this.timer = setInterval(() => void this.tick(), 2_000);
    this.timer.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick() {
    if (this.running || !this.runtime.enabled) return;
    this.running = true;
    try {
      // IDs only in system scope, matching existing Planner tenant discovery.
      // All source, operation, consent and output work is explicitly tenant scoped.
      const tenants = await this.prisma.withSystem(tx => tx.$queryRaw<Array<{ tenantId: string }>>`
        SELECT DISTINCT tenant_id::text AS "tenantId" FROM tenant_memberships
        WHERE status::text='active' AND tenant_id>${this.tenantCursor}::uuid
        ORDER BY "tenantId" LIMIT 20`);
      for (const row of tenants) {
        try { await this.runtime.consumeTenant(row.tenantId); }
        catch { this.logger.warn('One Objective Planner tenant pass remains pending durable recovery'); }
      }
      this.tenantCursor = tenants.length === 20 ? tenants[tenants.length - 1]!.tenantId
        : '00000000-0000-0000-0000-000000000000';
    } catch { this.logger.warn('Objective Planner continuation pass could not complete; durable work remains for recovery'); }
    finally { this.running = false; }
  }
}
