import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientProfileFillService } from './client-profile-fill.service.js';
import type { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';
import type { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import {
  auditAdvanced,
  type AdvancedFindingRow,
  type FindingApplicationReporter,
} from './client-profile-fill-finding-review.shared.js';
import { ClientProfileFillAdvocacyRecordApplication } from './client-profile-fill-advocacy-record-application.js';
import { ClientProfileFillOutcomeApplication } from './client-profile-fill-outcome-application.js';

export interface FindingReviewPorts extends FindingApplicationReporter {
  getRun: ClientProfileFillCompletionService['getRun'];
  confirmedMappingKeys(ctx: TenantContext, clientId: string, source: string): Promise<Set<string>>;
}

const ADVANCED_FINDING_KINDS = new Set([
  'federal_footprint',
  'facility_resolution',
  'district_nexus',
  'advocacy_record',
  'advocacy_outcome',
  'regulatory_outcome',
  'profile_completion',
]);
const NON_APPLYABLE_ADVANCED_KINDS = new Set([
  'facility_resolution',
  'district_nexus',
  'profile_completion',
]);

/** Complete human review workflow; each writer retains its original transaction boundaries. */
export class ClientProfileFillFindingReview {
  private readonly recordApplication: ClientProfileFillAdvocacyRecordApplication;
  private readonly outcomeApplication: ClientProfileFillOutcomeApplication;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fill: ClientProfileFillService,
    private readonly advocacyMatters: ClientAdvocacyMatterService,
    private readonly ports: FindingReviewPorts,
  ) {
    this.recordApplication = new ClientProfileFillAdvocacyRecordApplication(
      prisma,
      advocacyMatters,
      ports,
    );
    this.outcomeApplication = new ClientProfileFillOutcomeApplication(
      prisma,
      advocacyMatters,
      ports,
    );
  }

  async applyFindings(ctx: TenantContext, clientId: string, runId: string, findingIds: string[]) {
    const findings = await this.loadFindings(ctx.tenantId, clientId, runId, findingIds);
    if (findings.length !== new Set(findingIds).size) {
      throw new BadRequestException('One or more findings are no longer available');
    }
    const advanced = findings.filter((finding) => ADVANCED_FINDING_KINDS.has(finding.kind));
    const coreIds = findings
      .filter((finding) => !ADVANCED_FINDING_KINDS.has(finding.kind))
      .map((finding) => finding.id);

    if (coreIds.length) await this.fill.applyFindings(ctx, clientId, runId, coreIds);
    advanced.sort((a, b) => {
      if (a.kind === 'advocacy_record' && b.kind === 'advocacy_outcome') return -1;
      if (a.kind === 'advocacy_outcome' && b.kind === 'advocacy_record') return 1;
      return 0;
    });
    for (const finding of advanced) {
      if (finding.status !== 'pending') {
        throw new BadRequestException('Only pending findings can be applied');
      }
      if (NON_APPLYABLE_ADVANCED_KINDS.has(finding.kind)) {
        throw new BadRequestException(
          'This item is informational and is not applied to the client record',
        );
      }
      await this.applyAdvancedFinding(ctx, clientId, finding);
      await this.markAccepted(ctx, clientId, finding.id);
    }
    return this.ports.getRun(ctx, clientId, runId);
  }

  /**
   * §22/23 follow-up: a reviewer picks "Attach to Matter X" / "Create new
   * Matter" directly on a still-pending advocacy_record finding. That
   * choice IS the review/approval decision — there is no separate staging
   * queue, no "save for later" state, and no second apply workflow. This
   * commits immediately: record upsert + Matter assign/lock (atomic, see
   * `applyAdvocacyRecord`) then `markAccepted` through the SAME
   * accept/audit path every other applied finding uses.
   *
   * Idempotent: if the finding is already `accepted` (a duplicate
   * invocation — e.g. a double-click, or a client retry after a response
   * was lost in transit), this makes NO writes at all and simply returns
   * the Matter the record already resolved to, read fresh. It does not
   * matter whether the retry's `target` matches the original choice —
   * once a finding is accepted, this method's job is done; further
   * correction goes through the existing reassign/detach/merge paths, not
   * a second application of this action.
   */
  async applyAdvocacyFindingToMatter(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    findingId: string,
    target:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<{ findingId: string; matterId: string | null; alreadyApplied: boolean }> {
    if ('matterId' in target === 'newMatter' in target) {
      throw new BadRequestException('Provide exactly one of matterId or newMatter');
    }
    const findings = await this.loadFindings(ctx.tenantId, clientId, runId, [findingId]);
    const finding = findings[0];
    if (!finding) throw new BadRequestException('Finding is no longer available');
    if (finding.kind !== 'advocacy_record') {
      throw new BadRequestException('Only advocacy findings support direct Matter assignment');
    }

    if (finding.status === 'accepted') {
      const currentMatterId = await this.lookupAppliedAdvocacyMatterId(ctx, clientId, finding);
      return { findingId, matterId: currentMatterId, alreadyApplied: true };
    }
    if (finding.status !== 'pending') {
      throw new BadRequestException('Only pending findings can be applied');
    }

    const matterId = await this.recordApplication.applyAdvocacyRecord(
      ctx,
      clientId,
      finding,
      target,
    );
    await this.markAccepted(ctx, clientId, finding.id);
    return { findingId, matterId, alreadyApplied: false };
  }

  /** Read-only lookup used by the idempotent-replay branch of
   *  `applyAdvocacyFindingToMatter` — never writes anything. */
  private async lookupAppliedAdvocacyMatterId(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ): Promise<string | null> {
    const proposed = asRecord(finding.proposedValue);
    const externalKey = asString(proposed.externalKey);
    if (!externalKey) return null;
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ matterId: string | null }>>(
        `SELECT matter_id AS "matterId" FROM client_advocacy_record
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND external_key = $3`,
        ctx.tenantId,
        clientId,
        externalKey,
      ),
    );
    return rows[0]?.matterId ?? null;
  }

  private async applyAdvancedFinding(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ): Promise<void> {
    switch (finding.kind) {
      case 'federal_footprint':
        await this.applyFederalFootprint(ctx, clientId, finding);
        return;
      case 'advocacy_record':
        await this.recordApplication.applyAdvocacyRecord(ctx, clientId, finding);
        return;
      case 'advocacy_outcome':
        await this.outcomeApplication.applyAdvocacyOutcome(ctx, clientId, finding);
        return;
      case 'regulatory_outcome':
        await this.outcomeApplication.applyRegulatoryOutcome(ctx, clientId, finding);
        return;
      default:
        throw new BadRequestException(`Unsupported completion finding: ${finding.kind}`);
    }
  }

  private async applyFederalFootprint(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ) {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { intakeData: true },
      });
      if (!before) throw new NotFoundException('Client not found');
      await tx.$executeRawUnsafe(
        `UPDATE clients
            SET intake_data_jsonb = jsonb_set(
                  COALESCE(intake_data_jsonb, '{}'::jsonb),
                  '{federalMarket}',
                  $4::jsonb,
                  true
                ),
                updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        clientId,
        ctx.tenantId,
        finding.id,
        JSON.stringify(finding.proposedValue),
      );
      await auditAdvanced(
        tx,
        ctx,
        clientId,
        finding,
        asRecord(before.intakeData).federalMarket,
        finding.proposedValue,
      );
    });
  }

  private async markAccepted(ctx: TenantContext, clientId: string, findingId: string) {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_finding
            SET status = 'accepted', reviewed_by = $4::uuid, reviewed_at = now(),
                applied_at = now(), rejection_reason = NULL, updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status = 'pending'`,
        findingId,
        ctx.tenantId,
        clientId,
        ctx.userId,
      ),
    );
  }

  private async loadFindings(
    tenantId: string,
    clientId: string,
    runId: string,
    findingIds: string[],
  ) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<AdvancedFindingRow[]>(
        `SELECT id,
                kind,
                target_key AS "targetKey",
                source,
                fact_kind AS "factKind",
                current_value_jsonb AS "currentValue",
                proposed_value_jsonb AS "proposedValue",
                evidence_jsonb AS evidence,
                confidence,
                status,
                content_hash AS "contentHash"
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            AND id = ANY($4::uuid[])`,
        tenantId,
        clientId,
        runId,
        [...new Set(findingIds)],
      ),
    );
  }

  async applyAdvocacyRecord(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    matterTarget?:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<string | null> {
    return this.recordApplication.applyAdvocacyRecord(ctx, clientId, finding, matterTarget);
  }
}
