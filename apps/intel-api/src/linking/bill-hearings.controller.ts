import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerOwnerGuard } from '../tracker/tracker-owner.guard.js';
import { BillHearingsService } from './bill-hearings.service.js';

/**
 * Bill→Hearing interlink read (Phase 9). ONE endpoint surfacing the hearings a
 * tracked bill was discussed in (from the linker's `combined` intel_alert rows):
 *
 *   GET /intel-api/clients/:clientId/bills/:billId/hearings
 *     → { count, hearings: [{ sessionId, title, occurredAt, committeeId,
 *          mentions: [{ segmentId, timestampMs, speakerName, quote,
 *                       quoteSource, issueTags }] }] }
 *
 * Mounted under `/intel-api/clients/*` (global prefix + TenantGuard resolves the
 * tenant); TrackerOwnerGuard gates it to the intel-owned tenant (404 when off),
 * matching the tracker board/feed controllers. intel_alert carries FORCE ROW
 * LEVEL SECURITY scoped to tenant_id; the service additionally filters by
 * tenantId + clientId on every query.
 */
@Controller('clients')
@UseGuards(TenantGuard, TrackerOwnerGuard)
export class BillHearingsController {
  constructor(private readonly svc: BillHearingsService) {}

  @Get(':clientId/bills/:billId/hearings')
  getBillHearings(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('billId') billId: string,
  ) {
    return this.svc.getBillHearings(ctx.tenantId, clientId, billId);
  }
}
